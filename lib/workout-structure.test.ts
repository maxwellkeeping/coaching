import { describe, it, expect } from 'vitest'
import {
  classifyRideStructure,
  detectIntervalsFromStream,
  parsePrescribedStructure,
  compareStructures,
} from './workout-structure'
import type { StreamData } from './decoupling'

const FTP = 250

/** Build a 1Hz stream from [seconds, watts] runs. */
function stream(runs: Array<[number, number]>): StreamData {
  const watts: number[] = []
  for (const [secs, w] of runs) {
    for (let i = 0; i < secs; i++) watts.push(w)
  }
  return {
    time: watts.map((_, i) => i),
    watts,
    heartrate: watts.map(w => Math.round(110 + w * 0.18)),
  }
}

/** An over-under block: alternating 2min over / 2min under, `reps` times. */
function overUnderBlock(reps: number, over: number, under: number): Array<[number, number]> {
  const runs: Array<[number, number]> = []
  for (let i = 0; i < reps; i++) {
    runs.push([120, over], [120, under])
  }
  return runs
}

describe('detectIntervalsFromStream', () => {
  it('finds sustained efforts when the rider never pressed lap', () => {
    const s = stream([[600, 150], [720, 255], [300, 130], [720, 255], [300, 120]])
    const intervals = detectIntervalsFromStream(s, FTP)
    expect(intervals).toHaveLength(2)
    expect(intervals[0].startIndex).toBeGreaterThan(500)
    expect(intervals[0].endIndex - intervals[0].startIndex).toBeGreaterThan(600)
  })

  it('does not split an over-under across its under legs', () => {
    // The "under" leg dips below the effort floor by design — one block, not six.
    const s = stream([[600, 150], ...overUnderBlock(3, 275, 215), [600, 130]])
    const intervals = detectIntervalsFromStream(s, FTP)
    expect(intervals).toHaveLength(1)
    expect(intervals[0].endIndex - intervals[0].startIndex).toBeGreaterThan(600)
  })

  it('finds nothing in a steady endurance ride', () => {
    expect(detectIntervalsFromStream(stream([[3600, 165]]), FTP)).toEqual([])
  })

  it('finds efforts with no FTP at all — shape is read from the ride itself', () => {
    // The whole point: a stale or missing FTP must not hide a workout.
    const s = stream([[600, 150], [720, 260], [300, 130], [720, 260], [300, 120]])
    expect(detectIntervalsFromStream(s, null)).toHaveLength(2)
    expect(detectIntervalsFromStream(s, null)).toEqual(detectIntervalsFromStream(s, 250))
  })

  it('ignores efforts too brief to be intervals', () => {
    const s = stream([[600, 150], [30, 300], [600, 150]])
    expect(detectIntervalsFromStream(s, FTP)).toEqual([])
  })
})

describe('classifyRideStructure', () => {
  it('recognises an over-under session for what it is', () => {
    const s = stream([[600, 150], ...overUnderBlock(3, 275, 215), [300, 140], ...overUnderBlock(3, 272, 212), [400, 130]])
    const structure = classifyRideStructure(s, [], FTP)

    expect(structure.archetype).toBe('over-under')
    expect(structure.blocks).toHaveLength(2)
    expect(structure.blocks[0].isOverUnder).toBe(true)
    expect(structure.blocks[0].alternations).toBeGreaterThanOrEqual(3)
    expect(structure.description).toContain('over-unders')
    expect(structure.inferredFromStream).toBe(true)
  })

  it('does not mistake a steady threshold effort for an over-under', () => {
    const s = stream([[600, 150], [1200, 238], [300, 140], [1200, 236], [300, 130]])
    const structure = classifyRideStructure(s, [], FTP)
    expect(structure.archetype).toBe('threshold')
    expect(structure.blocks.every(b => !b.isOverUnder)).toBe(true)
  })

  it('separates VO2max from threshold by intensity', () => {
    const s = stream([[600, 150], [240, 290], [240, 130], [240, 288], [240, 130], [240, 285], [400, 120]])
    expect(classifyRideStructure(s, [], FTP).archetype).toBe('vo2max')
  })

  it('reads sweet spot as its own band', () => {
    const s = stream([[600, 140], [1200, 225], [300, 130], [1200, 222], [300, 120]])
    expect(classifyRideStructure(s, [], FTP).archetype).toBe('sweet-spot')
  })

  it('calls a steady ride unstructured rather than inventing intervals', () => {
    const structure = classifyRideStructure(stream([[7200, 160]]), [], FTP)
    expect(structure.archetype).toBe('unstructured')
    expect(structure.blocks).toEqual([])
    expect(structure.description).toContain('No structured work')
  })

  it('reports the rep scheme when the efforts are uniform', () => {
    const s = stream([[600, 150], [720, 240], [300, 130], [720, 240], [300, 130], [720, 240], [300, 120]])
    const structure = classifyRideStructure(s, [], FTP)
    expect(structure.repScheme).toBe('3 × 12min')
    expect(structure.description).toContain('3 × 12min')
  })

  it('gives no rep scheme when efforts are ragged', () => {
    const s = stream([[600, 150], [900, 240], [300, 130], [300, 240], [300, 120]])
    expect(classifyRideStructure(s, [], FTP).repScheme).toBeNull()
  })

  it('prefers the rider’s own laps over inferring from the stream', () => {
    const s = stream([[600, 150], ...overUnderBlock(3, 275, 215), [400, 130]])
    const structure = classifyRideStructure(s, [{ startIndex: 600, endIndex: 1320, label: 'Block 1' }], FTP)
    expect(structure.inferredFromStream).toBe(false)
    expect(structure.blocks).toHaveLength(1)
    expect(structure.archetype).toBe('over-under')
  })

  it('degrades to mixed rather than guessing a band with no FTP', () => {
    const s = stream([[600, 150], [720, 255], [300, 130], [720, 255], [300, 120]])
    const structure = classifyRideStructure(s, [{ startIndex: 600, endIndex: 1320 }, { startIndex: 1620, endIndex: 2340 }], null)
    expect(structure.archetype).toBe('mixed')
    expect(structure.avgWorkPctFtp).toBeNull()
  })
})

