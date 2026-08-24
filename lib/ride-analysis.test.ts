import { describe, it, expect } from 'vitest'
import {
  analyzeRide,
  normalizedPower,
  zoneDistribution,
  bestEfforts,
  intervalExecution,
  DECOUPLING_CONCERN_PCT,
} from './ride-analysis'
import type { StreamData } from './decoupling'

function makeStreams(watts: number[], heartrate?: number[]): StreamData {
  return {
    time: watts.map((_, i) => i),
    watts,
    heartrate: heartrate ?? watts.map(() => 150),
  }
}

describe('normalizedPower', () => {
  it('equals average power for a perfectly steady ride', () => {
    const np = normalizedPower(Array(3600).fill(250))
    expect(np).toBe(250)
  })

  it('exceeds average power for a punchy ride', () => {
    // Alternate 60s at 400W / 60s at 100W — avg 250W, NP well above
    const watts: number[] = []
    for (let i = 0; i < 30; i++) {
      watts.push(...Array(60).fill(400), ...Array(60).fill(100))
    }
    const np = normalizedPower(watts)!
    expect(np).toBeGreaterThan(280)
  })

  it('returns null when the ride is shorter than the 30s window', () => {
    expect(normalizedPower(Array(20).fill(250))).toBeNull()
  })
})

describe('zoneDistribution', () => {
  it('buckets time into the right zones for FTP 300', () => {
    // 100s at 150W (50% → Z1), 100s at 200W (67% → Z2), 100s at 350W (117% → Z6)
    const watts = [...Array(100).fill(150), ...Array(100).fill(200), ...Array(100).fill(350)]
    const time = watts.map((_, i) => i)
    const { zones } = zoneDistribution(watts, time, 300)
    const byZone = Object.fromEntries(zones.map(z => [z.zone, z.secs]))
    expect(byZone.Z1).toBe(100)
    expect(byZone.Z2).toBe(100)
    expect(byZone.Z6).toBe(100)
    expect(byZone.Z3).toBe(0)
  })

  it('counts 0W samples as coasting, not Z1', () => {
    const watts = [...Array(50).fill(0), ...Array(50).fill(150)]
    const time = watts.map((_, i) => i)
    const { zones, coastingSecs } = zoneDistribution(watts, time, 300)
    expect(coastingSecs).toBe(50)
    expect(zones.find(z => z.zone === 'Z1')!.secs).toBe(50)
  })
})

describe('bestEfforts', () => {
  it('finds the best rolling average for each duration', () => {
    // 1 hour at 200W with a 60s surge at 400W
    const watts = Array(3600).fill(200)
    for (let i = 1000; i < 1060; i++) watts[i] = 400
    const efforts = bestEfforts(watts)
    const oneMin = efforts.find(e => e.durationSecs === 60)!
    expect(oneMin.watts).toBe(400)
    const fiveSec = efforts.find(e => e.durationSecs === 5)!
    expect(fiveSec.watts).toBe(400)
  })

  it('skips durations longer than the ride', () => {
    const efforts = bestEfforts(Array(100).fill(250))
    expect(efforts.map(e => e.durationSecs)).toEqual([5, 60])
  })
})

describe('intervalExecution', () => {
  it('computes back-half fade within a work interval', () => {
    // Interval: 300s at 300W then 300s at 270W → 10% fade
    const watts = [...Array(300).fill(300), ...Array(300).fill(270)]
    const streams = makeStreams(watts)
    const [result] = intervalExecution(streams, [{ startIndex: 0, endIndex: 600 }], 300)
    expect(result.fadePct).toBeCloseTo(10, 0)
    expect(result.avgWatts).toBe(285)
    expect(result.pctFtp).toBe(95)
  })

  it('reports zero fade for a perfectly held interval', () => {
    const streams = makeStreams(Array(600).fill(280))
    const [result] = intervalExecution(streams, [{ startIndex: 0, endIndex: 600 }], 300)
    expect(result.fadePct).toBeCloseTo(0, 1)
  })
})

