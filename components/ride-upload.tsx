'use client'

import { useRef, useState } from 'react'
import { Button, Card, COLORS, ErrorNote, INPUT, Stat, VERDICT_TONE, formatDuration } from './ui'
import type { FitRideSummary } from '@/lib/fit-analysis'
import type { PlanComparison } from '@/lib/plan-match'

export interface RideFeedback {
  headline: string
  executionSummary: string
  whatWentWell: string[]
  concerns: string[]
  progressAssessment: string
  clientMessage: string
}

export interface PendingChange {
  id: string
  summary: string
  rationale: string | null
  changes: Record<string, unknown>
  plan_session_id: string
}

export interface RideResult {
  rideId: string
  movedFrom?: string | null
  filename: string
  rideDate: string | null
  ride: FitRideSummary
  comparison: PlanComparison
  feedback: RideFeedback
  pendingChanges: PendingChange[]
  hasPlan: boolean
}

function ZoneBar({ zones }: { zones: NonNullable<FitRideSummary['analysis']['zones']> }) {
  const colors: Record<string, string> = {
    Z1: '#475569', Z2: '#3b82f6', Z3: '#22c55e', Z4: '#eab308', Z5: '#f97316', Z6: '#ef4444',
  }
  const shown = zones.filter(z => z.pct > 0)
  if (shown.length === 0) return null
  return (
    <div>
      <div className="flex h-3 rounded-full overflow-hidden">
        {shown.map(z => (
          <div key={z.zone} style={{ width: `${z.pct}%`, backgroundColor: colors[z.zone] ?? '#475569' }} title={`${z.zone} ${z.label} ${z.pct}%`} />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2">
        {shown.map(z => (
          <span key={z.zone} className="text-[11px]" style={{ color: COLORS.body }}>
            <span className="inline-block w-2 h-2 rounded-full mr-1" style={{ backgroundColor: colors[z.zone] ?? '#475569' }} />
            {z.zone} {z.pct}%
          </span>
        ))}
      </div>
    </div>
  )
}

function IntervalTable({ intervals }: { intervals: NonNullable<FitRideSummary['analysis']['intervals']> }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[11px]" style={{ color: COLORS.body }}>
        <thead>
          <tr className="text-left" style={{ color: COLORS.muted }}>
            <th className="py-1 pr-3 font-medium">#</th>
            <th className="py-1 pr-3 font-medium">Time</th>
            <th className="py-1 pr-3 font-medium">Power</th>
            <th className="py-1 pr-3 font-medium">% FTP</th>
            <th className="py-1 pr-3 font-medium">HR</th>
            <th className="py-1 pr-3 font-medium">Fade</th>
            <th className="py-1 font-medium">Decoupling</th>
          </tr>
        </thead>
        <tbody>
          {intervals.map(i => (
            <tr key={i.interval} className="border-t border-slate-700/40">
              <td className="py-1.5 pr-3">{i.interval}</td>
              <td className="py-1.5 pr-3">{formatDuration(i.durationSecs)}</td>
              <td className="py-1.5 pr-3">{i.avgWatts != null ? `${i.avgWatts}W` : '—'}</td>
              <td className="py-1.5 pr-3">{i.pctFtp != null ? `${i.pctFtp}%` : '—'}</td>
              <td className="py-1.5 pr-3">{i.avgHr ?? '—'}</td>
              <td className="py-1.5 pr-3" style={{ color: (i.fadePct ?? 0) >= 5 ? COLORS.bad : undefined }}>
                {i.fadePct != null ? `${i.fadePct}%` : '—'}
              </td>
              <td className="py-1.5">{i.decoupling != null ? `${i.decoupling}%` : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ChangeRow({ change, onActioned }: { change: PendingChange; onActioned: () => void }) {
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<'pending' | 'applied' | 'dismissed'>('pending')
  const [error, setError] = useState('')

  const act = async (action: 'apply' | 'dismiss') => {
    setBusy(true)
    setError('')
    try {
      const res = await fetch(`/api/plan-changes/${change.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Failed')
      setStatus(action === 'apply' ? 'applied' : 'dismissed')
      onActioned()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-lg border border-slate-700/50 p-3" style={{ backgroundColor: COLORS.card }}>
      <div className="text-sm">{change.summary}</div>
      {change.rationale && (
        <div className="text-[11px] mt-1" style={{ color: COLORS.muted }}>{change.rationale}</div>
      )}
      {error && <div className="text-[11px] mt-2" style={{ color: COLORS.bad }}>{error}</div>}
      {status === 'pending' ? (
        <div className="flex gap-2 mt-3">
          <Button onClick={() => act('apply')} disabled={busy}>{busy ? 'Applying…' : 'Apply to plan'}</Button>
          <Button onClick={() => act('dismiss')} disabled={busy} variant="ghost">Dismiss</Button>
        </div>
      ) : (
        <div className="text-[11px] mt-2" style={{ color: status === 'applied' ? COLORS.good : COLORS.muted }}>
          {status === 'applied' ? '✓ Applied to the plan' : 'Dismissed'}
        </div>
      )}
    </div>
  )
}

/** Upload one ride file for a client and show the full read-out. */
export function RideUpload({ clientId, hasPlan, onUploaded }: {
  clientId: string
  hasPlan: boolean
  onUploaded: () => void
}) {
  const [file, setFile] = useState<File | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<RideResult | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const upload = async () => {
    if (!file) return
    setBusy(true)
    setError('')
    setResult(null)
    try {
      const form = new FormData()
      form.append('file', file)
      if (note.trim()) form.append('note', note.trim())
      const res = await fetch(`/api/clients/${clientId}/rides`, { method: 'POST', body: form })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Analysis failed')
      setResult(json as RideResult)
      setFile(null)
      setNote('')
      onUploaded()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const analysis = result?.ride.analysis
  const verdict = result ? VERDICT_TONE[result.comparison.verdict] : null

  return (
    <div className="space-y-4">
      <Card>
        <div
          onClick={() => inputRef.current?.click()}
          onDragOver={e => e.preventDefault()}
          onDrop={e => { e.preventDefault(); setFile(e.dataTransfer.files?.[0] ?? null) }}
          className="rounded-lg border-2 border-dashed border-slate-700/70 p-6 text-center cursor-pointer hover:border-slate-600"
        >
          <input
            ref={inputRef}
            type="file"
            accept=".fit"
            className="hidden"
            onChange={e => { setFile(e.target.files?.[0] ?? null); setError('') }}
          />
          <div className="text-sm">{file ? file.name : 'Drop the client’s .fit file here, or click to choose'}</div>
          <div className="text-[11px] mt-1" style={{ color: COLORS.muted }}>
            {file ? `${(file.size / 1024 / 1024).toFixed(1)} MB` : 'Garmin, Wahoo, Hammerhead, Zwift — 25MB max'}
          </div>
        </div>

        <textarea
          value={note}
          onChange={e => setNote(e.target.value)}
          rows={2}
          placeholder="Optional: anything the file will not show — illness, heat, a mechanical, what they told you about the session."
          className="w-full mt-3 px-3 py-2 rounded-lg text-sm outline-none resize-none"
          style={INPUT}
        />

        <div className="mt-3 flex items-center gap-3">
          <Button onClick={upload} disabled={!file || busy}>
            {busy ? 'Analyzing…' : 'Analyze ride'}
          </Button>
          {!hasPlan && (
            <span className="text-[11px]" style={{ color: COLORS.warn }}>
              No plan loaded — the ride will be analyzed, but there is nothing to compare it against.
            </span>
          )}
        </div>

        {error && <div className="mt-3"><ErrorNote>{error}</ErrorNote></div>}
        {busy && (
          <div className="mt-3 text-sm" style={{ color: COLORS.muted }}>
            Parsing the file, comparing it to the plan, and reading it against the block so far.
          </div>
        )}
      </Card>

      {result && analysis && (
        <div className="space-y-4">
          <Card>
            <div className="text-[10px] uppercase tracking-widest mb-1" style={{ color: verdict?.color }}>
              {verdict?.label}
            </div>
            <div className="text-base font-semibold">{result.feedback.headline}</div>
            <div className="text-sm mt-1" style={{ color: COLORS.body }}>
              Rode: {result.ride.structure.description}
              {result.ride.structure.inferredFromStream && (
                <span style={{ color: COLORS.muted }}> — read from the power stream, no lap markers in the file</span>
              )}
            </div>
            <div className="text-sm mt-2" style={{ color: COLORS.body }}>{result.feedback.executionSummary}</div>
            {result.movedFrom && (
              <div className="text-[11px] mt-2" style={{ color: COLORS.warn }}>
                Matched by structure to the session prescribed for {result.movedFrom} — the session was moved, not missed.
              </div>
            )}
            {result.comparison.planned && (
              <div className="text-[11px] mt-3" style={{ color: COLORS.muted }}>
                Prescribed: {result.comparison.planned.title} · {formatDuration(result.comparison.planned.durationSecs)}
                {result.comparison.planned.targetLoad != null ? ` · target TSS ${result.comparison.planned.targetLoad}` : ''}
              </div>
            )}
            {result.comparison.notes.length > 0 && (
              <ul className="mt-2 space-y-1">
                {result.comparison.notes.map((n, i) => (
                  <li key={i} className="text-[11px]" style={{ color: COLORS.muted }}>• {n}</li>
                ))}
              </ul>
            )}
          </Card>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <Stat label="Duration" value={formatDuration(analysis.durationSecs)} sub={result.ride.reported.totalDistanceKm != null ? `${result.ride.reported.totalDistanceKm} km` : undefined} />
            <Stat label="NP" value={analysis.power.normalizedPower != null ? `${analysis.power.normalizedPower}W` : '—'} sub={analysis.power.avgWatts != null ? `${analysis.power.avgWatts}W avg` : undefined} />
            <Stat label="TSS" value={result.ride.tss != null ? `${result.ride.tss}` : '—'} sub={result.ride.intensityFactor != null ? `IF ${result.ride.intensityFactor}` : 'no FTP on file'} />
            <Stat label="Work" value={`${analysis.power.totalKj} kJ`} sub={`VI ${analysis.power.variabilityIndex ?? '—'}`} />
            <Stat label="Avg HR" value={analysis.hr.avgHr != null ? `${analysis.hr.avgHr} bpm` : '—'} sub={analysis.hr.maxHr != null ? `${analysis.hr.maxHr} max` : undefined} />
            <Stat label="Decoupling" value={analysis.decoupling != null ? `${analysis.decoupling}%` : '—'} sub="HR drift vs power" />
            <Stat label="Late fade" value={analysis.lateFadePct != null ? `${analysis.lateFadePct}%` : '—'} sub="efficiency 1st → 3rd" />
            <Stat label="Coasting" value={`${analysis.power.coastingPct}%`} />
          </div>

          <Card>
            <div className="text-xs font-semibold uppercase tracking-widest mb-2" style={{ color: COLORS.muted }}>
              What the app saw
            </div>
            <pre className="text-[11px] leading-relaxed overflow-x-auto" style={{ color: COLORS.body, fontFamily: 'ui-monospace, monospace', margin: 0 }}>
              {result.ride.structure.segmentSummary}
            </pre>
            <div className="text-[11px] mt-2" style={{ color: COLORS.muted }}>
              Read straight from the power trace, without reference to FTP. If this does not match the ride, the
              analysis above it is wrong — say so in the chat and I can tell you why.
            </div>
          </Card>

          {analysis.zones && <Card><ZoneBar zones={analysis.zones} /></Card>}
          {analysis.intervals && analysis.intervals.length > 0 && (
            <Card><IntervalTable intervals={analysis.intervals} /></Card>
          )}

          {(result.feedback.whatWentWell.length > 0 || result.feedback.concerns.length > 0) && (
            <div className="grid sm:grid-cols-2 gap-3">
              {result.feedback.whatWentWell.length > 0 && (
                <Card>
                  <div className="text-xs font-semibold mb-2" style={{ color: COLORS.good }}>What went well</div>
                  <ul className="space-y-1.5">
                    {result.feedback.whatWentWell.map((s, i) => (
                      <li key={i} className="text-sm" style={{ color: COLORS.body }}>• {s}</li>
                    ))}
                  </ul>
                </Card>
              )}
              {result.feedback.concerns.length > 0 && (
                <Card>
                  <div className="text-xs font-semibold mb-2" style={{ color: COLORS.bad }}>Watch this</div>
                  <ul className="space-y-1.5">
                    {result.feedback.concerns.map((s, i) => (
                      <li key={i} className="text-sm" style={{ color: COLORS.body }}>• {s}</li>
                    ))}
                  </ul>
                </Card>
              )}
            </div>
          )}

          {result.feedback.progressAssessment && (
            <Card>
              <div className="text-xs font-semibold mb-2" style={{ color: COLORS.muted }}>How the block is going</div>
              <div className="text-sm" style={{ color: COLORS.body }}>{result.feedback.progressAssessment}</div>
            </Card>
          )}

          {result.pendingChanges.length > 0 && (
            <div>
              <div className="text-xs font-semibold uppercase tracking-widest mb-2" style={{ color: COLORS.muted }}>
                Suggested plan changes
              </div>
              <div className="space-y-2">
                {result.pendingChanges.map(c => (
                  <ChangeRow key={c.id} change={c} onActioned={onUploaded} />
                ))}
              </div>
            </div>
          )}

          {result.feedback.clientMessage && (
            <Card>
              <div className="text-xs font-semibold mb-2" style={{ color: COLORS.muted }}>Message for the client</div>
              <div className="text-sm whitespace-pre-wrap" style={{ color: COLORS.body }}>{result.feedback.clientMessage}</div>
              <div className="mt-3">
                <Button variant="ghost" onClick={() => navigator.clipboard?.writeText(result.feedback.clientMessage)}>
                  Copy
                </Button>
              </div>
            </Card>
          )}
        </div>
      )}
    </div>
  )
}
