import { NextResponse } from 'next/server'
import { generateText } from 'ai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { requireCoach } from '@/lib/auth'
import { loadClient, loadActivePlan, toRideRecord } from '@/lib/db'
import { parseFitFile, FitParseError } from '@/lib/fit-parser'
import { summarizeFitRide, type FitRideSummary } from '@/lib/fit-analysis'
import { matchSession, weekOf } from '@/lib/plan'
import { compareToPlan } from '@/lib/plan-match'
import { computeProgression } from '@/lib/progression'
import { buildFeedbackPrompt } from '@/lib/feedback-prompt'
import { INTENSITIES } from '@/lib/plan'

export const dynamic = 'force-dynamic'
export const maxDuration = 180

const MAX_FIT_BYTES = 25 * 1024 * 1024

const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

interface Adjustment {
  sessionId?: string
  summary?: string
  rationale?: string
  changes?: Record<string, unknown>
}

interface Feedback {
  headline: string
  executionSummary: string
  whatWentWell: string[]
  concerns: string[]
  progressAssessment: string
  adjustments: Adjustment[]
  clientMessage: string
}

function parseFeedback(text: string): Feedback {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim()
  const parsed = JSON.parse(cleaned) as Partial<Feedback>
  const list = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  return {
    headline: parsed.headline ?? 'Ride analyzed.',
    executionSummary: parsed.executionSummary ?? '',
    whatWentWell: list(parsed.whatWentWell),
    concerns: list(parsed.concerns),
    progressAssessment: parsed.progressAssessment ?? '',
    adjustments: Array.isArray(parsed.adjustments) ? parsed.adjustments : [],
    clientMessage: parsed.clientMessage ?? '',
  }
}

