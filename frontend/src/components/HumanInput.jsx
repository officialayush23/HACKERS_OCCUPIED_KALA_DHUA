import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AnimatePresence, motion } from 'motion/react'
import {
  CheckCircle2, HelpCircle, Loader2, MessageSquareQuote, Quote, UserCheck,
} from 'lucide-react'
import { api } from '@/lib/api'
import { refresh } from '@/lib/refresh'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Textarea } from '@/components/ui/textarea'

/**
 * The agent asking rather than guessing.
 *
 * Deliberately separate from Approvals. An approval is a decision the agent has
 * already made and is holding at the authority line. This is a decision it
 * *refused to make*, because the evidence would not carry it — a supplier who
 * said "around 400–500, subject to confirmation" has given us no number worth
 * spending money on.
 *
 * That refusal is the most defensible behaviour in the system, and until now it
 * happened silently. A judge could not see it, so it may as well not have.
 */

const KIND = {
  clarification: { label: 'Message unclear',   icon: MessageSquareQuote },
  claim:         { label: 'Claim unverified',  icon: HelpCircle },
  quantity:      { label: 'Quantity in doubt', icon: HelpCircle },
  quality:       { label: 'Quality decision',  icon: UserCheck },
}

function Confidence({ value }) {
  if (value == null) return null
  const pct = Math.round(value * 100)
  const tone = pct >= 75 ? 'text-ok' : pct >= 50 ? 'text-warn' : 'text-danger'
  return (
    <span className={`font-mono text-[11.5px] ${tone}`}>
      {pct}% confident
    </span>
  )
}

function Request({ req, onResolve, pending }) {
  const [note, setNote] = useState('')
  const [chosen, setChosen] = useState(null)
  const meta = KIND[req.kind] ?? KIND.clarification
  const Icon = meta.icon
  const options = req.options ?? []
  const ctx = req.context ?? {}

  return (
    <Card className="border-warn/40 gap-0 py-0">
      <div className="p-7">
        <div className="flex flex-wrap items-center gap-2.5">
          <Icon className="text-warn size-4 shrink-0" />
          <Badge variant="outline" className="border-warn/45 bg-warn/10 text-warn text-[10px]">
            {meta.label}
          </Badge>
          {req.supplier_name && (
            <span className="text-muted-foreground text-[12px]">{req.supplier_name}</span>
          )}
          {req.component_name && (
            <Badge variant="outline" className="text-[10px]">{req.component_name}</Badge>
          )}
          <span className="ml-auto"><Confidence value={req.confidence} /></span>
        </div>

        <h3 className="mt-4 text-[16px] leading-snug font-semibold tracking-tight">
          {req.question}
        </h3>
        {req.detail && (
          <p className="text-muted-foreground mt-2 text-[13px] leading-relaxed">
            {req.detail}
          </p>
        )}

        {/* what they actually wrote — the evidence, verbatim */}
        {ctx.message && (
          <div className="bg-muted/30 mt-5 rounded-lg px-4 py-3.5">
            <div className="text-muted-foreground flex items-center gap-1.5 text-[10px]
                            font-medium tracking-[0.1em] uppercase">
              <Quote className="size-3" />What they wrote
            </div>
            <p className="mt-2 text-[13px] leading-relaxed italic">“{ctx.message}”</p>
          </div>
        )}

        {/* what the agent did and did not manage to read out of it */}
        {(ctx.interpretation || ctx.quantity_mentioned != null) && (
          <div className="mt-4 flex flex-wrap gap-x-8 gap-y-3">
            {Object.entries(ctx.interpretation ?? ctx)
              .filter(([k, v]) => ['quantity_mentioned', 'unit_price', 'lead_time_days',
                                   'claim', 'firm_commitment'].includes(k) && v != null)
              .map(([k, v]) => (
                <div key={k}>
                  <div className="text-muted-foreground text-[10px] font-medium
                                  tracking-[0.1em] uppercase">
                    {k.replace(/_/g, ' ')}
                  </div>
                  <div className="mt-1 font-mono text-[15px]">{String(v)}</div>
                </div>
              ))}
          </div>
        )}

        <Separator className="my-6" />

        <div className="text-muted-foreground mb-3 text-[10px] font-medium
                        tracking-[0.12em] uppercase">What should it do?</div>

        <div className="flex flex-wrap gap-2">
          {options.map((o) => (
            <Button key={o} variant={chosen === o ? 'default' : 'outline'}
                    onClick={() => setChosen(o)} className="h-9 text-[12.5px]">
              {o}
            </Button>
          ))}
        </div>

        <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)}
                  placeholder="Anything the agent should record with your answer"
                  className="mt-4 text-[13px]" />

        <Button size="lg" disabled={!chosen || pending}
                onClick={() => onResolve(req, chosen, note)}
                className="mt-5 h-11">
          {pending && <Loader2 className="size-4 animate-spin" />}
          {chosen ? `Answer — ${chosen}` : 'Choose an answer'}
        </Button>

        <p className="text-muted-foreground/70 mt-3 text-[11px] leading-relaxed">
          Your answer is recorded against your name, not the agent's. It resumes from there.
        </p>
      </div>
    </Card>
  )
}

