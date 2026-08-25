import { describe, it, expect } from 'vitest'
import { buildIdentifyPrompt, parseIdentification, candidatesFor, type IdentifyCandidate } from './session-identify'
import { summarizeFitRide } from './fit-analysis'
import { parseFitFile } from './fit-parser'
import { buildFitFile, steady } from './fit-fixture'
import type { PlanSession } from './types'

function session(partial: Partial<PlanSession> & { id: string }): PlanSession {
  return {
    plan_id: 'p1', client_id: 'c1', week: 1, dayOfWeek: 2, date: '2026-08-25',
    title: 'Session', description: null, sport: 'cycling',
    durationSecs: 3600, targetLoad: null, intensity: 'threshold', sourceText: null,
    ...partial,
  }
}

const candidates: IdentifyCandidate[] = [
  { id: 'a', date: '2026-08-25', title: 'Over-unders 3x12', description: '3x12min, 2min @105% / 2min @90%', durationSecs: 4500, targetLoad: 95, intensity: 'threshold' },
  { id: 'b', date: '2026-08-26', title: 'Endurance', description: '2h Z2', durationSecs: 7200, targetLoad: 110, intensity: 'endurance' },
]

function overUnderRide() {
  const samples = [...steady(900, 140, 120)]
  for (let block = 0; block < 3; block++) {
    for (let rep = 0; rep < 3; rep++) samples.push(...steady(120, 262, 168), ...steady(120, 224, 160))
    if (block < 2) samples.push(...steady(300, 120, 125))
  }
  samples.push(...steady(600, 130, 120))
  return summarizeFitRide(parseFitFile(buildFitFile({ samples, session: null })), { ftp: 250 })
}

describe('buildIdentifyPrompt', () => {
  it('puts the measured segments and the plan’s own words side by side', () => {
    const prompt = buildIdentifyPrompt(overUnderRide(), '2026-08-26', candidates)
    expect(prompt).toMatch(/\d+ × \(/)                       // the segment table
    expect(prompt).toContain('3x12min, 2min @105% / 2min @90%')  // the prescription verbatim
    expect(prompt).toContain('ID: a')
    expect(prompt).toContain('ID: b')
  })

  it('tells the matcher that the date is the weakest signal', () => {
    const prompt = buildIdentifyPrompt(overUnderRide(), '2026-08-26', candidates)
    expect(prompt).toContain('Judge on structure first')
    expect(prompt).toContain('weakest signal')
  })
})

describe('parseIdentification', () => {
  it('reads a clean match', () => {
    const result = parseIdentification(
      JSON.stringify({ sessionId: 'a', confidence: 'high', reasoning: 'Three 12min blocks alternating 262W and 224W.' }),
      candidates
    )
    expect(result.sessionId).toBe('a')
    expect(result.confidence).toBe('high')
    expect(result.reasoning).toContain('262W')
  })

  it('strips a markdown fence', () => {
    const result = parseIdentification('```json\n{"sessionId":"b","confidence":"medium","reasoning":"Steady."}\n```', candidates)
    expect(result.sessionId).toBe('b')
  })

  it('refuses a session ID that was never offered', () => {
    const result = parseIdentification(
      JSON.stringify({ sessionId: 'invented', confidence: 'high', reasoning: 'x' }),
      candidates
    )
    expect(result.sessionId).toBeNull()
  })

  it('accepts a genuine no-match', () => {
    const result = parseIdentification(
      JSON.stringify({ sessionId: null, confidence: 'high', reasoning: 'A 20min commute matching nothing in the plan.' }),
      candidates
    )
    expect(result.sessionId).toBeNull()
    expect(result.reasoning).toContain('commute')
  })

  it('degrades safely when the response is not JSON', () => {
    const result = parseIdentification('I think this is the over-under session.', candidates)
    expect(result.sessionId).toBeNull()
    expect(result.confidence).toBe('low')
  })

  it('defaults an unrecognised confidence to low', () => {
    const result = parseIdentification(JSON.stringify({ sessionId: 'a', confidence: 'certain', reasoning: 'x' }), candidates)
    expect(result.confidence).toBe('low')
  })
})

describe('candidatesFor', () => {
  const sessions = [
    session({ id: 'a', date: '2026-08-25', title: 'Over-unders' }),
    session({ id: 'b', date: '2026-08-26', title: 'Endurance', intensity: 'endurance' }),
    session({ id: 'c', date: '2026-08-27', title: 'Rest', intensity: 'rest' }),
    session({ id: 'd', date: '2026-09-20', title: 'Much later' }),
  ]

  it('offers the sessions near the ride and drops rest days', () => {
    const result = candidatesFor(sessions, '2026-08-26')
    expect(result.map(c => c.id)).toEqual(['a', 'b'])
  })

  it('reaches wide enough to catch a session moved by several days', () => {
    const result = candidatesFor(sessions, '2026-08-31')
    expect(result.map(c => c.id)).toContain('a')
  })

  it('does not reach across the whole plan', () => {
    expect(candidatesFor(sessions, '2026-08-26').map(c => c.id)).not.toContain('d')
  })

  it('offers everything when the file has no date', () => {
    expect(candidatesFor(sessions, null).length).toBe(3)
  })
})
