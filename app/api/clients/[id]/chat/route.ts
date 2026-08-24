import { streamText, tool, zodSchema, convertToModelMessages, isLoopFinished, stepCountIs } from 'ai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { z } from 'zod'
import { requireCoach } from '@/lib/auth'
import { loadClient, loadActivePlan, toRideRecord } from '@/lib/db'
import { computeProgression } from '@/lib/progression'
import { buildChatSystemPrompt } from '@/lib/chat-prompt'
import { sessionDate, weekOf, INTENSITIES } from '@/lib/plan'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { supabase, coachId, unauthorized } = await requireCoach()
  if (unauthorized) return unauthorized

  const client = await loadClient(supabase, coachId!, id)
  if (!client) return new Response('Client not found', { status: 404 })

  const { messages: uiMessages } = await req.json()

  const { plan, sessions } = await loadActivePlan(supabase, id)
  const { data: rideRows } = await supabase
    .from('rides')
    .select('id, filename, ride_date, summary, comparison, created_at')
    .eq('client_id', id)
    .order('ride_date', { ascending: false })
    .limit(60)

  const rideRecords = (rideRows ?? []).map(r => toRideRecord(r))
  const today = new Date().toISOString().split('T')[0]

  // Persist the incoming turn so the thread survives a reload.
  const last = uiMessages[uiMessages.length - 1]
  if (last?.role === 'user') {
    const text = Array.isArray(last.parts)
      ? last.parts.filter((p: { type: string }) => p.type === 'text').map((p: { text: string }) => p.text).join('')
      : typeof last.content === 'string' ? last.content : ''
    if (text) {
      await supabase.from('client_messages').insert({
        client_id: id, coach_id: coachId, role: 'user', content: text,
      })
    }
  }

  const result = streamText({
    model: anthropic('claude-opus-5'),
    system: buildChatSystemPrompt({
      client,
      plan,
      sessions,
      currentWeek: plan?.startDate ? weekOf(plan.startDate, today, plan.weeks) : null,
      recentRides: rideRecords,
      progression: computeProgression(rideRecords),
      today,
    }),
    messages: await convertToModelMessages(uiMessages),
    stopWhen: [isLoopFinished(), stepCountIs(8)],
    tools: {
      set_plan_start_date: tool({
        description:
          'Change the date the client actually started their plan. Every session date is derived from it, so this re-dates the whole plan at once. Use when the date read from the PDF is not the date the client began.',
        inputSchema: zodSchema(z.object({
          startDate: z.string().describe('The real start date, YYYY-MM-DD'),
        })),
        execute: async ({ startDate }) => {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
            return { error: 'startDate must be YYYY-MM-DD' }
          }
          if (!plan) return { error: 'This client has no plan loaded.' }

          const { error: planError } = await supabase
            .from('training_plans')
            .update({ start_date: startDate })
            .eq('id', plan.id)
            .eq('coach_id', coachId)
          if (planError) return { error: planError.message }

          // Re-date every session off the new start. Each row is written
          // individually because the offset differs per week/day slot.
          let updated = 0
          for (const s of sessions) {
            const date = sessionDate(startDate, s.week, s.dayOfWeek)
            const { error } = await supabase
              .from('plan_sessions')
              .update({ session_date: date })
              .eq('id', s.id)
              .eq('coach_id', coachId)
            if (!error) updated++
          }

          return {
            ok: true,
            startDate,
            sessionsRedated: updated,
            note: 'Rides already uploaded keep the comparison they were given — re-upload one to have it re-matched against the new dates.',
          }
        },
      }),

      update_session: tool({
        description: 'Change one planned session — its title, prescription, duration, target load or intensity.',
        inputSchema: zodSchema(z.object({
          sessionId: z.string().describe('The plan session ID, from the lists in the system prompt'),
          title: z.string().optional(),
          description: z.string().optional(),
          durationSecs: z.number().int().positive().optional(),
          targetLoad: z.number().int().positive().optional(),
          intensity: z.string().optional().describe('rest, recovery, endurance, tempo, threshold, vo2max, anaerobic, race or test'),
        })),
        execute: async ({ sessionId, title, description, durationSecs, targetLoad, intensity }) => {
          const update: Record<string, unknown> = {}
          if (title != null) update.title = title
          if (description != null) update.description = description
          if (durationSecs != null) update.duration_secs = durationSecs
          if (targetLoad != null) update.target_load = targetLoad
          if (intensity != null) {
            if (!(INTENSITIES as string[]).includes(intensity.toLowerCase())) {
              return { error: `intensity must be one of ${INTENSITIES.join(', ')}` }
            }
            update.intensity = intensity.toLowerCase()
          }
          if (Object.keys(update).length === 0) return { error: 'Nothing to change.' }

          const { data, error } = await supabase
            .from('plan_sessions')
            .update(update)
            .eq('id', sessionId)
            .eq('client_id', id)
            .eq('coach_id', coachId)
            .select('id, session_date, title, duration_secs, target_load, intensity')
            .single()

          if (error) return { error: error.message }
          return { ok: true, session: data }
        },
      }),

      update_client: tool({
        description: "Update the client's own numbers and context — FTP, HRmax, weight, weekly hours, phase, goal, or your notes on them.",
        inputSchema: zodSchema(z.object({
          ftp: z.number().int().positive().optional(),
          hrMax: z.number().int().positive().optional(),
          weightKg: z.number().positive().optional(),
          weeklyHours: z.number().positive().optional(),
          trainingPhase: z.string().optional(),
          goalEvent: z.string().optional(),
          goalDate: z.string().optional().describe('YYYY-MM-DD'),
          notes: z.string().optional(),
        })),
        execute: async (fields) => {
          const map: Record<string, string> = {
            ftp: 'ftp', hrMax: 'hr_max', weightKg: 'weight_kg', weeklyHours: 'weekly_hours',
            trainingPhase: 'training_phase', goalEvent: 'goal_event', goalDate: 'goal_date', notes: 'notes',
          }
          const update: Record<string, unknown> = {}
          for (const [key, column] of Object.entries(map)) {
            const value = (fields as Record<string, unknown>)[key]
            if (value != null) update[column] = value
          }
          if (Object.keys(update).length === 0) return { error: 'Nothing to change.' }

          const { data, error } = await supabase
            .from('clients')
            .update(update)
            .eq('id', id)
            .eq('coach_id', coachId)
            .select('*')
            .single()

          if (error) return { error: error.message }
          return {
            ok: true,
            updated: Object.keys(update),
            note: update.ftp != null
              ? 'FTP drives zones, TSS and %FTP — rides analyzed before this change keep the numbers they were given.'
              : undefined,
            client: { name: data.name, ftp: data.ftp, hr_max: data.hr_max },
          }
        },
      }),
    },
    onFinish: async ({ text }) => {
      if (text.trim()) {
        await supabase.from('client_messages').insert({
          client_id: id, coach_id: coachId, role: 'assistant', content: text,
        })
      }
    },
  })

  return result.toUIMessageStreamResponse()
}

/** The stored thread, so the conversation is there when the coach comes back. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { supabase, coachId, unauthorized } = await requireCoach()
  if (unauthorized) return unauthorized

  const { data, error } = await supabase
    .from('client_messages')
    .select('id, role, content, created_at')
    .eq('client_id', id)
    .eq('coach_id', coachId)
    .order('created_at')
    .limit(200)

  if (error) {
    console.error('[chat] history read failed:', error)
    return Response.json({ error: 'Failed to load the thread' }, { status: 500 })
  }

  return Response.json({ messages: data ?? [] })
}
