import type { Client, PlanSession } from './types'
import type { FitRideSummary } from './fit-analysis'
import type { PlanComparison } from './plan-match'
import type { Progression, RideRecord } from './progression'

export interface FeedbackContext {
  client: Client
  ride: FitRideSummary
  filename: string
  rideDate: string | null
  /** What the coach said when uploading — context the file cannot carry. */
  coachNote: string | null
  comparison: PlanComparison
  /** Where this ride sits in the plan, when the plan has dates. */
  planWeek: number | null
  planWeeks: number | null
  progression: Progression
  recentRides: RideRecord[]
  /** Sessions still ahead — the only ones the coach may propose changes to. */
  upcoming: PlanSession[]
}

function mins(secs: number | null | undefined): string {
  if (secs == null) return 'n/a'
  const m = Math.round(secs / 60)
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}` : `${m}min`
}

function rideBlock(ride: FitRideSummary): string {
  const a = ride.analysis
  const zones = a.zones
    ? a.zones.filter(z => z.secs > 0).map(z => `${z.zone} ${z.label} ${z.pct}%`).join(', ')
    : 'not computed (no FTP on file)'
  const thirds = a.thirds.length === 3
    ? a.thirds.map(t => `T${t.third}: ${t.avgWatts ?? 'n/a'}W @ ${t.avgHr ?? 'n/a'}bpm, EF ${t.ef ?? 'n/a'}`).join(' | ')
    : 'too short to split'
  const intervals = a.intervals && a.intervals.length > 0
    ? a.intervals.map(i =>
        `#${i.interval}${i.label ? ` ${i.label}` : ''}: ${mins(i.durationSecs)}, ${i.avgWatts ?? 'n/a'}W` +
        `${i.pctFtp != null ? ` (${i.pctFtp}% FTP)` : ''}, ${i.avgHr ?? 'n/a'}bpm, back-half fade ${i.fadePct ?? 'n/a'}%, decoupling ${i.decoupling ?? 'n/a'}%`
      ).join('\n')
    : 'No work intervals detected — this reads as a continuous ride.'

  return `- Duration ${mins(a.durationSecs)}${ride.reported.totalDistanceKm != null ? `, ${ride.reported.totalDistanceKm}km` : ''}${ride.reported.totalAscentM != null ? `, ${ride.reported.totalAscentM}m climbing` : ''}
- Power: avg ${a.power.avgWatts ?? 'n/a'}W, NP ${a.power.normalizedPower ?? 'n/a'}W, VI ${a.power.variabilityIndex ?? 'n/a'}, ${a.power.totalKj}kJ, coasting ${a.power.coastingPct}%
- Load: IF ${ride.intensityFactor ?? 'n/a'}, TSS ${ride.tss ?? 'n/a'}
- HR: avg ${a.hr.avgHr ?? 'n/a'}bpm, max ${a.hr.maxHr ?? 'n/a'}bpm${a.hr.pctAboveThresholdHr != null ? `, ${a.hr.pctAboveThresholdHr}% of time above 85% HRmax` : ''}
- Best efforts: ${a.power.bestEfforts.map(b => `${b.label} ${b.watts}W`).join(', ') || 'n/a'}
- Whole-ride decoupling: ${a.decoupling ?? 'n/a'}%
- Thirds: ${thirds}
- Late-ride efficiency fade: ${a.lateFadePct ?? 'n/a'}%
- Zones: ${zones}

### Work intervals
${intervals}

### Signal flags from the file
${a.insights.length > 0 ? a.insights.map(i => `- ${i}`).join('\n') : '- None triggered.'}`
}

function comparisonBlock(c: PlanComparison): string {
  if (!c.planned) return 'This ride does not correspond to any planned session.'
  return `- Prescribed: ${c.planned.title} (${c.planned.intensity})${c.planned.date ? ` on ${c.planned.date}` : ''}, ${mins(c.planned.durationSecs)}${c.planned.targetLoad != null ? `, target TSS ${c.planned.targetLoad}` : ''}
- Compliance verdict from the numbers: ${c.verdict}
${c.notes.map(n => `- ${n}`).join('\n')}`
}

function progressionBlock(p: Progression): string {
  if (p.weeks.length === 0) return 'No prior rides have been uploaded for this client.'
  const weekly = p.weeks
    .slice(-8)
    .map(w =>
      `${w.weekStart}: ${w.rides} rides, ${mins(w.durationSecs)}, load ${w.load ?? 'n/a'}, aerobic EF ${w.aerobicEf ?? 'n/a'}, decoupling ${w.avgDecoupling ?? 'n/a'}%` +
      `${w.compliance ? `, ${w.compliance.onPlan}/${w.compliance.assessed} sessions on plan` : ''}`
    )
    .join('\n')
  return `${weekly}

Aerobic efficiency: ${p.aerobicEf.first ?? 'n/a'} → ${p.aerobicEf.last ?? 'n/a'} W/bpm (${p.aerobicEf.direction})
Plan compliance across the block: ${p.totals.compliancePct != null ? `${p.totals.compliancePct}%` : 'nothing planned yet'}
${p.observations.map(o => `- ${o}`).join('\n')}`
}

/**
 * The single prompt behind a ride upload.
 *
 * Three questions in one pass, because they only make sense together: what
 * happened in this ride, how it compares to what was prescribed, and what that
 * says about the block. The upcoming session list is the only set of IDs the
 * coach may propose changes against — that is what keeps a returned adjustment
 * applicable to a real row in the plan.
 */
