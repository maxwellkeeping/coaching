import { describe, it, expect } from 'vitest'
import { summarizeFitRide } from './fit-analysis'
import { parseFitFile } from './fit-parser'
import { buildFitFile, steady } from './fit-fixture'
import { compareToPlan } from './plan-match'
import { matchSessionByStructure } from './plan'
import type { PlanSession } from './types'

const FTP = 250

/** A realistic 3×12min over-under: 2min @ 105% / 2min @ 88%, no lap markers. */
function overUnderRide() {
  const samples = [...steady(900, 140, 120)]
  for (let block = 0; block < 3; block++) {
    for (let rep = 0; rep < 3; rep++) {
      samples.push(...steady(120, 263, 168), ...steady(120, 220, 160))
    }
    if (block < 2) samples.push(...steady(300, 120, 125))
  }
  samples.push(...steady(600, 130, 120))
  return parseFitFile(buildFitFile({ samples, session: null }))
}

const prescribed: PlanSession = {
  id: 's1', plan_id: 'p1', client_id: 'c1',
  week: 3, dayOfWeek: 2, date: '2026-08-25',
  title: 'Over-unders 3x12',
  description: '3x12min over/under — 2min @ 105% FTP, 2min @ 90% FTP. 5min recovery between blocks.',
  sport: 'cycling', durationSecs: 4500, targetLoad: 95, intensity: 'threshold', sourceText: null,
}

describe('an over-under session, end to end', () => {
  it('is recognised as an over-under from an unlapped file', () => {
    const ride = summarizeFitRide(overUnderRide(), { ftp: FTP, hrMax: 185 })
    expect(ride.structure.archetype).toBe('over-under')
    expect(ride.structure.blocks).toHaveLength(3)
    expect(ride.structure.repScheme).toBe('3 × 12min')
    expect(ride.structure.inferredFromStream).toBe(true)
    expect(ride.structure.description).toContain('over-unders')
  })

  it('is scored as the session it was, not as the wrong workout', () => {
    const ride = summarizeFitRide(overUnderRide(), { ftp: FTP, hrMax: 185 })
    const result = compareToPlan(ride, prescribed, FTP)
    expect(result.verdict).toBe('as-prescribed')
    expect(result.structure?.verdict).toBe('same-structure')
    expect(result.notes[0]).toBe('This was the session as written.')
  })

  it('is still recognised when it was ridden a day late', () => {
    const ride = summarizeFitRide(overUnderRide(), { ftp: FTP, hrMax: 185 })
    const easyDay: PlanSession = { ...prescribed, id: 's2', dayOfWeek: 3, date: '2026-08-26', title: 'Endurance', description: '2h steady Z2', intensity: 'endurance' }
    const { session, movedFrom } = matchSessionByStructure([prescribed, easyDay], '2026-08-26', ride.structure)
    expect(session?.id).toBe('s1')
    expect(movedFrom).toBe('2026-08-25')
  })

  it('does not accuse the rider of fading on the under legs', () => {
    const ride = summarizeFitRide(overUnderRide(), { ftp: FTP, hrMax: 185 })
    const result = compareToPlan(ride, prescribed, FTP)
    expect(result.notes.some(n => n.includes('% FTP against roughly'))).toBe(false)
  })
})

describe('the cases that broke it in the field', () => {
  /** An over-under ridden raggedly, with drift across blocks and noisy power. */
  function raggedOverUnder() {
    const samples = [...steady(720, 135, 118)]
    let seed = 42
    const noisy = (secs: number, w: number, hr: number) => {
      const out = []
      for (let i = 0; i < secs; i++) {
        seed = (seed * 1103515245 + 12345) % 2147483648
        const jitter = ((seed / 2147483648) - 0.5) * 0.12 * w
        out.push({ power: Math.round(w + jitter), heartRate: hr })
      }
      return out
    }
    // Three blocks, each fading a little, as a tiring rider actually rides them.
    for (const [over, under] of [[262, 224], [256, 220], [248, 216]]) {
      for (let rep = 0; rep < 3; rep++) {
        samples.push(...noisy(120, over, 168), ...noisy(120, under, 161))
      }
      samples.push(...steady(300, 115, 128))
    }
    samples.push(...steady(480, 125, 120))
    return parseFitFile(buildFitFile({ samples, session: null }))
  }

  it('recognises a ragged, fading over-under', () => {
    const ride = summarizeFitRide(raggedOverUnder(), { ftp: FTP, hrMax: 185 })
    expect(ride.structure.archetype).toBe('over-under')
    expect(ride.structure.blocks.length).toBeGreaterThanOrEqual(3)
  })

  it('recognises it with an FTP 20% out of date', () => {
    // The client record says 200W when they are riding 250W efforts. Shape is
    // read from the ride, so the session is still identified.
    const stale = summarizeFitRide(raggedOverUnder(), { ftp: 200, hrMax: 185 })
    expect(stale.structure.archetype).toBe('over-under')
    expect(stale.structure.blocks.length).toBeGreaterThanOrEqual(3)
  })

  it('recognises it with no FTP on file at all', () => {
    const none = summarizeFitRide(raggedOverUnder(), { ftp: null, hrMax: 185 })
    expect(none.structure.archetype).toBe('over-under')
    expect(none.structure.classifiable).toBe(true)
  })

  it('still matches it to the prescribed session with a stale FTP', () => {
    const stale = summarizeFitRide(raggedOverUnder(), { ftp: 200, hrMax: 185 })
    const result = compareToPlan(stale, prescribed, 200)
    expect(result.structure?.verdict).not.toBe('different-structure')
    expect(result.verdict).not.toBe('different-session')
  })

  it('describes the segments in terms a coach would recognise', () => {
    const ride = summarizeFitRide(raggedOverUnder(), { ftp: FTP, hrMax: 185 })
    expect(ride.structure.segmentSummary).toMatch(/\d+ × \(/)
  })
})
