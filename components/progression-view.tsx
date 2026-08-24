'use client'

import { Card, COLORS, Stat, formatDuration } from './ui'
import type { Progression } from '@/lib/progression'

const DIRECTION_TONE: Record<string, { label: string; color: string }> = {
  improving: { label: 'Improving', color: COLORS.good },
  flat: { label: 'Flat', color: COLORS.muted },
  declining: { label: 'Declining', color: COLORS.bad },
  'insufficient-data': { label: 'Too early to call', color: COLORS.muted },
}

/** The block view: weekly load and efficiency, with the trend called out. */
export function ProgressionView({ progression }: { progression: Progression }) {
  const { weeks, totals, aerobicEf, decoupling } = progression
  const efTone = DIRECTION_TONE[aerobicEf.direction]

  if (weeks.length === 0) {
    return (
      <Card>
        <div className="text-sm" style={{ color: COLORS.body }}>
          No rides uploaded yet. Upload this client&apos;s ride files and their progression builds up here.
        </div>
      </Card>
    )
  }

  const maxLoad = Math.max(...weeks.map(w => w.load ?? 0), 1)

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Stat label="Rides" value={`${totals.rides}`} sub={formatDuration(totals.durationSecs)} />
        <Stat label="Total load" value={totals.load != null ? `${totals.load}` : '—'} sub="TSS" />
        <Stat
          label="Aerobic EF"
          value={aerobicEf.last != null ? `${aerobicEf.last}` : '—'}
          sub={aerobicEf.changePct != null ? `${aerobicEf.changePct > 0 ? '+' : ''}${aerobicEf.changePct}% over block` : 'W/bpm'}
          tone={efTone.color}
        />
        <Stat
          label="On plan"
          value={totals.compliancePct != null ? `${totals.compliancePct}%` : '—'}
          sub="sessions as prescribed"
        />
      </div>

      <Card>
        <div className="flex items-center justify-between mb-3">
          <div className="text-xs font-semibold uppercase tracking-widest" style={{ color: COLORS.muted }}>By week</div>
          <div className="text-[11px]" style={{ color: efTone.color }}>Aerobic efficiency: {efTone.label}</div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]" style={{ color: COLORS.body }}>
            <thead>
              <tr className="text-left" style={{ color: COLORS.muted }}>
                <th className="py-1 pr-3 font-medium">Week of</th>
                <th className="py-1 pr-3 font-medium">Rides</th>
                <th className="py-1 pr-3 font-medium">Time</th>
                <th className="py-1 pr-3 font-medium">Load</th>
                <th className="py-1 pr-3 font-medium">EF</th>
                <th className="py-1 pr-3 font-medium">Decoupling</th>
                <th className="py-1 font-medium">On plan</th>
              </tr>
            </thead>
            <tbody>
              {weeks.map(w => (
                <tr key={w.weekStart} className="border-t border-slate-700/40">
                  <td className="py-1.5 pr-3">{w.weekStart}</td>
                  <td className="py-1.5 pr-3">{w.rides}</td>
                  <td className="py-1.5 pr-3">{formatDuration(w.durationSecs)}</td>
                  <td className="py-1.5 pr-3">
                    <span className="inline-flex items-center gap-2">
                      {w.load ?? '—'}
                      {w.load != null && (
                        <span className="inline-block h-1.5 rounded-full" style={{ width: `${(w.load / maxLoad) * 48}px`, backgroundColor: COLORS.accent }} />
                      )}
                    </span>
                  </td>
                  <td className="py-1.5 pr-3">{w.aerobicEf ?? '—'}</td>
                  <td className="py-1.5 pr-3" style={{ color: (w.avgDecoupling ?? 0) >= 6 ? COLORS.bad : undefined }}>
                    {w.avgDecoupling != null ? `${w.avgDecoupling}%` : '—'}
                  </td>
                  <td className="py-1.5">{w.compliance ? `${w.compliance.onPlan}/${w.compliance.assessed}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {decoupling.last != null && (
          <div className="text-[11px] mt-3" style={{ color: COLORS.muted }}>
            Decoupling {decoupling.first ?? '—'}% → {decoupling.last}% across the block.
          </div>
        )}
      </Card>

      {progression.observations.length > 0 && (
        <Card>
          <div className="text-xs font-semibold uppercase tracking-widest mb-2" style={{ color: COLORS.muted }}>Read</div>
          <ul className="space-y-1.5">
            {progression.observations.map((o, i) => (
              <li key={i} className="text-sm" style={{ color: COLORS.body }}>• {o}</li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  )
}
