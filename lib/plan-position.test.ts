import { describe, it, expect } from 'vitest'
import { inferPlanStart, planPosition, type RideEvidence } from './plan-position'
import { resolveDates } from './plan'
import type { PlanSession } from './types'

/**
 * A three-week plan whose weeks differ, as real blocks do: week 1 builds with
 * sweet spot, week 2 goes to over-unders and VO2, week 3 is a recovery week.
 * Weeks that differ are what make a start date identifiable at all.
 */
function plan(startDate: string | null = null): PlanSession[] {
  const byWeek: Record<number, Array<{ dayOfWeek: number; title: string; description: string | null; intensity: PlanSession['intensity'] }>> = {
    1: [
      { dayOfWeek: 2, title: 'Sweet spot 3x15', description: '3x15min @ 90% FTP', intensity: 'tempo' },
      { dayOfWeek: 4, title: 'Tempo 2x20', description: '2x20min tempo', intensity: 'tempo' },
      { dayOfWeek: 6, title: 'Long endurance', description: '3h steady Z2', intensity: 'endurance' },
      { dayOfWeek: 1, title: 'Rest', description: null, intensity: 'rest' },
    ],
    2: [
      { dayOfWeek: 2, title: 'Over-unders 3x12', description: '3x12min over/under', intensity: 'threshold' },
      { dayOfWeek: 4, title: 'VO2max 5x4', description: '5x4min @ 115% FTP', intensity: 'vo2max' },
      { dayOfWeek: 6, title: 'Long endurance', description: '3h steady Z2', intensity: 'endurance' },
      { dayOfWeek: 1, title: 'Rest', description: null, intensity: 'rest' },
    ],
    3: [
      { dayOfWeek: 3, title: 'Recovery spin', description: '45min easy', intensity: 'recovery' },
      { dayOfWeek: 6, title: 'Easy endurance', description: '90min Z2', intensity: 'endurance' },
      { dayOfWeek: 1, title: 'Rest', description: null, intensity: 'rest' },
    ],
  }
  const raw = [1, 2, 3].flatMap(week =>
    byWeek[week].map(t => ({
      id: `w${week}d${t.dayOfWeek}`,
      plan_id: 'p1', client_id: 'c1',
      week, dayOfWeek: t.dayOfWeek, date: null as string | null,
      title: t.title, description: t.description, sport: 'cycling',
      durationSecs: 3600, targetLoad: null, intensity: t.intensity, sourceText: null,
    }))
  )
  return resolveDates(raw, startDate) as PlanSession[]
}

const ride = (date: string, archetype: string, durationSecs = 3600): RideEvidence =>
  ({ date, archetype, durationSecs }) as RideEvidence

