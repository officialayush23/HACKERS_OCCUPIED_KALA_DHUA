import { useEffect, useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { AnimatePresence, motion } from 'motion/react'
import { ArrowUp, Bot, Loader2, Sparkles, User } from 'lucide-react'
import { api } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Textarea } from '@/components/ui/textarea'

/**
 * Talking to the agent, properly.
 *
 * The command bar could take a question, but it was a search box that happened
 * to answer: one turn, no history, and the reply had to fit in a dropdown. You
 * cannot ask "why that one?" after "what should I do?" — and follow-ups are
 * most of what anyone actually wants from this.
 *
 * Two rules this screen keeps:
 *
 *   **The numbers are not the model's.** Every table and card below a reply is
 *   built server-side from the operational tables and sent as `blocks`. The
 *   model writes the sentence around them and nothing else. So a figure here
 *   exists in the database, and the answer still carries its figures when the
 *   model is unreachable — which is the state this system spends a lot of its
 *   life in and should degrade gracefully into.
 *
 *   **It reads, it never writes.** Nothing said here changes the world. Actions
 *   live on Approvals and Questions, where they are recorded against your name.
 */

const STARTERS = [
  'What needs me right now?',
  'Why was that supplier refused?',
  'What is the cheapest option that actually clears the shortfall?',
  'Which component is tightest on cover?',
  'What did the agent do without asking me?',
]

