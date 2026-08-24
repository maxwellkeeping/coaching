import type { PlanSession, SessionIntensity } from './types'
import { compareStructures, parsePrescribedStructure, type RideStructure } from './workout-structure'

export const INTENSITIES: SessionIntensity[] = [
  'rest', 'recovery', 'endurance', 'tempo', 'threshold', 'vo2max', 'anaerobic', 'race', 'test', 'unknown',
]

/** Days a session may sit either side of a ride and still be considered its match. */
export const MATCH_TOLERANCE_DAYS = 1
/** How far to look for a session whose *shape* matches the ride, when dates alone do not. */
export const STRUCTURE_MATCH_WINDOW_DAYS = 4

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().split('T')[0]
}

export function daysBetween(a: string, b: string): number {
  const ms = new Date(`${b}T12:00:00Z`).getTime() - new Date(`${a}T12:00:00Z`).getTime()
  return Math.round(ms / 86400000)
}

/**
 * Resolve a week/day slot to a calendar date.
 *
 * Plan PDFs are written in weeks and weekdays, never dates, so the coach
 * supplies the start date and everything hangs off it. Week 1 day 1 is the
 * start date itself; the plan's week boundary follows the start date's weekday
 * rather than assuming plans begin on a Monday.
 */
export function sessionDate(startDate: string, week: number, dayOfWeek: number): string {
  const startDow = new Date(`${startDate}T12:00:00Z`).getUTCDay() || 7  // Sunday 0 → 7
  const offsetWithinWeek = (dayOfWeek - startDow + 7) % 7
  return addDays(startDate, (week - 1) * 7 + offsetWithinWeek)
}

/** Fill in every session's date from the plan start date. */
export function resolveDates<T extends { week: number; dayOfWeek: number }>(
  sessions: T[],
  startDate: string | null
): Array<T & { date: string | null }> {
  return sessions.map(s => ({
    ...s,
    date: startDate ? sessionDate(startDate, s.week, s.dayOfWeek) : null,
  }))
}

/**
 * Find the planned session a completed ride belongs to.
 *
 * An exact date match always wins. Failing that, a session within
 * MATCH_TOLERANCE_DAYS is accepted — riders routinely shift a session by a day
 * — preferring the nearest, and the earlier one on a tie, since a session done
 * late is far more common than one done early.
 */
export function matchSession<T extends PlanSession>(sessions: T[], rideDate: string): T | null {
  const dated = sessions.filter(s => s.date != null && s.intensity !== 'rest')
  const exact = dated.find(s => s.date === rideDate)
  if (exact) return exact

  const near = dated
    .map(s => ({ s, gap: daysBetween(s.date!, rideDate) }))
    .filter(x => Math.abs(x.gap) <= MATCH_TOLERANCE_DAYS)
    // Nearest first; on a tie prefer the earlier session, since a rider is far
    // more likely to have done a session a day late than a day early.
    .sort((a, b) => Math.abs(a.gap) - Math.abs(b.gap) || b.gap - a.gap)

  return near.length > 0 ? near[0].s : null
}

/** Which plan week a date falls in — 1-based, null when outside the plan. */
export function weekOf(startDate: string, date: string, weeks: number | null): number | null {
  const offset = daysBetween(startDate, date)
  if (offset < 0) return null
  const week = Math.floor(offset / 7) + 1
  if (weeks != null && week > weeks) return null
  return week
}

/**
 * Match a ride to its session using what was actually ridden, not just the date.
 *
 * Riders move sessions. Matching on the calendar alone means an over-under done
 * on Wednesday instead of Tuesday is scored against Wednesday's endurance ride
 * and reported as the wrong workout — the single most misleading thing this app
 * can tell a coach. So: take the date match when the shapes agree, and
 * otherwise look through the week for the session whose prescription this ride
 * actually is.
 */
export function matchSessionByStructure<T extends PlanSession>(
  sessions: T[],
  rideDate: string,
  structure: RideStructure
): { session: T | null; movedFrom: string | null } {
  const byDate = matchSession(sessions, rideDate)

  if (byDate) {
    const agreement = compareStructures(structure, parsePrescribedStructure(byDate.title, byDate.description))
    if (agreement.verdict !== 'different-structure') return { session: byDate, movedFrom: null }
  }

  if (!structure.classifiable) return { session: byDate, movedFrom: null }

  const candidates = sessions
    .filter(s => s.date != null && s.intensity !== 'rest' && s.id !== byDate?.id)
    .map(s => ({ s, gap: daysBetween(s.date!, rideDate) }))
    .filter(x => Math.abs(x.gap) <= STRUCTURE_MATCH_WINDOW_DAYS)
    .sort((a, b) => Math.abs(a.gap) - Math.abs(b.gap) || b.gap - a.gap)

  for (const { s } of candidates) {
    const agreement = compareStructures(structure, parsePrescribedStructure(s.title, s.description))
    if (agreement.verdict === 'same-structure') {
      return { session: s, movedFrom: s.date }
    }
  }

  return { session: byDate, movedFrom: null }
}
