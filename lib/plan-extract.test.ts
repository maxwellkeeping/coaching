import { describe, it, expect } from 'vitest'
import { parseExtractedPlan, PlanExtractionError, PLAN_EXTRACTION_PROMPT } from './plan-extract'

const valid = JSON.stringify({
  planName: '12-Week Gran Fondo Build',
  weeks: 2,
  startDate: '2026-09-07',
  sessions: [
    { week: 1, dayOfWeek: 2, title: 'Threshold 3x12', description: '3x12min @ 95% FTP, 5min recovery', sport: 'cycling', durationSecs: 4500, targetLoad: 85, intensity: 'threshold', sourceText: 'Tue: 3x12 threshold' },
    { week: 1, dayOfWeek: 1, title: 'Rest', description: null, sport: null, durationSecs: null, targetLoad: null, intensity: 'rest', sourceText: 'Mon: rest' },
    { week: 2, dayOfWeek: 6, title: 'Long endurance', description: '4h steady Z2', sport: 'cycling', durationSecs: 14400, targetLoad: 220, intensity: 'endurance', sourceText: 'Sat: 4h Z2' },
  ],
  warnings: [],
})

describe('PLAN_EXTRACTION_PROMPT', () => {
  it('pins the shape and the rules that keep extraction honest', () => {
    expect(PLAN_EXTRACTION_PROMPT).toContain('1 = Monday through 7 = Sunday')
    expect(PLAN_EXTRACTION_PROMPT).toContain('Never invent a session that is not in the PDF')
    expect(PLAN_EXTRACTION_PROMPT).toContain('Include rest days')
  })
})

describe('parseExtractedPlan', () => {
  it('reads a clean extraction and sorts sessions by week then day', () => {
    const plan = parseExtractedPlan(valid)
    expect(plan.planName).toBe('12-Week Gran Fondo Build')
    expect(plan.weeks).toBe(2)
    expect(plan.startDate).toBe('2026-09-07')
    expect(plan.sessions.map(s => s.title)).toEqual(['Rest', 'Threshold 3x12', 'Long endurance'])
    expect(plan.sessions[1]).toMatchObject({ durationSecs: 4500, targetLoad: 85, intensity: 'threshold' })
    expect(plan.warnings).toEqual([])
  })

  it('strips a markdown fence the model wrapped the JSON in', () => {
    expect(parseExtractedPlan('```json\n' + valid + '\n```').sessions).toHaveLength(3)
  })

  it('accepts weekday names in place of day numbers', () => {
    const plan = parseExtractedPlan(JSON.stringify({
      weeks: 1,
      sessions: [{ week: 1, dayOfWeek: 'Saturday', title: 'Long ride', intensity: 'endurance' }],
    }))
    expect(plan.sessions[0].dayOfWeek).toBe(6)
  })

  it('drops unreadable sessions and warns rather than guessing', () => {
    const plan = parseExtractedPlan(JSON.stringify({
      weeks: 1,
      sessions: [
        { week: 1, dayOfWeek: 3, title: 'Tempo', intensity: 'tempo' },
        { week: null, dayOfWeek: 4, title: 'Mystery', intensity: 'tempo' },
        { week: 1, dayOfWeek: 9, title: 'Bad day', intensity: 'tempo' },
      ],
    }))
    expect(plan.sessions).toHaveLength(1)
    expect(plan.warnings[0]).toContain('2 sessions could not be read')
  })

  it('falls back to an unknown intensity rather than inventing a band', () => {
    const plan = parseExtractedPlan(JSON.stringify({
      weeks: 1,
      sessions: [{ week: 1, dayOfWeek: 1, title: 'Something', intensity: 'sweet spot-ish' }],
    }))
    expect(plan.sessions[0].intensity).toBe('unknown')
  })

  it('reconciles a stated week count against the sessions actually found', () => {
    const plan = parseExtractedPlan(JSON.stringify({
      weeks: 12,
      sessions: [{ week: 1, dayOfWeek: 1, title: 'Ride', intensity: 'endurance' }],
    }))
    expect(plan.weeks).toBe(12)
    expect(plan.warnings[0]).toContain('says 12 weeks but sessions were found across 1')
  })

  it('ignores a start date that is not a real date', () => {
    const plan = parseExtractedPlan(JSON.stringify({ weeks: 1, startDate: 'week of Sept 7', sessions: [] }))
    expect(plan.startDate).toBeNull()
  })

  it('carries through the extraction warnings when the PDF is not a plan', () => {
    const plan = parseExtractedPlan(JSON.stringify({
      planName: null, weeks: 0, sessions: [], warnings: ['This appears to be a race result sheet, not a training plan.'],
    }))
    expect(plan.sessions).toEqual([])
    expect(plan.weeks).toBe(0)
    expect(plan.warnings[0]).toContain('race result sheet')
  })

  it('throws when the response is not JSON at all', () => {
    expect(() => parseExtractedPlan("I couldn't read that PDF.")).toThrow(PlanExtractionError)
  })

  it('treats a zero or negative duration as no duration given', () => {
    const plan = parseExtractedPlan(JSON.stringify({
      weeks: 1,
      sessions: [{ week: 1, dayOfWeek: 1, title: 'Ride', durationSecs: 0, intensity: 'endurance' }],
    }))
    expect(plan.sessions[0].durationSecs).toBeNull()
  })
})
