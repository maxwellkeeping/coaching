import { describe, it, expect } from 'vitest'
import { segmentRide, findRepeats, describeSegments, type Segment } from './segments'
import type { StreamData } from './decoupling'

function stream(runs: Array<[number, number]>, jitter = 0): StreamData {
  const watts: number[] = []
  let seed = 7
  for (const [secs, w] of runs) {
    for (let i = 0; i < secs; i++) {
      // Deterministic pseudo-noise, so a real-world ragged trace is exercised.
      seed = (seed * 1103515245 + 12345) % 2147483648
      const noise = jitter > 0 ? ((seed / 2147483648) - 0.5) * 2 * jitter * w : 0
      watts.push(Math.max(0, Math.round(w + noise)))
    }
  }
  return { time: watts.map((_, i) => i), watts, heartrate: watts.map(() => 150) }
}

function overUnder(reps: number, over: number, under: number, legSecs = 120): Array<[number, number]> {
  const runs: Array<[number, number]> = []
  for (let i = 0; i < reps; i++) runs.push([legSecs, over], [legSecs, under])
  return runs
}

describe('segmentRide', () => {
  it('finds the alternating legs of an over-under with no FTP anywhere', () => {
    const s = segmentRide(stream([[600, 140], ...overUnder(3, 270, 225), [600, 130]]))
    const work = s.segments.filter(x => x.durationSecs >= 60)
    expect(work.length).toBeGreaterThanOrEqual(6)
    expect(s.groups.length).toBeGreaterThan(0)
    expect(s.groups[0].reps).toBeGreaterThanOrEqual(3)
    expect(s.groups[0].pattern).toHaveLength(2)
  })

  it('finds the same structure in a noisy real-world trace', () => {
    const s = segmentRide(stream([[600, 140], ...overUnder(3, 270, 225), [600, 130]], 0.08))
    expect(s.groups.some(g => g.reps >= 3 && g.pattern.length === 2)).toBe(true)
  })

  it('survives a stale FTP entirely — it never looks at one', () => {
    // Same session ridden by a much stronger rider; the shape is identical.
    const weak = segmentRide(stream([[600, 140], ...overUnder(3, 270, 225), [600, 130]]))
    const strong = segmentRide(stream([[600, 280], ...overUnder(3, 540, 450), [600, 260]]))
    expect(strong.groups[0].reps).toBe(weak.groups[0].reps)
    expect(strong.groups[0].pattern).toHaveLength(weak.groups[0].pattern.length)
  })

  it('reads a 5x4min VO2 set as five reps', () => {
    const runs: Array<[number, number]> = [[600, 150]]
    for (let i = 0; i < 5; i++) runs.push([240, 320], [180, 120])
    runs.push([300, 130])
    const s = segmentRide(stream(runs))
    expect(s.groups.some(g => g.reps === 5 && g.pattern.length === 2)).toBe(true)
  })

  it('does not invent structure in a steady ride', () => {
    const s = segmentRide(stream([[5400, 165]], 0.05))
    expect(s.groups).toEqual([])
    expect(s.segments.length).toBeLessThanOrEqual(3)
  })

  it('marks recovery valleys as rest against the ride’s own working power', () => {
    const s = segmentRide(stream([[600, 150], [720, 260], [300, 110], [720, 260], [300, 110]]))
    const rests = s.segments.filter(x => x.level === 'rest')
    expect(rests.length).toBeGreaterThanOrEqual(2)
    expect(rests.every(r => r.avgWatts < 160)).toBe(true)
  })

  it('does not split a segment for one brief surge', () => {
    const s = segmentRide(stream([[600, 200], [8, 450], [600, 200]]))
    expect(s.segments.filter(x => x.durationSecs > 60)).toHaveLength(1)
  })

  it('handles an empty or tiny ride without throwing', () => {
    expect(segmentRide({ time: [], watts: [], heartrate: [] }).segments).toEqual([])
    expect(segmentRide(stream([[10, 200]])).segments).toEqual([])
  })
})

describe('findRepeats', () => {
  const seg = (durationSecs: number, avgWatts: number, startSecs = 0): Segment => ({
    startSecs, endSecs: startSecs + durationSecs, durationSecs, avgWatts, level: 'work',
  })

  it('collapses an alternating pattern into reps', () => {
    const segments = [seg(120, 270, 0), seg(120, 225, 120), seg(120, 268, 240), seg(120, 227, 360)]
    const groups = findRepeats(segments)
    expect(groups[0].reps).toBe(2)
    expect(groups[0].pattern).toHaveLength(2)
  })

  it('tolerates the drift a tiring rider shows across reps', () => {
    const segments = [seg(240, 300, 0), seg(180, 120, 240), seg(240, 285, 420), seg(180, 118, 660)]
    expect(findRepeats(segments)[0].reps).toBe(2)
  })

  it('finds nothing in a pyramid', () => {
    const segments = [seg(120, 200, 0), seg(120, 250, 120), seg(120, 300, 240), seg(120, 250, 360)]
    expect(findRepeats(segments).every(g => g.pattern.length <= 3)).toBe(true)
  })
})

describe('describeSegments', () => {
  it('reads out like a coach describing the graph', () => {
    const text = describeSegments(segmentRide(stream([[600, 140], ...overUnder(3, 270, 225), [600, 130]])), 250)
    expect(text).toMatch(/3 × \(/)
    expect(text).toContain('% FTP')
  })

  it('omits %FTP when there is no FTP on file', () => {
    const text = describeSegments(segmentRide(stream([[600, 140], ...overUnder(3, 270, 225), [600, 130]])), null)
    expect(text).not.toContain('% FTP')
    expect(text).toMatch(/\d+W/)
  })
})
