'use client'

import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport } from 'ai'
import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { COLORS, INPUT } from './ui'

interface StoredMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
}

/** Tool calls the coach should see the effect of, named in plain language. */
const TOOL_LABELS: Record<string, string> = {
  'tool-set_plan_start_date': 'Re-dated the plan',
  'tool-update_session': 'Updated a planned session',
  'tool-update_client': 'Updated the client',
}

function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
        ul: ({ children }) => <ul className="mb-2 ml-4 list-disc space-y-0.5">{children}</ul>,
        ol: ({ children }) => <ol className="mb-2 ml-4 list-decimal space-y-0.5">{children}</ol>,
        strong: ({ children }) => <strong className="font-semibold" style={{ color: COLORS.text }}>{children}</strong>,
        code: ({ children }) => (
          <code className="px-1 py-0.5 rounded text-xs font-mono" style={{ backgroundColor: COLORS.bg, color: '#93c5fd' }}>{children}</code>
        ),
      }}
    >
      {text}
    </ReactMarkdown>
  )
}

function Bubble({ role, children }: { role: 'user' | 'assistant'; children: React.ReactNode }) {
  const isUser = role === 'user'
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-3`}>
      <div
        className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${isUser ? 'rounded-br-sm whitespace-pre-wrap' : 'rounded-bl-sm border border-slate-700/50'}`}
        style={{ backgroundColor: isUser ? COLORS.accent : COLORS.card, color: isUser ? '#f8fafc' : COLORS.text }}
      >
        {children}
      </div>
    </div>
  )
}

/**
 * The coaching chat for one client.
 *
 * It is not only a Q&A surface: its tools write to the plan and the client, so
 * "he actually started on the 3rd" is a fix, not a note. Anything it changes
 * triggers onChanged so the rest of the page reloads behind it.
 */
export function ClientChat({ clientId, clientName, onChanged }: {
  clientId: string
  clientName: string
  onChanged: () => void
}) {
  const { messages, sendMessage, status, setMessages } = useChat({
    transport: new DefaultChatTransport({ api: `/api/clients/${clientId}/chat` }),
  })
  const [input, setInput] = useState('')
  const [history, setHistory] = useState<StoredMessage[]>([])
  const [loadingHistory, setLoadingHistory] = useState(true)
  const endRef = useRef<HTMLDivElement>(null)
  const appliedRef = useRef(0)

  useEffect(() => {
    let cancelled = false
    fetch(`/api/clients/${clientId}/chat`)
      .then(r => r.json())
      .then(json => { if (!cancelled) setHistory(json.messages ?? []) })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoadingHistory(false) })
    return () => { cancelled = true }
  }, [clientId])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, history])

  // A tool call means something in the database changed — refresh the page
  // around the chat so the plan and progress the coach can see stay true.
  useEffect(() => {
    const toolCalls = messages.reduce((count, m) => {
      const parts = (m as { parts?: Array<{ type: string; state?: string }> }).parts ?? []
      return count + parts.filter(p => p.type.startsWith('tool-') && p.state === 'output-available').length
    }, 0)
    if (toolCalls > appliedRef.current) {
      appliedRef.current = toolCalls
      onChanged()
    }
  }, [messages, onChanged])

  const busy = status === 'streaming' || status === 'submitted'

  const send = (text: string) => {
    if (!text.trim() || busy) return
    // Once a live turn starts, the stored thread is replayed above it; clear it
    // so a reloaded history and the live messages do not double up.
    sendMessage({ text: text.trim() })
    setInput('')
  }

  const clearThread = () => {
    setMessages([])
    setHistory([])
  }

  const suggestions = [
    `When did ${clientName} actually start the plan?`,
    'The start date is wrong — how do I fix it?',
    'How is the block going overall?',
  ]

  return (
    <div className="flex flex-col" style={{ height: '65vh' }}>
      <div className="flex-1 overflow-y-auto pr-1">
        {loadingHistory ? (
          <div className="text-sm" style={{ color: COLORS.muted }}>Loading the thread…</div>
        ) : history.length === 0 && messages.length === 0 ? (
          <div className="space-y-3">
            <div className="text-sm" style={{ color: COLORS.body }}>
              Ask about {clientName}&apos;s training, or tell me what the app got wrong. I can re-date the plan,
              change a planned session, or fix their numbers directly.
            </div>
            <div className="flex flex-wrap gap-2">
              {suggestions.map(s => (
                <button
                  key={s}
                  onClick={() => send(s)}
                  className="text-[11px] px-3 py-1.5 rounded-full hover:opacity-80"
                  style={{ backgroundColor: COLORS.card, color: COLORS.body, border: `1px solid ${COLORS.border}` }}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            {history.map(m => (
              <Bubble key={m.id} role={m.role}>
                {m.role === 'user' ? m.content : <Markdown text={m.content} />}
              </Bubble>
            ))}
            {messages.map(m => {
              const parts = (m as { parts?: Array<{ type: string; text?: string; state?: string }> }).parts ?? []
              const text = parts.filter(p => p.type === 'text').map(p => p.text ?? '').join('')
              const tools = parts.filter(p => p.type.startsWith('tool-') && p.state === 'output-available')
              return (
                <div key={m.id}>
                  {text && (
                    <Bubble role={m.role === 'user' ? 'user' : 'assistant'}>
                      {m.role === 'user' ? text : <Markdown text={text} />}
                    </Bubble>
                  )}
                  {tools.map((t, i) => (
                    <div key={i} className="mb-3 text-[11px]" style={{ color: COLORS.good }}>
                      ✓ {TOOL_LABELS[t.type] ?? 'Change applied'}
                    </div>
                  ))}
                </div>
              )
            })}
          </>
        )}
        {busy && <div className="text-[11px] mb-3" style={{ color: COLORS.muted }}>Thinking…</div>}
        <div ref={endRef} />
      </div>

      <div className="pt-3 border-t border-slate-700/50">
        <div className="flex gap-2">
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send(input)
              }
            }}
            rows={2}
            placeholder={`Ask about ${clientName}, or tell me what to correct…`}
            className="flex-1 px-3 py-2 rounded-lg text-sm outline-none resize-none"
            style={INPUT}
          />
          <button
            onClick={() => send(input)}
            disabled={busy || !input.trim()}
            className="px-4 rounded-lg text-sm font-medium disabled:opacity-40"
            style={{ backgroundColor: COLORS.accent, color: '#f8fafc' }}
          >
            Send
          </button>
        </div>
        {(history.length > 0 || messages.length > 0) && (
          <button onClick={clearThread} className="text-[11px] mt-2 hover:opacity-80" style={{ color: COLORS.muted }}>
            Clear this view
          </button>
        )}
      </div>
    </div>
  )
}
