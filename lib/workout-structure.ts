import type { StreamData } from './decoupling'
import type { WorkInterval } from './ride-analysis'

/** Power is smoothed over this window before structure is read, to kill noise and coasting spikes. */
const SMOOTHING_SECS = 15
/** A sustained effort must run at least this long to count as a work interval. */
const MIN_EFFORT_SECS = 120
/** Effort detection floor, as a fraction of FTP. */
const EFFORT_FLOOR_FRAC = 0.88
/** A dip between efforts can be this long and still be inside one block. */
const MAX_INNER_DIP_SECS = 240
/** …but only if the dip is still ridden at working power. Below this it is a real recovery. */
const INNER_DIP_FLOOR_FRAC = 0.72

/** Over/under segment detection: sustained runs either side of threshold. */
const OVER_FRAC = 1.0
const UNDER_FRAC = 0.95
const MIN_SEGMENT_SECS = 45
/** Alternations needed inside a block before it reads as over-under rather than a ragged effort. */
const MIN_ALTERNATIONS = 3

export type WorkoutArchetype =
  | 'over-under'
  | 'vo2max'
  | 'threshold'
  | 'sweet-spot'
  | 'tempo'
  | 'endurance'
  | 'recovery'
  | 'sprints'
  | 'mixed'
  | 'unstructured'

export interface StructureBlock {
  startSecs: number
  endSecs: number
  durationSecs: number
  avgWatts: number
  avgPctFtp: number | null
  /** Sustained runs above and below threshold inside this block, in order. */
  segments: Array<{ side: 'over' | 'under'; secs: number; avgWatts: number }>
  /** How many times the block crossed between sustained over and under runs. */
  alternations: number
  isOverUnder: boolean
}

export interface RideStructure {
  archetype: WorkoutArchetype
  blocks: StructureBlock[]
  /** Reps × duration, e.g. "3 × 12min" — null when the blocks are not uniform. */
  repScheme: string | null
  avgWorkPctFtp: number | null
  /** A coach-readable line: "3 × 12min over-unders, alternating 2min @ 106% / 2min @ 88% FTP". */
  description: string
  /** True when intervals were inferred from the power stream rather than the rider's laps. */
  inferredFromStream: boolean
  /**
   * False when the ride could not be read at all — no FTP to measure efforts
   * against, and no laps to fall back on. "No structure found" and "could not
   * look" are different answers, and only the first is evidence about the ride.
   */
  classifiable: boolean
}

function smooth(watts: number[], window: number): number[] {
  if (watts.length === 0) return []
  const out = new Array<number>(watts.length)
  let sum = 0
  const half = Math.floor(window / 2)
  for (let i = 0; i < watts.length; i++) {
    sum += watts[i]
    if (i >= window) sum -= watts[i - window]
    out[Math.max(0, i - half)] = sum / Math.min(i + 1, window)
  }
  // Tail: carry the last computed value forward.
  for (let i = watts.length - half; i < watts.length; i++) {
    if (i >= 0) out[i] = out[Math.max(0, watts.length - half - 1)]
  }
  return out
}

function mean(values: number[]): number {
  return values.length > 0 ? values.reduce((s, v) => s + v, 0) / values.length : 0
}

/**
 * Find work intervals from the power stream itself.
 *
 * Riders forget to press lap, and a workout with no lap markers is not an
 * unstructured ride — it is a structured one the file failed to label. Without
 * this, an over-under session with no laps reads as a flat blob of tempo.
 */