describe('parsePrescribedStructure', () => {
  it('reads over-unders however the plan spells them', () => {
    for (const text of ['3x12 over/unders', 'Over-Under intervals', '2x15 O/U', 'over unders @ threshold']) {
      expect(parsePrescribedStructure(text, null).archetype).toBe('over-under')
    }
  })

  it('reads the rep scheme out of the prescription', () => {
    const p = parsePrescribedStructure('Threshold 3x12', '3 x 12min @ 95% FTP')
    expect(p.archetype).toBe('threshold')
    expect(p.reps).toBe(3)
    expect(p.repMinutes).toBe(12)
  })

  it('handles the × character and minute marks', () => {
    const p = parsePrescribedStructure('4×8min VO2', null)
    expect(p.archetype).toBe('vo2max')
    expect(p.reps).toBe(4)
    expect(p.repMinutes).toBe(8)
  })

  it('finds the structure in the description when the title is vague', () => {
    const p = parsePrescribedStructure('Tuesday session', 'Sweet spot 2x20min at 90% FTP')
    expect(p.archetype).toBe('sweet-spot')
  })

  it('returns a null archetype when the plan says nothing about structure', () => {
    expect(parsePrescribedStructure('Ride', 'Get out for a bit').archetype).toBeNull()
  })

  it('ignores implausible rep counts', () => {
    expect(parsePrescribedStructure('Ride 2024x5', null).reps).toBeNull()
  })
})

describe('compareStructures', () => {
  const overUnderRide = () =>
    classifyRideStructure(stream([[600, 150], ...overUnderBlock(3, 275, 215), [300, 140], ...overUnderBlock(3, 272, 212), [400, 130]]), [], FTP)

  it('recognises the prescribed over-under was done', () => {
    const result = compareStructures(overUnderRide(), parsePrescribedStructure('Over-unders 2x12', '2x12min over/under'))
    expect(result.verdict).toBe('same-structure')
    expect(result.notes[0]).toContain('Structure matches')
  })

  it('flags the right session done with the wrong rep count', () => {
    const result = compareStructures(overUnderRide(), parsePrescribedStructure('Over-unders 4x12', '4x12min over/under'))
    expect(result.verdict).toBe('similar-structure')
    expect(result.notes.some(n => n.includes('2 efforts against 4 prescribed'))).toBe(true)
  })

  it('calls a neighbouring session close rather than wrong', () => {
    const threshold = classifyRideStructure(stream([[600, 150], [1200, 238], [300, 140], [1200, 236], [300, 130]]), [], FTP)
    const result = compareStructures(threshold, parsePrescribedStructure('Over-unders 2x20', '2x20min over/under'))
    expect(result.verdict).toBe('similar-structure')
    expect(result.notes[0]).toContain('close, but not the session as written')
  })

  it('calls a genuinely different session different', () => {
    const sprints = classifyRideStructure(stream([[600, 150], [1200, 165], [300, 140]]), [], FTP)
    const result = compareStructures(sprints, parsePrescribedStructure('VO2max 5x4', '5x4min @ 115%'))
    expect(result.verdict).toBe('different-structure')
  })

  it('says so plainly when the prescription gives no structure to compare', () => {
    const result = compareStructures(overUnderRide(), parsePrescribedStructure('Tuesday', 'Ride 90 minutes'))
    expect(result.verdict).toBe('unknown')
    expect(result.notes[0]).toContain('does not say what kind of session')
  })

  it('does not fault a steady ride for being steady when steady was prescribed', () => {
    const steady = classifyRideStructure(stream([[7200, 160]]), [], FTP)
    const result = compareStructures(steady, parsePrescribedStructure('Long endurance', '3h Z2'))
    expect(result.verdict).not.toBe('different-structure')
  })
})