describe('inferPlanStart', () => {
  it('works out the start date from rides that line up with the plan’s shapes', () => {
    // A Monday 2026-09-07 start. Week 1 is sweet spot / tempo; week 2 is
    // over-unders / VO2. Only one alignment explains rides in that order.
    const sessions = plan('2026-09-07')
    const rides = [
      ride('2026-09-08', 'sweet-spot'),
      ride('2026-09-10', 'tempo'),
      ride('2026-09-12', 'endurance'),
      ride('2026-09-15', 'over-under'),
      ride('2026-09-17', 'vo2max'),
    ]
    const result = inferPlanStart(rides, sessions, '2026-09-18', 3)
    expect(result.suggestedStart).toBe('2026-09-07')
    expect(result.confidence).toBe('high')
    expect(result.best?.shapeMatches).toBeGreaterThanOrEqual(4)
    expect(result.currentWeek).toBe(2)
    expect(result.summary).toContain('week 2 of 3')
  })

  it('corrects a plan whose saved dates are a week out', () => {
    // The plan on file thinks it began 2026-08-31; the rides say a week later.
    const sessions = plan('2026-08-31')
    const rides = [
      ride('2026-09-08', 'sweet-spot'),
      ride('2026-09-10', 'tempo'),
      ride('2026-09-12', 'endurance'),
      ride('2026-09-15', 'over-under'),
      ride('2026-09-17', 'vo2max'),
    ]
    const result = inferPlanStart(rides, sessions, '2026-09-18', 3, '2026-08-31')
    expect(result.suggestedStart).toBe('2026-09-07')
  })

  it('still finds the alignment when a session was ridden a day late', () => {
    const sessions = plan('2026-09-07')
    const rides = [
      ride('2026-09-09', 'sweet-spot'),   // Tuesday's session, ridden Wednesday
      ride('2026-09-10', 'tempo'),
      ride('2026-09-12', 'endurance'),
      ride('2026-09-15', 'over-under'),
    ]
    expect(inferPlanStart(rides, sessions, '2026-09-16', 3).suggestedStart).toBe('2026-09-07')
  })

  it('admits when identical weeks make a whole-week shift indistinguishable', () => {
    // Every week the same: the rides fit a start seven days earlier just as well.
    const uniform = resolveDates(
      [1, 2, 3].flatMap(week => ([
        { id: `u${week}a`, plan_id: 'p', client_id: 'c', week, dayOfWeek: 2, date: null,
          title: 'Over-unders 3x12', description: '3x12min over/under', sport: 'cycling',
          durationSecs: 3600, targetLoad: null, intensity: 'threshold' as const, sourceText: null },
        { id: `u${week}b`, plan_id: 'p', client_id: 'c', week, dayOfWeek: 6, date: null,
          title: 'Long endurance', description: '3h Z2', sport: 'cycling',
          durationSecs: 10800, targetLoad: null, intensity: 'endurance' as const, sourceText: null },
      ])),
      '2026-09-07'
    ) as PlanSession[]

    const result = inferPlanStart(
      [ride('2026-09-08', 'over-under'), ride('2026-09-12', 'endurance')],
      uniform, '2026-09-14', 3
    )
    expect(result.equallyGood.length).toBeGreaterThan(0)
    expect(result.confidence).not.toBe('high')
    expect(result.summary).toContain('fit the same rides just as well')
  })

  it('keeps the date already on file when the rides do not contradict it', () => {
    const uniform = plan('2026-09-07')
    const result = inferPlanStart(
      [ride('2026-09-08', 'sweet-spot'), ride('2026-09-12', 'endurance')],
      uniform, '2026-09-14', 3, '2026-09-07'
    )
    expect(result.suggestedStart).toBe('2026-09-07')
  })

  it('reports low confidence from a single ride', () => {
    const result = inferPlanStart([ride('2026-09-08', 'over-under')], plan('2026-09-07'), '2026-09-09', 3)
    expect(result.confidence).toBe('low')
  })

  it('says so plainly when there are no rides to go on', () => {
    const result = inferPlanStart([], plan('2026-09-07'), '2026-09-09', 3)
    expect(result.suggestedStart).toBeNull()
    expect(result.summary).toContain('No rides uploaded yet')
  })

  it('handles a plan with no sessions', () => {
    const result = inferPlanStart([ride('2026-09-08', 'over-under')], [], '2026-09-09', 3)
    expect(result.suggestedStart).toBeNull()
    expect(result.confidence).toBe('low')
  })

  it('does not claim confidence from rides that match no shape', () => {
    const sessions = plan('2026-09-07')
    const rides = [ride('2026-09-08', 'sprints'), ride('2026-09-11', 'sprints')]
    const result = inferPlanStart(rides, sessions, '2026-09-11', 3)
    expect(result.confidence).not.toBe('high')
  })
})

describe('planPosition', () => {
  const sessions = plan('2026-09-07')

  it('reports the current week and what is next', () => {
    const position = planPosition(sessions, '2026-09-07', 3, [], '2026-09-16', '2026-10-10')
    expect(position.week).toBe(2)
    expect(position.thisWeek.length).toBe(4)
    expect(position.nextSession?.title).toBe('VO2max 5x4')
    expect(position.daysToGoal).toBe(24)
  })

  it('counts a session with no upload near it as missed', () => {
    const position = planPosition(sessions, '2026-09-07', 3, ['2026-09-08'], '2026-09-16')
    const missed = position.missedSessions.map(s => s.date)
    expect(missed).not.toContain('2026-09-08')   // uploaded
    expect(missed).toContain('2026-09-10')       // no upload
  })

  it('credits a session uploaded a day either side of its date', () => {
    const position = planPosition(sessions, '2026-09-07', 3, ['2026-09-09'], '2026-09-16')
    expect(position.missedSessions.map(s => s.date)).not.toContain('2026-09-08')
  })

  it('never counts rest days as missed', () => {
    const position = planPosition(sessions, '2026-09-07', 3, [], '2026-09-16')
    expect(position.missedSessions.every(s => s.intensity !== 'rest')).toBe(true)
  })

  it('degrades to nothing useful rather than guessing with no start date', () => {
    const position = planPosition(plan(null), null, 3, [], '2026-09-16')
    expect(position.week).toBeNull()
    expect(position.thisWeek).toEqual([])
    expect(position.nextSession).toBeNull()
  })
})
