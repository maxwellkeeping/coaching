'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import Link from 'next/link'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const router = useRouter()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')
    const supabase = createClient()
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) { setError(error.message); setLoading(false) }
    else router.push('/')
  }

  return (
    <div className="min-h-screen flex items-center justify-center" style={{ backgroundColor: '#0f1117' }}>
      <div className="w-full max-w-sm p-8 rounded-2xl border border-slate-700/50" style={{ backgroundColor: '#1a1d27' }}>
        <h1 className="text-xl font-bold mb-1" style={{ color: '#e2e8f0' }}>Coaching</h1>
        <p className="text-sm mb-6" style={{ color: '#64748b' }}>Sign in to your coaching account</p>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-medium mb-1" style={{ color: '#94a3b8' }}>Email</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} required
              className="w-full px-3 py-2 rounded-lg text-sm outline-none"
              style={{ backgroundColor: '#0f1117', border: '1px solid #334155', color: '#e2e8f0' }} />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1" style={{ color: '#94a3b8' }}>Password</label>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} required
              className="w-full px-3 py-2 rounded-lg text-sm outline-none"
              style={{ backgroundColor: '#0f1117', border: '1px solid #334155', color: '#e2e8f0' }} />
          </div>
          {error && <p className="text-xs text-red-400">{error}</p>}
          <button type="submit" disabled={loading}
            className="w-full py-2 rounded-lg text-sm font-semibold disabled:opacity-50"
            style={{ backgroundColor: '#3b82f6', color: '#fff' }}>
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        <p className="text-xs text-center mt-4" style={{ color: '#64748b' }}>
          No account? <Link href="/signup" className="text-blue-400 hover:underline">Sign up</Link>
        </p>
      </div>
    </div>
  )
}
