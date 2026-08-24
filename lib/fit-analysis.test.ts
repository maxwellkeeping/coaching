import { describe, it, expect } from 'vitest'
import { toStreams, detectWorkIntervals, summarizeFitRide } from './fit-analysis'
import { parseFitFile } from './fit-parser'
import { buildFitFile, steady } from './fit-fixture'
import type { FitLap } from './fit-parser'

function lap(partial: Partial<FitLap> & { startSecs: number; endSecs: number }): FitLap {
  return {
    label: null,
    intensity: null,
    avgWatts: null,
    maxWatts: null,
    avgHr: null,
    ...partial,
  }
}

describe('toStreams', () => {
  it('produces a strict 1Hz grid', () => {
    const streams = toStreams([
      { t: 0, watts: 200, hr: 140, cadence: 90, speed: null, altitude: null, distance: null },
      { t: 1, watts: 210, hr: 141, cadence: 90, speed: null, altitude: null, distance: null },
      { t: 2, watts: 220, hr: 142, cadence: 90, speed: null, altitude: null, distance: null },
    ])
    expect(streams.time).toEqual([0, 1, 2])
    expect(streams.watts).toEqual([200, 210, 220])
    expect(streams.heartrate).toEqual([140, 141, 142])
  })

  it('carries the last sample forward across a short dropout', () => {
    const streams = toStreams([
      { t: 0, watts: 200, hr: 140, cadence: null, speed: null, altitude: null, distance: null },
      { t: 3, watts: 260, hr: 150, cadence: null, speed: null, altitude: null, distance: null },
    ])
    expect(streams.watts).toEqual([200, 200, 200, 260])
    expect(streams.heartrate).toEqual([140, 140, 140, 150])
  })

  it('zero-fills a long stop rather than inventing sustained power', () => {
    const streams = toStreams([
      { t: 0, watts: 200, hr: 140, cadence: null, speed: null, altitude: null, distance: null },
      { t: 20, watts: 200, hr: 140, cadence: null, speed: null, altitude: null, distance: null },
    ])
    expect(streams.watts.slice(0, 6)).toEqual([200, 200, 200, 200, 200, 200])
    expect(streams.watts.slice(6, 20)).toEqual(new Array(14).fill(0))
    expect(streams.watts[20]).toBe(200)
  })

  it('returns empty streams for an empty ride', () => {
    expect(toStreams([])).toEqual({ time: [], watts: [], heartrate: [] })
  })
})

describe('detectWorkIntervals', () => {
  it('trusts FIT lap intensity when every lap carries one', () => {
    const work = detectWorkIntervals([
      lap({ startSecs: 0, endSecs: 600, intensity: 'warmup' }),
      lap({ startSecs: 600, endSecs: 900, intensity: 'active', label: 'Interval 1' }),
      lap({ startSecs: 900, endSecs: 1100, intensity: 'rest' }),
      lap({ startSecs: 1100, endSecs: 1400, intensity: 'active', label: 'Interval 2' }),
      lap({ startSecs: 1400, endSecs: 1800, intensity: 'cooldown' }),
    ])
    expect(work).toEqual([
      { startIndex: 600, endIndex: 900, label: 'Interval 1' },
      { startIndex: 1100, endIndex: 1400, label: 'Interval 2' },
    ])
  })

  it('classifies untagged laps by power when the spread implies intervals', () => {
    const work = detectWorkIntervals([
      lap({ startSecs: 0, endSecs: 600, avgWatts: 160 }),
      lap({ startSecs: 600, endSecs: 900, avgWatts: 290 }),
      lap({ startSecs: 900, endSecs: 1100, avgWatts: 150 }),
      lap({ startSecs: 1100, endSecs: 1400, avgWatts: 285 }),
    ])
    expect(work.map(w => w.startIndex)).toEqual([600, 1100])
  })

  it('ignores laps on a steady ride where the spread is flat', () => {
    expect(detectWorkIntervals([
      lap({ startSecs: 0, endSecs: 1800, avgWatts: 200 }),
      lap({ startSecs: 1800, endSecs: 3600, avgWatts: 205 }),
      lap({ startSecs: 3600, endSecs: 5400, avgWatts: 198 }),
    ])).toEqual([])
  })

  it('ignores laps too short to be work intervals', () => {
    expect(detectWorkIntervals([
      lap({ startSecs: 0, endSecs: 10, intensity: 'active', avgWatts: 400 }),
      lap({ startSecs: 10, endSecs: 20, intensity: 'active', avgWatts: 400 }),
    ])).toEqual([])
  })
})

describe('summarizeFitRide', () => {
  it('analyzes a structured interval ride end to end', () => {
    const buf = buildFitFile({
      samples: [
        ...steady(600, 150, 125),  // warmup
        ...steady(300, 290, 165),  // interval 1
        ...steady(200, 140, 130),  // recovery
        ...steady(300, 275, 172),  // interval 2 — faded, HR higher
        ...steady(300, 140, 128),  // cooldown
      ],
      laps: [
        { startSecs: 0, endSecs: 600, intensity: 'warmup', avgPower: 150 },
        { startSecs: 600, endSecs: 900, intensity: 'active', avgPower: 290 },
        { startSecs: 900, endSecs: 1100, intensity: 'rest', avgPower: 140 },
        { startSecs: 1100, endSecs: 1400, intensity: 'active', avgPower: 275 },
        { startSecs: 1400, endSecs: 1700, intensity: 'cooldown', avgPower: 140 },
      ],
      session: { avgPower: 190, normalizedPower: 215, avgHeartRate: 143, totalDistance: 18000 },
    })

    const summary = summarizeFitRide(parseFitFile(buf), { ftp: 300, hrMax: 190 })

    expect(summary.source.sport).toBe('cycling')
    expect(summary.source.hasPower).toBe(true)
    expect(summary.analysis.durationSecs).toBe(1700)

    // Two work laps recognised, in order, with the fade across reps measured.
    expect(summary.analysis.intervals).toHaveLength(2)
    expect(summary.analysis.intervals![0].pctFtp).toBe(97)
    expect(summary.analysis.repFadePct).toBeCloseTo(5.2, 1)

    // TSS/IF computed from our own NP against profile FTP.
    expect(summary.intensityFactor).toBeGreaterThan(0)
    expect(summary.tss).toBeGreaterThan(0)

    // Head-unit numbers are preserved separately from ours.
    expect(summary.reported.normalizedPower).toBe(215)
    expect(summary.reported.totalDistanceKm).toBe(18)

    expect(summary.laps).toHaveLength(5)
    expect(summary.laps[1]).toMatchObject({ lap: 2, intensity: 'active', durationSecs: 300 })
  })

  it('still analyzes a ride with no laps and no FTP', () => {
    const buf = buildFitFile({ samples: steady(1200, 200, 140), session: null })
    const summary = summarizeFitRide(parseFitFile(buf))

    expect(summary.analysis.intervals).toBeNull()
    expect(summary.analysis.zones).toBeNull()
    expect(summary.tss).toBeNull()
    expect(summary.intensityFactor).toBeNull()
    expect(summary.analysis.power.avgWatts).toBe(200)
  })

  it('computes TSS consistently with the standard formula', () => {
    const buf = buildFitFile({ samples: steady(3600, 250, 155), session: null })
    const summary = summarizeFitRide(parseFitFile(buf), { ftp: 250 })
    // One hour at exactly FTP is 100 TSS by definition.
    expect(summary.intensityFactor).toBeCloseTo(1, 2)
    expect(summary.tss).toBeGreaterThanOrEqual(98)
    expect(summary.tss).toBeLessThanOrEqual(102)
  })
})
