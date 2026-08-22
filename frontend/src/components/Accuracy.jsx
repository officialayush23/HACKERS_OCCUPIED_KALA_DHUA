import { useQuery } from '@tanstack/react-query'
import { motion } from 'motion/react'
import {
  AlertTriangle, Check, Gauge, PackageCheck, ShieldCheck, TriangleAlert, UserCheck,
} from 'lucide-react'
import { api } from '@/lib/api'
import NoRun from '@/components/NoRun'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'

/**
 * Is the agent actually right?
 *
 * The rubric score says how well a run went against the marking formula. It does
 * not say whether the agent was *correct*, and those are different questions —
 * a run can score well and still have quietly ordered an uncertified part.
 *
 * Everything here is a verified outcome recomputed from the world and the audit
 * log, not a self-report. Each panel names what it counts, and what a bad number
 * would mean.
 */

const PANELS = [
  {
    key: 'constraint_compliance', icon: ShieldCheck,
    title: 'Constraint compliance',
    question: 'Did it ever break a hard rule?',
    fmt: (d) => `${d.orders_raised - d.violations} of ${d.orders_raised} orders clean`,
    // The only metric here where anything below 100 is a failure.
    critical: true,
  },
  {
    key: 'claim_verification', icon: TriangleAlert,
    title: 'Claim verification',
    question: 'Did it catch the suppliers who lied?',
    fmt: (d) => `${d.caught} of ${d.contradictions_present} contradictions caught`,
  },
  {
    key: 'delivery_accuracy', icon: PackageCheck,
    title: 'Delivery accuracy',
    question: 'Did the stock it bought actually turn up usable?',
    fmt: (d) => `${d.units_usable_on_arrival} of ${d.units_planned} units usable`,
  },
  {
    key: 'escalation_precision', icon: UserCheck,
    title: 'Escalation precision',
    question: 'When it stopped to ask, did it need to?',
    fmt: (d) => `${d.genuinely_over_authority} of ${d.escalations} escalations justified`,
  },
]

function tone(pct, critical) {
  if (pct == null) return 'text-muted-foreground'
  if (critical) return pct >= 100 ? 'text-ok' : 'text-danger'
  return pct >= 90 ? 'text-ok' : pct >= 60 ? 'text-warn' : 'text-danger'
}

