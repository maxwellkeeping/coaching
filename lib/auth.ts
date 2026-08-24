import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from './supabase-server'

/** Resolve the signed-in coach, or the 401 to return instead. */
export async function requireCoach() {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return { supabase, coachId: null, unauthorized: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }
  return { supabase, coachId: user.id, unauthorized: null }
}
