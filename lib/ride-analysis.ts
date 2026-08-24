import { computeLapDecoupling, type StreamData, type LapBoundary } from './decoupling'

// Insight thresholds — sourced from docs/coaching-strategy.md and weekly-signals
export const DECOUPLING_CONCERN_PCT = 6      // whole-ride decoupling flag
export const DECOUPLING_CONTROLLED_PCT = 5   // "held control" on long rides
export const LONG_RIDE_SECS = 5400           // 90 min — long enough for decoupling to mean something
export const LATE_FADE_CONCERN_PCT = 5       // EF drop first third → final third
export const DURABILITY_KJ_THRESHOLD = 2000  // late-ride adaptations trigger past this
export const INTERVAL_FADE_CONCERN_PCT = 5   // back-half power fade within a work interval
export const HIGH_VARIABILITY_INDEX = 1.15   // punchy/unsteady pacing
export const HIGH_COASTING_PCT = 20

// Zone fractions of FTP — ceilings, matching the coach system prompt zones
const ZONE_DEFS = [
  { zone: 'Z1', label: 'Recovery', ceiling: 0.55 },
  { zone: 'Z2', label: 'Endurance', ceiling: 0.75 },
  { zone: 'Z3', label: 'Tempo', ceiling: 0.87 },
  { zone: 'Z4', label: 'Threshold', ceiling: 0.95 },
  { zone: 'Z5', label: 'VO2max', ceiling: 1.05 },
  { zone: 'Z6', label: 'Anaerobic', ceiling: Infinity },
]

export interface WorkInterval extends LapBoundary {
  label?: string | null
}

export interface ZoneTime {
  zone: string
  label: string
  secs: number
  pct: number
}

export interface ThirdSummary {
  third: 1 | 2 | 3
  avgWatts: number | null
  avgHr: number | null
  ef: number | null
  kj: number
}

export interface IntervalExecution {
  interval: number
  label: string | null
  durationSecs: number
  avgWatts: number | null
  avgHr: number | null
  pctFtp: number | null
  /** % power drop from first half to second half of the interval. Positive = faded. */
  fadePct: number | null
  decoupling: number | null
}

export interface BestEffort {
  durationSecs: number
  label: string
  watts: number
}

export interface RideAnalysis {
  durationSecs: number
  power: {
    avgWatts: number | null
    normalizedPower: number | null
    variabilityIndex: number | null
    totalKj: number
    coastingPct: number
    bestEfforts: BestEffort[]
  }
  hr: {
    avgHr: number | null
    maxHr: number | null
    /** % of ride time above 85% HRmax (threshold spikes) — null when hrMax unknown */
    pctAboveThresholdHr: number | null
  }
  /** Whole-ride cardiac decoupling %. Positive = HR drifted up relative to power. */
  decoupling: number | null
  /** Ride split into equal thirds — the durability view. */
  thirds: ThirdSummary[]
  /** EF drop from first third to final third, %. Positive = faded late. */
  lateFadePct: number | null
  zones: ZoneTime[] | null
  intervals: IntervalExecution[] | null
  /** % power drop from first work interval to last. Positive = fading across reps. */
  repFadePct: number | null
  /** Pre-computed, human-readable coaching flags. */
  insights: string[]
}

export interface AnalyzeRideOptions {
  ftp?: number | null
  hrMax?: number | null
  workIntervals?: WorkInterval[]
}

function sanitize(streams: StreamData): StreamData {
  const n = streams.watts?.length ?? 0
  const num = (v: unknown): number => (typeof v === 'number' && isFinite(v) ? v : 0)
  const watts = Array.from({ length: n }, (_, i) => num(streams.watts[i]))
  const heartrate = Array.from({ length: n }, (_, i) => num(streams.heartrate?.[i]))
  const time = streams.time?.length === n
    ? Array.from({ length: n }, (_, i) => num(streams.time[i]))
    : Array.from({ length: n }, (_, i) => i)
  return { time, watts, heartrate }
}

