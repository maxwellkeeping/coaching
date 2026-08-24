import type { PlanSession } from './types'
import type { FitRideSummary as RideSummary } from './fit-analysis'
import { archetypeBand, compareStructures, parsePrescribedStructure, type StructureComparison } from './workout-structure'

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
  /** Whether the ride was the *kind* of session prescribed, judged on its shape. */
  structure: StructureComparison | null
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
      structure: null,
      durationDeltaPct: null,
      loadDeltaPct: null,
      planned: null,
      notes: [
        `No planned session lines up with this ride — it sits outside the plan. The ride itself was ${ride.structure.description.toLowerCase()}.`,
      ],
    }
  }

  // What kind of session was this, against what kind was asked for? This is
  // judged before duration and load, because a rider who did the prescribed
  // over-unders a day late has done the session — and calling that "the wrong
  // workout" on the strength of the calendar is how a coach stops trusting the
  // tool.
  const prescribedStructure = parsePrescribedStructure(session.title, session.description)
  const structure = compareStructures(ride.structure, prescribedStructure)

  const notes: string[] = [...structure.notes]
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
  const structuredAsOverUnder = ride.structure.archetype === 'over-under'
  if (isQuality && !structuredAsOverUnder && ftp && intervals.length > 0) {
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

  // Structure only forces "different session" when the ride was a harder kind
  // of session than asked for, or had no structure at all where intervals were
  // written. Doing the prescribed shape at lower power is not a different
  // session — it is the same session ridden easier, and the rules below say so
  // more usefully. Cutting it short outranks structure either way: once a rider
  // stops early the shape is bound to look wrong, and stopping early is the
  // more informative fact.
  const rideBand = archetypeBand(ride.structure.archetype)
  const prescribedBand = prescribedStructure.archetype ? archetypeBand(prescribedStructure.archetype) : null
  const wrongKind =
    structure.verdict === 'different-structure' &&
    (ride.structure.archetype === 'unstructured' ||
      (rideBand != null && prescribedBand != null && rideBand > prescribedBand))

  if (durationDeltaPct != null && durationDeltaPct <= -25) {
    verdict = 'cut-short'
  } else if (wrongKind) {
    verdict = 'different-session'
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

  if (structure.verdict === 'same-structure' && verdict === 'as-prescribed') {
    notes.unshift('This was the session as written.')
  }

  return {
    verdict,
    structure,
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