export function buildFeedbackPrompt(ctx: FeedbackContext): string {
  const { client, ride, progression, comparison } = ctx

  const upcomingBlock = ctx.upcoming.length > 0
    ? ctx.upcoming
        .slice(0, 14)
        .map(s => `ID: ${s.id} | ${s.date ?? `week ${s.week} day ${s.dayOfWeek}`} | ${s.title} (${s.intensity}) | ${mins(s.durationSecs)}${s.description ? ` | ${s.description.replace(/\s+/g, ' ').slice(0, 160)}` : ''}`)
        .join('\n')
    : 'No upcoming sessions are on file. You must return an empty adjustments array.'

  const recentBlock = ctx.recentRides.length > 0
    ? ctx.recentRides.slice(0, 10).map(r =>
        `${r.date} | ${r.title ?? 'Ride'} | ${mins(r.durationSecs)} | ${r.avgWatts ?? 'n/a'}W | ${r.avgHr ?? 'n/a'}bpm | TSS ${r.tss ?? 'n/a'}` +
        `${r.decoupling != null ? ` | decoupling ${r.decoupling}%` : ''}${r.complianceVerdict ? ` | ${r.complianceVerdict}` : ''}`
      ).join('\n')
    : 'No earlier rides on file for this client.'

  return `You are a cycling coach reviewing a ride file for one of your clients. Assess how the session was executed against what you prescribed, and what it says about how their block is progressing.

## Client
- Name: ${client.name}
- FTP: ${client.ftp != null ? `${client.ftp}W` : 'not on file — do not quote %FTP or TSS figures as if they were reliable'}
- HRmax: ${client.hr_max != null ? `${client.hr_max}bpm` : 'not on file'}
- Weight: ${client.weight_kg != null ? `${client.weight_kg}kg` : 'not on file'}
- Weekly availability: ${client.weekly_hours != null ? `${client.weekly_hours}h` : 'not on file'}
- Training phase: ${client.training_phase ?? 'not stated'}
- Goal: ${client.goal_event ? `${client.goal_event}${client.goal_date ? ` on ${client.goal_date}` : ''}` : 'no goal event on file'}${client.notes ? `\n- Your notes on this client: ${client.notes}` : ''}

## The uploaded ride — ${ctx.filename}${ctx.rideDate ? ` (${ctx.rideDate})` : ''}${ctx.planWeek != null ? `, week ${ctx.planWeek}${ctx.planWeeks ? ` of ${ctx.planWeeks}` : ''} of the plan` : ''}
${rideBlock(ride)}
${ctx.coachNote ? `\n### Your note on this upload\n${ctx.coachNote}\n` : ''}
## Executed against prescribed
${comparisonBlock(comparison)}

## Their earlier rides (most recent first)
${recentBlock}

## Block progression
${progressionBlock(progression)}

## Upcoming sessions in the plan
${upcomingBlock}

## Interpretation guide
- Decoupling under 5% is aerobic control; 6% or more is real strain. Under 90 minutes it means little.
- Back-half fade of 5% or more inside a work interval is fatigue or a pacing error — say which, and why.
- Rides past ~2,000 kJ are durability-relevant: judge the final third's efficiency against the first.
- VI at or above 1.15 outdoors means punchy, unsteady riding — NP overstates the steady-state cost.
- On outdoor endurance rides judge compliance on average HR, not power. Terrain inflates NP without a matching metabolic cost.
- Aerobic efficiency (W/bpm) trending up is fitness. A single ride's EF is noise; the block's direction is the signal.
- With no power data, work from HR and duration and say plainly which conclusions that limits.

## Your task
Respond with raw JSON only — no markdown fences, no commentary outside the JSON — in exactly this shape:

{
  "headline": "<one sentence, max 100 characters, the verdict on this ride>",
  "executionSummary": "<2-4 sentences on what actually happened in this ride against what was prescribed, citing specific numbers>",
  "whatWentWell": ["<specific, number-backed positives — 0 to 3 items>"],
  "concerns": ["<specific, number-backed concerns — 0 to 3 items>"],
  "progressAssessment": "<3-5 sentences on how the block is going: the aerobic efficiency direction, compliance, load, and whether the goal is still on track. This is the part the client is paying for — be concrete about the trajectory.>",
  "adjustments": [
    {
      "sessionId": "<an ID from Upcoming sessions in the plan — never invent one>",
      "summary": "<one sentence naming the change in coach language>",
      "rationale": "<the specific signal from this ride or the block that drives the change>",
      "changes": { "<one or more of: title, description, durationSecs, targetLoad, intensity>": "<new value>" }
    }
  ],
  "clientMessage": "<3-5 sentences written to the client in second person, ready to send as-is: what you saw in the ride, what it means, what happens next. Plain language, no jargon they would not know.>"
}

Rules:
- adjustments may be empty. Leave it empty when the ride was executed well and the plan still fits — say so in progressAssessment rather than inventing a change.
- Only use session IDs listed under "Upcoming sessions in the plan". Never invent an ID.
- durationSecs is an integer number of seconds; intensity must be one of rest, recovery, endurance, tempo, threshold, vo2max, anaerobic, race, test.
- Every concern and every rationale must cite a number.
- Never hedge. If the data does not support a conclusion, say what is missing instead.`
}
