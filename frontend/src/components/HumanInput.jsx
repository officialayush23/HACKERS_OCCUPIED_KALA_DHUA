import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AnimatePresence, motion } from 'motion/react'
import {
  ArrowRight, CheckCircle2, CircleHelp, Loader2, MessageSquare, Quote,
} from 'lucide-react'
import { api } from '@/lib/api'
import { refresh } from '@/lib/refresh'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'

/**
 * The questions the agent refused to answer.
 *
 * Distinct from Approvals, and the distinction is the interesting one. An
 * approval is a decision the agent already made and may not execute. This is a
 * decision it declined to make, because the evidence would not carry it — and
 * that is the more valuable behaviour of the two, because it is the one that
 * stops an agent inventing a fact and then spending money on it.
 *
 * These events were already being emitted with a confidence and three options
 * attached. Nothing rendered them, so the agent was politely asking a question
 * into a log file. Every option here does something specific and says what
 * before you press it.
 */

const KIND = {
  ambiguous_reply: {
    label: 'A reply it could not act on',
    why: 'Language that sounds like an offer and commits to nothing. Reading a '
       + 'quantity out of it would be inventing supply.',
  },
  contradiction: {
    label: 'Two sources disagree',
    why: 'It will not pick a winner between a counterparty and a system of record '
       + 'without being told to.',
  },
  no_viable_option: {
    label: 'Nothing satisfies every constraint',
    why: 'Every candidate failed a hard rule. Recovering needs a rule relaxed, '
       + 'and that is not the agent’s to relax.',
  },
  conflicting_extraction: {
    label: 'Two readings of the same message',
    why: 'The model and the text disagree on a number. It kept neither.',
  },
}

function Confidence({ value }) {
  const v = Number(value ?? 0)
  const tone = v >= 0.7 ? 'bg-ok' : v >= 0.4 ? 'bg-warn' : 'bg-danger'
  return (
    <div className="flex items-center gap-2.5">
      <span className="text-muted-foreground text-[10px] font-medium tracking-[0.12em]
                       uppercase">its confidence</span>
      <Progress value={v * 100} className="h-1 w-20" indicatorClassName={tone} />
      <span className="font-mono text-[11.5px] tabular-nums">{v.toFixed(2)}</span>
    </div>
  )
}

function Card_({ req, onResolve, pending }) {
  const [note, setNote] = useState('')
  const [chosen, setChosen] = useState(null)
  const meta = KIND[req.kind] ?? { label: req.kind.replace(/_/g, ' '), why: '' }
  const quoted = req.context?.message

  return (
    <motion.div layout
      initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, height: 0 }}
      className="border-warn/45 bg-warn/[0.05] rounded-xl border p-6">

      <div className="flex flex-wrap items-center gap-2.5">
        <Badge variant="outline"
               className="border-warn/50 bg-warn/12 text-warn gap-1 text-[10px]">
          <CircleHelp className="size-2.5" />{meta.label}
        </Badge>
        {req.supplier_name && (
          <span className="text-muted-foreground text-[11.5px]">{req.supplier_name}</span>
        )}
        {req.confidence != null && (
          <div className="ml-auto"><Confidence value={req.confidence} /></div>
        )}
      </div>

      <h3 className="mt-3.5 text-[16px] leading-snug font-semibold tracking-tight">
        {req.question}
      </h3>
      {req.detail && (
        <p className="text-muted-foreground mt-2 text-[13px] leading-relaxed">{req.detail}</p>
      )}

      {quoted && (
        <div className="bg-muted/40 mt-4 flex items-start gap-2.5 rounded-lg px-4 py-3">
          <Quote className="text-muted-foreground/50 mt-0.5 size-3.5 shrink-0" />
          <p className="text-[12.5px] leading-relaxed italic">{quoted}</p>
        </div>
      )}

      {meta.why && (
        <p className="text-muted-foreground/80 mt-3 text-[11.5px] leading-relaxed">
          {meta.why}
        </p>
      )}

      <Separator className="my-5" />

      <div className="text-muted-foreground mb-2.5 text-[10px] font-medium
                      tracking-[0.14em] uppercase">
        What each answer will do
      </div>
      <div className="flex flex-col gap-2">
        {(req.options ?? []).map((o) => {
          const on = chosen === o.id
          return (
            <button key={o.id} onClick={() => setChosen(o.id)}
              className={`rounded-lg border px-4 py-3 text-left transition-colors ${
                on ? 'border-primary/55 bg-primary/[0.07]' : 'hover:bg-accent/40'}`}>
              <div className="flex items-center gap-2">
                {on && <CheckCircle2 className="text-primary size-3.5 shrink-0" />}
                <span className="text-[13.5px] font-medium">{o.label}</span>
              </div>
              {o.detail && (
                <p className="text-muted-foreground mt-1 text-[12px] leading-relaxed">
                  {o.detail}
                </p>
              )}
              {o.effect && (
                <p className="text-muted-foreground/70 mt-1.5 flex items-center gap-1.5
                              text-[11px] leading-relaxed">
                  <ArrowRight className="size-3 shrink-0" />{o.effect}
                </p>
              )}
            </button>
          )
        })}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Input value={note} onChange={(e) => setNote(e.target.value)}
               placeholder="why, for the record (optional)"
               className="h-9 min-w-[14rem] flex-1 text-[12.5px]" />
        <Button size="lg" disabled={!chosen || pending} className="h-9 px-5 text-[13px]"
                onClick={() => onResolve(req.id, { choice: chosen, note: note.trim() || null })}>
          {pending && <Loader2 className="size-3.5 animate-spin" />}
          Answer
        </Button>
      </div>
    </motion.div>
  )
}