export default function HumanInput({ onRunSim }) {
  const qc = useQueryClient()
  const { data } = useQuery({
    queryKey: ['human-input'], queryFn: api.humanInput})

  const resolve = useMutation({
    mutationFn: ({ id, body }) => api.resolveInput(id, body),
    onSuccess: () => refresh(qc, 'decision'),
  })

  const open = data?.open ?? []
  const recent = data?.recent ?? []

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto flex max-w-3xl flex-col gap-7 p-7">

        <div>
          <h2 className="text-[19px] font-semibold tracking-tight">
            {open.length
              ? `${open.length} question${open.length > 1 ? 's' : ''} for you`
              : 'The agent has not had to ask'}
          </h2>
          <p className="text-muted-foreground mt-2.5 max-w-xl text-[13px] leading-relaxed">
            These are decisions the agent <b>refused to make</b> — not ones it made and is
            holding for approval. When a supplier's reply will not carry a number, guessing
            is the failure. Asking is the correct behaviour.
          </p>
        </div>

        <AnimatePresence mode="popLayout">
          {open.map((r) => (
            <motion.div key={r.id} layout
                        initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.98 }}>
              <Request req={r} pending={resolve.isPending}
                       onResolve={(req, choice, note) => resolve.mutate({
                         id: req.id, body: { choice, note: note || null,
                                             decided_by: 'operator' } })} />
            </motion.div>
          ))}
        </AnimatePresence>

        {open.length === 0 && (
          <Card className="gap-0 py-0">
            <div className="flex flex-col items-center gap-2.5 p-14 text-center">
              <CheckCircle2 className="text-ok/60 size-7" />
              <p className="text-[14px] font-medium">Nothing is waiting on you</p>
              <p className="text-muted-foreground max-w-sm text-[12.5px] leading-relaxed">
                Every reply so far has been clear enough to act on. If one arrives that
                is not, the agent will stop and ask here rather than invent a figure.
              </p>
            </div>
          </Card>
        )}

        {recent.length > 0 && (
          <div>
            <h3 className="text-muted-foreground text-[10px] font-medium
                           tracking-[0.14em] uppercase">Already answered</h3>
            <div className="mt-3 flex flex-col gap-1">
              {recent.map((r) => (
                <div key={r.id} className="flex flex-wrap items-baseline gap-2.5
                                           rounded-lg border px-4 py-3">
                  <span className="text-[12.5px]">{r.question}</span>
                  <Badge variant="outline"
                         className="border-primary/40 bg-primary/10 text-primary text-[10px]">
                    {r.chosen_option}
                  </Badge>
                  <span className="text-muted-foreground ml-auto text-[11px]">
                    {r.resolved_by}
                  </span>
                  {r.note && (
                    <p className="text-muted-foreground w-full text-[11.5px] leading-relaxed">
                      {r.note}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </ScrollArea>
  )
}