/** Keep only the fields a plan session actually has, coerced to its column types. */
function sanitizeChanges(changes: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (typeof changes.title === 'string' && changes.title.trim()) out.title = changes.title.trim()
  if (typeof changes.description === 'string') out.description = changes.description.trim() || null
  const duration = Number(changes.durationSecs)
  if (isFinite(duration) && duration > 0) out.duration_secs = Math.round(duration)
  const load = Number(changes.targetLoad)
  if (isFinite(load) && load > 0) out.target_load = Math.round(load)
  if (typeof changes.intensity === 'string' && (INTENSITIES as string[]).includes(changes.intensity.toLowerCase())) {
    out.intensity = changes.intensity.toLowerCase()
  }
  return out
}

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
    return NextResponse.json({ error: 'No file uploaded — attach the ride as "file".' }, { status: 400 })
  }
  if (!file.name.toLowerCase().endsWith('.fit')) {
    return NextResponse.json({ error: 'Only .fit files are supported.' }, { status: 400 })
  }
  if (file.size > MAX_FIT_BYTES) {
    return NextResponse.json({ error: 'That file is larger than the 25MB limit.' }, { status: 413 })
  }

  const noteRaw = form.get('note')
  const coachNote = typeof noteRaw === 'string' && noteRaw.trim() ? noteRaw.trim().slice(0, 2000) : null

  // 1. The file itself, analyzed against this client's numbers.
  let ride: FitRideSummary
  let rideDate: string | null = null
  try {
    const parsed = parseFitFile(await file.arrayBuffer())
    ride = summarizeFitRide(parsed, { ftp: client.ftp, hrMax: client.hr_max })
    rideDate = parsed.startTime ? parsed.startTime.split('T')[0] : null
  } catch (e) {
    if (e instanceof FitParseError) return NextResponse.json({ error: e.message }, { status: 422 })
    console.error('[rides] parse failed:', e)
    return NextResponse.json({ error: 'Could not read that FIT file.' }, { status: 500 })
  }

  // 2. What it was meant to be, and how the block is going.
  const { plan, sessions } = await loadActivePlan(supabase, id)
  const matched = rideDate ? matchSession(sessions, rideDate) : null
  const comparison = compareToPlan(ride, matched, client.ftp)

  const { data: priorRows } = await supabase
    .from('rides')
    .select('id, filename, ride_date, summary, comparison, created_at')
    .eq('client_id', id)
    .order('ride_date', { ascending: false })
    .limit(60)

  const priorRecords = (priorRows ?? []).map(r => toRideRecord(r))
  const thisRecord = {
    id: 'pending',
    date: rideDate ?? new Date().toISOString().split('T')[0],
    title: file.name,
    durationSecs: ride.analysis.durationSecs,
    tss: ride.tss,
    avgWatts: ride.analysis.power.avgWatts,
    avgHr: ride.analysis.hr.avgHr,
    normalizedPower: ride.analysis.power.normalizedPower,
    decoupling: ride.analysis.decoupling,
    intensityFactor: ride.intensityFactor,
    complianceVerdict: comparison.verdict,
  }
  // The progression the coach is shown includes this ride — it is the newest
  // data point and the whole reason they uploaded it.
  const progression = computeProgression([...priorRecords, thisRecord])

  const today = new Date().toISOString().split('T')[0]
  const upcoming = sessions.filter(s => s.date != null && s.date >= today && s.intensity !== 'rest')

  // 3. Coach it.
  let feedback: Feedback
  try {
    const { text } = await generateText({
      model: anthropic('claude-opus-5'),
      prompt: buildFeedbackPrompt({
        client,
        ride,
        filename: file.name,
        rideDate,
        coachNote,
        comparison,
        planWeek: plan?.startDate && rideDate ? weekOf(plan.startDate, rideDate, plan.weeks) : null,
        planWeeks: plan?.weeks ?? null,
        progression,
        recentRides: priorRecords,
        upcoming,
      }),
    })
    feedback = parseFeedback(text)
  } catch (e) {
    console.error('[rides] coaching failed:', e)
    return NextResponse.json(
      { error: 'The ride was analyzed but the coaching response failed. Try again.' },
      { status: 502 }
    )
  }

  // Adjustments only survive if they point at a real upcoming session and
  // actually change a field the plan holds.
  const upcomingIds = new Set(upcoming.map(s => s.id))
  const adjustments = feedback.adjustments
    .map(a => ({ ...a, sanitized: a.changes ? sanitizeChanges(a.changes) : {} }))
    .filter(a => a.sessionId && upcomingIds.has(a.sessionId) && Object.keys(a.sanitized).length > 0)
  feedback.adjustments = adjustments.map(a => ({
    sessionId: a.sessionId,
    summary: a.summary,
    rationale: a.rationale,
    changes: a.sanitized,
  }))

  // 4. Save the ride, then the changes it proposes.
  const { data: savedRide, error: rideError } = await supabase
    .from('rides')
    .insert({
      client_id: id,
      coach_id: coachId,
      plan_session_id: matched?.id ?? null,
      filename: file.name,
      ride_date: rideDate,
      coach_note: coachNote,
      summary: ride,
      comparison,
      feedback,
    })
    .select('id')
    .single()

  if (rideError) {
    console.error('[rides] save failed:', rideError)
    return NextResponse.json({ error: 'Analyzed the ride but failed to save it.' }, { status: 500 })
  }

  let pendingChanges: Array<Record<string, unknown>> = []
  if (adjustments.length > 0) {
    const { data: inserted, error: changeError } = await supabase
      .from('plan_changes')
      .insert(adjustments.map(a => ({
        client_id: id,
        coach_id: coachId,
        ride_id: savedRide.id,
        plan_session_id: a.sessionId,
        summary: a.summary ?? 'Plan adjustment',
        rationale: a.rationale ?? null,
        changes: a.sanitized,
        status: 'pending',
      })))
      .select('*')

    if (changeError) console.error('[rides] plan change save failed:', changeError)
    else pendingChanges = inserted ?? []
  }

  return NextResponse.json({
    rideId: savedRide.id,
    rideDate,
    filename: file.name,
    ride,
    comparison,
    feedback,
    progression,
    matchedSession: matched,
    pendingChanges,
    hasPlan: plan != null,
  })
}