export function detectIntervalsFromStream(
  streams: StreamData,
  ftp: number | null
): WorkInterval[] {
  const n = streams.watts.length
  if (n < MIN_EFFORT_SECS || !ftp || ftp <= 0) return []

  const sm = smooth(streams.watts, SMOOTHING_SECS)
  const floor = ftp * EFFORT_FLOOR_FRAC

  const raw: Array<{ start: number; end: number }> = []
  let start: number | null = null
  for (let i = 0; i < n; i++) {
    if (sm[i] >= floor) {
      if (start == null) start = i
    } else if (start != null) {
      raw.push({ start, end: i })
      start = null
    }
  }
  if (start != null) raw.push({ start, end: n })

  // Merge across a dip that is still being ridden hard. An over-under's "under"
  // leg sits below the effort floor for two full minutes by design — long
  // enough to look like the end of the interval, but ridden at ~90% FTP, which
  // a real recovery valley never is. The power in the gap is what separates
  // them, not its length.
  const merged: Array<{ start: number; end: number }> = []
  for (const effort of raw) {
    const last = merged[merged.length - 1]
    if (last) {
      const gapSecs = effort.start - last.end
      const gapPower = gapSecs > 0 ? mean(sm.slice(last.end, effort.start)) : Infinity
      if (gapSecs <= MAX_INNER_DIP_SECS && gapPower >= ftp * INNER_DIP_FLOOR_FRAC) {
        last.end = effort.end
        continue
      }
    }
    merged.push({ ...effort })
  }

  return merged
    .filter(e => e.end - e.start >= MIN_EFFORT_SECS)
    .map((e, i) => ({ startIndex: e.start, endIndex: e.end, label: `Effort ${i + 1}` }))
}

/** Sustained runs either side of threshold within one block. */
function segmentsOf(watts: number[], ftp: number): StructureBlock['segments'] {
  const sm = smooth(watts, SMOOTHING_SECS)
  const over = ftp * OVER_FRAC
  const under = ftp * UNDER_FRAC

  const raw: Array<{ side: 'over' | 'under'; from: number; to: number }> = []
  let side: 'over' | 'under' | null = null
  let from = 0
  for (let i = 0; i < sm.length; i++) {
    // Hysteresis: a sample only flips the side when it clears the far band,
    // so power hovering on threshold does not shred the block into slivers.
    const next: 'over' | 'under' | null = sm[i] >= over ? 'over' : sm[i] <= under ? 'under' : side
    if (next !== side) {
      if (side != null) raw.push({ side, from, to: i })
      side = next
      from = i
    }
  }
  if (side != null) raw.push({ side, from, to: sm.length })

  return raw
    .filter(s => s.to - s.from >= MIN_SEGMENT_SECS)
    .map(s => ({
      side: s.side,
      secs: s.to - s.from,
      avgWatts: Math.round(mean(watts.slice(s.from, s.to))),
    }))
}

function analyzeBlock(streams: StreamData, interval: WorkInterval, ftp: number | null): StructureBlock {
  const watts = streams.watts.slice(interval.startIndex, interval.endIndex)
  const avgWatts = Math.round(mean(watts))
  const segments = ftp && ftp > 0 ? segmentsOf(watts, ftp) : []

  let alternations = 0
  for (let i = 1; i < segments.length; i++) {
    if (segments[i].side !== segments[i - 1].side) alternations++
  }

  const overSecs = segments.filter(s => s.side === 'over').reduce((s, x) => s + x.secs, 0)
  const underSecs = segments.filter(s => s.side === 'under').reduce((s, x) => s + x.secs, 0)
  const total = overSecs + underSecs

  // An over-under has to actually spend meaningful time on both sides —
  // otherwise it is a threshold effort with a couple of surges.
  const balanced = total > 0 && overSecs / total >= 0.2 && underSecs / total >= 0.2

  return {
    startSecs: interval.startIndex,
    endSecs: interval.endIndex,
    durationSecs: interval.endIndex - interval.startIndex,
    avgWatts,
    avgPctFtp: ftp && ftp > 0 ? Math.round((avgWatts / ftp) * 100) : null,
    segments,
    alternations,
    isOverUnder: alternations >= MIN_ALTERNATIONS && balanced,
  }
}