/** Per-sample durations, capped at 10s so recording pauses don't inflate time. */
function sampleDurations(time: number[]): number[] {
  return time.map((t, i) => {
    if (i === 0) return 1
    const dt = t - time[i - 1]
    return dt > 0 && dt <= 10 ? dt : 1
  })
}

function avg(arr: number[]): number | null {
  return arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : null
}

function avgEF(watts: number[], hr: number[]): number | null {
  const pairs = watts.map((w, i) => ({ w, hr: hr[i] })).filter(p => p.w > 0 && p.hr > 0)
  if (pairs.length === 0) return null
  const w = pairs.reduce((s, p) => s + p.w, 0) / pairs.length
  const h = pairs.reduce((s, p) => s + p.hr, 0) / pairs.length
  return w / h
}

/** Standard NP: 30-sample rolling average of power, 4th-power mean, 4th root. Assumes ~1Hz data. */
export function normalizedPower(watts: number[]): number | null {
  const WINDOW = 30
  if (watts.length < WINDOW) return null
  let windowSum = 0
  let fourthPowerSum = 0
  let count = 0
  for (let i = 0; i < watts.length; i++) {
    windowSum += watts[i]
    if (i >= WINDOW) windowSum -= watts[i - WINDOW]
    if (i >= WINDOW - 1) {
      const rolling = windowSum / WINDOW
      fourthPowerSum += rolling ** 4
      count++
    }
  }
  return count > 0 ? Math.round((fourthPowerSum / count) ** 0.25) : null
}

export function zoneDistribution(
  watts: number[],
  time: number[],
  ftp: number
): { zones: ZoneTime[]; coastingSecs: number; totalSecs: number } {
  const dts = sampleDurations(time)
  const secsByZone = ZONE_DEFS.map(() => 0)
  let coastingSecs = 0
  let totalSecs = 0
  for (let i = 0; i < watts.length; i++) {
    totalSecs += dts[i]
    if (watts[i] <= 0) {
      coastingSecs += dts[i]
      continue
    }
    const frac = watts[i] / ftp
    const zi = ZONE_DEFS.findIndex(z => frac <= z.ceiling)
    secsByZone[zi >= 0 ? zi : ZONE_DEFS.length - 1] += dts[i]
  }
  const zones = ZONE_DEFS.map((z, i) => ({
    zone: z.zone,
    label: z.label,
    secs: Math.round(secsByZone[i]),
    pct: totalSecs > 0 ? +((secsByZone[i] / totalSecs) * 100).toFixed(1) : 0,
  }))
  return { zones, coastingSecs: Math.round(coastingSecs), totalSecs: Math.round(totalSecs) }
}

/** Best rolling-average power for each duration (seconds). Assumes ~1Hz data. */
export function bestEfforts(
  watts: number[],
  durations: number[] = [5, 60, 300, 1200]
): BestEffort[] {
  const labels: Record<number, string> = { 5: '5s', 60: '1m', 300: '5m', 1200: '20m' }
  const prefix = new Array(watts.length + 1).fill(0)
  for (let i = 0; i < watts.length; i++) prefix[i + 1] = prefix[i] + watts[i]
  const results: BestEffort[] = []
  for (const d of durations) {
    if (d > watts.length) continue
    let best = 0
    for (let i = 0; i + d <= watts.length; i++) {
      const sum = prefix[i + d] - prefix[i]
      if (sum > best) best = sum
    }
    results.push({
      durationSecs: d,
      label: labels[d] ?? `${d}s`,
      watts: Math.round(best / d),
    })
  }
  return results
}

