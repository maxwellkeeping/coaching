import { sessionDate, weekOf, daysBetween, addDays } from './plan'
import { parsePrescribedStructure } from './workout-structure'
import type { PlanSession } from './types'
import type { WorkoutArchetype } from './workout-structure'

/** How far either side of a candidate date a ride may sit and still support it. */
const ALIGNMENT_TOLERANCE_DAYS = 1
/** Score for a ride landing on a session whose prescribed shape it matches. */
const SHAPE_MATCH_SCORE = 4
/** Score for a ride landing on a training day whose shape could not be compared. */
const TRAINING_DAY_SCORE = 1
/** Penalty for a ride landing where the plan prescribes nothing at all. */
const OFF_PLAN_PENALTY = 1
/** A candidate must beat the runner-up by this ratio to be called confident. */
const CONFIDENT_MARGIN = 1.35
/** Candidates within this of the best score are, on this evidence, equally good. */
const TIE_BAND = 0.98

export interface RideEvidence {
  date: string
  /** What the ride was, read from its own power. */
  archetype: WorkoutArchetype
  durationSecs: number
}

export interface StartDateCandidate {
  startDate: string
  score: number
  /** Rides that landed on a session whose shape they match. */
  shapeMatches: number
  /** Rides that landed on a training day at all. */
  onTrainingDays: number
}

export interface PlanPositionInference {
  suggestedStart: string | null
  confidence: 'high' | 'medium' | 'low'
  /** How the best candidate scored, and what it explained. */
  best: StartDateCandidate | null
  runnerUp: StartDateCandidate | null
  /**
   * Other start dates the rides fit equally well. A plan whose weeks are alike
   * cannot distinguish a whole-week shift — the rides fit both — and saying so
   * is better than picking one and sounding certain.
   */
  equallyGood: string[]
  ridesConsidered: number
  /** Which week of the plan that start date puts the client in today. */
  currentWeek: number | null
  /** One line a coach can act on. */
  summary: string
}

/**
 * Work out when a plan actually started from the rides that have been uploaded.
 *
 * A plan PDF says "week 1, Tuesday"; the client started on some Monday nobody
 * wrote down. But the rides know: if the over-unders and the long rides line up
 * with the plan's Tuesdays and Saturdays under one start date and scatter under
 * every other, that start date is the answer. This is the inversion of the
 * usual question — instead of asking where a ride falls in the plan, it asks
 * which plan alignment the rides as a whole are evidence for.
 */