function repScheme(blocks: StructureBlock[]): string | null {
  if (blocks.length < 2) return null
  const durations = blocks.map(b => Math.round(b.durationSecs / 60))
  const first = durations[0]
  // Within a minute of each other reads as the same prescription.
  const uniform = durations.every(d => Math.abs(d - first) <= 1)
  return uniform ? `${blocks.length} × ${first}min` : null
}

function archetypeOf(blocks: StructureBlock[], avgWorkPctFtp: number | null, ftp: number | null): WorkoutArchetype {
  if (blocks.length === 0) return 'unstructured'

  // Over-under is tested first: its average sits in the threshold band, so
  // testing by average alone would always call it a threshold session.
  const overUnders = blocks.filter(b => b.isOverUnder)
  if (overUnders.length >= Math.ceil(blocks.length / 2)) return 'over-under'

  if (!ftp || avgWorkPctFtp == null) return blocks.length >= 2 ? 'mixed' : 'unstructured'

  const avgDuration = mean(blocks.map(b => b.durationSecs))

  if (avgDuration <= 60 && avgWorkPctFtp >= 130) return 'sprints'
  if (avgWorkPctFtp >= 106) return 'vo2max'
  if (avgWorkPctFtp >= 95) return 'threshold'
  if (avgWorkPctFtp >= 84) return 'sweet-spot'
  if (avgWorkPctFtp >= 76) return 'tempo'
  if (avgWorkPctFtp >= 56) return 'endurance'
  return 'recovery'
}

const ARCHETYPE_LABELS: Record<WorkoutArchetype, string> = {
  'over-under': 'over-unders',
  vo2max: 'VO2max intervals',
  threshold: 'threshold intervals',
  'sweet-spot': 'sweet spot intervals',
  tempo: 'tempo work',
  endurance: 'steady endurance',
  recovery: 'recovery riding',
  sprints: 'sprints',
  mixed: 'mixed intervals',
  unstructured: 'no structured work',
}

function describe(
  archetype: WorkoutArchetype,
  blocks: StructureBlock[],
  scheme: string | null,
  ftp: number | null
): string {
  if (blocks.length === 0) return 'No structured work — a continuous ride.'

  const label = ARCHETYPE_LABELS[archetype]
  const head = scheme ? `${scheme} ${label}` : `${blocks.length} × ${label}`

  if (archetype === 'over-under') {
    const ou = blocks.find(b => b.isOverUnder)
    const over = ou?.segments.filter(s => s.side === 'over') ?? []
    const under = ou?.segments.filter(s => s.side === 'under') ?? []
    if (over.length > 0 && under.length > 0) {
      const overSecs = Math.round(mean(over.map(s => s.secs)))
      const underSecs = Math.round(mean(under.map(s => s.secs)))
      const pctOf = (w: number): number | null =>
        ftp && ftp > 0 ? Math.round((w / ftp) * 100) : null
      const overPct = pctOf(mean(over.map(s => s.avgWatts)))
      const underPct = pctOf(mean(under.map(s => s.avgWatts)))
      const alternation = overPct != null && underPct != null
        ? `, alternating ~${Math.round(overSecs / 60) || 1}min @ ${overPct}% / ~${Math.round(underSecs / 60) || 1}min @ ${underPct}% FTP`
        : ''
      return `${head}${alternation}`
    }
  }

  const pcts = blocks.map(b => b.avgPctFtp).filter((p): p is number => p != null)
  return pcts.length > 0
    ? `${head} averaging ${Math.round(mean(pcts))}% FTP`
    : head
}

/**
 * Read the shape of what was actually ridden.
 *
 * The point is to tell an over-under from a threshold session, and either from
 * a hard group ride — distinctions the duration and average power a plan is
 * written in cannot make, and the ones a coach makes at a glance.
 */