export default function Accuracy({ revision, onRunSim }) {
  const { data } = useQuery({
    queryKey: ['accuracy', revision], queryFn: api.accuracy, refetchInterval: 5000 })
  const { data: run } = useQuery({
    queryKey: ['activeRun'], queryFn: api.activeRun, refetchInterval: 4000 })

  const interp = data?.interpretation
  const violations = data?.constraint_compliance?.detail ?? []

  // Zeros here would read as "the agent failed everything" when in fact nothing
  // has been asked of it. That is a different, and much worse, claim.
  if (!run?.active) {
    return (
      <NoRun icon={Gauge}
             title="Not evaluated"
             what="Accuracy is measured against a run's own artefacts. With no run there is
                   nothing to measure — these are not zeros, they are unasked questions."
             onRun={onRunSim} />
    )
  }

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-7 p-7">
        <div>
          <div className="flex items-center gap-2.5">
            <Gauge className="text-muted-foreground size-4" />
            <h2 className="text-muted-foreground text-[10px] font-medium
                           tracking-[0.14em] uppercase">Is the agent right?</h2>
          </div>
          <p className="text-muted-foreground mt-2.5 max-w-2xl text-[13px] leading-relaxed">
            Recomputed from the world and the append-only log every few seconds — not
            reported by the agent about itself. A rubric score says how well a run went;
            these say whether the decisions were correct.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-4">
          {PANELS.map((p, i) => {
            const d = data?.[p.key]
            const pct = d?.score_pct
            const Icon = p.icon
            return (
              <motion.div key={p.key} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
                          transition={{ delay: i * 0.05 }}>
                <Card className="gap-0 py-0">
                  <div className="p-6">
                    <div className="flex items-center gap-2.5">
                      <Icon className={`size-4 ${tone(pct, p.critical)}`} />
                      <span className="text-[14px] font-semibold tracking-tight">
                        {p.title}
                      </span>
                      {p.critical && (
                        <Badge variant="outline" className="ml-auto text-[9.5px]">
                          zero tolerance
                        </Badge>
                      )}
                    </div>

                    <p className="text-muted-foreground mt-2 text-[12px]">{p.question}</p>

                    <div className={`mt-4 font-mono text-[34px] leading-none tabular-nums
                      ${tone(pct, p.critical)}`}>
                      {pct == null ? '—' : `${pct}%`}
                    </div>
                    <Progress value={pct ?? 0} className="mt-3 h-1"
                              indicatorClassName={pct == null ? 'bg-muted'
                                : p.critical ? (pct >= 100 ? 'bg-ok' : 'bg-danger')
                                : pct >= 90 ? 'bg-ok' : pct >= 60 ? 'bg-warn' : 'bg-danger'} />

                    <div className="text-muted-foreground mt-3 text-[11.5px]">
                      {d ? p.fmt(d) : 'nothing measured yet'}
                    </div>
                    {d?.note && (
                      <p className="text-muted-foreground/70 mt-2.5 text-[11px] leading-relaxed">
                        {d.note}
                      </p>
                    )}
                  </div>
                </Card>
              </motion.div>
            )
          })}
        </div>

        {violations.length > 0 && (
          <Card className="border-danger/50 gap-0 py-0">
            <div className="p-6">
              <div className="text-danger flex items-center gap-2.5">
                <AlertTriangle className="size-4" />
                <span className="text-[14px] font-semibold tracking-tight">
                  {violations.length} constraint violation{violations.length > 1 ? 's' : ''}
                </span>
              </div>
              <p className="text-muted-foreground mt-2 text-[12.5px] leading-relaxed">
                These are failures regardless of what the run scored. Each names the
                order and the rule it broke.
              </p>
              <div className="mt-4 flex flex-col gap-2">
                {violations.map((v, i) => (
                  <div key={i} className="border-danger/40 bg-danger/[0.06] flex flex-wrap
                                          items-center gap-2.5 rounded-lg border px-3 py-2.5">
                    <span className="font-mono text-[11.5px]">{v.po_id}</span>
                    <Badge variant="outline"
                           className="border-danger/50 text-danger text-[9.5px]">
                      {v.rule}
                    </Badge>
                    <span className="text-muted-foreground text-[12px]">{v.detail}</span>
                  </div>
                ))}
              </div>
            </div>
          </Card>
        )}

        {interp && (
          <Card className="gap-0 py-0">
            <div className="p-6">
              <div className="flex items-center gap-2.5">
                <Check className="text-muted-foreground size-4" />
                <span className="text-[14px] font-semibold tracking-tight">
                  Reading supplier replies
                </span>
              </div>
              <div className="mt-5 flex flex-wrap items-end gap-10">
                {[
                  ['Read', interp.messages_read, 'replies received'],
                  ['Parsed into facts', interp.parsed_into_facts, 'quantity, price, lead time'],
                  ['Refused to guess', interp.refused_to_guess, 'handed to a person'],
                ].map(([k, v, sub]) => (
                  <div key={k}>
                    <div className="text-muted-foreground text-[10px] font-medium
                                    tracking-[0.12em] uppercase">{k}</div>
                    <div className="mt-1.5 font-mono text-[26px] leading-none tabular-nums">
                      {v ?? 0}
                    </div>
                    <div className="text-muted-foreground mt-1.5 text-[11px]">{sub}</div>
                  </div>
                ))}
              </div>
              <Separator className="my-5" />
              <p className="text-muted-foreground text-[11.5px] leading-relaxed">
                {interp.note} A message that says <i>“we may be able to arrange around
                400–500 units”</i> contains no number the agent may act on. Reading it as an
                offer would be inventing a fact, so it goes to a human instead — and that
                counts here as a correct outcome.
              </p>
            </div>
          </Card>
        )}
      </div>
    </ScrollArea>
  )
}
