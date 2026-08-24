import type { StreamData } from './decoupling'

/** Power is smoothed over this window before segmenting, to kill noise without blurring a 2min leg. */
const SMOOTHING_SECS = 10
/** Window compared either side of a candidate boundary. Shorter than a 2min leg, long enough to be steady. */
const CHANGE_WINDOW_SECS = 30
/** Relative step between those windows that counts as a change of level. */
const CHANGE_THRESHOLD = 0.12
/** Segments shorter than this are noise and get folded into a neighbour. */
const MIN_SEGMENT_SECS = 30
/** Adjacent segments within this of each other are the same level, and merge. */
const MERGE_TOLERANCE = 0.07
/** Fallback work/rest split when a ride's levels form no clear gap. */
const REST_FRACTION = 0.62
/** The adaptive work/rest boundary is kept inside this range of working power. */
const REST_BOUNDARY_MIN = 0.40
const REST_BOUNDARY_MAX = 0.85
/** A blip this short, with matching power either side of it, is a surge inside one segment. */
const TRANSIENT_MAX_SECS = 45

export interface Segment {
  startSecs: number
  endSecs: number
  durationSecs: number
  avgWatts: number
  /** Where this segment sits relative to the ride's own working power. */
  level: 'work' | 'rest'
}

export interface RepeatGroup {
  /** How many times the pattern repeats back to back. */
  reps: number
  /** One cycle of the pattern. */
  pattern: Segment[]
  startSecs: number
  endSecs: number
}

export interface SegmentedRide {
  segments: Segment[]
  /** Repeating structures found in the segment list — the "3 × (2min hard, 2min easy)" reading. */
  groups: RepeatGroup[]
  /** Median power across the ride's working segments — the ride's own reference level. */
  workingWatts: number
}

function smooth(watts: number[], window: number): number[] {
  if (watts.length === 0) return []
  const out = new Array<number>(watts.length).fill(0)
  let sum = 0
  const half = Math.floor(window / 2)
  for (let i = 0; i < watts.length; i++) {
    sum += watts[i]
    if (i >= window) sum -= watts[i - window]
    const idx = Math.max(0, i - half)
    out[idx] = sum / Math.min(i + 1, window)
  }
  for (let i = Math.max(0, watts.length - half); i < watts.length; i++) {
    out[i] = out[Math.max(0, watts.length - half - 1)]
  }
  return out
}