export function classifyRideStructure(
  streams: StreamData,
  lapIntervals: WorkInterval[],
  ftp: number | null
): RideStructure {
  const inferred = lapIntervals.length === 0
  const intervals = inferred ? detectIntervalsFromStream(streams, ftp) : lapIntervals

  const blocks = intervals.map(i => analyzeBlock(streams, i, ftp))
  const pcts = blocks.map(b => b.avgPctFtp).filter((p): p is number => p != null)
  const avgWorkPctFtp = pcts.length > 0 ? Math.round(mean(pcts)) : null
  const archetype = archetypeOf(blocks, avgWorkPctFtp, ftp)
  const scheme = repScheme(blocks)

  return {
    archetype,
    classifiable: (ftp != null && ftp > 0) || lapIntervals.length > 0,
    blocks,
    repScheme: scheme,
    avgWorkPctFtp,
    description: describe(archetype, blocks, scheme, ftp),
    inferredFromStream: inferred && blocks.length > 0,
  }
}

export interface PrescribedStructure {
  archetype: WorkoutArchetype | null
  reps: number | null
  repMinutes: number | null
  raw: string
}

const ARCHETYPE_PATTERNS: Array<{ archetype: WorkoutArchetype; pattern: RegExp }> = [
  { archetype: 'over-under', pattern: /over[\s\-/]?unders?|o\/u\b|over[\s\-]?over|under[\s\-]?over/i },
  { archetype: 'vo2max', pattern: /vo2|v02|max\s?aerobic|5\s?min\s?power/i },
  { archetype: 'threshold', pattern: /threshold|ftp\s?interval|lthr|\bLT2\b/i },
  { archetype: 'sweet-spot', pattern: /sweet\s?spot|\bSST\b|\bSS\b/i },
  { archetype: 'tempo', pattern: /tempo/i },
  { archetype: 'sprints', pattern: /sprint|neuromuscular|anaerobic/i },
  { archetype: 'endurance', pattern: /endurance|\bz2\b|zone\s?2|aerobic\s?base|long\s?ride/i },
  { archetype: 'recovery', pattern: /recovery|easy\s?spin|\bz1\b/i },
]

/**
 * Read the prescription's own words for structure.
 *
 * Plans say "3x12 over/unders (2min @105%, 2min @90%)" — the intent is in the
 * text, not in the duration field, and matching on text is how a ride done a
 * day late is still recognised as the session it was.
 */
