import type { ComplianceVerdict } from './plan-match'

/** Weeks of history needed before a trend is called rather than described. */
export const MIN_WEEKS_FOR_TREND = 3
/** EF change beyond this, week over week across the block, is a real move. */
export const EF_TREND_PCT = 3
/** Decoupling above this on aerobic rides is the aerobic system under strain. */
export const DECOUPLING_CONCERN_PCT = 6
/** Weekly load climbing faster than this is a ramp worth flagging. */
export const LOAD_RAMP_CONCERN_PCT = 15

/** The slice of a stored ride that progression maths needs. */
export interface RideRecord {
  id: string
  date: string
  title: string | null
  durationSecs: number
  tss: number | null
  avgWatts: number | null
  avgHr: number | null
  normalizedPower: number | null
  decoupling: number | null
  /** Fraction of FTP the ride sat at, used to split aerobic from quality work. */
  intensityFactor: number | null
  complianceVerdict: ComplianceVerdict | null
}

export interface WeekSummary {
  weekStart: string
  rides: number
  durationSecs: number
  load: number | null
  /** Efficiency factor (W/bpm) across the week's aerobic riding only. */
  aerobicEf: number | null
  avgDecoupling: number | null
  /** Sessions that matched the plan, out of those with a planned session. */
  compliance: { onPlan: number; assessed: number } | null
}

export type TrendDirection = 'improving' | 'flat' | 'declining' | 'insufficient-data'

export interface Progression {
  weeks: WeekSummary[]
  totals: {
    rides: number
    durationSecs: number
    load: number | null
    /** Share of planned sessions ridden as prescribed, 0–100. Null when nothing was planned. */
    compliancePct: number | null
  }
  aerobicEf: {
    first: number | null
    last: number | null
    changePct: number | null
    direction: TrendDirection
  }
  decoupling: {
    first: number | null
    last: number | null
    direction: TrendDirection
  }
  /** Week-over-week load change across the most recent pair, as a percentage. */
  loadRampPct: number | null
  /** Ready-made observations, each backed by a number. */
  observations: string[]
}

/** Monday of the week a date falls in. */
export function weekStartOf(date: string): string {
  const d = new Date(`${date}T12:00:00Z`)
  const dow = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() - (dow - 1))
  return d.toISOString().split('T')[0]
}

function mean(values: number[]): number | null {
  return values.length > 0 ? values.reduce((s, v) => s + v, 0) / values.length : null
}

/** Aerobic riding only — quality work inflates W/bpm and hides the aerobic trend. */
function isAerobic(r: RideRecord): boolean {
  return r.intensityFactor == null || r.intensityFactor <= 0.8
}

function efOf(r: RideRecord): number | null {
  return r.avgWatts != null && r.avgHr != null && r.avgHr > 0 ? r.avgWatts / r.avgHr : null
}

function direction(first: number | null, last: number | null, thresholdPct: number, higherIsBetter: boolean): TrendDirection {
  if (first == null || last == null || first === 0) return 'insufficient-data'
  const changePct = ((last - first) / Math.abs(first)) * 100
  if (Math.abs(changePct) < thresholdPct) return 'flat'
  const better = higherIsBetter ? changePct > 0 : changePct < 0
  return better ? 'improving' : 'declining'
}

/**
 * Summarise how a client's training is going across their uploaded rides.
 *
 * Everything is bucketed by calendar week, because that is the unit a plan is
 * written in and the unit a coach reasons in. Aerobic efficiency is the
 * headline trend: it is the one signal that separates "fitter" from "trying
 * harder", since it holds power against the heart rate that produced it.
 */
