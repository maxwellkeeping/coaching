import type { PlanSession } from './types'
import type { FitRideSummary as RideSummary } from './fit-analysis'

/** Duration inside this band of the prescription counts as hitting it. */
export const DURATION_TOLERANCE_PCT = 10
/** Load (TSS) inside this band counts as hitting the prescription. */
export const LOAD_TOLERANCE_PCT = 15
/** An intensity session is "soft" when its hardest sustained work lands this far below target. */
export const INTENSITY_SHORTFALL_PCT = 8

export type ComplianceVerdict =
  | 'as-prescribed'
  | 'harder-than-prescribed'
  | 'easier-than-prescribed'
  | 'cut-short'
  | 'different-session'
  | 'unplanned'

export interface PlanComparison {
  verdict: ComplianceVerdict
  /** Positive = rode longer than prescribed. Null when the plan gave no duration. */
  durationDeltaPct: number | null
  /** Positive = more load than prescribed. Null when the plan gave no target. */
  loadDeltaPct: number | null
  planned: {
    title: string
    date: string | null
    durationSecs: number | null
    targetLoad: number | null
    intensity: string
  } | null
  /** Plain-language points a coach would raise, each backed by a number. */
  notes: string[]
}

function pctDelta(actual: number, planned: number): number {
  return +(((actual - planned) / planned) * 100).toFixed(1)
}

function mins(secs: number): string {
  const m = Math.round(secs / 60)
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}` : `${m}min`
}

/** Intensity bands that are about hitting a power target, not about accumulating time. */
const QUALITY_INTENSITIES = new Set(['threshold', 'vo2max', 'anaerobic', 'tempo', 'race', 'test'])

/**
 * Compare a completed ride against the session it was meant to be.
 *
 * The verdict leans on duration and load first because those are what a plan
 * actually prescribes. Intensity only overrides them for quality sessions,
 * where riding the right time at the wrong power is the failure that matters —
 * on an endurance ride the reverse is true, and going too hard is the fault.
 */
export function compareToPlan(
  ride: RideSummary,
  session: PlanSession | null,
  ftp: number | null
): PlanComparison {
  if (!session) {
    return {
      verdict: 'unplanned',
      durationDeltaPct: null,
      loadDeltaPct: null,
      planned: null,
      notes: ['No planned session lines up with this ride — it sits outside the plan.'],
    }
  }

  const notes: string[] = []
  const actualSecs = ride.analysis.durationSecs
  const durationDeltaPct = session.durationSecs && session.durationSecs > 0
    ? pctDelta(actualSecs, session.durationSecs)
    : null
  const loadDeltaPct = session.targetLoad && session.targetLoad > 0 && ride.tss != null
    ? pctDelta(ride.tss, session.targetLoad)
    : null

  if (durationDeltaPct != null) {
    notes.push(
      `Rode ${mins(actualSecs)} against ${mins(session.durationSecs!)} prescribed (${durationDeltaPct > 0 ? '+' : ''}${durationDeltaPct}%).`
    )
  }
  if (loadDeltaPct != null) {
    notes.push(`TSS ${ride.tss} against a ${session.targetLoad} target (${loadDeltaPct > 0 ? '+' : ''}${loadDeltaPct}%).`)
  }

  const isQuality = QUALITY_INTENSITIES.has(session.intensity)
  const intervals = ride.analysis.intervals ?? []

  // For a quality session, the question is whether the work intervals landed on
  // target — a rider can complete every minute prescribed and still miss the
  // session entirely by riding the efforts 15% under.
  let intensityShortfall: number | null = null
  if (isQuality && ftp && intervals.length > 0) {
    const pcts = intervals.map(i => i.pctFtp).filter((p): p is number => p != null)
    if (pcts.length > 0) {
      const avgPctFtp = pcts.reduce((s, p) => s + p, 0) / pcts.length
      const target = targetPctFtp(session.intensity)
      if (target != null) {
        intensityShortfall = +(target - avgPctFtp).toFixed(1)
        notes.push(
          `Work intervals averaged ${Math.round(avgPctFtp)}% FTP against roughly ${target}% for a ${session.intensity} session.`
        )
      }
    }
  }

  let verdict: ComplianceVerdict = 'as-prescribed'

  if (durationDeltaPct != null && durationDeltaPct <= -25) {
    verdict = 'cut-short'
  } else if (isQuality && intensityShortfall != null && intensityShortfall >= INTENSITY_SHORTFALL_PCT) {
    verdict = 'easier-than-prescribed'
  } else if (loadDeltaPct != null && loadDeltaPct > LOAD_TOLERANCE_PCT) {
    verdict = 'harder-than-prescribed'
  } else if (loadDeltaPct != null && loadDeltaPct < -LOAD_TOLERANCE_PCT) {
    verdict = 'easier-than-prescribed'
  } else if (durationDeltaPct != null && durationDeltaPct > DURATION_TOLERANCE_PCT) {
    verdict = 'harder-than-prescribed'
  } else if (durationDeltaPct != null && durationDeltaPct < -DURATION_TOLERANCE_PCT) {
    verdict = 'easier-than-prescribed'
  }

  // An easy day ridden hard is its own failure, and one a load target alone can miss.
  if (
    (session.intensity === 'recovery' || session.intensity === 'endurance') &&
    ftp && ride.analysis.power.normalizedPower != null &&
    ride.analysis.power.normalizedPower / ftp > 0.8
  ) {
    verdict = 'harder-than-prescribed'
    notes.push(
      `NP ${ride.analysis.power.normalizedPower}W is ${Math.round((ride.analysis.power.normalizedPower / ftp) * 100)}% of FTP on a day prescribed as ${session.intensity} — the easy day was not easy.`
    )
  }

  if (session.intensity === 'rest' && actualSecs > 600) {
    verdict = 'different-session'
    notes.push(`This was a prescribed rest day; ${mins(actualSecs)} was ridden instead.`)
  }

  return {
    verdict,
    durationDeltaPct,
    loadDeltaPct,
    planned: {
      title: session.title,
      date: session.date,
      durationSecs: session.durationSecs,
      targetLoad: session.targetLoad,
      intensity: session.intensity,
    },
    notes,
  }
}

/** Rough mid-band %FTP a session of each intensity is ridden at. */
export function targetPctFtp(intensity: string): number | null {
  switch (intensity) {
    case 'recovery': return 50
    case 'endurance': return 65
    case 'tempo': return 82
    case 'threshold': return 95
    case 'vo2max': return 110
    case 'anaerobic': return 130
    default: return null
  }
}
