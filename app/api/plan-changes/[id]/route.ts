import { NextResponse } from 'next/server'
import { requireCoach } from '@/lib/auth'

export const dynamic = 'force-dynamic'

/**
 * Apply or dismiss a proposed plan change.
 *
 * Applying writes the change onto the plan session it points at — the plan
 * lives here, so there is no external calendar to keep in step. The change row
 * is kept either way as the record of what was proposed and what the coach
 * decided.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { supabase, coachId, unauthorized } = await requireCoach()
  if (unauthorized) return unauthorized

  const body = await req.json().catch(() => null)
  const action = body?.action
  if (action !== 'apply' && action !== 'dismiss') {
    return NextResponse.json({ error: 'action must be "apply" or "dismiss"' }, { status: 400 })
  }

  const { data: change } = await supabase
    .from('plan_changes')
    .select('*')
    .eq('id', id)
    .eq('coach_id', coachId)
    .maybeSingle()

  if (!change) return NextResponse.json({ error: 'Change not found' }, { status: 404 })
  if (change.status !== 'pending') {
    return NextResponse.json({ error: `This change was already ${change.status}.` }, { status: 409 })
  }

  if (action === 'dismiss') {
    const { error } = await supabase.from('plan_changes').update({ status: 'dismissed' }).eq('id', id)
    if (error) {
      console.error('[plan-changes] dismiss failed:', error)
      return NextResponse.json({ error: 'Failed to dismiss the change' }, { status: 500 })
    }
    return NextResponse.json({ status: 'dismissed' })
  }

  const changes = change.changes as Record<string, unknown>
  if (!changes || Object.keys(changes).length === 0) {
    return NextResponse.json({ error: 'This change has nothing to apply.' }, { status: 400 })
  }

  const { data: session, error: sessionError } = await supabase
    .from('plan_sessions')
    .update(changes)
    .eq('id', change.plan_session_id)
    .eq('coach_id', coachId)
    .select('*')
    .single()

  if (sessionError || !session) {
    console.error('[plan-changes] apply failed:', sessionError)
    return NextResponse.json({ error: 'Failed to update the planned session' }, { status: 500 })
  }

  const { error: statusError } = await supabase
    .from('plan_changes')
    .update({ status: 'applied', applied_at: new Date().toISOString() })
    .eq('id', id)

  if (statusError) {
    console.error('[plan-changes] status update failed:', statusError)
  }

  return NextResponse.json({ status: 'applied', session })
}