function Blocks({ blocks }) {
  return (
    <div className="mt-4 flex flex-col gap-4">
      {blocks.map((b, i) => {
        if (b.kind === 'facts') {
          return (
            <div key={i}>
              <div className="text-muted-foreground text-[10px] font-medium
                              tracking-[0.12em] uppercase">{b.title}</div>
              <div className="mt-2 flex flex-wrap gap-2">
                {(b.items ?? []).map((it, j) => (
                  <div key={j} className="min-w-[9rem] rounded-lg border px-3 py-2">
                    <div className="text-muted-foreground font-mono text-[10px]">{it.label}</div>
                    <div className="mt-0.5 text-[13px] font-medium">{it.value}</div>
                    {it.sub && (
                      <div className="text-muted-foreground mt-0.5 text-[11px]">{it.sub}</div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )
        }

        if (b.kind === 'table') {
          const align = b.align ?? []
          return (
            <div key={i}>
              <div className="text-muted-foreground text-[10px] font-medium
                              tracking-[0.12em] uppercase">{b.title}</div>
              <div className="mt-2 overflow-x-auto rounded-lg border">
                <table className="w-full text-[12.5px]">
                  <thead>
                    <tr className="bg-muted/40">
                      {(b.columns ?? []).map((c, k) => (
                        <th key={k}
                            className={`text-muted-foreground px-3 py-2 text-[10px] font-medium
                                        tracking-[0.1em] whitespace-nowrap uppercase
                                        ${align[k] === 'right' ? 'text-right' : 'text-left'}`}>
                          {c}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(b.rows ?? []).map((row, ri) => (
                      <tr key={ri} className="border-t">
                        {row.map((cell, ci) => (
                          <td key={ci}
                              className={`px-3 py-2 ${align[ci] === 'right'
                                ? 'text-right font-mono tabular-nums' : ''}`}>{cell}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {b.note && (
                <p className="text-muted-foreground/70 mt-1.5 text-[10.5px] leading-relaxed">
                  {b.note}
                </p>
              )}
            </div>
          )
        }

        if (b.kind === 'list') {
          return (
            <div key={i}>
              <div className="text-muted-foreground text-[10px] font-medium
                              tracking-[0.12em] uppercase">{b.title}</div>
              <ul className="mt-2 flex flex-col gap-1.5">
                {(b.items ?? []).map((it, j) => (
                  <li key={j} className="flex gap-2 text-[12.5px] leading-relaxed">
                    <span className="text-muted-foreground/60 shrink-0">·</span>{it}
                  </li>
                ))}
              </ul>
            </div>
          )
        }
        return null
      })}
    </div>
  )
}

function Turn({ turn }) {
  const mine = turn.role === 'you'
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
                className={`flex gap-3.5 ${mine ? 'justify-end' : ''}`}>
      {!mine && (
        <div className="bg-primary/12 ring-primary/25 mt-0.5 flex size-7 shrink-0
                        items-center justify-center rounded-lg ring-1">
          <Bot className="text-primary size-3.5" />
        </div>
      )}

      <div className={`min-w-0 ${mine ? 'max-w-[75%]' : 'max-w-[85%] flex-1'}`}>
        {mine ? (
          <div className="bg-primary/10 border-primary/25 rounded-2xl rounded-tr-sm border
                          px-4 py-2.5 text-[13.5px] leading-relaxed">
            {turn.text}
          </div>
        ) : (
          <div>
            {turn.pending ? (
              <div className="text-muted-foreground flex items-center gap-2 py-1 text-[13px]">
                <Loader2 className="size-3.5 animate-spin" />reading the current state…
              </div>
            ) : (
              <>
                <p className="text-[13.5px] leading-relaxed">{turn.text}</p>
                {turn.blocks?.length > 0 && <Blocks blocks={turn.blocks} />}
                {turn.grounding?.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {turn.grounding.map((g, i) => (
                      <Badge key={i} variant="outline" className="text-[10px]">{g}</Badge>
                    ))}
                  </div>
                )}
                <p className="text-muted-foreground/60 mt-2 text-[10.5px]">
                  {turn.llm
                    ? 'Written by the model from the figures below it. The figures are the database’s.'
                    : 'The model was unreachable, so this is the deterministic summary. The figures are unaffected — they never came from the model.'}
                </p>
              </>
            )}
          </div>
        )}
      </div>

      {mine && (
        <div className="bg-muted mt-0.5 flex size-7 shrink-0 items-center justify-center
                        rounded-lg">
          <User className="text-muted-foreground size-3.5" />
        </div>
      )}
    </motion.div>
  )
}

export default function Chat({ incidentId }) {
  const [turns, setTurns] = useState([])
  const [q, setQ] = useState('')
  const endRef = useRef(null)
  const boxRef = useRef(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [turns])

  const ask = useMutation({
    mutationFn: (question) => api.ask(question, incidentId),
    // The reply is the answer; a toast on top of it would be noise.
    meta: { silent: true },
    onSuccess: (r) => setTurns((t) => t.map((x) => (
      x.pending ? { ...x, pending: false, text: r.answer, blocks: r.blocks,
                    grounding: r.grounding, llm: r.llm } : x))),
    onError: (e) => setTurns((t) => t.map((x) => (
      x.pending
        ? { ...x, pending: false, error: true,
            text: `I could not answer that — ${e.message}` }
        : x))),
  })

  const send = (text) => {
    const question = (text ?? q).trim()
    if (!question || ask.isPending) return
    setTurns((t) => [...t,
      { id: `${t.length}-you`, role: 'you', text: question },
      { id: `${t.length}-agent`, role: 'agent', pending: true }])
    setQ('')
    ask.mutate(question)
  }

  return (
    <div className="flex h-full flex-col">
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex max-w-3xl flex-col gap-7 px-7 py-8">
          {turns.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-14 text-center">
              <div className="bg-primary/12 ring-primary/25 flex size-12 items-center
                              justify-center rounded-2xl ring-1">
                <Sparkles className="text-primary size-5" />
              </div>
              <h2 className="text-[19px] font-semibold tracking-tight">
                Ask about the run in front of you
              </h2>
              <p className="text-muted-foreground max-w-md text-[13px] leading-relaxed">
                This reads the live operational state — incidents, plans, refusals, stock —
                and answers from it. It never invents a number and it never changes
                anything. Approving and answering still happen on their own screens, where
                they are recorded against your name.
              </p>
              <div className="mt-3 flex max-w-lg flex-wrap justify-center gap-2">
                {STARTERS.map((s) => (
                  <Button key={s} variant="outline" size="sm"
                          onClick={() => send(s)}
                          className="h-8 text-[12px] font-normal">{s}</Button>
                ))}
              </div>
            </div>
          ) : (
            <AnimatePresence initial={false}>
              {turns.map((t) => <Turn key={t.id} turn={t} />)}
            </AnimatePresence>
          )}
          <div ref={endRef} />
        </div>
      </ScrollArea>

      <div className="shrink-0 border-t px-7 py-4">
        <div className="mx-auto flex max-w-3xl items-end gap-2.5">
          <Textarea
            ref={boxRef} value={q} rows={1}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends, Shift+Enter is a newline. Anything else here would
              // be a surprise to everyone who has ever used a chat box.
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
            }}
            placeholder="Ask about this run — why an option was refused, what is tightest, what needs you…"
            className="max-h-40 min-h-[2.75rem] resize-none py-3 text-[13.5px]" />
          <Button size="icon" disabled={!q.trim() || ask.isPending}
                  onClick={() => send()} className="size-11 shrink-0">
            {ask.isPending ? <Loader2 className="size-4 animate-spin" />
                           : <ArrowUp className="size-4" />}
          </Button>
        </div>
        <p className="text-muted-foreground/60 mx-auto mt-2 max-w-3xl text-[10.5px]">
          Read-only. Enter to send, Shift+Enter for a new line.
        </p>
      </div>
    </div>
  )
}