export default function HumanInput({ revision, onGoto }) {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({
    queryKey: ['human-input', revision], queryFn: api.humanInput, refetchInterval: 3000 })

  const resolve = useMutation({
    mutationFn: ({ id, body }) => api.resolveInput(id, body),
    onSuccess: () => refresh(qc, 'decision'),
  })

  const open = data?.open ?? []
  const recent = data?.recent ?? []

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto flex max-w-3xl flex-col gap-7 p-8">
        <div>
          <h2 className="text-[22px] font-semibold tracking-tight">
            {open.length
              ? `${open.length} question${open.length > 1 ? 's' : ''} it would not answer`
              : 'It has not had to ask you anything'}
          </h2>
          <p className="text-muted-foreground mt-2 max-w-2xl text-[13.5px] leading-relaxed">
            Different from approvals. An approval is a decision the agent already made
            and may not execute. These are decisions it <b>declined to make</b>, because
            the evidence would not carry them — which is the behaviour that stops it
            inventing a fact and then spending money on it.
          </p>
        </div>

        {isLoading && (
          <div className="text-muted-foreground flex items-center gap-2 text-[13px]">
            <Loader2 className="size-4 animate-spin" />loading…
          </div>
        )}

        <div className="flex flex-col gap-4">
          <AnimatePresence mode="popLayout">
            {open.map((r) => (
              <Card_ key={r.id} req={r} pending={resolve.isPending}
                     onResolve={(id, body) => resolve.mutate({ id, body })} />
            ))}
          </AnimatePresence>

          {!isLoading && open.length === 0 && (
            <div className="flex flex-col items-center gap-2.5 py-16 text-center">
              <CheckCircle2 className="text-ok/60 size-7" />
              <p className="text-[14px] font-medium">Nothing is stuck</p>
              <p className="text-muted-foreground max-w-sm text-[12.5px] leading-relaxed">
                Every message so far has been clear enough to act on. Send a hedged
                reply from a supplier portal — &ldquo;we may be able to arrange around
                500 units&rdquo; — and one of these appears within a second.
              </p>
              {onGoto && (
                <Button variant="ghost" size="sm" onClick={() => onGoto('comms')}
                        className="text-muted-foreground mt-1 h-8 text-[12px]">
                  <MessageSquare className="size-3.5" />open the conversations
                </Button>
              )}
            </div>
          )}
        </div>

        {recent.length > 0 && (
          <>
            <Separator />
            <div>
              <div className="text-muted-foreground mb-3 text-[10px] font-medium
                              tracking-[0.14em] uppercase">Recently answered</div>
              <ul className="flex flex-col gap-2.5">
                {recent.map((r) => (
                  <li key={r.id} className="flex items-start gap-2.5 text-[12.5px]
                                            leading-relaxed">
                    <CheckCircle2 className="text-ok mt-[3px] size-3.5 shrink-0" />
                    <span>
                      {r.question}
                      <span className="text-muted-foreground">
                        {' '}— {r.resolved_by} chose <b>{r.chosen_option}</b>
                        {r.note ? `: ${r.note}` : ''}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </>
        )}
      </div>
    </ScrollArea>
  )
}