export function inferPlanStart(
  rides: RideEvidence[],
  sessions: PlanSession[],
  today: string,
  planWeeks: number | null = null,
  /** The start date currently on file, used only to break a genuine tie. */
  priorStart: string | null = null
): PlanPositionInference {
  const usable = rides.filter(r => r.date)
  const structured = sessions.filter(s => s.intensity !== 'rest')

  if (usable.length === 0 || structured.length === 0) {
    return {
      suggestedStart: null,
      confidence: 'low',
      best: null,
      runnerUp: null,
      equallyGood: [],
      ridesConsidered: usable.length,
      currentWeek: null,
      summary: usable.length === 0
        ? 'No rides uploaded yet — nothing to work the start date out from.'
        : 'The plan has no sessions to align rides against.',
    }
  }

  // Pre-read every session's prescribed shape once.
  const shapes = new Map<string, WorkoutArchetype | null>()
  for (const s of structured) {
    shapes.set(s.id, parsePrescribedStructure(s.title, s.description).archetype)
  }

  const dates = usable.map(r => r.date).sort()
  const earliest = dates[0]
  const latest = dates[dates.length - 1]
  const weeks = planWeeks ?? Math.max(...sessions.map(s => s.week), 1)

  // The plan can have started any time from a full plan-length before the first
  // ride up to the first ride itself.
  const from = addDays(earliest, -(weeks * 7))
  const span = Math.max(1, daysBetween(from, latest))

  const candidates: StartDateCandidate[] = []
  for (let offset = 0; offset <= span; offset++) {
    const startDate = addDays(from, offset)

    // Index this alignment's sessions by date.
    const byDate = new Map<string, PlanSession[]>()
    for (const s of structured) {
      const date = sessionDate(startDate, s.week, s.dayOfWeek)
      const bucket = byDate.get(date)
      if (bucket) bucket.push(s)
      else byDate.set(date, [s])
    }

    let score = 0
    let shapeMatches = 0
    let onTrainingDays = 0

    for (const ride of usable) {
      let bestForRide = -OFF_PLAN_PENALTY
      let matchedShape = false
      let matchedDay = false

      for (let d = -ALIGNMENT_TOLERANCE_DAYS; d <= ALIGNMENT_TOLERANCE_DAYS; d++) {
        const near = byDate.get(addDays(ride.date, d)) ?? []
        for (const s of near) {
          // A ride sitting exactly on its day is better evidence than one a day off.
          const proximity = d === 0 ? 1 : 0.6
          const shape = shapes.get(s.id)
          const value = shape && shape === ride.archetype
            ? SHAPE_MATCH_SCORE * proximity
            : TRAINING_DAY_SCORE * proximity
          if (value > bestForRide) {
            bestForRide = value
            matchedShape = shape != null && shape === ride.archetype
            matchedDay = true
          }
        }
      }

      score += bestForRide
      if (matchedShape) shapeMatches++
      if (matchedDay) onTrainingDays++
    }

    candidates.push({ startDate, score: +score.toFixed(2), shapeMatches, onTrainingDays })
  }

  candidates.sort((a, b) => b.score - a.score || a.startDate.localeCompare(b.startDate))
  const topScore = candidates[0].score

  // Everything within the tie band fits the rides equally well. Distinct
  // alignments among them are the real alternatives; dates a day or two apart
  // are the same alignment blurred by the tolerance.
  const tied = candidates.filter(c => c.score >= topScore * TIE_BAND)
  const distinct: StartDateCandidate[] = []
  for (const c of tied) {
    if (!distinct.some(d => Math.abs(daysBetween(d.startDate, c.startDate)) <= 3)) distinct.push(c)
  }

  // Several consecutive start dates put the plan's sessions on exactly the same
  // days — a plan referencing only Tuesdays and Saturdays cannot say whether
  // the block began on the Monday or the Friday before. The plan's own layout
  // settles it: a plan whose first week has a Monday entry starts on a Monday.
  const firstWeek = sessions.filter(s => s.week === Math.min(...sessions.map(x => x.week)))
  const planFirstDay = firstWeek.length > 0 ? Math.min(...firstWeek.map(s => s.dayOfWeek)) : null
  const weekdayOf = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay() || 7

  const rank = (c: StartDateCandidate): number[] => [
    planFirstDay != null && weekdayOf(c.startDate) === planFirstDay ? 0 : 1,
    priorStart ? Math.abs(daysBetween(priorStart, c.startDate)) : 0,
  ]

  const best = [...tied].sort((a, b) => {
    const [ra, rb] = [rank(a), rank(b)]
    for (let i = 0; i < ra.length; i++) {
      if (ra[i] !== rb[i]) return ra[i] - rb[i]
    }
    // All else equal, assume the plan began around when the uploads did rather
    // than that whole weeks at the start were silently skipped.
    return b.startDate.localeCompare(a.startDate)
  })[0]

  // The runner-up must be a genuinely different alignment, not the same one
  // shifted by a day — a plan is a weekly pattern, so neighbouring dates score
  // similarly by construction and comparing against them proves nothing.
  const runnerUp = candidates.find(c => Math.abs(daysBetween(best.startDate, c.startDate)) > 3) ?? null
  const equallyGood = distinct
    .filter(c => Math.abs(daysBetween(best.startDate, c.startDate)) > 3)
    .map(c => c.startDate)

  const decisive = runnerUp == null || runnerUp.score <= 0
    ? best.score > 0
    : best.score >= runnerUp.score * CONFIDENT_MARGIN

  // Never claim high confidence while another alignment fits just as well.
  const confidence: PlanPositionInference['confidence'] =
    equallyGood.length > 0
      ? (best.shapeMatches >= 2 ? 'medium' : 'low')
      : best.shapeMatches >= 2 && decisive ? 'high'
      : best.onTrainingDays >= Math.ceil(usable.length / 2) && decisive ? 'medium'
      : 'low'

  const currentWeek = weekOf(best.startDate, today, planWeeks)

  return {
    suggestedStart: best.startDate,
    confidence,
    best,
    runnerUp,
    equallyGood,
    ridesConsidered: usable.length,
    currentWeek,
    summary:
      `A ${best.startDate} start lines up ${best.onTrainingDays} of ${usable.length} uploaded rides with training days` +
      (best.shapeMatches > 0 ? `, ${best.shapeMatches} of them matching the prescribed session's shape` : '') +
      (currentWeek != null ? `. That puts them in week ${currentWeek}${planWeeks ? ` of ${planWeeks}` : ''}.` : '.') +
      (equallyGood.length > 0
        ? ` The plan's weeks are alike enough that ${equallyGood.slice(0, 2).join(' and ')} fit the same rides just as well — confirm which is right.`
        : ''),
  }
}

export interface PlanPosition {
  week: number | null
  weeks: number | null
  /** Sessions in the current week, in plan order. */
  thisWeek: PlanSession[]
  nextSession: PlanSession | null
  /** Days from today to the goal, when there is one. */
  daysToGoal: number | null
  /** Sessions prescribed before today that no upload accounts for. */
  missedSessions: PlanSession[]
}

/**
 * Where the client is in the plan right now, and what the plan says is next.
 *
 * Missed sessions are counted against uploaded ride dates rather than against
 * matched session IDs: a session the client rode but never sent you a file for
 * is not evidence they skipped it, and reporting it as missed would be worse
 * than saying nothing.
 */
export function planPosition(
  sessions: PlanSession[],
  startDate: string | null,
  planWeeks: number | null,
  rideDates: string[],
  today: string,
  goalDate: string | null = null
): PlanPosition {
  const week = startDate ? weekOf(startDate, today, planWeeks) : null
  const dated = sessions.filter(s => s.date != null)
  const uploads = new Set(rideDates)

  const missedSessions = dated.filter(s =>
    s.intensity !== 'rest' &&
    s.date! < today &&
    ![-1, 0, 1].some(d => uploads.has(addDays(s.date!, d)))
  )

  return {
    week,
    weeks: planWeeks,
    thisWeek: week != null ? sessions.filter(s => s.week === week) : [],
    nextSession: dated.find(s => s.date! >= today && s.intensity !== 'rest') ?? null,
    daysToGoal: goalDate ? daysBetween(today, goalDate) : null,
    missedSessions,
  }
}
