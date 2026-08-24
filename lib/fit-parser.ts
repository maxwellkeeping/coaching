import { Decoder, Stream } from '@garmin/fitsdk'

/** A single 1Hz-ish sample from the FIT `record` messages. */
export interface FitRecord {
  /** Seconds since the first record in the file. */
  t: number
  watts: number
  hr: number
  cadence: number | null
  speed: number | null
  altitude: number | null
  distance: number | null
}

/** A lap (or interval) marker written by the head unit. */
export interface FitLap {
  startSecs: number
  endSecs: number
  label: string | null
  /** FIT lap intensity: active | rest | warmup | cooldown | recovery | interval. */
  intensity: string | null
  avgWatts: number | null
  maxWatts: number | null
  avgHr: number | null
}

export interface FitSession {
  totalTimerSecs: number | null
  totalElapsedSecs: number | null
  totalDistanceM: number | null
  avgWatts: number | null
  maxWatts: number | null
  normalizedPower: number | null
  avgHr: number | null
  maxHr: number | null
  avgCadence: number | null
  totalCalories: number | null
  totalAscentM: number | null
  /** Only present when the head unit computed them (device FTP must be set). */
  trainingStressScore: number | null
  intensityFactor: number | null
  thresholdPower: number | null
}

export interface ParsedFit {
  /** ISO timestamp of the first record, or null when the file carries no timestamps. */
  startTime: string | null
  sport: string | null
  subSport: string | null
  device: string | null
  records: FitRecord[]
  laps: FitLap[]
  session: FitSession | null
  hasPower: boolean
  hasHr: boolean
}

export class FitParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FitParseError'
  }
}

function num(v: unknown): number | null {
  return typeof v === 'number' && isFinite(v) ? v : null
}

function toMillis(v: unknown): number | null {
  if (v instanceof Date) return v.getTime()
  // The SDK hands back Date objects for DateTime fields; a raw number is a FIT
  // timestamp (seconds since 1989-12-31) and only ever appears on odd files.
  const n = num(v)
  return n != null ? (n + 631065600) * 1000 : null
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

/**
 * Decode a .fit file into the record/lap/session shapes the analysis layer needs.
 * Throws FitParseError when the bytes are not a FIT file or contain no ride data.
 */
export function parseFitFile(buffer: ArrayBuffer): ParsedFit {
  let messages: Record<string, Array<Record<string, unknown>>>
  try {
    const stream = Stream.fromArrayBuffer(buffer)
    const decoder = new Decoder(stream)
    if (!decoder.isFIT()) {
      throw new FitParseError('Not a FIT file — the header does not match the FIT format.')
    }
    // Deliberately not calling checkIntegrity(): plenty of real-world files from
    // third-party exporters carry a bad file CRC but decode perfectly.
    const result = decoder.read({ mesgListener: undefined })
    messages = result.messages as Record<string, Array<Record<string, unknown>>>
  } catch (e) {
    if (e instanceof FitParseError) throw e
    throw new FitParseError(`Could not decode the FIT file: ${e instanceof Error ? e.message : String(e)}`)
  }

  const recordMesgs = messages.recordMesgs ?? []
  if (recordMesgs.length === 0) {
    throw new FitParseError('The FIT file contains no ride records (no timestamped data points).')
  }

  const stamped = recordMesgs
    .map(m => ({ m, ms: toMillis(m.timestamp) }))
    .filter((x): x is { m: Record<string, unknown>; ms: number } => x.ms != null)
    .sort((a, b) => a.ms - b.ms)

  const source = stamped.length > 0 ? stamped.map(x => x.m) : recordMesgs
  const baseMs = stamped.length > 0 ? stamped[0].ms : null

  const records: FitRecord[] = source.map((m, i) => {
    const ms = toMillis(m.timestamp)
    return {
      t: baseMs != null && ms != null ? Math.round((ms - baseMs) / 1000) : i,
      watts: num(m.power) ?? 0,
      hr: num(m.heartRate) ?? 0,
      cadence: num(m.cadence),
      speed: num(m.enhancedSpeed) ?? num(m.speed),
      altitude: num(m.enhancedAltitude) ?? num(m.altitude),
      distance: num(m.distance),
    }
  })

  const laps: FitLap[] = (messages.lapMesgs ?? []).flatMap((m, i) => {
    const startMs = toMillis(m.startTime)
    const endMs = toMillis(m.timestamp)
    const elapsed = num(m.totalElapsedTime)
    if (baseMs == null || startMs == null) return []
    const startSecs = Math.round((startMs - baseMs) / 1000)
    const endSecs = endMs != null
      ? Math.round((endMs - baseMs) / 1000)
      : elapsed != null ? startSecs + Math.round(elapsed) : startSecs
    if (endSecs <= startSecs) return []
    return [{
      startSecs,
      endSecs,
      label: str(m.wktStepName) ?? str(m.eventGroup) ?? `Lap ${i + 1}`,
      intensity: str(m.intensity),
      avgWatts: num(m.avgPower),
      maxWatts: num(m.maxPower),
      avgHr: num(m.avgHeartRate),
    }]
  })

  const s = (messages.sessionMesgs ?? [])[0]
  const session: FitSession | null = s
    ? {
        totalTimerSecs: num(s.totalTimerTime),
        totalElapsedSecs: num(s.totalElapsedTime),
        totalDistanceM: num(s.totalDistance),
        avgWatts: num(s.avgPower),
        maxWatts: num(s.maxPower),
        normalizedPower: num(s.normalizedPower),
        avgHr: num(s.avgHeartRate),
        maxHr: num(s.maxHeartRate),
        avgCadence: num(s.avgCadence),
        totalCalories: num(s.totalCalories),
        totalAscentM: num(s.totalAscent),
        trainingStressScore: num(s.trainingStressScore),
        intensityFactor: num(s.intensityFactor),
        thresholdPower: num(s.thresholdPower),
      }
    : null

  const fileId = (messages.fileIdMesgs ?? [])[0]
  const device = fileId
    ? [str(fileId.manufacturer), str(fileId.garminProduct) ?? str(fileId.product)].filter(Boolean).join(' ') || null
    : null

  return {
    startTime: baseMs != null ? new Date(baseMs).toISOString() : null,
    sport: str(s?.sport) ?? null,
    subSport: str(s?.subSport) ?? null,
    device,
    records,
    laps,
    session,
    hasPower: records.some(r => r.watts > 0),
    hasHr: records.some(r => r.hr > 0),
  }
}