export function parsePrescribedStructure(title: string, description: string | null): PrescribedStructure {
  const raw = [title, description ?? ''].join(' ').trim()

  const archetype = ARCHETYPE_PATTERNS.find(p => p.pattern.test(raw))?.archetype ?? null

  // "3x12", "3 x 12min", "3×12'"
  const repMatch = raw.match(/(?<!\d)(\d{1,2})\s*[x×]\s*(\d{1,3})\s*(?:min|m|'|″|”)?/i)
  const reps = repMatch ? Number(repMatch[1]) : null
  const repMinutes = repMatch ? Number(repMatch[2]) : null

  return {
    archetype,
    reps: reps != null && reps > 0 && reps <= 30 ? reps : null,
    repMinutes: repMinutes != null && repMinutes > 0 && repMinutes <= 240 ? repMinutes : null,
    raw,
  }
}

/**
 * Where each archetype sits on the intensity ladder.
 *
 * Used to tell "did the right shape, softer than asked" from "did something
 * else entirely" — a distinction the archetype name alone cannot make.
 */
const BANDS: Record<WorkoutArchetype, number> = {
  recovery: 0,
  endurance: 1,
  tempo: 2,
  'sweet-spot': 3,
  threshold: 4,
  'over-under': 4,
  vo2max: 5,
  sprints: 6,
  mixed: -1,
  unstructured: -1,
}

/** The intensity band of an archetype, or null when it could not be classified. */
export function archetypeBand(archetype: WorkoutArchetype): number | null {
  const band = BANDS[archetype]
  return band >= 0 ? band : null
}

export type StructureVerdict = 'same-structure' | 'similar-structure' | 'different-structure' | 'unknown'

export interface StructureComparison {
  verdict: StructureVerdict
  notes: string[]
}

/** Archetypes close enough that doing one where the other was written is a near miss, not a different session. */
const NEIGHBOURS: Record<string, WorkoutArchetype[]> = {
  'over-under': ['threshold'],
  threshold: ['over-under', 'sweet-spot'],
  'sweet-spot': ['threshold', 'tempo'],
  tempo: ['sweet-spot', 'endurance'],
  endurance: ['tempo', 'recovery'],
  recovery: ['endurance'],
  vo2max: ['threshold'],
  sprints: ['vo2max'],
}

/**
 * Did they do the session that was written, whatever the calendar says?
 *
 * This exists because matching on date and duration alone calls an over-under
 * done a day late "the wrong session", which is both wrong and the fastest way
 * for a coach to stop trusting the tool.
 */
export function compareStructures(
  ride: RideStructure,
  prescribed: PrescribedStructure
): StructureComparison {
  const notes: string[] = []

  if (!ride.classifiable) {
    return {
      verdict: 'unknown',
      notes: ['No FTP on file and no lap markers in the file, so the shape of this ride cannot be read.'],
    }
  }

  if (ride.archetype === 'mixed') {
    return {
      verdict: 'unknown',
      notes: ['The ride has interval structure, but without an FTP on file it cannot be classified.'],
    }
  }

  if (prescribed.archetype == null) {
    return {
      verdict: 'unknown',
      notes: [`The prescription does not say what kind of session it is; the ride itself was ${ride.description.toLowerCase()}.`],
    }
  }

  // A ride with no efforts in it is not a failed interval session when no
  // intervals were asked for — it is exactly what a Z2 day looks like. Whether
  // it was ridden at the right intensity is a separate judgement.
  const CONTINUOUS = new Set(['endurance', 'recovery', 'unstructured'])
  if (CONTINUOUS.has(prescribed.archetype) && CONTINUOUS.has(ride.archetype)) {
    return {
      verdict: 'same-structure',
      notes: ['A continuous ride, as prescribed — no interval structure was asked for.'],
    }
  }

  if (ride.archetype === 'unstructured') {
    return {
      verdict: 'different-structure',
      notes: [`${ARCHETYPE_LABELS[prescribed.archetype]} were prescribed, but the ride has no structured efforts in it.`],
    }
  }

  if (ride.archetype === prescribed.archetype) {
    notes.push(`Structure matches the prescription: ${ride.description}.`)
    if (prescribed.reps != null && ride.blocks.length > 0 && ride.blocks.length !== prescribed.reps) {
      notes.push(`${ride.blocks.length} efforts against ${prescribed.reps} prescribed.`)
      return { verdict: 'similar-structure', notes }
    }
    if (prescribed.repMinutes != null && ride.blocks.length > 0) {
      const avgMin = Math.round(mean(ride.blocks.map(b => b.durationSecs)) / 60)
      if (Math.abs(avgMin - prescribed.repMinutes) > Math.max(2, prescribed.repMinutes * 0.25)) {
        notes.push(`Efforts averaged ${avgMin}min against ${prescribed.repMinutes}min prescribed.`)
        return { verdict: 'similar-structure', notes }
      }
    }
    return { verdict: 'same-structure', notes }
  }

  if ((NEIGHBOURS[prescribed.archetype] ?? []).includes(ride.archetype)) {
    notes.push(`${ARCHETYPE_LABELS[prescribed.archetype]} were prescribed; the ride reads as ${ARCHETYPE_LABELS[ride.archetype]} — close, but not the session as written.`)
    return { verdict: 'similar-structure', notes }
  }

  notes.push(`${ARCHETYPE_LABELS[prescribed.archetype]} were prescribed; the ride was ${ARCHETYPE_LABELS[ride.archetype]}.`)
  return { verdict: 'different-structure', notes }
}