function mean(values: number[]): number {
  return values.length > 0 ? values.reduce((s, v) => s + v, 0) / values.length : 0
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/**
 * Split a ride into segments of steady power, without reference to FTP.
 *
 * This is the part a coach does by eye: "two minutes hard, two minutes easier,
 * six times". Deliberately FTP-free — the FTP on file is often stale or wrong,
 * and a workout's shape does not stop existing because the number is out of
 * date. Levels are judged against the ride's own working power instead.
 */
export function segmentRide(streams: StreamData): SegmentedRide {
  const watts = streams.watts
  if (watts.length < MIN_SEGMENT_SECS) {
    return { segments: [], groups: [], workingWatts: 0 }
  }

  const sm = smooth(watts, SMOOTHING_SECS)

  // Change-point detection: at each second, compare the half-minute before with
  // the half-minute after. A step between them is a boundary. A running mean
  // cannot do this job — inside an over-under it drifts to the average of the
  // overs and unders and stops seeing either.
  const w = CHANGE_WINDOW_SECS
  const scores = new Array<number>(sm.length).fill(0)
  for (let i = w; i < sm.length - w; i++) {
    const before = mean(sm.slice(i - w, i))
    const after = mean(sm.slice(i, i + w))
    const scale = Math.max(before, after)
    scores[i] = scale > 0 ? Math.abs(after - before) / scale : 0
  }

  // Keep local maxima above the threshold, spaced at least a segment apart, so
  // one transition yields one boundary rather than a cluster of them.
  const bounds: number[] = [0]
  for (let i = w; i < sm.length - w; i++) {
    if (scores[i] < CHANGE_THRESHOLD) continue
    let isPeak = true
    for (let j = Math.max(0, i - w); j < Math.min(scores.length, i + w); j++) {
      if (scores[j] > scores[i]) { isPeak = false; break }
    }
    if (isPeak && i - bounds[bounds.length - 1] >= MIN_SEGMENT_SECS) bounds.push(i)
  }
  bounds.push(sm.length)

  let segments: Segment[] = []
  for (let i = 0; i < bounds.length - 1; i++) {
    const start = bounds[i]
    const end = bounds[i + 1]
    if (end - start <= 0) continue
    segments.push({
      startSecs: start,
      endSecs: end,
      durationSecs: end - start,
      avgWatts: Math.round(mean(watts.slice(start, end))),
      level: 'work',
    })
  }

  segments = mergeSimilar(segments, watts)
  segments = absorbTransients(segments, watts)

  // The ride's own reference: the median of the segments in its upper half by
  // power, weighted by how long they ran.
  const sorted = [...segments].sort((a, b) => b.avgWatts - a.avgWatts)
  const upper = sorted.slice(0, Math.max(1, Math.ceil(sorted.length / 2)))
  const workingWatts = Math.round(median(upper.flatMap(s => new Array(Math.ceil(s.durationSecs / 30)).fill(s.avgWatts))))

  const boundary = restBoundary(segments, workingWatts)
  for (const s of segments) {
    s.level = s.avgWatts >= boundary ? 'work' : 'rest'
  }

  return { segments, groups: findRepeats(segments), workingWatts }
}

/**
 * Where work stops and rest begins, found in the ride's own levels.
 *
 * A fixed fraction of working power cannot do this: a warmup at 62% of the
 * day's efforts sits either side of any line you pick, and when it lands on the
 * wrong side it merges into the first interval and drags the whole reading
 * down a band. The levels in a real workout are clustered with a wide gap
 * between them, so split on the widest gap instead.
 */
function restBoundary(segments: Segment[], workingWatts: number): number {
  const fallback = workingWatts * REST_FRACTION
  const levels = [...new Set(segments.filter(s => s.durationSecs >= MIN_SEGMENT_SECS).map(s => s.avgWatts))]
    .sort((a, b) => b - a)
  if (levels.length < 2 || workingWatts <= 0) return fallback

  let bestGap = 0
  let boundary = fallback
  for (let i = 0; i < levels.length - 1; i++) {
    const gap = levels[i] > 0 ? (levels[i] - levels[i + 1]) / levels[i] : 0
    if (gap > bestGap) {
      bestGap = gap
      boundary = (levels[i] + levels[i + 1]) / 2
    }
  }

  // Too shallow a gap means the ride has no real work/rest distinction.
  if (bestGap < 0.15) return fallback

  const min = workingWatts * REST_BOUNDARY_MIN
  const max = workingWatts * REST_BOUNDARY_MAX
  return Math.min(Math.max(boundary, min), max)
}

function mergeSimilar(segments: Segment[], watts: number[]): Segment[] {
  const out: Segment[] = []
  for (const seg of segments) {
    const last = out[out.length - 1]
    const similar = last && last.avgWatts > 0 &&
      Math.abs(seg.avgWatts - last.avgWatts) / last.avgWatts <= MERGE_TOLERANCE
    // A sliver is not its own segment — fold it into whichever neighbour it
    // resembles, so one dropped-chain moment does not become a "level".
    const sliver = seg.durationSecs < MIN_SEGMENT_SECS

    if (last && (similar || sliver)) {
      last.endSecs = seg.endSecs
      last.durationSecs = last.endSecs - last.startSecs
      last.avgWatts = Math.round(mean(watts.slice(last.startSecs, last.endSecs)))
    } else {
      out.push({ ...seg })
    }
  }
  return out
}

/**
 * Fold a short blip back into its surroundings when the power either side of it
 * matches. A rider standing up for eight seconds mid-tempo has not started a
 * new interval, and reporting it as one turns a clean block into confetti.
 */
function absorbTransients(segments: Segment[], watts: number[]): Segment[] {
  const out = [...segments]
  for (let i = 1; i < out.length - 1; i++) {
    const [before, blip, after] = [out[i - 1], out[i], out[i + 1]]
    if (blip.durationSecs > TRANSIENT_MAX_SECS || before.avgWatts <= 0) continue
    const neighboursMatch =
      Math.abs(after.avgWatts - before.avgWatts) / before.avgWatts <= MERGE_TOLERANCE * 1.5
    if (!neighboursMatch) continue

    const merged: Segment = {
      startSecs: before.startSecs,
      endSecs: after.endSecs,
      durationSecs: after.endSecs - before.startSecs,
      avgWatts: Math.round(mean(watts.slice(before.startSecs, after.endSecs))),
      level: before.level,
    }
    out.splice(i - 1, 3, merged)
    i = Math.max(0, i - 2)
  }
  return out
}

/** Two segments are the same step of a pattern when duration and power both line up. */
function alike(a: Segment, b: Segment): boolean {
  const durRatio = Math.min(a.durationSecs, b.durationSecs) / Math.max(a.durationSecs, b.durationSecs)
  const powRatio = a.avgWatts > 0 && b.avgWatts > 0
    ? Math.min(a.avgWatts, b.avgWatts) / Math.max(a.avgWatts, b.avgWatts)
    : 0
  return durRatio >= 0.6 && powRatio >= 0.88
}

/**
 * Find repeating patterns in the segment list.
 *
 * An over-under is a two-step pattern repeated; 5×4min VO2 is a two-step
 * pattern repeated; a pyramid is not. Finding the repeat is what turns a list
 * of segments into a workout a coach would recognise by name.
 */
export function findRepeats(segments: Segment[]): RepeatGroup[] {
  const groups: RepeatGroup[] = []
  let i = 0

  while (i < segments.length) {
    let best: RepeatGroup | null = null

    for (let patternLen = 1; patternLen <= 3; patternLen++) {
      if (i + patternLen * 2 > segments.length) break
      const pattern = segments.slice(i, i + patternLen)
      let reps = 1
      let next = i + patternLen
      while (
        next + patternLen <= segments.length &&
        segments.slice(next, next + patternLen).every((s, k) => alike(s, pattern[k]))
      ) {
        reps++
        next += patternLen
      }
      // A two-step pattern repeated three times beats a one-step repeated twice.
      // A final effort whose recovery ran into the cooldown still counts as a
      // rep — "5 × 4min" is what was ridden, and what the plan will say.
      let end = next - 1
      if (reps >= 2 && next < segments.length && alike(segments[next], pattern[0])) {
        reps++
        end = next
      }

      if (reps >= 2 && (!best || reps * patternLen > (best.reps * best.pattern.length))) {
        best = {
          reps,
          pattern,
          startSecs: segments[i].startSecs,
          endSecs: segments[end].endSecs,
        }
      }
    }

    if (best) {
      groups.push(best)
      // Advance past what the group consumed, without running off the end when
      // the final rep was a partial cycle.
      let consumed = 0
      let at = i
      while (at < segments.length && segments[at].endSecs <= best.endSecs) { consumed++; at++ }
      i += Math.max(1, consumed)
    } else {
      i++
    }
  }

  return groups
}

function mins(secs: number): string {
  if (secs < 90) return `${secs}s`
  const m = Math.round(secs / 60)
  return `${m}min`
}

/**
 * The segment list as a coach would read it off a graph.
 *
 * This is what gets handed to the model for identification — the objective
 * shape of the ride, in the same terms a plan is written in.
 */
export function describeSegments(ride: SegmentedRide, ftp: number | null): string {
  if (ride.segments.length === 0) return 'No usable power data.'

  const pct = (w: number) => (ftp && ftp > 0 ? ` (${Math.round((w / ftp) * 100)}% FTP)` : '')

  const lines: string[] = []
  const claimed = new Set<number>()
  for (const g of ride.groups) {
    for (let s = g.startSecs; s <= g.endSecs; s++) claimed.add(s)
  }

  let cursor = 0
  for (const g of ride.groups) {
    for (const s of ride.segments) {
      if (s.startSecs >= cursor && s.endSecs <= g.startSecs) {
        lines.push(`${mins(s.startSecs)}–${mins(s.endSecs)}: ${mins(s.durationSecs)} @ ${s.avgWatts}W${pct(s.avgWatts)}`)
      }
    }
    const cycle = g.pattern.map(p => `${mins(p.durationSecs)} @ ${p.avgWatts}W${pct(p.avgWatts)}`).join(' then ')
    lines.push(`${mins(g.startSecs)}–${mins(g.endSecs)}: ${g.reps} × (${cycle})`)
    cursor = g.endSecs
  }
  for (const s of ride.segments) {
    if (s.startSecs >= cursor) {
      lines.push(`${mins(s.startSecs)}–${mins(s.endSecs)}: ${mins(s.durationSecs)} @ ${s.avgWatts}W${pct(s.avgWatts)}`)
    }
  }

  return lines.join('\n')
}
