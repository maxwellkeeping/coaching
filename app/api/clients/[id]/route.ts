import { NextResponse } from 'next/server'
import { requireCoach } from '@/lib/auth'
import { loadClient, loadActivePlan, toRideRecord, toClient } from '@/lib/db'
import { computeProgression } from '@/lib/progression'
import { weekOf } from '@/lib/plan'

export const dynamic = 'force-dynamic'

/** The whole client view in one call: profile, plan, rides, progression, pending changes. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { supabase, coachId, unauthorized } = await requireCoach()
  if (unauthorized) return unauthorized

  const client = await loadClient(supabase, coachId!, id)
  if (!client) return NextResponse.json({ error: 'Client not found' }, { status: 404 })

  const [{ plan, sessions }, { data: rideRows }, { data: changeRows }] = await Promise.all([
    loadActivePlan(supabase, id),
    supabase
      .from('rides')
      .select('id, filename, ride_date, summary, comparison, feedback, plan_session_id, created_at')
      .eq('client_id', id)
      .order('ride_date', { ascending: false })
      .limit(60),
    supabase
      .from('plan_changes')
      .select('*')
      .eq('client_id', id)
      .eq('status', 'pending')
      .order('created_at', { ascending: false }),
  ])

  const rides = (rideRows ?? []).map(r => ({
    id: r.id as string,
    filename: r.filename as string,
    rideDate: (r.ride_date as string) ?? null,
    planSessionId: (r.plan_session_id as string) ?? null,
    summary: r.summary,
    comparison: r.comparison,
    feedback: r.feedback,
    createdAt: r.created_at as string,
  }))

  const progression = computeProgression((rideRows ?? []).map(r => toRideRecord(r)))

  const today = new Date().toISOString().split('T')[0]
  const currentWeek = plan?.startDate ? weekOf(plan.startDate, today, plan.weeks) : null

  return NextResponse.json({
    client,
    plan,
    sessions,
    currentWeek,
    rides,
    progression,
    pendingChanges: changeRows ?? [],
  })
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { supabase, coachId, unauthorized } = await requireCoach()
  if (unauthorized) return unauthorized

  const body = await req.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Expected a JSON body' }, { status: 400 })

  const allowed = ['name', 'email', 'ftp', 'hr_max', 'weight_kg', 'goal_event', 'goal_date', 'weekly_hours', 'training_phase', 'notes', 'archived'] as const
  const update: Record<string, unknown> = {}
  for (const key of allowed) {
    if (key in body) update[key] = body[key] === '' ? null : body[key]
  }
  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
  }

  const { data, error } = await supabase
    .from('clients')
    .update(update)
    .eq('id', id)
    .eq('coach_id', coachId)
    .select('*')
    .single()

  if (error) {
    console.error('[clients] update failed:', error)
    return NextResponse.json({ error: 'Failed to update the client' }, { status: 500 })
  }

  return NextResponse.json({ client: toClient(data) })
}
