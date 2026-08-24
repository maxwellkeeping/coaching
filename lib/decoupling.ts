export interface StreamData {
  time: number[]
  watts: number[]
  heartrate: number[]
}

export interface LapBoundary {
  startIndex: number
  endIndex: number
}

function avgEF(watts: number[], hr: number[]): number | null {
  const validPairs = watts
    .map((w, i) => ({ w, hr: hr[i] }))
    .filter(p => p.w > 0 && p.hr > 0)
  if (validPairs.length === 0) return null
  const avgW = validPairs.reduce((s, p) => s + p.w, 0) / validPairs.length
  const avgHr = validPairs.reduce((s, p) => s + p.hr, 0) / validPairs.length
  return avgW / avgHr
}

/**
 * Computes cardiac decoupling (%) for each lap.
 * Positive = HR drifted up relative to power (aerobic system under stress).
 * Negative = HR drifted down (unusual, typically early in a session).
 * Returns null for a lap if streams are too short or lack valid data.
 */
export function computeLapDecoupling(
  streams: StreamData,
  laps: LapBoundary[]
): (number | null)[] {
  return laps.map(({ startIndex, endIndex }) => {
    const len = endIndex - startIndex
    if (len < 4) return null

    const mid = startIndex + Math.floor(len / 2)

    const firstWatts = streams.watts.slice(startIndex, mid)
    const firstHr = streams.heartrate.slice(startIndex, mid)
    const secondWatts = streams.watts.slice(mid, endIndex)
    const secondHr = streams.heartrate.slice(mid, endIndex)

    const ef1 = avgEF(firstWatts, firstHr)
    const ef2 = avgEF(secondWatts, secondHr)

    if (ef1 == null || ef2 == null || ef1 === 0) return null

    return +(((ef1 - ef2) / ef1) * 100).toFixed(2)
  })
}
