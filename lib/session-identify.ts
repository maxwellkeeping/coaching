import type { PlanSession } from './types'
import type { FitRideSummary } from './fit-analysis'

export interface IdentifyCandidate {
  id: string
  date: string | null
  title: string
  description: string | null
  durationSecs: number | null
  targetLoad: number | null
  intensity: string
}

export interface Identification {
  /** The session this ride is, or null when none of them is. */
  sessionId: string | null
  confidence: 'high' | 'medium' | 'low'
  /** Why, in one line, in terms of the shape — shown to the coach. */
  reasoning: string
}

function mins(secs: number | null): string {
  if (secs == null) return 'not stated'
  const m = Math.round(secs / 60)
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}` : `${m}min`
}

/**
 * Ask which planned session a ride is, given its shape and the plan.
 *
 * This is a matching problem, not a classification one. Naming the ride and
 * then string-matching that name against the plan's wording was two lossy steps
 * where a coach does one: look at the intervals, look at the plan, see which
 * session it is. The segment table is measured deterministically; only the
 * match is judged here.
 */
export function buildIdentifyPrompt(
  ride: FitRideSummary,
  rideDate: string | null,
  candidates: IdentifyCandidate[]
): string {
  const list = candidates
    .map(c =>
      `ID: ${c.id}\n  Date: ${c.date ?? 'unscheduled'}\n  Title: ${c.title}\n  Prescription: ${c.description ?? '(none given)'}\n  Planned duration: ${mins(c.durationSecs)}${c.targetLoad != null ? `\n  Target TSS: ${c.targetLoad}` : ''}`
    )
    .join('\n\n')

  const a = ride.analysis

  return `A cycling coach uploaded a ride file for a client. Work out which session in the client's plan this ride is.

## The ride${rideDate ? `, recorded ${rideDate}` : ''}
Total duration: ${mins(a.durationSecs)}
Average power: ${a.power.avgWatts ?? 'n/a'}W, normalized ${a.power.normalizedPower ?? 'n/a'}W
Average HR: ${a.hr.avgHr ?? 'n/a'}bpm

### Segment by segment, read straight from the power trace
${ride.structure.segmentSummary}

These segments are measured from the file, not inferred. "3 × (2min @ 262W, 2min @ 224W)" means the rider
alternated between those two power levels three times in a row.

## Sessions in the plan, near this date
${list}

## Your task
Match the ride's interval structure to the prescription it fits. This is what a coach does by eye: read the
shape off the graph, read the sessions in the plan, and see which one it is.

Judge on structure first. Specifically:
- The number of efforts and how long each ran.
- Whether power alternated between two working levels (an over-under) or held one level (a straight interval).
- The work-to-rest pattern.

Then use these to break ties, never to overrule structure:
- Total duration against the planned duration.
- The date, which is the weakest signal of all. Riders move sessions by a day or two constantly. A ride whose
  structure plainly matches Tuesday's prescription is Tuesday's session, even if it was ridden on Thursday.

Say the ride matches no session only when its structure genuinely fits none of them — not merely because the
date is off, and not because the prescription's wording is vague. If a prescription describes alternating
efforts in any wording at all and the ride shows alternating efforts of about that length, that is the match.

Respond with raw JSON only — no markdown fences, no commentary:

{
  "sessionId": "<the ID of the matching session, or null if genuinely none match>",
  "confidence": "<high | medium | low>",
  "reasoning": "<one sentence naming the structural evidence, e.g. 'Three blocks of 12min alternating 2min at 262W with 2min at 224W matches the 3x12 over-unders prescribed for Tuesday.'>"
}`
}

/** Validate the identification against the candidates actually offered. */
export function parseIdentification(text: string, candidates: IdentifyCandidate[]): Identification {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim()

  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(cleaned) as Record<string, unknown>
  } catch {
    return { sessionId: null, confidence: 'low', reasoning: 'The identification response could not be read.' }
  }

  const id = typeof raw.sessionId === 'string' ? raw.sessionId : null
  // A session ID that was never offered is a hallucination, not a match.
  const sessionId = id && candidates.some(c => c.id === id) ? id : null

  const confidence = raw.confidence === 'high' || raw.confidence === 'medium' || raw.confidence === 'low'
    ? raw.confidence
    : 'low'

  return {
    sessionId,
    confidence,
    reasoning: typeof raw.reasoning === 'string' && raw.reasoning.trim()
      ? raw.reasoning.trim()
      : sessionId
        ? 'Matched on interval structure.'
        : 'No session in the plan matches this ride’s structure.',
  }
}

/** Sessions worth offering as candidates: real sessions near the ride, plus the whole plan week. */
export function candidatesFor(sessions: PlanSession[], rideDate: string | null, windowDays = 10): IdentifyCandidate[] {
  const toCandidate = (s: PlanSession): IdentifyCandidate => ({
    id: s.id,
    date: s.date,
    title: s.title,
    description: s.description,
    durationSecs: s.durationSecs,
    targetLoad: s.targetLoad,
    intensity: s.intensity,
  })

  const real = sessions.filter(s => s.intensity !== 'rest')
  if (!rideDate) return real.slice(0, 20).map(toCandidate)

  const within = real.filter(s => {
    if (!s.date) return false
    const gap = Math.abs(
      (new Date(`${s.date}T12:00:00Z`).getTime() - new Date(`${rideDate}T12:00:00Z`).getTime()) / 86400000
    )
    return gap <= windowDays
  })

  return within.map(toCandidate)
}
