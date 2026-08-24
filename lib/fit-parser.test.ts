import { describe, it, expect } from 'vitest'
import { parseFitFile, FitParseError } from './fit-parser'
import { buildFitFile, steady } from './fit-fixture'

describe('parseFitFile', () => {
  it('decodes records, laps and the session summary', () => {
    const buf = buildFitFile({
      samples: [...steady(60, 200, 140), ...steady(60, 300, 165)],
      laps: [
        { startSecs: 0, endSecs: 60, intensity: 'warmup', avgPower: 200, avgHeartRate: 140 },
        { startSecs: 60, endSecs: 120, intensity: 'active', avgPower: 300, avgHeartRate: 165 },
      ],
      session: { avgPower: 250, normalizedPower: 260, avgHeartRate: 152, maxHeartRate: 170, totalDistance: 12000 },
    })

    const fit = parseFitFile(buf)

    expect(fit.records).toHaveLength(120)
    expect(fit.records[0]).toMatchObject({ t: 0, watts: 200, hr: 140 })
    expect(fit.records[119]).toMatchObject({ t: 119, watts: 300, hr: 165 })
    expect(fit.startTime).toBe('2026-08-20T10:00:00.000Z')
    expect(fit.sport).toBe('cycling')
    expect(fit.hasPower).toBe(true)
    expect(fit.hasHr).toBe(true)

    expect(fit.laps).toHaveLength(2)
    expect(fit.laps[1]).toMatchObject({ startSecs: 60, endSecs: 120, intensity: 'active', avgWatts: 300 })

    expect(fit.session).toMatchObject({
      avgWatts: 250,
      normalizedPower: 260,
      avgHr: 152,
      maxHr: 170,
      totalDistanceM: 12000,
    })
  })

  it('reports times relative to the first record even when the ride starts mid-file', () => {
    const buf = buildFitFile({
      start: new Date('2026-08-20T14:30:00Z'),
      samples: steady(10, 180, 130),
    })
    const fit = parseFitFile(buf)
    expect(fit.records.map(r => r.t)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(fit.startTime).toBe('2026-08-20T14:30:00.000Z')
  })

  it('preserves recording gaps in the record timeline', () => {
    const buf = buildFitFile({
      samples: [...steady(5, 200, 140), { power: 200, heartRate: 140, gapBefore: 30 }],
    })
    const fit = parseFitFile(buf)
    expect(fit.records.map(r => r.t)).toEqual([0, 1, 2, 3, 4, 35])
  })

  it('keeps a ride with heart rate but no power meter', () => {
    const buf = buildFitFile({
      samples: Array.from({ length: 30 }, () => ({ heartRate: 145 })),
      session: { avgHeartRate: 145 },
    })
    const fit = parseFitFile(buf)
    expect(fit.hasPower).toBe(false)
    expect(fit.hasHr).toBe(true)
    expect(fit.records.every(r => r.watts === 0)).toBe(true)
  })

  it('rejects bytes that are not a FIT file', () => {
    const bytes = new TextEncoder().encode('this is a gpx file, not a fit file')
    expect(() => parseFitFile(bytes.buffer as ArrayBuffer)).toThrow(FitParseError)
  })

  it('rejects a FIT file with no ride records', () => {
    const buf = buildFitFile({ samples: [], session: null })
    expect(() => parseFitFile(buf)).toThrow(/no ride records/)
  })
})
