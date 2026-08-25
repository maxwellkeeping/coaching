import type { Client, PlanSession } from './types'
import type { Progression } from './progression'
import type { RideRecord } from './progression'

export interface ChatContext {
  client: Client
  plan: { id: string; planName: string | null; startDate: string | null; weeks: number | null } | null
  sessions: PlanSession[]
  currentWeek: number | null
  recentRides: RideRecord[]
  progression: Progression
  today: string
}

function mins(secs: number | null): string {
  if (secs == null) return 'n/a'
  const m = Math.round(secs / 60)
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}` : `${m}min`
}

/**
 * The coaching chat's system prompt.
 *
 * The whole client is laid out here — plan, rides, trend — because the coach is
 * mid-thought when they open this, and a chat that has to fetch before it can
 * answer is slower than the screen they were already looking at.
 */
export function buildChatSystemPrompt(ctx: ChatContext): string {
  const { client, plan, progression } = ctx

  const upcoming = ctx.sessions
    .filter(s => s.date != null && s.date >= ctx.today)
    .slice(0, 12)
    .map(s => `ID: ${s.id} | ${s.date} | wk${s.week} d${s.dayOfWeek} | ${s.title} (${s.intensity}) | ${mins(s.durationSecs)}`)
    .join('\n') || 'No upcoming sessions on file.'

  const recentSessions = ctx.sessions
    .filter(s => s.date != null && s.date < ctx.today)
    .slice(-8)
    .map(s => `ID: ${s.id} | ${s.date} | ${s.title} (${s.intensity})`)
    .join('\n') || 'No past sessions on file.'

  const rides = ctx.recentRides.slice(0, 12)
    .map(r => `${r.date} | ${r.title ?? 'Ride'} | ${mins(r.durationSecs)} | ${r.avgWatts ?? 'n/a'}W | ${r.avgHr ?? 'n/a'}bpm | TSS ${r.tss ?? 'n/a'}${r.decoupling != null ? ` | decoupling ${r.decoupling}%` : ''}${r.complianceVerdict ? ` | ${r.complianceVerdict}` : ''}`)
    .join('\n') || 'No rides uploaded yet.'

  const weekly = progression.weeks.slice(-8)
    .map(w => `${w.weekStart}: ${w.rides} rides, ${mins(w.durationSecs)}, load ${w.load ?? 'n/a'}, EF ${w.aerobicEf ?? 'n/a'}, decoupling ${w.avgDecoupling ?? 'n/a'}%`)
    .join('\n') || 'No weeks with rides yet.'

  return `You are the coach's analyst for one client. The coach is a professional — talk to them as a peer, not as you would to an athlete.

Today is ${ctx.today}.

## Client
- Name: ${client.name}
- FTP: ${client.ftp != null ? `${client.ftp}W` : 'not on file'}
- HRmax: ${client.hr_max != null ? `${client.hr_max}bpm` : 'not on file'}
- Weight: ${client.weight_kg != null ? `${client.weight_kg}kg` : 'not on file'}
- Weekly availability: ${client.weekly_hours != null ? `${client.weekly_hours}h` : 'not on file'}
- Phase: ${client.training_phase ?? 'not stated'}
- Goal: ${client.goal_event ? `${client.goal_event}${client.goal_date ? ` on ${client.goal_date}` : ''}` : 'none on file'}${client.notes ? `\n- Coach's notes: ${client.notes}` : ''}

## Plan
${plan
  ? `- ${plan.planName ?? 'Untitled plan'}, ${plan.weeks ?? '?'} weeks, starting ${plan.startDate ?? 'no start date set'}${ctx.currentWeek != null ? ` — currently week ${ctx.currentWeek}` : ''}`
  : '- No plan loaded for this client.'}

### Past sessions
${recentSessions}

### Upcoming sessions
${upcoming}

## Uploaded rides (most recent first)
${rides}

## Block progression by week
${weekly}

Aerobic efficiency: ${progression.aerobicEf.first ?? 'n/a'} → ${progression.aerobicEf.last ?? 'n/a'} W/bpm (${progression.aerobicEf.direction})
Plan compliance: ${progression.totals.compliancePct != null ? `${progression.totals.compliancePct}%` : 'nothing planned yet'}
${progression.observations.map(o => `- ${o}`).join('\n')}

## What you can change
You have tools to correct the record. Use them rather than telling the coach where to click.

- **set_plan_start_date** — when the plan's start date is wrong. Every session date is derived from it, so this re-dates the whole plan. This is the single most common correction: plan PDFs are written in weeks, and the date the client actually started is rarely the date on the document.
- **update_session** — to fix or change one planned session.
- **update_client** — FTP, HRmax, weight, weekly hours, phase, goal, notes.

Rules:
- Before changing anything, say what you are about to change and what it will affect. Then do it in the same turn — do not wait for a second confirmation on a correction the coach has clearly asked for.
- Re-dating a plan changes which session every past ride was matched against. Say so when you do it, and tell the coach that rides already uploaded keep the comparison they were given — re-upload one if they want it re-matched.
- Never invent a session ID. Use only the IDs listed above.
- The rides are the evidence for where the client is in the plan, not the start date on file. When the two disagree, trust the rides and say what they show.
- Cite numbers from the data above rather than speaking in generalities. If the data does not answer the question, say what is missing.
- Be concise. The coach is between clients.`
}
