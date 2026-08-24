import { NextResponse } from 'next/server'
import { generateText } from 'ai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { requireCoach } from '@/lib/auth'
import { loadClient } from '@/lib/db'
import { PLAN_EXTRACTION_PROMPT, parseExtractedPlan, PlanExtractionError, type ExtractedPlan } from '@/lib/plan-extract'
import { resolveDates, sessionDate } from '@/lib/plan'

export const dynamic = 'force-dynamic'
export const maxDuration = 180

const MAX_PDF_BYTES = 20 * 1024 * 1024

const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

/**
 * Read a plan PDF and return the extracted sessions for review.
 *
 * Nothing is saved here on purpose: PDF extraction is fallible, and a plan the
 * coach has not looked at is not a plan worth measuring rides against. The
 * coach confirms via PUT, which is what writes the plan.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { supabase, coachId, unauthorized } = await requireCoach()
  if (unauthorized) return unauthorized

  const client = await loadClient(supabase, coachId!, id)
  if (!client) return NextResponse.json({ error: 'Client not found' }, { status: 404 })

  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return NextResponse.json({ error: 'Expected a multipart form upload' }, { status: 400 })
  }

  const file = form.get('file')
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'No file uploaded — attach the plan PDF as "file".' }, { status: 400 })
  }
  if (!file.name.toLowerCase().endsWith('.pdf')) {
    return NextResponse.json({ error: 'The plan needs to be a PDF.' }, { status: 400 })
  }
  if (file.size > MAX_PDF_BYTES) {
    return NextResponse.json({ error: 'That PDF is larger than the 20MB limit.' }, { status: 413 })
  }

  const startDateRaw = form.get('startDate')
  const startDate = typeof startDateRaw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(startDateRaw)
    ? startDateRaw
    : null

  let extracted: ExtractedPlan
  try {
    const bytes = new Uint8Array(await file.arrayBuffer())
    const { text } = await generateText({
      model: anthropic('claude-opus-5'),
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: PLAN_EXTRACTION_PROMPT },
          { type: 'file', data: bytes, mediaType: 'application/pdf', filename: file.name },
        ],
      }],
    })
    extracted = parseExtractedPlan(text)
  } catch (e) {
    if (e instanceof PlanExtractionError) {
      return NextResponse.json({ error: e.message }, { status: 422 })
    }
    console.error('[plan] extraction failed:', e)
    return NextResponse.json({ error: 'Could not read that PDF.' }, { status: 502 })
  }

  if (extracted.sessions.length === 0) {
    return NextResponse.json({
      error: 'No training sessions could be read from that PDF.',
      warnings: extracted.warnings,
    }, { status: 422 })
  }

  const effectiveStart = startDate ?? extracted.startDate
  return NextResponse.json({
    filename: file.name,
    plan: {
      ...extracted,
      startDate: effectiveStart,
      sessions: resolveDates(extracted.sessions, effectiveStart),
    },
  })
}

/**
 * Save a reviewed plan. Any existing active plan is archived first — a client
 * has exactly one plan in force, and rides are measured against that one.
 */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { supabase, coachId, unauthorized } = await requireCoach()
  if (unauthorized) return unauthorized

  const client = await loadClient(supabase, coachId!, id)
  if (!client) return NextResponse.json({ error: 'Client not found' }, { status: 404 })

  const body = await req.json().catch(() => null)
  const plan = body?.plan as ExtractedPlan | undefined
  const filename = typeof body?.filename === 'string' ? body.filename : 'plan.pdf'

  if (!plan || !Array.isArray(plan.sessions) || plan.sessions.length === 0) {
    return NextResponse.json({ error: 'No plan sessions to save.' }, { status: 400 })
  }
  if (!plan.startDate || !/^\d{4}-\d{2}-\d{2}$/.test(plan.startDate)) {
    return NextResponse.json({ error: 'A plan needs a start date before it can be saved.' }, { status: 400 })
  }

  await supabase
    .from('training_plans')
    .update({ status: 'archived' })
    .eq('client_id', id)
    .eq('status', 'active')

  const { data: planRow, error: planError } = await supabase
    .from('training_plans')
    .insert({
      client_id: id,
      coach_id: coachId,
      filename,
      plan_name: plan.planName ?? null,
      start_date: plan.startDate,
      weeks: plan.weeks || null,
      status: 'active',
      extracted: plan,
      warnings: plan.warnings ?? [],
    })
    .select('id')
    .single()

  if (planError || !planRow) {
    console.error('[plan] save failed:', planError)
    return NextResponse.json({ error: 'Failed to save the plan' }, { status: 500 })
  }

  const dated = resolveDates(plan.sessions, plan.startDate)
  const { error: sessionError } = await supabase.from('plan_sessions').insert(
    dated.map(s => ({
      plan_id: planRow.id,
      client_id: id,
      coach_id: coachId,
      week: s.week,
      day_of_week: s.dayOfWeek,
      session_date: s.date,
      title: s.title,
      description: s.description,
      sport: s.sport,
      duration_secs: s.durationSecs,
      target_load: s.targetLoad,
      intensity: s.intensity,
      source_text: s.sourceText,
    }))
  )

  if (sessionError) {
    console.error('[plan] session save failed:', sessionError)
    // Roll the plan back rather than leaving a plan with no sessions behind it.
    await supabase.from('training_plans').delete().eq('id', planRow.id)
    return NextResponse.json({ error: 'Failed to save the plan sessions' }, { status: 500 })
  }

  return NextResponse.json({ planId: planRow.id, sessions: dated.length })
}

/**
 * Change the active plan's start date and re-date every session off it.
 *
 * The date in a plan PDF is rarely the date the client actually began, and
 * every session date is derived from it — so this is the correction the coach
 * needs most, and it must not require re-uploading the plan.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { supabase, coachId, unauthorized } = await requireCoach()
  if (unauthorized) return unauthorized

  const client = await loadClient(supabase, coachId!, id)
  if (!client) return NextResponse.json({ error: 'Client not found' }, { status: 404 })

  const body = await req.json().catch(() => null)
  const startDate = body?.startDate
  if (typeof startDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    return NextResponse.json({ error: 'startDate must be YYYY-MM-DD' }, { status: 400 })
  }

  const { data: planRow } = await supabase
    .from('training_plans')
    .select('id')
    .eq('client_id', id)
    .eq('coach_id', coachId)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!planRow) return NextResponse.json({ error: 'This client has no active plan.' }, { status: 404 })

  const { error: planError } = await supabase
    .from('training_plans')
    .update({ start_date: startDate })
    .eq('id', planRow.id)
    .eq('coach_id', coachId)

  if (planError) {
    console.error('[plan] start date update failed:', planError)
    return NextResponse.json({ error: 'Failed to update the start date' }, { status: 500 })
  }

  const { data: sessionRows } = await supabase
    .from('plan_sessions')
    .select('id, week, day_of_week')
    .eq('plan_id', planRow.id)

  let redated = 0
  for (const s of sessionRows ?? []) {
    const date = sessionDate(startDate, s.week as number, s.day_of_week as number)
    const { error } = await supabase
      .from('plan_sessions')
      .update({ session_date: date })
      .eq('id', s.id)
      .eq('coach_id', coachId)
    if (!error) redated++
  }

  return NextResponse.json({ startDate, sessionsRedated: redated })
}
