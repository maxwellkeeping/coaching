import { Encoder, Profile } from '@garmin/fitsdk'

export interface FixtureSample {
  power?: number
  heartRate?: number
  cadence?: number
  /** Seconds to skip before writing this sample — used to simulate a dropout. */
  gapBefore?: number
}

export interface FixtureLap {
  startSecs: number
  endSecs: number
  intensity?: string
  avgPower?: number
  avgHeartRate?: number
}

export interface FixtureOptions {
  start?: Date
  samples: FixtureSample[]
  laps?: FixtureLap[]
  session?: Record<string, unknown> | null
  sport?: string
}

/**
 * Encode a synthetic .fit file for tests. Kept in lib/ rather than a fixtures
 * folder because it is the only way to exercise the parser without checking a
 * binary ride file into the repo.
 */
export function buildFitFile(opts: FixtureOptions): ArrayBuffer {
  const start = opts.start ?? new Date('2026-08-20T10:00:00Z')
  const enc = new Encoder()
  // The SDK's Encodable type only admits its own generated message shapes; the
  // fixtures build plain objects, so the write goes through one cast here.
  const write = (mesg: Record<string, unknown>) =>
    enc.writeMesg(mesg as unknown as Parameters<Encoder['writeMesg']>[0])

  write({
    mesgNum: Profile.MesgNum.FILE_ID,
    type: 'activity',
    manufacturer: 'garmin',
    product: 1,
    serialNumber: 1,
    timeCreated: start,
  })

  let t = 0
  for (const s of opts.samples) {
    t += s.gapBefore ?? 0
    write({
      mesgNum: Profile.MesgNum.RECORD,
      timestamp: new Date(start.getTime() + t * 1000),
      power: s.power ?? 0,
      heartRate: s.heartRate ?? 0,
      cadence: s.cadence ?? 85,
    })
    t += 1
  }

  for (const l of opts.laps ?? []) {
    write({
      mesgNum: Profile.MesgNum.LAP,
      startTime: new Date(start.getTime() + l.startSecs * 1000),
      timestamp: new Date(start.getTime() + l.endSecs * 1000),
      totalElapsedTime: l.endSecs - l.startSecs,
      totalTimerTime: l.endSecs - l.startSecs,
      intensity: l.intensity ?? 'active',
      avgPower: l.avgPower,
      avgHeartRate: l.avgHeartRate,
      event: 'lap',
      eventType: 'stop',
    })
  }

  if (opts.session !== null) {
    write({
      mesgNum: Profile.MesgNum.SESSION,
      startTime: start,
      timestamp: new Date(start.getTime() + t * 1000),
      sport: opts.sport ?? 'cycling',
      subSport: 'road',
      totalElapsedTime: t,
      totalTimerTime: t,
      ...(opts.session ?? {}),
    })
  }

  const bytes = enc.close()
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

/** A steady sample run — `secs` samples at the given power and HR. */
export function steady(secs: number, power: number, heartRate: number): FixtureSample[] {
  return Array.from({ length: secs }, () => ({ power, heartRate }))
}
