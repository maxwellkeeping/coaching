import type { CSSProperties, ReactNode } from 'react'

export const COLORS = {
  bg: '#0f1117',
  card: '#1a1d27',
  border: '#334155',
  text: '#e2e8f0',
  muted: '#64748b',
  body: '#94a3b8',
  accent: '#2563eb',
  good: '#4ade80',
  warn: '#fbbf24',
  bad: '#f87171',
}

export const CARD: CSSProperties = { backgroundColor: COLORS.card }
export const PILL: CSSProperties = { backgroundColor: COLORS.card, color: COLORS.muted, border: `1px solid ${COLORS.border}` }
export const INPUT: CSSProperties = { backgroundColor: COLORS.bg, border: `1px solid ${COLORS.border}`, color: COLORS.text }

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border border-slate-700/50 p-4 ${className}`} style={CARD}>
      {children}
    </div>
  )
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between mb-2">
      <h2 className="text-xs font-semibold uppercase tracking-widest" style={{ color: COLORS.muted }}>{children}</h2>
      {action}
    </div>
  )
}

export function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-slate-700/50 px-3 py-2" style={CARD}>
      <div className="text-[10px] uppercase tracking-widest" style={{ color: COLORS.muted }}>{label}</div>
      <div className="text-lg font-semibold" style={{ color: tone ?? COLORS.text }}>{value}</div>
      {sub && <div className="text-[11px]" style={{ color: COLORS.muted }}>{sub}</div>}
    </div>
  )
}

export function Button({
  children, onClick, disabled, variant = 'primary', type = 'button',
}: {
  children: ReactNode
  onClick?: () => void
  disabled?: boolean
  variant?: 'primary' | 'ghost'
  type?: 'button' | 'submit'
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className="text-xs px-3 py-1.5 rounded-full font-medium transition-colors hover:opacity-80 disabled:opacity-40"
      style={variant === 'primary' ? { backgroundColor: COLORS.accent, color: '#f8fafc' } : PILL}
    >
      {children}
    </button>
  )
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border p-3 text-sm" style={{ backgroundColor: COLORS.card, borderColor: '#7f1d1d', color: '#fca5a5' }}>
      {children}
    </div>
  )
}

export function formatDuration(secs: number | null | undefined): string {
  if (secs == null) return '—'
  const m = Math.round(secs / 60)
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`
}

export const VERDICT_TONE: Record<string, { label: string; color: string }> = {
  'as-prescribed': { label: 'As prescribed', color: COLORS.good },
  'harder-than-prescribed': { label: 'Harder than prescribed', color: COLORS.warn },
  'easier-than-prescribed': { label: 'Easier than prescribed', color: COLORS.warn },
  'cut-short': { label: 'Cut short', color: COLORS.bad },
  'different-session': { label: 'Different session', color: COLORS.warn },
  'unplanned': { label: 'Unplanned ride', color: COLORS.muted },
}
