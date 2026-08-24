import { NextResponse } from 'next/server'
import { requireCoach } from '@/lib/auth'
import { toClient } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET() {
  const { supabase, coachId, unauthorized } = await requireCoach()
  if (unauthorized) return unauthorized

  const { data, error } = await supabase
    .from('clients')
    .select('*')
    .eq('coach_id', coachId)
    .eq('archived', false)
    .order('name')

  if (error) {
    console.error('[clients] list failed:', error)
    return NextResponse.json({ error: 'Failed to load clients' }, { status: 500 })
  }

  // The counts drive the roster view: a client with no plan or no rides is the
  // one needing attention, and that should be visible without opening them.
  const ids = (data ?? []).map(c => c.id)
  const counts = new Map<string, { rides: number; hasPlan: boolean; lastRide: string | null }>()
  if (ids.length > 0) {
    const [{ data: rides }, { data: plans }] = await Promise.all([
      supabase.from('rides').select('client_id, ride_date').in('client_id', ids),
      supabase.from('training_plans').select('client_id').eq('status', 'active').in('client_id', ids),
    ])
    for (const id of ids) counts.set(id, { rides: 0, hasPlan: false, lastRide: null })
    for (const r of rides ?? []) {
      const c = counts.get(r.client_id as string)!
      c.rides++
      const date = r.ride_date as string | null
      if (date && (!c.lastRide || date > c.lastRide)) c.lastRide = date
    }
    for (const p of plans ?? []) counts.get(p.client_id as string)!.hasPlan = true
  }

  return NextResponse.json({
    clients: (data ?? []).map(row => ({
      ...toClient(row),
      ...(counts.get(row.id as string) ?? { rides: 0, hasPlan: false, lastRide: null }),
    })),
  })
}

export async function POST(req: Request) {
  const { supabase, coachId, unauthorized } = await requireCoach()
  if (unauthorized) return unauthorized

  const body = await req.json().catch(() => null)
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  if (!name) return NextResponse.json({ error: 'A client needs a name.' }, { status: 400 })

  const numeric = (v: unknown): number | null => {
    const n = typeof v === 'string' ? Number(v) : v
    return typeof n === 'number' && isFinite(n) && n > 0 ? n : null
  }

  const { data, error } = await supabase
    .from('clients')
    .insert({
      coach_id: coachId,
      name,
      email: typeof body.email === 'string' && body.email.trim() ? body.email.trim() : null,
      ftp: numeric(body.ftp),
      hr_max: numeric(body.hr_max),
      weight_kg: numeric(body.weight_kg),
      goal_event: typeof body.goal_event === 'string' && body.goal_event.trim() ? body.goal_event.trim() : null,
      goal_date: typeof body.goal_date === 'string' && body.goal_date ? body.goal_date : null,
      weekly_hours: numeric(body.weekly_hours),
      training_phase: typeof body.training_phase === 'string' && body.training_phase.trim() ? body.training_phase.trim() : null,
      notes: typeof body.notes === 'string' && body.notes.trim() ? body.notes.trim() : null,
    })
    .select('*')
    .single()

  if (error) {
    console.error('[clients] create failed:', error)
    return NextResponse.json({ error: 'Failed to create the client' }, { status: 500 })
  }

  return NextResponse.json({ client: toClient(data) })
}
