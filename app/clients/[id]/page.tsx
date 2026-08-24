'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { use } from 'react'
import { Button, Card, COLORS, ErrorNote, INPUT, PILL, SectionTitle, VERDICT_TONE, formatDuration } from '@/components/ui'
import { PlanUpload } from '@/components/plan-upload'
import { RideUpload } from '@/components/ride-upload'
import { ProgressionView } from '@/components/progression-view'
import { ClientChat } from '@/components/client-chat'
import type { Client, PlanSession } from '@/lib/types'
import type { Progression } from '@/lib/progression'
import type { PlanComparison } from '@/lib/plan-match'
import type { FitRideSummary } from '@/lib/fit-analysis'
import type { RideFeedback } from '@/components/ride-upload'

interface StoredRide {
  id: string
  filename: string
  rideDate: string | null
  summary: FitRideSummary | null
  comparison: PlanComparison | null
  feedback: RideFeedback | null
  createdAt: string
}

interface ClientView {
  client: Client
  plan: { id: string; planName: string | null; startDate: string | null; weeks: number | null; filename: string } | null
  sessions: PlanSession[]
  currentWeek: number | null
  rides: StoredRide[]
  progression: Progression
  pendingChanges: Array<{ id: string; summary: string }>
}

type Tab = 'overview' | 'plan' | 'rides' | 'chat'

const DAY_LABELS = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

function today(): string {
  return new Date().toISOString().split('T')[0]
}

