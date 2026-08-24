import { analyzeRide, type RideAnalysis, type WorkInterval } from './ride-analysis'
import type { StreamData } from './decoupling'
import type { FitLap, FitRecord, ParsedFit } from './fit-parser'

/** Gap (seconds) beyond which a hole in the recording is treated as a stop, not a dropout. */
const DROPOUT_TOLERANCE_SECS = 5
/** Minimum lap length to be considered a work interval rather than a marker. */
const MIN_WORK_LAP_SECS = 30
/** A lap set is only treated as structured work when the hardest lap is this much above the easiest. */
const WORK_LAP_SPREAD = 1.2

const WORK_INTENSITIES = new Set(['active', 'interval'])
const REST_INTENSITIES = new Set(['rest', 'warmup', 'cooldown', 'recovery'])

/**
 * Resample FIT records onto a strict 1Hz grid.
 *
 * analyzeRide's normalized power and best-effort maths assume one sample per
 * second, and head units drop samples (auto-pause, signal loss, smart
 * recording). Short holes carry the previous sample forward; anything longer
 * than DROPOUT_TOLERANCE_SECS is filled with zeros so a coffee stop reads as
 * coasting rather than as sustained power.
 */
export function toStreams(records: FitRecord[]): StreamData {
  if (records.length === 0) return { time: [], watts: [], heartrate: [] }

  const bySecond = new Map<number, FitRecord>()
  for (const r of records) {
    if (!bySecond.has(r.t)) bySecond.set(r.t, r)
  }

  const lastT = records[records.length - 1].t
  const time: number[] = []
  const watts: number[] = []
  const heartrate: number[] = []

  let carried: FitRecord | null = null
  let gap = 0
  for (let t = 0; t <= lastT; t++) {
    const here = bySecond.get(t)
    if (here) {
      carried = here
      gap = 0
    } else {
      gap++
    }
    const use = carried && gap <= DROPOUT_TOLERANCE_SECS ? carried : null
    time.push(t)
    watts.push(use ? use.watts : 0)
    heartrate.push(use ? use.hr : 0)
  }

  return { time, watts, heartrate }
}

/**
 * Pick out the work intervals from the head unit's laps.
 *
 * Structured workouts carry a FIT `intensity` on each lap and we trust it.
 * Manually lapped rides carry nothing, so laps are classified by power: a lap
 * counts as work when its average sits in the upper half of the lap spread,
 * and only when the spread is wide enough to imply the rider was actually
 * doing intervals rather than pressing lap at road junctions.
 */
export function detectWorkIntervals(laps: FitLap[]): WorkInterval[] {
  const usable = laps.filter(l => l.endSecs - l.startSecs >= MIN_WORK_LAP_SECS)
  if (usable.length < 2) return []

  const toInterval = (l: FitLap): WorkInterval => ({
    startIndex: l.startSecs,
    endIndex: l.endSecs,
    label: l.label,
  })

  const tagged = usable.filter(l => l.intensity && (WORK_INTENSITIES.has(l.intensity) || REST_INTENSITIES.has(l.intensity)))
  if (tagged.length === usable.length) {
    return usable.filter(l => WORK_INTENSITIES.has(l.intensity!)).map(toInterval)
  }

  const withPower = usable.filter((l): l is FitLap & { avgWatts: number } => l.avgWatts != null && l.avgWatts > 0)
  if (withPower.length < 2) return []

  const powers = withPower.map(l => l.avgWatts)
  const min = Math.min(...powers)
  const max = Math.max(...powers)
  if (min <= 0 || max / min < WORK_LAP_SPREAD) return []

  const threshold = (min + max) / 2
  return withPower.filter(l => l.avgWatts >= threshold).map(toInterval)
}

export interface FitLapSummary {
  lap: number
  label: string | null
  intensity: string | null
  durationSecs: number
  avgWatts: number | null
  maxWatts: number | null
  avgHr: number | null
}

export interface FitRideSummary {
  /** File-level facts, straight from the FIT messages. */
  source: {
    startTime: string | null
    sport: string | null
    subSport: string | null
    device: string | null
    hasPower: boolean
    hasHr: boolean
    sampleCount: number
  }
  /** Head-unit reported totals — kept alongside our own maths for comparison. */
  reported: {
    totalTimerSecs: number | null
    totalDistanceKm: number | null
    avgWatts: number | null
    normalizedPower: number | null
    avgHr: number | null
    maxHr: number | null
    avgCadence: number | null
    totalCalories: number | null
    totalAscentM: number | null
    trainingStressScore: number | null
    intensityFactor: number | null
  }
  /** Computed against the athlete's profile FTP — null when FTP is unknown. */
  intensityFactor: number | null
  tss: number | null
  analysis: RideAnalysis
  laps: FitLapSummary[]
}

export interface SummarizeOptions {
  ftp?: number | null
  hrMax?: number | null
}

/** Turn a parsed FIT file into the full coaching view of the ride. */
export function summarizeFitRide(parsed: ParsedFit, opts: SummarizeOptions = {}): FitRideSummary {
  const streams = toStreams(parsed.records)
  // Lap boundaries are seconds from the ride start, which on the 1Hz grid are
  // also array indices — clamped, since a lap can outrun the last record.
  const workIntervals = detectWorkIntervals(parsed.laps)
    .map(w => ({ ...w, endIndex: Math.min(w.endIndex, streams.watts.length) }))
    .filter(w => w.endIndex - w.startIndex >= MIN_WORK_LAP_SECS)
  const analysis = analyzeRide(streams, {
    ftp: opts.ftp,
    hrMax: opts.hrMax,
    workIntervals,
  })

  const np = analysis.power.normalizedPower
  const ftp = opts.ftp ?? null
  const intensityFactor = ftp && ftp > 0 && np != null ? +(np / ftp).toFixed(3) : null
  const tss = ftp && ftp > 0 && np != null && intensityFactor != null
    ? Math.round((analysis.durationSecs * np * intensityFactor) / (ftp * 3600) * 100)
    : null

  return {
    source: {
      startTime: parsed.startTime,
      sport: parsed.sport,
      subSport: parsed.subSport,
      device: parsed.device,
      hasPower: parsed.hasPower,
      hasHr: parsed.hasHr,
      sampleCount: parsed.records.length,
    },
    reported: {
      totalTimerSecs: parsed.session?.totalTimerSecs ?? null,
      totalDistanceKm: parsed.session?.totalDistanceM != null
        ? +(parsed.session.totalDistanceM / 1000).toFixed(2)
        : null,
      avgWatts: parsed.session?.avgWatts ?? null,
      normalizedPower: parsed.session?.normalizedPower ?? null,
      avgHr: parsed.session?.avgHr ?? null,
      maxHr: parsed.session?.maxHr ?? null,
      avgCadence: parsed.session?.avgCadence ?? null,
      totalCalories: parsed.session?.totalCalories ?? null,
      totalAscentM: parsed.session?.totalAscentM ?? null,
      trainingStressScore: parsed.session?.trainingStressScore ?? null,
      intensityFactor: parsed.session?.intensityFactor ?? null,
    },
    intensityFactor,
    tss,
    analysis,
    laps: parsed.laps.map((l, i) => ({
      lap: i + 1,
      label: l.label,
      intensity: l.intensity,
      durationSecs: l.endSecs - l.startSecs,
      avgWatts: l.avgWatts,
      maxWatts: l.maxWatts,
      avgHr: l.avgHr,
    })),
  }
}