function summariseThird(streams: StreamData, start: number, end: number, third: 1 | 2 | 3): ThirdSummary {
  const watts = streams.watts.slice(start, end)
  const hr = streams.heartrate.slice(start, end).filter(h => h > 0)
  const dts = sampleDurations(streams.time).slice(start, end)
  const kj = watts.reduce((s, w, i) => s + w * dts[i], 0) / 1000
  const avgW = avg(watts)
  const avgH = avg(hr)
  const ef = avgEF(streams.watts.slice(start, end), streams.heartrate.slice(start, end))
  return {
    third,
    avgWatts: avgW != null ? Math.round(avgW) : null,
    avgHr: avgH != null ? Math.round(avgH) : null,
    ef: ef != null ? +ef.toFixed(2) : null,
    kj: Math.round(kj),
  }
}

export function intervalExecution(
  streams: StreamData,
  workIntervals: WorkInterval[],
  ftp?: number | null
): IntervalExecution[] {
  const decouplings = computeLapDecoupling(streams, workIntervals)
  return workIntervals.map((lap, i) => {
    const watts = streams.watts.slice(lap.startIndex, lap.endIndex)
    const hr = streams.heartrate.slice(lap.startIndex, lap.endIndex).filter(h => h > 0)
    const mid = Math.floor(watts.length / 2)
    const firstHalf = avg(watts.slice(0, mid))
    const secondHalf = avg(watts.slice(mid))
    const fadePct = firstHalf != null && secondHalf != null && firstHalf > 0
      ? +(((firstHalf - secondHalf) / firstHalf) * 100).toFixed(1)
      : null
    const avgW = avg(watts)
    const avgH = avg(hr)
    const durationSecs = streams.time[Math.min(lap.endIndex, streams.time.length) - 1] - streams.time[lap.startIndex]
    return {
      interval: i + 1,
      label: lap.label ?? null,
      durationSecs: Math.round(durationSecs > 0 ? durationSecs : watts.length),
      avgWatts: avgW != null ? Math.round(avgW) : null,
      avgHr: avgH != null ? Math.round(avgH) : null,
      pctFtp: ftp && avgW != null ? Math.round((avgW / ftp) * 100) : null,
      fadePct,
      decoupling: decouplings[i],
    }
  })
}

function generateInsights(a: RideAnalysis): string[] {
  const insights: string[] = []
  const hours = (a.durationSecs / 3600).toFixed(1)

  if (a.decoupling != null && a.decoupling >= DECOUPLING_CONCERN_PCT) {
    insights.push(`Whole-ride decoupling ${a.decoupling}% — above the ${DECOUPLING_CONCERN_PCT}% concern threshold; the aerobic system was under real strain.`)
  } else if (a.decoupling != null && a.decoupling < DECOUPLING_CONTROLLED_PCT && a.durationSecs >= LONG_RIDE_SECS) {
    insights.push(`Decoupling ${a.decoupling}% over ${hours}h — aerobic control held on a long ride. Good sign.`)
  }

  if (a.lateFadePct != null && a.lateFadePct >= LATE_FADE_CONCERN_PCT) {
    insights.push(`Efficiency (W/bpm) dropped ${a.lateFadePct}% from the first third to the final third — late-ride fade, the durability signal to watch.`)
  }

  if (a.power.totalKj >= DURABILITY_KJ_THRESHOLD) {
    insights.push(`${a.power.totalKj} kJ of total work — past the ~${DURABILITY_KJ_THRESHOLD} kJ threshold where durability adaptations trigger. Late-ride numbers on this ride are meaningful.`)
  }

  if (a.power.variabilityIndex != null && a.power.variabilityIndex >= HIGH_VARIABILITY_INDEX) {
    insights.push(`Variability index ${a.power.variabilityIndex} — power was punchy/stochastic rather than steady; NP is well above average power.`)
  }

  if (a.power.coastingPct >= HIGH_COASTING_PCT) {
    insights.push(`${a.power.coastingPct}% of ride time at 0W (coasting).`)
  }

  if (a.intervals && a.intervals.length > 0) {
    const faded = a.intervals.filter(i => i.fadePct != null && i.fadePct >= INTERVAL_FADE_CONCERN_PCT)
    if (faded.length > 0) {
      insights.push(`Back-half power faded ≥${INTERVAL_FADE_CONCERN_PCT}% in ${faded.length} of ${a.intervals.length} work intervals — a fatigue or pacing signal.`)
    }
    if (a.repFadePct != null && a.repFadePct >= INTERVAL_FADE_CONCERN_PCT) {
      insights.push(`The last work interval averaged ${a.repFadePct}% less power than the first — power dropped across reps.`)
    }
  }

  return insights
}