export default function ClientPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const [view, setView] = useState<ClientView | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [tab, setTab] = useState<Tab>('overview')
  const [replacingPlan, setReplacingPlan] = useState(false)
  const [openRide, setOpenRide] = useState<string | null>(null)
  const [editingStart, setEditingStart] = useState(false)
  const [newStart, setNewStart] = useState('')
  const [savingStart, setSavingStart] = useState(false)
  const [startNote, setStartNote] = useState('')

  const saveStartDate = async () => {
    if (!newStart) return
    setSavingStart(true)
    setStartNote('')
    try {
      const res = await fetch(`/api/clients/${id}/plan`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ startDate: newStart }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Failed to change the start date')
      setStartNote(`Re-dated ${json.sessionsRedated} sessions. Rides already uploaded keep the comparison they were given — re-upload one to re-match it.`)
      setEditingStart(false)
      await load()
    } catch (e) {
      setStartNote(e instanceof Error ? e.message : String(e))
    } finally {
      setSavingStart(false)
    }
  }

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/clients/${id}`)
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Failed to load the client')
      setView(json)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => { load() }, [load])

  if (loading) {
    return (
      <div className="min-h-screen p-6" style={{ backgroundColor: COLORS.bg, color: COLORS.muted }}>
        Loading…
      </div>
    )
  }

  if (error || !view) {
    return (
      <div className="min-h-screen p-6" style={{ backgroundColor: COLORS.bg }}>
        <div className="max-w-4xl mx-auto space-y-4">
          <ErrorNote>{error || 'Client not found'}</ErrorNote>
          <Link href="/" className="text-xs" style={{ color: COLORS.muted }}>← Back to clients</Link>
        </div>
      </div>
    )
  }

  const { client, plan, sessions, currentWeek, rides, progression } = view
  const upcoming = sessions.filter(s => s.date != null && s.date >= today()).slice(0, 10)
  const thisWeek = currentWeek != null ? sessions.filter(s => s.week === currentWeek) : []

  return (
    <div className="min-h-screen" style={{ backgroundColor: COLORS.bg, color: COLORS.text }}>
      <div className="max-w-4xl mx-auto px-4 py-6">
        <header className="mb-5">
          <Link href="/" className="text-xs" style={{ color: COLORS.muted }}>← Clients</Link>
          <div className="mt-2 flex items-start justify-between gap-4">
            <div>
              <h1 className="text-lg sm:text-xl font-bold">{client.name}</h1>
              <p className="text-xs mt-0.5" style={{ color: COLORS.muted }}>
                {client.ftp ? `FTP ${client.ftp}W` : 'No FTP on file'}
                {client.hr_max ? ` · HRmax ${client.hr_max}` : ''}
                {client.training_phase ? ` · ${client.training_phase}` : ''}
                {client.goal_event ? ` · ${client.goal_event}${client.goal_date ? ` (${client.goal_date})` : ''}` : ''}
              </p>
            </div>
            {plan && (
              <div className="text-right text-[11px]" style={{ color: COLORS.muted }}>
                <div>{plan.planName ?? plan.filename}</div>
                <div>
                  {currentWeek != null
                    ? `Week ${currentWeek}${plan.weeks ? ` of ${plan.weeks}` : ''}`
                    : plan.startDate
                      ? `Starts ${plan.startDate}`
                      : 'No start date'}
                </div>
              </div>
            )}
          </div>
        </header>

        <div className="flex gap-2 mb-5">
          {(['overview', 'plan', 'rides', 'chat'] as Tab[]).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className="text-xs px-3 py-1.5 rounded-full font-medium transition-colors hover:opacity-80"
              style={tab === t ? { backgroundColor: COLORS.accent, color: '#f8fafc' } : PILL}
            >
              {t === 'overview' ? 'Progress' : t === 'plan' ? 'Plan' : t === 'rides' ? 'Upload ride' : 'Chat'}
            </button>
          ))}
        </div>

        <div style={{ display: tab === 'overview' ? 'block' : 'none' }}>
          <div className="space-y-5">
            <ProgressionView progression={progression} />

            {thisWeek.length > 0 && (
              <div>
                <SectionTitle>This week&apos;s plan</SectionTitle>
                <Card>
                  <div className="space-y-1.5">
                    {thisWeek.map(s => (
                      <div key={s.id} className="flex gap-3 text-[11px]">
                        <span className="w-8 shrink-0" style={{ color: COLORS.muted }}>{DAY_LABELS[s.dayOfWeek]}</span>
                        <span className="w-20 shrink-0" style={{ color: s.date === today() ? COLORS.accent : COLORS.muted }}>
                          {s.date ?? '—'}
                        </span>
                        <span className="flex-1">{s.title}</span>
                        <span className="w-14 text-right shrink-0" style={{ color: COLORS.muted }}>
                          {s.durationSecs ? formatDuration(s.durationSecs) : ''}
                        </span>
                      </div>
                    ))}
                  </div>
                </Card>
              </div>
            )}

            <div>
              <SectionTitle>Ride history</SectionTitle>
              {rides.length === 0 ? (
                <Card>
                  <div className="text-sm" style={{ color: COLORS.body }}>
                    No rides uploaded for {client.name} yet.
                  </div>
                </Card>
              ) : (
                <div className="space-y-2">
                  {rides.map(r => {
                    const tone = r.comparison ? VERDICT_TONE[r.comparison.verdict] : null
                    const open = openRide === r.id
                    return (
                      <div key={r.id} className="rounded-xl border border-slate-700/50" style={{ backgroundColor: COLORS.card }}>
                        <button
                          onClick={() => setOpenRide(open ? null : r.id)}
                          className="w-full p-4 text-left"
                        >
                          <div className="flex items-start justify-between gap-4">
                            <div className="min-w-0">
                              <div className="text-sm truncate">{r.feedback?.headline ?? r.filename}</div>
                              <div className="text-[11px] mt-0.5" style={{ color: COLORS.muted }}>
                                {r.rideDate ?? r.createdAt.split('T')[0]}
                                {r.summary ? ` · ${formatDuration(r.summary.analysis.durationSecs)}` : ''}
                                {r.summary?.tss != null ? ` · TSS ${r.summary.tss}` : ''}
                                {r.summary?.analysis.decoupling != null ? ` · decoupling ${r.summary.analysis.decoupling}%` : ''}
                              </div>
                            </div>
                            {tone && (
                              <div className="text-[10px] uppercase tracking-widest shrink-0" style={{ color: tone.color }}>
                                {tone.label}
                              </div>
                            )}
                          </div>
                        </button>
                        {open && r.feedback && (
                          <div className="px-4 pb-4 space-y-3">
                            <div className="text-sm" style={{ color: COLORS.body }}>{r.feedback.executionSummary}</div>
                            {r.comparison?.notes && r.comparison.notes.length > 0 && (
                              <ul className="space-y-1">
                                {r.comparison.notes.map((n, i) => (
                                  <li key={i} className="text-[11px]" style={{ color: COLORS.muted }}>• {n}</li>
                                ))}
                              </ul>
                            )}
                            {r.feedback.progressAssessment && (
                              <div className="text-sm" style={{ color: COLORS.body }}>{r.feedback.progressAssessment}</div>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        </div>

        <div style={{ display: tab === 'plan' ? 'block' : 'none' }}>
          <div className="space-y-5">
            {plan && !replacingPlan ? (
              <>
                <div>
                  <SectionTitle action={<Button variant="ghost" onClick={() => setReplacingPlan(true)}>Replace plan</Button>}>
                    {plan.planName ?? 'Current plan'}
                  </SectionTitle>
                  <Card>
                    <div className="text-[11px]" style={{ color: COLORS.muted }}>
                      From {plan.filename} · {plan.weeks ?? '?'} weeks · {sessions.length} sessions
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-3">
                      {editingStart ? (
                        <>
                          <div>
                            <label className="block text-[11px] font-medium mb-1" style={{ color: COLORS.body }}>
                              Date {client.name} actually started
                            </label>
                            <input
                              type="date"
                              value={newStart}
                              onChange={e => setNewStart(e.target.value)}
                              className="px-3 py-2 rounded-lg text-sm outline-none"
                              style={INPUT}
                            />
                          </div>
                          <Button onClick={saveStartDate} disabled={savingStart || !newStart}>
                            {savingStart ? 'Re-dating…' : 'Re-date plan'}
                          </Button>
                          <button onClick={() => setEditingStart(false)} className="text-xs" style={{ color: COLORS.muted }}>
                            Cancel
                          </button>
                        </>
                      ) : (
                        <>
                          <div className="text-sm">
                            Starts <span style={{ color: COLORS.text }}>{plan.startDate ?? 'unset'}</span>
                          </div>
                          <Button
                            variant="ghost"
                            onClick={() => { setNewStart(plan.startDate ?? ''); setEditingStart(true) }}
                          >
                            Change start date
                          </Button>
                        </>
                      )}
                    </div>
                    {startNote && (
                      <div className="text-[11px] mt-2" style={{ color: COLORS.body }}>{startNote}</div>
                    )}
                    <div className="text-[11px] mt-2" style={{ color: COLORS.muted }}>
                      Every session date is derived from this — changing it re-dates the whole plan.
                    </div>
                  </Card>
                </div>
                <div>
                  <SectionTitle>Coming up</SectionTitle>
                  <Card>
                    {upcoming.length === 0 ? (
                      <div className="text-sm" style={{ color: COLORS.body }}>No sessions left ahead in this plan.</div>
                    ) : (
                      <div className="space-y-2">
                        {upcoming.map(s => (
                          <div key={s.id} className="flex gap-3 text-[11px] border-b border-slate-700/40 pb-2 last:border-0 last:pb-0">
                            <span className="w-20 shrink-0" style={{ color: COLORS.muted }}>{s.date}</span>
                            <span className="flex-1">
                              <span style={{ color: COLORS.text }}>{s.title}</span>
                              {s.description && <span style={{ color: COLORS.muted }}> — {s.description}</span>}
                            </span>
                            <span className="w-14 text-right shrink-0" style={{ color: COLORS.muted }}>
                              {s.durationSecs ? formatDuration(s.durationSecs) : ''}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </Card>
                </div>
              </>
            ) : (
              <div className="space-y-3">
                {plan && (
                  <div className="text-[11px]" style={{ color: COLORS.warn }}>
                    Saving a new plan archives the current one. Past rides keep the comparison they were given.
                  </div>
                )}
                <PlanUpload clientId={id} onSaved={() => { setReplacingPlan(false); load() }} />
                {plan && (
                  <button onClick={() => setReplacingPlan(false)} className="text-xs" style={{ color: COLORS.muted }}>
                    Cancel
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        <div style={{ display: tab === 'rides' ? 'block' : 'none' }}>
          <RideUpload clientId={id} hasPlan={plan != null} onUploaded={load} />
        </div>

        <div style={{ display: tab === 'chat' ? 'block' : 'none' }}>
          <ClientChat clientId={id} clientName={client.name} onChanged={load} />
        </div>
      </div>
    </div>
  )
}
