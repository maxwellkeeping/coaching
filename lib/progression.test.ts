import { describe, it, expect } from 'vitest'
import { computeProgression, weekStartOf, type RideRecord } from './progression'
import type { ComplianceVerdict } from './plan-match'

let seq = 0
function rideRecord(partial: Partial<RideRecord> & { date: string }): RideRecord {
  return {
    id: `r${seq++}`,
    title: 'Ride',
    durationSecs: 3600,
    tss: 60,
    avgWatts: 180,
    avgHr: 140,
    normalizedPower: 190,
    decoupling: 3,
    intensityFactor: 0.7,
    complianceVerdict: null,
    ...partial,
  }
}

describe('weekStartOf', () => {
  it('returns the Monday of the week', () => {
    expect(weekStartOf('2026-08-26')).toBe('2026-08-24')  // Wednesday → Monday
    expect(weekStartOf('2026-08-24')).toBe('2026-08-24')  // Monday → itself
    expect(weekStartOf('2026-08-23')).toBe('2026-08-17')  // Sunday → the Monday before
  })
})

describe('computeProgression', () => {
  it('handles a client with no uploaded rides yet', () => {
    const p = computeProgression([])
    expect(p.weeks).toEqual([])
    expect(p.totals).toEqual({ rides: 0, durationSecs: 0, load: null, compliancePct: null })
    expect(p.aerobicEf.direction).toBe('insufficient-data')
    expect(p.observations).toEqual([])
  })

  it('buckets rides into calendar weeks and totals them', () => {
    const p = computeProgression([
      rideRecord({ date: '2026-08-25', durationSecs: 3600, tss: 60 }),
      rideRecord({ date: '2026-08-29', durationSecs: 7200, tss: 120 }),
      rideRecord({ date: '2026-09-01', durationSecs: 5400, tss: 90 }),
    ])
    expect(p.weeks.map(w => w.weekStart)).toEqual(['2026-08-24', '2026-08-31'])
    expect(p.weeks[0]).toMatchObject({ rides: 2, durationSecs: 10800, load: 180 })
    expect(p.totals).toMatchObject({ rides: 3, durationSecs: 16200, load: 270 })
  })

  it('calls a rising aerobic efficiency trend across a block', () => {
    const p = computeProgression([
      rideRecord({ date: '2026-08-03', avgWatts: 180, avgHr: 145 }),  // EF 1.24
      rideRecord({ date: '2026-08-10', avgWatts: 185, avgHr: 143 }),
      rideRecord({ date: '2026-08-17', avgWatts: 190, avgHr: 140 }),
      rideRecord({ date: '2026-08-24', avgWatts: 195, avgHr: 138 }),  // EF 1.41
    ])
    expect(p.aerobicEf.direction).toBe('improving')
    expect(p.aerobicEf.changePct).toBeGreaterThan(3)
    expect(p.observations.some(o => o.includes('Aerobic efficiency up'))).toBe(true)
  })

  it('calls a declining trend when power per heartbeat falls away', () => {
    const p = computeProgression([
      rideRecord({ date: '2026-08-03', avgWatts: 200, avgHr: 135 }),
      rideRecord({ date: '2026-08-10', avgWatts: 190, avgHr: 140 }),
      rideRecord({ date: '2026-08-17', avgWatts: 180, avgHr: 148 }),
    ])
    expect(p.aerobicEf.direction).toBe('declining')
    expect(p.observations.some(o => o.includes('Aerobic efficiency down'))).toBe(true)
  })

  it('excludes quality rides from the aerobic efficiency trend', () => {
    const p = computeProgression([
      rideRecord({ date: '2026-08-03', avgWatts: 180, avgHr: 145, intensityFactor: 0.68 }),
      rideRecord({ date: '2026-08-04', avgWatts: 260, avgHr: 170, intensityFactor: 0.95 }),
    ])
    // Only the aerobic ride counts toward the week's EF.
    expect(p.weeks[0].aerobicEf).toBeCloseTo(180 / 145, 2)
  })

  it('refuses to call a trend on too little history', () => {
    const p = computeProgression([
      rideRecord({ date: '2026-08-03', avgWatts: 180, avgHr: 150 }),
      rideRecord({ date: '2026-08-10', avgWatts: 220, avgHr: 140 }),
    ])
    expect(p.aerobicEf.direction).toBe('insufficient-data')
    expect(p.observations.some(o => o.includes('too little to call a trend'))).toBe(true)
  })

  it('flags decoupling that is running high in the latest week', () => {
    const p = computeProgression([
      rideRecord({ date: '2026-08-03', decoupling: 3 }),
      rideRecord({ date: '2026-08-10', decoupling: 5 }),
      rideRecord({ date: '2026-08-17', decoupling: 8.4 }),
    ])
    expect(p.decoupling.last).toBe(8.4)
    expect(p.observations.some(o => o.includes('8.4%'))).toBe(true)
  })

  it('flags a steep week-over-week load ramp', () => {
    const p = computeProgression([
      rideRecord({ date: '2026-08-10', tss: 200 }),
      rideRecord({ date: '2026-08-17', tss: 300 }),
    ])
    expect(p.loadRampPct).toBe(50)
    expect(p.observations.some(o => o.includes('Weekly load jumped 50%'))).toBe(true)
  })

  it('scores plan compliance over the sessions that had a plan', () => {
    const verdicts: ComplianceVerdict[] = ['as-prescribed', 'as-prescribed', 'cut-short', 'unplanned']
    const p = computeProgression(verdicts.map((v, i) => rideRecord({ date: `2026-08-1${i}`, complianceVerdict: v })))
    // The unplanned ride is not held against compliance.
    expect(p.totals.compliancePct).toBe(67)
    expect(p.observations.some(o => o.includes('2 of 3 planned sessions'))).toBe(true)
  })

  it('survives rides with no power or HR data', () => {
    const p = computeProgression([
      rideRecord({ date: '2026-08-03', avgWatts: null, avgHr: null, tss: null, decoupling: null }),
    ])
    expect(p.weeks[0].aerobicEf).toBeNull()
    expect(p.weeks[0].load).toBeNull()
    expect(p.totals.load).toBeNull()
  })
})