export function analyzeRide(rawStreams: StreamData, opts: AnalyzeRideOptions = {}): RideAnalysis {
  const streams = sanitize(rawStreams)
  const n = streams.watts.length
  const dts = sampleDurations(streams.time)
  const durationSecs = Math.round(dts.reduce((s, d) => s + d, 0))

  const avgW = avg(streams.watts.filter(w => w > 0))
  const np = normalizedPower(streams.watts)
  const vi = np != null && avgW != null && avgW > 0 ? +(np / avgW).toFixed(2) : null
  const totalKj = Math.round(streams.watts.reduce((s, w, i) => s + w * dts[i], 0) / 1000)
  const coastingSecs = dts.reduce((s, d, i) => s + (streams.watts[i] <= 0 ? d : 0), 0)
  const coastingPct = durationSecs > 0 ? +((coastingSecs / durationSecs) * 100).toFixed(1) : 0

  const hrValues = streams.heartrate.filter(h => h > 0)
  const avgH = avg(hrValues)
  const maxH = hrValues.length ? Math.max(...hrValues) : null
  let pctAboveThresholdHr: number | null = null
  if (opts.hrMax && durationSecs > 0) {
    const threshold = opts.hrMax * 0.85
    const above = dts.reduce((s, d, i) => s + (streams.heartrate[i] > threshold ? d : 0), 0)
    pctAboveThresholdHr = +((above / durationSecs) * 100).toFixed(1)
  }

  const [decoupling] = computeLapDecoupling(streams, [{ startIndex: 0, endIndex: n }])

  const third = Math.floor(n / 3)
  const thirds: ThirdSummary[] = n >= 9
    ? [
        summariseThird(streams, 0, third, 1),
        summariseThird(streams, third, 2 * third, 2),
        summariseThird(streams, 2 * third, n, 3),
      ]
    : []
  const ef1 = thirds[0]?.ef
  const ef3 = thirds[2]?.ef
  const lateFadePct = ef1 != null && ef3 != null && ef1 > 0
    ? +(((ef1 - ef3) / ef1) * 100).toFixed(1)
    : null

  const zones = opts.ftp
    ? zoneDistribution(streams.watts, streams.time, opts.ftp).zones
    : null

  const intervals = opts.workIntervals && opts.workIntervals.length > 0
    ? intervalExecution(streams, opts.workIntervals, opts.ftp)
    : null

  let repFadePct: number | null = null
  if (intervals && intervals.length >= 2) {
    const first = intervals[0].avgWatts
    const last = intervals[intervals.length - 1].avgWatts
    if (first != null && last != null && first > 0) {
      repFadePct = +(((first - last) / first) * 100).toFixed(1)
    }
  }

  const analysis: RideAnalysis = {
    durationSecs,
    power: {
      avgWatts: avgW != null ? Math.round(avgW) : null,
      normalizedPower: np,
      variabilityIndex: vi,
      totalKj,
      coastingPct,
      bestEfforts: bestEfforts(streams.watts),
    },
    hr: {
      avgHr: avgH != null ? Math.round(avgH) : null,
      maxHr: maxH,
      pctAboveThresholdHr,
    },
    decoupling,
    thirds,
    lateFadePct,
    zones,
    intervals,
    repFadePct,
    insights: [],
  }
  analysis.insights = generateInsights(analysis)
  return analysis
}