export function computeProgression(rides: RideRecord[]): Progression {
  const sorted = [...rides].sort((a, b) => a.date.localeCompare(b.date))

  const byWeek = new Map<string, RideRecord[]>()
  for (const r of sorted) {
    const key = weekStartOf(r.date)
    const bucket = byWeek.get(key)
    if (bucket) bucket.push(r)
    else byWeek.set(key, [r])
  }

  const weeks: WeekSummary[] = [...byWeek.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([weekStart, weekRides]) => {
      const loads = weekRides.map(r => r.tss).filter((t): t is number => t != null)
      const efs = weekRides.filter(isAerobic).map(efOf).filter((e): e is number => e != null)
      const decouplings = weekRides.map(r => r.decoupling).filter((d): d is number => d != null)
      const assessed = weekRides.filter(r => r.complianceVerdict != null && r.complianceVerdict !== 'unplanned')
      const onPlan = assessed.filter(r => r.complianceVerdict === 'as-prescribed')
      const ef = mean(efs)
      const dec = mean(decouplings)
      return {
        weekStart,
        rides: weekRides.length,
        durationSecs: weekRides.reduce((s, r) => s + r.durationSecs, 0),
        load: loads.length > 0 ? Math.round(loads.reduce((s, l) => s + l, 0)) : null,
        aerobicEf: ef != null ? +ef.toFixed(2) : null,
        avgDecoupling: dec != null ? +dec.toFixed(1) : null,
        compliance: assessed.length > 0 ? { onPlan: onPlan.length, assessed: assessed.length } : null,
      }
    })

  const efWeeks = weeks.filter(w => w.aerobicEf != null)
  const efFirst = efWeeks.length > 0 ? efWeeks[0].aerobicEf : null
  const efLast = efWeeks.length > 0 ? efWeeks[efWeeks.length - 1].aerobicEf : null
  const efChangePct = efFirst != null && efLast != null && efFirst > 0
    ? +(((efLast - efFirst) / efFirst) * 100).toFixed(1)
    : null

  const decWeeks = weeks.filter(w => w.avgDecoupling != null)
  const decFirst = decWeeks.length > 0 ? decWeeks[0].avgDecoupling : null
  const decLast = decWeeks.length > 0 ? decWeeks[decWeeks.length - 1].avgDecoupling : null

  const enoughWeeks = weeks.length >= MIN_WEEKS_FOR_TREND
  const efDirection = enoughWeeks && efWeeks.length >= 2
    ? direction(efFirst, efLast, EF_TREND_PCT, true)
    : 'insufficient-data'
  const decDirection = enoughWeeks && decWeeks.length >= 2
    ? direction(decFirst, decLast, 1, false)
    : 'insufficient-data'

  const loadWeeks = weeks.filter(w => w.load != null)
  const loadRampPct = loadWeeks.length >= 2
    ? (() => {
        const prev = loadWeeks[loadWeeks.length - 2].load!
        const curr = loadWeeks[loadWeeks.length - 1].load!
        return prev > 0 ? +(((curr - prev) / prev) * 100).toFixed(1) : null
      })()
    : null

  const assessedTotal = weeks.reduce((s, w) => s + (w.compliance?.assessed ?? 0), 0)
  const onPlanTotal = weeks.reduce((s, w) => s + (w.compliance?.onPlan ?? 0), 0)
  const allLoads = sorted.map(r => r.tss).filter((t): t is number => t != null)

  const observations: string[] = []

  if (efDirection === 'improving' && efChangePct != null) {
    observations.push(`Aerobic efficiency up ${efChangePct}% across the block (${efFirst} → ${efLast} W/bpm) — more power per heartbeat, which is fitness rather than effort.`)
  } else if (efDirection === 'declining' && efChangePct != null) {
    observations.push(`Aerobic efficiency down ${Math.abs(efChangePct)}% across the block (${efFirst} → ${efLast} W/bpm) — worth reading against fatigue and sleep before adding load.`)
  } else if (efDirection === 'flat' && efChangePct != null) {
    observations.push(`Aerobic efficiency flat across the block (${efFirst} → ${efLast} W/bpm, ${efChangePct}%).`)
  }

  if (decLast != null && decLast >= DECOUPLING_CONCERN_PCT) {
    observations.push(`Decoupling averaged ${decLast}% in the most recent week — above the ${DECOUPLING_CONCERN_PCT}% mark where the aerobic system is under real strain.`)
  } else if (decDirection === 'improving' && decFirst != null && decLast != null) {
    observations.push(`Decoupling down from ${decFirst}% to ${decLast}% — aerobic control is holding better late in rides.`)
  }

  if (loadRampPct != null && loadRampPct > LOAD_RAMP_CONCERN_PCT) {
    observations.push(`Weekly load jumped ${loadRampPct}% week over week — a ramp that steep is where things break.`)
  }

  if (assessedTotal > 0) {
    const pct = Math.round((onPlanTotal / assessedTotal) * 100)
    observations.push(`${onPlanTotal} of ${assessedTotal} planned sessions were ridden as prescribed (${pct}%).`)
  }

  if (weeks.length > 0 && weeks.length < MIN_WEEKS_FOR_TREND) {
    observations.push(`Only ${weeks.length} week${weeks.length === 1 ? '' : 's'} of uploaded rides so far — too little to call a trend.`)
  }

  return {
    weeks,
    totals: {
      rides: sorted.length,
      durationSecs: sorted.reduce((s, r) => s + r.durationSecs, 0),
      load: allLoads.length > 0 ? Math.round(allLoads.reduce((s, l) => s + l, 0)) : null,
      compliancePct: assessedTotal > 0 ? Math.round((onPlanTotal / assessedTotal) * 100) : null,
    },
    aerobicEf: { first: efFirst, last: efLast, changePct: efChangePct, direction: efDirection },
    decoupling: { first: decFirst, last: decLast, direction: decDirection },
    loadRampPct,
    observations,
  }
}
