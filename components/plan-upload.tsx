'use client'

import { useRef, useState } from 'react'
import { Button, Card, COLORS, ErrorNote, INPUT, formatDuration } from './ui'

interface DraftSession {
  week: number
  dayOfWeek: number
  date: string | null
  title: string
  description: string | null
  sport: string | null
  durationSecs: number | null
  targetLoad: number | null
  intensity: string
  sourceText: string | null
}

interface Draft {
  planName: string | null
  weeks: number
  startDate: string | null
  sessions: DraftSession[]
  warnings: string[]
}

const DAY_LABELS = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

/**
 * Upload a plan PDF, review what was read out of it, then commit it.
 *
 * The review step is the point of this component: extraction from a PDF is
 * fallible, and a plan the coach has not eyeballed would quietly corrupt every
 * comparison made against it.
 */
export function PlanUpload({ clientId, onSaved }: { clientId: string; onSaved: () => void }) {
  const [file, setFile] = useState<File | null>(null)
  const [startDate, setStartDate] = useState('')
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [filename, setFilename] = useState('')
  const [expandedWeek, setExpandedWeek] = useState<number | null>(1)
  const inputRef = useRef<HTMLInputElement>(null)

  const extract = async () => {
    if (!file) return
    setBusy(true)
    setError('')
    setDraft(null)
    try {
      const form = new FormData()
      form.append('file', file)
      if (startDate) form.append('startDate', startDate)
      const res = await fetch(`/api/clients/${clientId}/plan`, { method: 'POST', body: form })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Could not read that PDF')
      setDraft(json.plan)
      setFilename(json.filename)
      if (json.plan.startDate) setStartDate(json.plan.startDate)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const save = async () => {
    if (!draft) return
    if (!startDate) {
      setError('Set the date the plan starts before saving — every session date hangs off it.')
      return
    }
    setSaving(true)
    setError('')
    try {
      const res = await fetch(`/api/clients/${clientId}/plan`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename, plan: { ...draft, startDate } }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Failed to save the plan')
      setDraft(null)
      setFile(null)
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const weeks = draft ? [...new Set(draft.sessions.map(s => s.week))].sort((a, b) => a - b) : []

  return (
    <Card>
      <div className="space-y-3">
        <div
          onClick={() => inputRef.current?.click()}
          className="rounded-lg border-2 border-dashed border-slate-700/70 p-6 text-center cursor-pointer hover:border-slate-600"
          onDragOver={e => e.preventDefault()}
          onDrop={e => { e.preventDefault(); setFile(e.dataTransfer.files?.[0] ?? null) }}
        >
          <input
            ref={inputRef}
            type="file"
            accept=".pdf"
            className="hidden"
            onChange={e => { setFile(e.target.files?.[0] ?? null); setError('') }}
          />
          <div className="text-sm">{file ? file.name : 'Drop the plan PDF here, or click to choose'}</div>
          <div className="text-[11px] mt-1" style={{ color: COLORS.muted }}>
            {file ? `${(file.size / 1024).toFixed(0)} KB` : 'The plan you wrote for this client — 20MB max'}
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-[11px] font-medium mb-1" style={{ color: COLORS.body }}>Plan start date</label>
            <input
              type="date"
              value={startDate}
              onChange={e => setStartDate(e.target.value)}
              className="px-3 py-2 rounded-lg text-sm outline-none"
              style={INPUT}
            />
          </div>
          <Button onClick={extract} disabled={!file || busy}>
            {busy ? 'Reading the plan…' : 'Read plan'}
          </Button>
        </div>

        {error && <ErrorNote>{error}</ErrorNote>}

        {busy && (
          <div className="text-sm" style={{ color: COLORS.muted }}>
            Reading every week and session out of the PDF. This takes a moment on a long plan.
          </div>
        )}

        {draft && (
          <div className="space-y-3">
            <div className="rounded-lg border border-slate-700/50 p-3">
              <div className="text-sm font-semibold">{draft.planName ?? 'Untitled plan'}</div>
              <div className="text-[11px] mt-0.5" style={{ color: COLORS.muted }}>
                {draft.weeks} week{draft.weeks === 1 ? '' : 's'} · {draft.sessions.length} sessions read from {filename}
              </div>
            </div>

            {draft.warnings.length > 0 && (
              <div className="rounded-lg border p-3" style={{ borderColor: '#78350f' }}>
                <div className="text-xs font-semibold mb-1" style={{ color: COLORS.warn }}>Check these before saving</div>
                <ul className="space-y-1">
                  {draft.warnings.map((w, i) => (
                    <li key={i} className="text-[11px]" style={{ color: COLORS.body }}>• {w}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="space-y-1">
              {weeks.map(week => {
                const sessions = draft.sessions.filter(s => s.week === week)
                const open = expandedWeek === week
                return (
                  <div key={week} className="rounded-lg border border-slate-700/50">
                    <button
                      onClick={() => setExpandedWeek(open ? null : week)}
                      className="w-full px-3 py-2 flex items-center justify-between text-left"
                    >
                      <span className="text-xs font-medium">Week {week}</span>
                      <span className="text-[11px]" style={{ color: COLORS.muted }}>
                        {sessions.filter(s => s.intensity !== 'rest').length} sessions · {open ? 'hide' : 'show'}
                      </span>
                    </button>
                    {open && (
                      <div className="px-3 pb-3 space-y-1.5">
                        {sessions.map((s, i) => (
                          <div key={i} className="flex gap-3 text-[11px]">
                            <span className="w-8 shrink-0" style={{ color: COLORS.muted }}>{DAY_LABELS[s.dayOfWeek]}</span>
                            <span className="w-20 shrink-0" style={{ color: COLORS.muted }}>{s.date ?? '—'}</span>
                            <span className="flex-1" style={{ color: COLORS.text }}>
                              {s.title}
                              {s.description && <span style={{ color: COLORS.muted }}> — {s.description}</span>}
                            </span>
                            <span className="w-14 text-right shrink-0" style={{ color: COLORS.muted }}>
                              {s.durationSecs ? formatDuration(s.durationSecs) : ''}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

            <div className="flex items-center gap-3">
              <Button onClick={save} disabled={saving}>
                {saving ? 'Saving…' : 'Save as this client’s plan'}
              </Button>
              <button onClick={() => setDraft(null)} className="text-xs" style={{ color: COLORS.muted }}>
                Discard
              </button>
            </div>
          </div>
        )}
      </div>
    </Card>
  )
}
