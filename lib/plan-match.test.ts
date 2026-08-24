import { describe, it, expect } from 'vitest'
import { compareToPlan, targetPctFtp } from './plan-match'
import { summarizeFitRide } from './fit-analysis'
import { parseFitFile } from './fit-parser'
import { buildFitFile, steady } from './fit-fixture'
import type { PlanSession } from './types'
import type { FitRideSummary } from './fit-analysis'

function session(partial: Partial<PlanSession> = {}): PlanSession {
  return {
    id: 's1',
    plan_id: 'p1',
    client_id: 'c1',
    week: 1,
    dayOfWeek: 2,
    date: '2026-08-25',
    title: 'Threshold 3x12',
    description: '3x12min @ 95% FTP',
    sport: 'cycling',
    durationSecs: 3600,
    targetLoad: 85,
    intensity: 'threshold',
    sourceText: null,
    ...partial,
  }
}

/** A ride of `secs` at `watts` with a matching HR, analyzed against `ftp`. */
function ride(secs: number, watts: number, hr: number, ftp: number | null = 250): FitRideSummary {
  const buf = buildFitFile({ samples: steady(secs, watts, hr), session: null })
  return summarizeFitRide(parseFitFile(buf), { ftp })
}

/** A ride built as warmup + two work intervals, so interval execution is measured. */
function intervalRide(workWatts: number, ftp = 250): FitRideSummary {
  const buf = buildFitFile({
    samples: [...steady(900, 120, 120), ...steady(720, workWatts, 170), ...steady(300, 110, 130), ...steady(720, workWatts, 172), ...steady(360, 110, 125)],
    laps: [
      { startSecs: 0, endSecs: 900, intensity: 'warmup', avgPower: 120 },
      { startSecs: 900, endSecs: 1620, intensity: 'active', avgPower: workWatts },
      { startSecs: 1620, endSecs: 1920, intensity: 'rest', avgPower: 110 },
      { startSecs: 1920, endSecs: 2640, intensity: 'active', avgPower: workWatts },
      { startSecs: 2640, endSecs: 3000, intensity: 'cooldown', avgPower: 110 },
    ],
    session: null,
  })
  return summarizeFitRide(parseFitFile(buf), { ftp })
}

describe('compareToPlan', () => {
  it('reports an unplanned ride when nothing in the plan matches', () => {
    const result = compareToPlan(ride(3600, 180, 140), null, 250)
    expect(result.verdict).toBe('unplanned')
    expect(result.planned).toBeNull()
    expect(result.notes[0]).toContain('No planned session')
  })

  it('calls a session ridden to prescription as-prescribed', () => {
    const result = compareToPlan(intervalRide(238), session({ durationSecs: 3000, targetLoad: null }), 250)
    expect(result.verdict).toBe('as-prescribed')
    expect(result.durationDeltaPct).toBe(0)
  })

  it('flags a quality session ridden well under target power', () => {
    // 200W against a ~95% FTP (238W) threshold target — the time was done, the work was not.
    const result = compareToPlan(intervalRide(200), session({ durationSecs: 3000, targetLoad: null }), 250)
    expect(result.verdict).toBe('easier-than-prescribed')
    expect(result.notes.some(n => n.includes('% FTP against roughly 95%'))).toBe(true)
  })

  it('flags a ride cut well short of the prescription', () => {
    const result = compareToPlan(ride(1800, 180, 140), session({ durationSecs: 5400, targetLoad: null, intensity: 'endurance' }), 250)
    expect(result.verdict).toBe('cut-short')
    expect(result.durationDeltaPct).toBeCloseTo(-66.7, 0)
  })

  it('flags an easy day ridden hard even when the duration was right', () => {
    const result = compareToPlan(ride(3600, 220, 155), session({ durationSecs: 3600, targetLoad: null, intensity: 'endurance', title: 'Z2 endurance' }), 250)
    expect(result.verdict).toBe('harder-than-prescribed')
    expect(result.notes.some(n => n.includes('the easy day was not easy'))).toBe(true)
  })

  it('flags a rest day that was ridden through', () => {
    const result = compareToPlan(ride(3600, 180, 140), session({ intensity: 'rest', durationSecs: null, targetLoad: null, title: 'Rest' }), 250)
    expect(result.verdict).toBe('different-session')
    expect(result.notes.some(n => n.includes('prescribed rest day'))).toBe(true)
  })

  it('judges against the load target when the plan gives one', () => {
    const heavy = compareToPlan(ride(5400, 250, 160), session({ durationSecs: 5400, targetLoad: 100, intensity: 'tempo' }), 250)
    expect(heavy.loadDeltaPct).not.toBeNull()
    expect(heavy.verdict).toBe('harder-than-prescribed')
    expect(heavy.notes.some(n => n.includes('TSS'))).toBe(true)
  })

  it('reports duration and load deltas without an FTP to judge intensity by', () => {
    const result = compareToPlan(ride(3600, 200, 145, null), session({ durationSecs: 3600, targetLoad: null }), null)
    expect(result.durationDeltaPct).toBe(0)
    expect(result.loadDeltaPct).toBeNull()
    expect(result.verdict).toBe('as-prescribed')
  })

  it('carries the prescription through for display', () => {
    const result = compareToPlan(ride(3600, 200, 145), session(), 250)
    expect(result.planned).toMatchObject({
      title: 'Threshold 3x12',
      date: '2026-08-25',
      durationSecs: 3600,
      intensity: 'threshold',
    })
  })
})

describe('targetPctFtp', () => {
  it('gives a mid-band target for each trainable intensity', () => {
    expect(targetPctFtp('threshold')).toBe(95)
    expect(targetPctFtp('vo2max')).toBe(110)
    expect(targetPctFtp('endurance')).toBe(65)
  })

  it('has no target for bands that are not about power', () => {
    expect(targetPctFtp('rest')).toBeNull()
    expect(targetPctFtp('unknown')).toBeNull()
  })
})
