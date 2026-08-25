import { NextResponse } from 'next/server'
import { requireCoach } from '@/lib/auth'
import { loadClient, loadActivePlan, toRideRecord } from '@/lib/db'
import { inferPlanStart, planPosition, type RideEvidence } from '@/lib/plan-position'
import type { FitRideSummary } from '@/lib/fit-analysis'

export const dynamic = 'force-dynamic'

/**
 * Where the client is in their plan, worked out from their uploaded rides.
 *
 * The rides are the evidence: a plan PDF is written in weeks, and the date the
 * client actually began is rarely recorded anywhere. If the uploads line up
 * with the plan's shapes under one start date and scatter under every other,
 * that start date is the answer.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { supabase, coachId, unauthorized } = await requireCoach()
  if (unauthorized) return unauthorized

  const client = await loadClient(supabase, coachId!, id)
  if (!client) return NextResponse.json({ error: 'Client not found' }, { status: 404 })

  const { plan, sessions } = await loadActivePlan(supabase, id)
  const { data: rideRows } = await supabase
    .from('rides')
    .select('id, filename, ride_date, summary, comparison, created_at')
    .eq('client_id', id)
    .order('ride_date', { ascending: true })

  const today = new Date().toISOString().split('T')[0]

  const evidence: RideEvidence[] = (rideRows ?? [])
    .filter(r => r.ride_date)
    .map(r => {
      const summary = r.summary as FitRideSummary | null
      return {
        date: r.ride_date as string,
        archetype: summary?.structure?.archetype ?? 'unstructured',
        durationSecs: summary?.analysis.durationSecs ?? 0,
      }
    })

  const inference = inferPlanStart(evidence, sessions, today, plan?.weeks ?? null, plan?.startDate ?? null)
  const position = planPosition(
    sessions,
    plan?.startDate ?? null,
    plan?.weeks ?? null,
    (rideRows ?? []).map(r => r.ride_date as string).filter(Boolean),
    today,
    client.goal_date
  )

  return NextResponse.json({
    plan,
    position,
    inference,
    // Only worth raising when the rides actually disagree with what is on file.
    disagreesWithSaved:
      plan?.startDate != null &&
      inference.suggestedStart != null &&
      inference.suggestedStart !== plan.startDate &&
      inference.confidence !== 'low',
    rideCount: (rideRows ?? []).length,
    latestRide: (rideRows ?? []).map(r => toRideRecord(r)).slice(-1)[0] ?? null,
  })
}
