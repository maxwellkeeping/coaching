import type { SupabaseClient } from '@supabase/supabase-js'
import type { Client, PlanSession, SessionIntensity } from './types'
import type { RideRecord } from './progression'
import type { ComplianceVerdict } from './plan-match'
import type { FitRideSummary } from './fit-analysis'

type Row = Record<string, unknown>

export function toPlanSession(row: Row): PlanSession {
  return {
    id: row.id as string,
    plan_id: row.plan_id as string,
    client_id: row.client_id as string,
    week: row.week as number,
    dayOfWeek: row.day_of_week as number,
    date: (row.session_date as string) ?? null,
    title: row.title as string,
    description: (row.description as string) ?? null,
    sport: (row.sport as string) ?? null,
    durationSecs: (row.duration_secs as number) ?? null,
    targetLoad: (row.target_load as number) ?? null,
    intensity: (row.intensity as SessionIntensity) ?? 'unknown',
    sourceText: (row.source_text as string) ?? null,
  }
}

/** Flatten a stored ride row into the slim shape the progression maths reads. */
export function toRideRecord(row: Row): RideRecord {
  const summary = row.summary as FitRideSummary | null
  const comparison = row.comparison as { verdict?: ComplianceVerdict } | null
  const analysis = summary?.analysis
  return {
    id: row.id as string,
    date: (row.ride_date as string) ?? (row.created_at as string).split('T')[0],
    title: (row.filename as string) ?? null,
    durationSecs: analysis?.durationSecs ?? 0,
    tss: summary?.tss ?? null,
    avgWatts: analysis?.power.avgWatts ?? null,
    avgHr: analysis?.hr.avgHr ?? null,
    normalizedPower: analysis?.power.normalizedPower ?? null,
    decoupling: analysis?.decoupling ?? null,
    intensityFactor: summary?.intensityFactor ?? null,
    complianceVerdict: comparison?.verdict ?? null,
  }
}

export function toClient(row: Row): Client {
  return {
    id: row.id as string,
    coach_id: row.coach_id as string,
    name: row.name as string,
    email: (row.email as string) ?? null,
    ftp: (row.ftp as number) ?? null,
    hr_max: (row.hr_max as number) ?? null,
    weight_kg: row.weight_kg != null ? Number(row.weight_kg) : null,
    goal_event: (row.goal_event as string) ?? null,
    goal_date: (row.goal_date as string) ?? null,
    weekly_hours: row.weekly_hours != null ? Number(row.weekly_hours) : null,
    training_phase: (row.training_phase as string) ?? null,
    notes: (row.notes as string) ?? null,
    archived: (row.archived as boolean) ?? false,
    created_at: row.created_at as string,
  }
}

/**
 * Load a client the signed-in coach owns.
 *
 * RLS already scopes every query to the coach, so a miss here means the client
 * does not exist or belongs to someone else — both are a 404 to the caller,
 * which is also what stops client IDs being probed across accounts.
 */
export async function loadClient(
  supabase: SupabaseClient,
  coachId: string,
  clientId: string
): Promise<Client | null> {
  const { data } = await supabase
    .from('clients')
    .select('*')
    .eq('id', clientId)
    .eq('coach_id', coachId)
    .maybeSingle()
  return data ? toClient(data as Row) : null
}

/** The client's active plan, with its sessions in plan order. */
export async function loadActivePlan(supabase: SupabaseClient, clientId: string): Promise<{
  plan: { id: string; planName: string | null; startDate: string | null; weeks: number | null; filename: string } | null
  sessions: PlanSession[]
}> {
  const { data: planRow } = await supabase
    .from('training_plans')
    .select('id, plan_name, start_date, weeks, filename')
    .eq('client_id', clientId)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!planRow) return { plan: null, sessions: [] }

  const { data: sessionRows } = await supabase
    .from('plan_sessions')
    .select('*')
    .eq('plan_id', planRow.id)
    .order('week', { ascending: true })
    .order('day_of_week', { ascending: true })

  return {
    plan: {
      id: planRow.id as string,
      planName: (planRow.plan_name as string) ?? null,
      startDate: (planRow.start_date as string) ?? null,
      weeks: (planRow.weeks as number) ?? null,
      filename: planRow.filename as string,
    },
    sessions: (sessionRows ?? []).map(r => toPlanSession(r as Row)),
  }
}
