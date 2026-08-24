import { INTENSITIES } from './plan'
import type { SessionIntensity } from './types'

/** A session as it comes back from the PDF extraction pass, before it is saved. */
export interface ExtractedSession {
  week: number
  dayOfWeek: number
  title: string
  description: string | null
  sport: string | null
  durationSecs: number | null
  targetLoad: number | null
  intensity: SessionIntensity
  sourceText: string | null
}

export interface ExtractedPlan {
  planName: string | null
  weeks: number
  /** A start date only when the PDF states one outright — otherwise the coach supplies it. */
  startDate: string | null
  sessions: ExtractedSession[]
  /** Anything the extraction could not read cleanly, surfaced to the coach for review. */
  warnings: string[]
}

export class PlanExtractionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PlanExtractionError'
  }
}

const DAY_NAMES = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']

export const PLAN_EXTRACTION_PROMPT = `You are reading a cycling training plan from a PDF and turning it into structured data.

Extract every prescribed session in the plan. Work week by week, and within each week day by day.

Respond with raw JSON only — no markdown fences, no commentary outside the JSON — in exactly this shape:

{
  "planName": "<the plan's title, or null>",
  "weeks": <total number of weeks in the plan, as an integer>,
  "startDate": "<YYYY-MM-DD if the PDF states an actual start date, otherwise null>",
  "sessions": [
    {
      "week": <1-based week number>,
      "dayOfWeek": <1 = Monday through 7 = Sunday>,
      "title": "<short session name, e.g. 'Threshold 3x12' or 'Long endurance ride'>",
      "description": "<the full prescription: intervals, targets, cadence, notes. null if the plan gives none>",
      "sport": "<cycling | running | swimming | strength | other, or null>",
      "durationSecs": <planned duration in seconds, or null if not stated>,
      "targetLoad": <planned TSS if the plan states one, otherwise null>,
      "intensity": "<one of: rest, recovery, endurance, tempo, threshold, vo2max, anaerobic, race, test, unknown>",
      "sourceText": "<the raw text this session was read from, so the coach can check it against the PDF>"
    }
  ],
  "warnings": ["<anything ambiguous, unreadable, or assumed — one short sentence each>"]
}

Rules:
- Include rest days as sessions with intensity "rest" and a null duration. A plan's rest days are part of the prescription.
- Convert every duration to seconds. "1h30" is 5400. "90 min" is 5400. A distance-only prescription has a null duration — note it in warnings.
- Never invent a session that is not in the PDF. If a week is listed with no detail, emit what is there and add a warning.
- If the plan uses dates rather than week numbers, still emit week and dayOfWeek, counting the first week in the plan as week 1, and put the stated start date in startDate.
- intensity is your read of the session's hardest sustained work, not its average.
- If the document is not a training plan at all, return {"planName": null, "weeks": 0, "sessions": [], "warnings": ["<what the document appears to be instead>"]}.`

function asInt(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && isFinite(n) ? Math.round(n) : null
}

function asIntensity(v: unknown): SessionIntensity {
  return typeof v === 'string' && (INTENSITIES as string[]).includes(v.toLowerCase())
    ? v.toLowerCase() as SessionIntensity
    : 'unknown'
}

function asDayOfWeek(v: unknown): number | null {
  const n = asInt(v)
  if (n != null && n >= 1 && n <= 7) return n
  if (typeof v === 'string') {
    const i = DAY_NAMES.indexOf(v.trim().toLowerCase())
    if (i >= 0) return i + 1
  }
  return null
}

function asDate(v: unknown): string | null {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? v.trim() : null
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null
}

/**
 * Validate and normalise the extraction response.
 *
 * The model is asked for a strict shape but a plan PDF is messy input, so every
 * field is coerced and anything unusable is dropped into warnings rather than
 * thrown away silently — the coach reviews this before it becomes their plan.
 */
export function parseExtractedPlan(text: string): ExtractedPlan {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim()

  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(cleaned) as Record<string, unknown>
  } catch {
    throw new PlanExtractionError('Could not read the plan from that PDF — the extraction response was not valid JSON.')
  }

  const warnings = Array.isArray(raw.warnings)
    ? raw.warnings.filter((w): w is string => typeof w === 'string')
    : []

  const rawSessions = Array.isArray(raw.sessions) ? raw.sessions as Array<Record<string, unknown>> : []
  const sessions: ExtractedSession[] = []
  let dropped = 0

  for (const s of rawSessions) {
    const week = asInt(s.week)
    const dayOfWeek = asDayOfWeek(s.dayOfWeek)
    const title = str(s.title)
    if (week == null || week < 1 || dayOfWeek == null || !title) {
      dropped++
      continue
    }
    const duration = asInt(s.durationSecs)
    sessions.push({
      week,
      dayOfWeek,
      title,
      description: str(s.description),
      sport: str(s.sport),
      durationSecs: duration != null && duration > 0 ? duration : null,
      targetLoad: asInt(s.targetLoad),
      intensity: asIntensity(s.intensity),
      sourceText: str(s.sourceText),
    })
  }

  if (dropped > 0) {
    warnings.push(`${dropped} session${dropped === 1 ? '' : 's'} could not be read and ${dropped === 1 ? 'was' : 'were'} skipped — check the PDF against the extracted plan.`)
  }

  sessions.sort((a, b) => a.week - b.week || a.dayOfWeek - b.dayOfWeek)

  const statedWeeks = asInt(raw.weeks)
  const impliedWeeks = sessions.length > 0 ? Math.max(...sessions.map(s => s.week)) : 0
  const weeks = Math.max(statedWeeks ?? 0, impliedWeeks)

  if (statedWeeks != null && impliedWeeks > 0 && statedWeeks !== impliedWeeks) {
    warnings.push(`The plan says ${statedWeeks} weeks but sessions were found across ${impliedWeeks} — using ${weeks}.`)
  }

  return {
    planName: str(raw.planName),
    weeks,
    startDate: asDate(raw.startDate),
    sessions,
    warnings,
  }
}