describe('analyzeRide', () => {
  it('produces a full analysis for a steady 2h ride', () => {
    const n = 7200
    const watts = Array(n).fill(200)
    const hr = Array(n).fill(140)
    const analysis = analyzeRide(makeStreams(watts, hr), { ftp: 300, hrMax: 185 })

    expect(analysis.durationSecs).toBe(n)
    expect(analysis.power.avgWatts).toBe(200)
    expect(analysis.power.normalizedPower).toBe(200)
    expect(analysis.power.variabilityIndex).toBe(1)
    expect(analysis.power.totalKj).toBe(1440)
    expect(analysis.hr.avgHr).toBe(140)
    expect(analysis.hr.pctAboveThresholdHr).toBe(0)
    expect(analysis.decoupling).toBeCloseTo(0, 1)
    expect(analysis.thirds).toHaveLength(3)
    expect(analysis.lateFadePct).toBeCloseTo(0, 1)
    expect(analysis.zones!.find(z => z.zone === 'Z2')!.pct).toBeGreaterThan(99)
  })

  it('flags decoupling on a ride with strong HR drift', () => {
    // 2h at constant 200W, HR climbing 135 → 165 — decoupling well above 6%
    const n = 7200
    const watts = Array(n).fill(200)
    const hr = Array.from({ length: n }, (_, i) => Math.round(135 + (30 * i) / n))
    const analysis = analyzeRide(makeStreams(watts, hr), { ftp: 300 })

    expect(analysis.decoupling!).toBeGreaterThanOrEqual(DECOUPLING_CONCERN_PCT)
    expect(analysis.insights.some(s => s.includes('decoupling'))).toBe(true)
    expect(analysis.lateFadePct!).toBeGreaterThan(0)
  })

  it('flags durability-relevant rides past 2000 kJ', () => {
    // 3h at 200W = 2160 kJ
    const n = 10800
    const analysis = analyzeRide(makeStreams(Array(n).fill(200)), { ftp: 300 })
    expect(analysis.power.totalKj).toBeGreaterThan(2000)
    expect(analysis.insights.some(s => s.includes('kJ'))).toBe(true)
  })

  it('flags interval fade across reps', () => {
    // 4×5min intervals, each rep 10W lower than the last: 300, 290, 280, 270
    const watts: number[] = []
    const laps = []
    for (let rep = 0; rep < 4; rep++) {
      laps.push({ startIndex: watts.length, endIndex: watts.length + 300 })
      watts.push(...Array(300).fill(300 - rep * 10))
      watts.push(...Array(120).fill(120)) // recovery
    }
    const analysis = analyzeRide(makeStreams(watts), { ftp: 300, workIntervals: laps })

    expect(analysis.intervals).toHaveLength(4)
    expect(analysis.repFadePct).toBeCloseTo(10, 0)
    expect(analysis.insights.some(s => s.includes('less power than the first'))).toBe(true)
  })

  it('handles null-riddled and HR-less streams without crashing', () => {
    const streams: StreamData = {
      time: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
      watts: [200, null, 210, 205, null, 200, 195, 205, 200, 210] as unknown as number[],
      heartrate: [] as number[],
    }
    const analysis = analyzeRide(streams, { ftp: 300 })
    expect(analysis.power.avgWatts).toBeGreaterThan(0)
    expect(analysis.hr.avgHr).toBeNull()
    expect(analysis.decoupling).toBeNull()
  })

  it('flags high coasting percentage', () => {
    const watts = [...Array(3000).fill(0), ...Array(7000).fill(200)]
    const analysis = analyzeRide(makeStreams(watts), { ftp: 300 })
    expect(analysis.power.coastingPct).toBeCloseTo(30, 0)
    expect(analysis.insights.some(s => s.includes('coasting'))).toBe(true)
  })
})
