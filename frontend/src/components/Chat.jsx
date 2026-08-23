import { useEffect, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { AnimatePresence, motion } from 'motion/react'
import {
  ArrowUp, Ban, Bot, CheckCircle2, HelpCircle, Loader2, ShieldAlert, Sparkles, User,
} from 'lucide-react'
import { api } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { inr } from '@/lib/format'
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

/** Does this read as an instruction rather than a question? */
const IMPERATIVE = /^\s*(buy|order|source|procure|purchase|get|find|secure|cover|cancel|don'?t|do not|avoid|exclude|stop using|never use|place|raise)\b/i

const ASK = [
  'What needs me right now?',
  'Why was that supplier refused?',
  'Which component is tightest on cover?',
]

const DO = [
  'Buy enough Motor Driver IC to cover the run',
  "Don't use SUP-21, find another supplier",
  'Source 500 Motor Driver IC and place the best compliant order',
]

const STATUS = {
  completed:           { label: 'Done',                tone: 'text-ok',      Icon: CheckCircle2 },
  needs_approval:      { label: 'Waiting on you',      tone: 'text-warn',    Icon: ShieldAlert },
  blocked:             { label: 'I cannot do that',    tone: 'text-danger',  Icon: Ban },
  needs_clarification: { label: 'I need one detail',   tone: 'text-warn',    Icon: HelpCircle },
  executing:           { label: 'Working',             tone: 'text-primary', Icon: Loader2 },
}

const STATE_MARK = { done: '✓', blocked: '✕' }

/**
 * The result of an instruction.
 *
 * Deliberately never a paragraph. A command has a status, a plan it followed,
 * the rules that stopped it, and what it can do instead — and each of those is
 * a different thing a person does something different with. Flattening them
 * into prose is how "I cannot source the components" happens, which tells you
 * nothing you can act on.
 */
function CommandResult({ r }) {
  const meta = STATUS[r.status] ?? STATUS.needs_clarification
  const { Icon } = meta

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-2.5">
        <Icon className={`mt-0.5 size-4 shrink-0 ${meta.tone}`} />
        <div className="min-w-0">
          <div className={`text-[11px] font-medium tracking-[0.12em] uppercase ${meta.tone}`}>
            {meta.label}
          </div>
          <p className="mt-1 text-[13.5px] leading-relaxed">{r.summary}</p>
        </div>
      </div>

      {r.plan?.length > 0 && (
        <div className="rounded-xl border px-4 py-3">
          <div className="text-muted-foreground text-[10px] font-medium
                          tracking-[0.12em] uppercase">What I did</div>
          <ol className="mt-2 flex flex-col gap-1.5">
            {r.plan.map((p, i) => (
              <li key={i} className="flex gap-2.5 text-[12.5px] leading-relaxed">
                <span className={`shrink-0 font-mono ${
                  p.state === 'blocked' ? 'text-danger'
                  : p.state === 'done' ? 'text-ok' : 'text-warn'}`}>
                  {STATE_MARK[p.state] ?? '·'}
                </span>
                <span className="min-w-0">
                  {p.step}
                  {p.state && p.state !== 'done' && (
                    <span className="text-muted-foreground"> — {p.state}</span>
                  )}
                  {p.detail && (
                    <span className="text-muted-foreground block text-[11.5px]">
                      {p.detail}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {r.blockers?.length > 0 && (
        <div className="border-danger/35 bg-danger/[0.05] rounded-xl border px-4 py-3">
          <div className="text-danger text-[10px] font-medium tracking-[0.12em] uppercase">
            Why I could not
          </div>
          <ul className="mt-2 flex flex-col gap-1.5">
            {r.blockers.map((b, i) => (
              <li key={i} className="text-[12.5px] leading-relaxed">
                <span className="font-mono text-[11px] opacity-70">{b.constraint}</span>{' '}
                — {b.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {r.alternatives?.length > 0 && (
        <div>
          <div className="text-muted-foreground text-[10px] font-medium
                          tracking-[0.12em] uppercase">What I can do instead</div>
          <div className="mt-2 flex flex-col gap-2">
            {r.alternatives.map((a, i) => (
              <div key={i} className="rounded-xl border px-4 py-3">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="text-[13px] font-medium">{a.label}</span>
                  {a.cost > 0 && (
                    <span className="font-mono text-[12.5px] tabular-nums">
                      {inr(a.cost)}
                    </span>
                  )}
                  {a.requires_approval && (
                    <Badge variant="outline"
                           className="border-warn/40 bg-warn/10 text-warn text-[9.5px]">
                      needs your approval
                    </Badge>
                  )}
                  {a.arrives_in_days > 0 && (
                    <span className="text-muted-foreground text-[11.5px]">
                      arrives in {a.arrives_in_days}d
                    </span>
                  )}
                </div>
                {a.why_not_chosen && (
                  <p className="text-muted-foreground mt-1 text-[11.5px] leading-relaxed">
                    {a.why_not_chosen}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {r.actions_taken?.length > 0 && (
        <div className="border-ok/35 bg-ok/[0.05] rounded-xl border px-4 py-3">
          <div className="text-ok text-[10px] font-medium tracking-[0.12em] uppercase">
            What changed
          </div>
          <ul className="mt-2 flex flex-col gap-1">
            {r.actions_taken.map((a, i) => (
              <li key={i} className="text-[12.5px] leading-relaxed">
                {a.label ?? a.action}
                {a.cost ? ` — ${inr(a.cost)}` : ''}
                {a.detail && (
                  <span className="text-muted-foreground block text-[11.5px]">{a.detail}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {r.human_action_required && (
        <p className="text-[12.5px] leading-relaxed">
          <span className="text-muted-foreground">Over to you — </span>
          {r.human_action_required}
        </p>
      )}
    </div>
  )
}

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
                <Loader2 className="size-3.5 animate-spin" />
                {turn.mode === 'do' ? 'working on it…' : 'reading the current state…'}
              </div>
            ) : turn.command ? (
              <CommandResult r={turn.command} />
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

  const qc = useQueryClient()

  const settle = (patch) => setTurns((t) => t.map((x) => (
    x.pending ? { ...x, pending: false, ...patch } : x)))

  const ask = useMutation({
    mutationFn: (question) => api.ask(question, incidentId),
    // The reply is the answer; a toast on top of it would be noise.
    meta: { silent: true },
    onSuccess: (r) => settle({ text: r.answer, blocks: r.blocks,
                               grounding: r.grounding, llm: r.llm }),
    onError: (e) => settle({ error: true, text: `I could not answer that — ${e.message}` }),
  })

  const act = useMutation({
    mutationFn: (instruction) => api.command(instruction),
    meta: { silent: true },
    onSuccess: (r) => {
      settle({ command: r })
      // A command changes the world. Everything else on screen is now behind.
      qc.invalidateQueries({ predicate: (x) => x.queryKey?.[0] !== 'llm',
                             refetchType: 'all' })
      if (r.status === 'completed') toast.success(r.summary)
      else if (r.status === 'needs_approval') toast.warning(r.summary)
      else if (r.status === 'blocked') toast.error(r.summary)
    },
    onError: (e) => settle({ error: true,
                             text: `I could not carry that out — ${e.message}` }),
  })

  const busy = ask.isPending || act.isPending

  const send = (text, forceMode) => {
    const input = (text ?? q).trim()
    if (!input || busy) return
    // Questions read; commands write. Guessing wrong in the write direction is
    // the expensive mistake, so an instruction has to actually look like one —
    // and the backend refuses to act on anything it reads as a question anyway.
    const isCommand = forceMode === 'do' || (forceMode !== 'ask' && IMPERATIVE.test(input))
    setTurns((t) => [...t,
      { id: `${t.length}-you`, role: 'you', text: input, mode: isCommand ? 'do' : 'ask' },
      { id: `${t.length}-agent`, role: 'agent', pending: true,
        mode: isCommand ? 'do' : 'ask' }])
    setQ('')
    ;(isCommand ? act : ask).mutate(input)
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
                Ask it, or tell it what to do
              </h2>
              <p className="text-muted-foreground max-w-md text-[13px] leading-relaxed">
                Questions are answered from the live operational state. Instructions go
                into the same agent an alert would wake — it reads the real position,
                applies the same hard constraints, and either does it, or tells you which
                rule stopped it and what it can do instead. Anything past its
                ₹1,50,000 authority stops for you.
              </p>
              <div className="mt-4 flex w-full max-w-xl flex-col gap-4">
                <div>
                  <div className="text-muted-foreground mb-2 text-[10px] font-medium
                                  tracking-[0.12em] uppercase">Ask it something</div>
                  <div className="flex flex-wrap justify-center gap-2">
                    {ASK.map((x) => (
                      <Button key={x} variant="outline" size="sm"
                              onClick={() => send(x, 'ask')}
                              className="h-8 text-[12px] font-normal">{x}</Button>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="text-muted-foreground mb-2 text-[10px] font-medium
                                  tracking-[0.12em] uppercase">Tell it to do something</div>
                  <div className="flex flex-wrap justify-center gap-2">
                    {DO.map((x) => (
                      <Button key={x} variant="outline" size="sm"
                              onClick={() => send(x, 'do')}
                              className="border-primary/35 h-8 text-[12px] font-normal">
                        {x}
                      </Button>
                    ))}
                  </div>
                </div>
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
            placeholder="Ask, or instruct — “why was SUP-18 refused?” · “buy enough Motor Driver IC to cover the run”"
            className="max-h-40 min-h-[2.75rem] resize-none py-3 text-[13.5px]" />
          <Button size="icon" disabled={!q.trim() || busy}
                  onClick={() => send()} className="size-11 shrink-0">
            {busy ? <Loader2 className="size-4 animate-spin" />
                           : <ArrowUp className="size-4" />}
          </Button>
        </div>
        <p className="text-muted-foreground/60 mx-auto mt-2 max-w-3xl text-[10.5px]">
          Questions read; instructions act, inside the agent’s authority. Enter to send,
          Shift+Enter for a new line.
        </p>
      </div>
    </div>
  )
}
