'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { Button, Card, COLORS, ErrorNote, INPUT, PILL, SectionTitle } from '@/components/ui'
import type { Client } from '@/lib/types'

interface RosterClient extends Client {
  rides: number
  hasPlan: boolean
  lastRide: string | null
}

const EMPTY_FORM = {
  name: '', email: '', ftp: '', hr_max: '', weight_kg: '',
  goal_event: '', goal_date: '', weekly_hours: '', training_phase: '', notes: '',
}

function daysSince(date: string | null): number | null {
  if (!date) return null
  const ms = Date.now() - new Date(`${date}T12:00:00Z`).getTime()
  return Math.floor(ms / 86400000)
}

export default function RosterPage() {
  const router = useRouter()
  const [clients, setClients] = useState<RosterClient[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [adding, setAdding] = useState(false)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/clients')
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Failed to load clients')
      setClients(json.clients)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const addClient = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setError('')
    try {
      const res = await fetch('/api/clients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Failed to add the client')
      setForm(EMPTY_FORM)
      setAdding(false)
      router.push(`/clients/${json.client.id}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const signOut = async () => {
    await createClient().auth.signOut()
    router.push('/login')
  }

  const field = (key: keyof typeof EMPTY_FORM, label: string, type = 'text', placeholder = '') => (
    <div>
      <label className="block text-[11px] font-medium mb-1" style={{ color: COLORS.body }}>{label}</label>
      <input
        type={type}
        value={form[key]}
        placeholder={placeholder}
        onChange={e => setForm({ ...form, [key]: e.target.value })}
        className="w-full px-3 py-2 rounded-lg text-sm outline-none"
        style={INPUT}
      />
    </div>
  )

  return (
    <div className="min-h-screen" style={{ backgroundColor: COLORS.bg, color: COLORS.text }}>
      <div className="max-w-4xl mx-auto px-4 py-6">
        <header className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-lg sm:text-xl font-bold">Clients</h1>
            <p className="text-xs mt-0.5" style={{ color: COLORS.muted }}>
              Upload a client&apos;s plan, then their rides, and see how the block is going.
            </p>
          </div>
          <div className="flex gap-2">
            <Button onClick={() => setAdding(v => !v)}>{adding ? 'Cancel' : '+ Add client'}</Button>
            <button onClick={signOut} className="text-xs px-3 py-1.5 rounded-full font-medium hover:opacity-80" style={PILL}>
              Sign out
            </button>
          </div>
        </header>

        {error && <div className="mb-4"><ErrorNote>{error}</ErrorNote></div>}

        {adding && (
          <form onSubmit={addClient} className="mb-6">
            <Card>
              <SectionTitle>New client</SectionTitle>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {field('name', 'Name')}
                {field('email', 'Email', 'email')}
                {field('ftp', 'FTP (W)', 'number')}
                {field('hr_max', 'HRmax (bpm)', 'number')}
                {field('weight_kg', 'Weight (kg)', 'number')}
                {field('weekly_hours', 'Weekly hours', 'number')}
                {field('goal_event', 'Goal event')}
                {field('goal_date', 'Goal date', 'date')}
                {field('training_phase', 'Phase', 'text', 'Base 2')}
              </div>
              <div className="mt-3">
                <label className="block text-[11px] font-medium mb-1" style={{ color: COLORS.body }}>Notes</label>
                <textarea
                  value={form.notes}
                  onChange={e => setForm({ ...form, notes: e.target.value })}
                  rows={2}
                  placeholder="Anything that shapes how you read their rides — history, constraints, injuries."
                  className="w-full px-3 py-2 rounded-lg text-sm outline-none resize-none"
                  style={INPUT}
                />
              </div>
              <div className="mt-3">
                <Button type="submit" disabled={saving || !form.name.trim()}>
                  {saving ? 'Saving…' : 'Add client'}
                </Button>
              </div>
            </Card>
          </form>
        )}

        {loading ? (
          <div className="text-sm" style={{ color: COLORS.muted }}>Loading…</div>
        ) : clients.length === 0 ? (
          <Card>
            <div className="text-sm" style={{ color: COLORS.body }}>
              No clients yet. Add one, upload their training plan PDF, then start uploading their ride files.
            </div>
          </Card>
        ) : (
          <div className="space-y-2">
            {clients.map(c => {
              const since = daysSince(c.lastRide)
              return (
                <Link key={c.id} href={`/clients/${c.id}`} className="block">
                  <div className="rounded-xl border border-slate-700/50 p-4 transition-colors hover:border-slate-600" style={{ backgroundColor: COLORS.card }}>
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <div className="text-sm font-semibold">{c.name}</div>
                        <div className="text-[11px] mt-0.5" style={{ color: COLORS.muted }}>
                          {c.ftp ? `FTP ${c.ftp}W` : 'No FTP on file'}
                          {c.training_phase ? ` · ${c.training_phase}` : ''}
                          {c.goal_event ? ` · ${c.goal_event}${c.goal_date ? ` (${c.goal_date})` : ''}` : ''}
                        </div>
                      </div>
                      <div className="text-right text-[11px]" style={{ color: COLORS.muted }}>
                        <div style={{ color: c.hasPlan ? COLORS.muted : COLORS.warn }}>
                          {c.hasPlan ? 'Plan loaded' : 'No plan yet'}
                        </div>
                        <div>
                          {c.rides === 0
                            ? 'No rides uploaded'
                            : since != null
                              ? `${c.rides} ride${c.rides === 1 ? '' : 's'} · last ${since === 0 ? 'today' : `${since}d ago`}`
                              : `${c.rides} ride${c.rides === 1 ? '' : 's'}`}
                        </div>
                      </div>
                    </div>
                  </div>
                </Link>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
