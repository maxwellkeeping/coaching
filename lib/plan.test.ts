import { describe, it, expect } from 'vitest'
import { sessionDate, resolveDates, matchSession, weekOf, daysBetween, addDays } from './plan'
import type { PlanSession } from './types'

function session(partial: Partial<PlanSession> & { week: number; dayOfWeek: number }): PlanSession {
  return {
    id: `s${partial.week}-${partial.dayOfWeek}`,
    plan_id: 'p1',
    client_id: 'c1',
    date: null,
    title: 'Session',
    description: null,
    sport: 'cycling',
    durationSecs: 3600,
    targetLoad: null,
    intensity: 'endurance',
    sourceText: null,
    ...partial,
  }
}

describe('date helpers', () => {
  it('adds days across a month boundary', () => {
    expect(addDays('2026-08-30', 3)).toBe('2026-09-02')
  })

  it('counts days between dates in both directions', () => {
    expect(daysBetween('2026-08-20', '2026-08-23')).toBe(3)
    expect(daysBetween('2026-08-23', '2026-08-20')).toBe(-3)
  })
})

describe('sessionDate', () => {
  it('puts week 1 day 1 on the start date when the plan starts on a Monday', () => {
    // 2026-08-24 is a Monday.
    expect(sessionDate('2026-08-24', 1, 1)).toBe('2026-08-24')
    expect(sessionDate('2026-08-24', 1, 7)).toBe('2026-08-30')
    expect(sessionDate('2026-08-24', 2, 1)).toBe('2026-08-31')
    expect(sessionDate('2026-08-24', 4, 3)).toBe('2026-09-16')
  })

  it('hangs the first week off a mid-week start rather than assuming Monday', () => {
    // 2026-08-26 is a Wednesday: week 1 runs Wed → Tue.
    expect(sessionDate('2026-08-26', 1, 3)).toBe('2026-08-26')
    expect(sessionDate('2026-08-26', 1, 6)).toBe('2026-08-29')
    expect(sessionDate('2026-08-26', 1, 2)).toBe('2026-09-01')
    expect(sessionDate('2026-08-26', 2, 3)).toBe('2026-09-02')
  })

  it('handles a Sunday start, where day 7 is the start date itself', () => {
    // 2026-08-23 is a Sunday.
    expect(sessionDate('2026-08-23', 1, 7)).toBe('2026-08-23')
    expect(sessionDate('2026-08-23', 1, 1)).toBe('2026-08-24')
  })
})

describe('resolveDates', () => {
  it('leaves dates null until the coach sets a start date', () => {
    const resolved = resolveDates([{ week: 1, dayOfWeek: 2 }], null)
    expect(resolved[0].date).toBeNull()
  })

  it('fills every session date from the start date', () => {
    const resolved = resolveDates([{ week: 1, dayOfWeek: 2 }, { week: 3, dayOfWeek: 6 }], '2026-08-24')
    expect(resolved.map(r => r.date)).toEqual(['2026-08-25', '2026-09-12'])
  })
})

describe('matchSession', () => {
  const sessions = [
    session({ week: 1, dayOfWeek: 2, date: '2026-08-25', title: 'Threshold 3x12', intensity: 'threshold' }),
    session({ week: 1, dayOfWeek: 4, date: '2026-08-27', title: 'Rest', intensity: 'rest' }),
    session({ week: 1, dayOfWeek: 6, date: '2026-08-29', title: 'Long ride' }),
  ]

  it('matches a ride to the session on the same date', () => {
    expect(matchSession(sessions, '2026-08-25')?.title).toBe('Threshold 3x12')
  })

  it('matches a session ridden a day late', () => {
    expect(matchSession(sessions, '2026-08-30')?.title).toBe('Long ride')
  })

  it('prefers the earlier session when two are equally near', () => {
    const pair = [
      session({ week: 1, dayOfWeek: 1, date: '2026-08-24', title: 'Monday' }),
      session({ week: 1, dayOfWeek: 3, date: '2026-08-26', title: 'Wednesday' }),
    ]
    expect(matchSession(pair, '2026-08-25')?.title).toBe('Monday')
  })

  it('never matches a ride to a rest day', () => {
    expect(matchSession([sessions[1]], '2026-08-27')).toBeNull()
  })

  it('returns null when the ride is well outside any planned session', () => {
    expect(matchSession(sessions, '2026-09-15')).toBeNull()
  })

  it('returns null when no session has a resolved date', () => {
    expect(matchSession([session({ week: 1, dayOfWeek: 1 })], '2026-08-24')).toBeNull()
  })
})

describe('weekOf', () => {
  it('reports the plan week a date falls in', () => {
    expect(weekOf('2026-08-24', '2026-08-24', 8)).toBe(1)
    expect(weekOf('2026-08-24', '2026-08-30', 8)).toBe(1)
    expect(weekOf('2026-08-24', '2026-08-31', 8)).toBe(2)
  })

  it('returns null outside the plan', () => {
    expect(weekOf('2026-08-24', '2026-08-20', 8)).toBeNull()
    expect(weekOf('2026-08-24', '2026-11-01', 8)).toBeNull()
  })
})
