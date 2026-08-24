import { describe, it, expect } from 'vitest'
import { computeLapDecoupling, type StreamData, type LapBoundary } from './decoupling'

function makeStreams(watts: number[], heartrate: number[]): StreamData {
  return { time: watts.map((_, i) => i), watts, heartrate }
}

describe('computeLapDecoupling', () => {
  it('returns positive decoupling when HR drifts up at constant power', () => {
    // 20 points: constant 250W, HR rises from 150 to 165
    const watts = Array(20).fill(250)
    const hr = Array.from({ length: 20 }, (_, i) => 150 + i)
    const streams = makeStreams(watts, hr)
    const laps: LapBoundary[] = [{ startIndex: 0, endIndex: 20 }]

    const [decoupling] = computeLapDecoupling(streams, laps)

    expect(decoupling).not.toBeNull()
    expect(decoupling!).toBeGreaterThan(0)
  })

  it('returns negative decoupling when HR drops at constant power', () => {
    const watts = Array(20).fill(250)
    const hr = Array.from({ length: 20 }, (_, i) => 165 - i)
    const streams = makeStreams(watts, hr)
    const laps: LapBoundary[] = [{ startIndex: 0, endIndex: 20 }]

    const [decoupling] = computeLapDecoupling(streams, laps)

    expect(decoupling).not.toBeNull()
    expect(decoupling!).toBeLessThan(0)
  })

  it('returns ~0 decoupling when HR is flat at constant power', () => {
    const watts = Array(20).fill(250)
    const hr = Array(20).fill(155)
    const streams = makeStreams(watts, hr)
    const laps: LapBoundary[] = [{ startIndex: 0, endIndex: 20 }]

    const [decoupling] = computeLapDecoupling(streams, laps)

    expect(decoupling).not.toBeNull()
    expect(decoupling!).toBeCloseTo(0, 1)
  })

  it('handles multiple laps independently', () => {
    // Lap 1: HR drifts up. Lap 2: HR flat.
    const watts = Array(40).fill(250)
    const hr = [
      ...Array.from({ length: 20 }, (_, i) => 150 + i),  // lap 1: drifting
      ...Array(20).fill(155),                              // lap 2: flat
    ]
    const streams = makeStreams(watts, hr)
    const laps: LapBoundary[] = [
      { startIndex: 0, endIndex: 20 },
      { startIndex: 20, endIndex: 40 },
    ]

    const [d1, d2] = computeLapDecoupling(streams, laps)

    expect(d1!).toBeGreaterThan(0)
    expect(d2!).toBeCloseTo(0, 1)
  })

  it('returns null for laps that are too short', () => {
    const streams = makeStreams([250, 250, 250], [155, 156, 157])
    const laps: LapBoundary[] = [{ startIndex: 0, endIndex: 3 }]

    const [decoupling] = computeLapDecoupling(streams, laps)

    expect(decoupling).toBeNull()
  })

  it('returns null for laps with zero HR values', () => {
    const watts = Array(20).fill(250)
    const hr = Array(20).fill(0)
    const streams = makeStreams(watts, hr)
    const laps: LapBoundary[] = [{ startIndex: 0, endIndex: 20 }]

    const [decoupling] = computeLapDecoupling(streams, laps)

    expect(decoupling).toBeNull()
  })
})
