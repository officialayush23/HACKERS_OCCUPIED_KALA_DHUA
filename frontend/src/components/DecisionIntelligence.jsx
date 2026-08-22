import { useQuery } from '@tanstack/react-query'
import { motion } from 'motion/react'
import {
  AlertTriangle, Ban, Check, CircleHelp, FileSearch, Gavel, Unlink, Loader2,
  Eye, ShieldAlert, Sigma,
} from 'lucide-react'
import { api } from '@/lib/api'
import { inr } from '@/lib/format'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'

/**
 * The brief, in the order a decision is actually made.
 *
 * The Decision Explorer answers *what did the solver pick and what did it
 * refuse*. That is a comparison, and it is the right screen for a procurement
 * analyst. It is the wrong screen for the person who has to sign, who asks a
 * different five questions in a fixed order:
 *
 *     What do we know, and how do we know it?          EVIDENCE
 *     So what is true about this situation?            CONCLUSION
 *     What is being done?                              ACTION
 *     Why that and not something else?                 WHY
 *     How sure are you, and what would change it?      CONFIDENCE
 *
 * Every row is assembled from a fact with a source attached. Nothing on this
 * screen is written by a language model — a brief whose reasoning was composed
 * afterwards is a rationalisation, and an auditor can tell.
 */

const VERDICT = {
  corroborated:  { label: 'corroborated', icon: Check,
                   cls: 'border-ok/45 bg-ok/12 text-ok' },
  contradicted:  { label: 'contradicted', icon: Unlink,
                   cls: 'border-danger/50 bg-danger/12 text-danger' },
  single_source: { label: 'single source', icon: Eye,
                   cls: 'border-warn/45 bg-warn/12 text-warn' },
  hedged:        { label: 'not a commitment', icon: CircleHelp,
                   cls: 'border-warn/45 bg-warn/12 text-warn' },
  unresolved:    { label: 'unanswered', icon: CircleHelp,
                   cls: 'border-danger/40 bg-danger/10 text-danger' },
}

const BAND_TONE = {
  high:     'text-ok',
  moderate: 'text-warn',
  low:      'text-danger',
}

function Step({ n, title, hint, icon: Icon, children }) {
  return (
    <section>
      <div className="flex items-baseline gap-3">
        <span className="text-muted-foreground/60 font-mono text-[11px] tabular-nums">
          {String(n).padStart(2, '0')}
        </span>
        <h3 className="flex items-center gap-2 text-[15px] font-semibold tracking-tight">
          {Icon && <Icon className="text-muted-foreground size-4" />}{title}
        </h3>
      </div>
      {hint && (
        <p className="text-muted-foreground mt-1.5 ml-[2.1rem] text-[12px] leading-relaxed">
          {hint}
        </p>
      )}
      <div className="mt-4 ml-[2.1rem]">{children}</div>
    </section>
  )
}

export default function DecisionIntelligence({ incidentId, productionOrderId, onGoto }) {
  const { data, isLoading } = useQuery({
    queryKey: ['intelligence', incidentId ?? null, productionOrderId ?? null],
    queryFn: () => api.intelligence(incidentId, productionOrderId),
  })

  if (isLoading) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center gap-2
                      text-[13px]">
        <Loader2 className="size-4 animate-spin" />assembling the brief…
      </div>
    )
  }

  if (!data?.available) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2.5 p-10
                      text-center">
        <FileSearch className="text-muted-foreground/40 size-7" />
        <p className="text-[14px] font-medium">Nothing to brief on</p>
        <p className="text-muted-foreground max-w-sm text-[12.5px] leading-relaxed">
          {data?.reason ?? 'Every component is covered.'}
        </p>
      </div>
    )
  }

  const { subject, evidence, conclusion, action, why, confidence, residual_risk } = data
  const refusals = why.filter((w) => w.refusal)
  const reasons = why.filter((w) => !w.refusal)

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto flex max-w-3xl flex-col gap-9 p-8">

        {/* ------------------------------------------------------- heading */}
        <div>
          <div className="text-muted-foreground text-[10px] font-medium
                          tracking-[0.14em] uppercase">
            Decision brief · {subject.incident_id ?? subject.production_order_id}
          </div>
          <h2 className="mt-2 text-[24px] leading-tight font-semibold tracking-tight">
            {subject.product} for {subject.customer}
          </h2>
          <p className="text-muted-foreground mt-1.5 text-[13px]">
            {subject.component} · {subject.part_number} · {subject.priority} priority
          </p>
        </div>

        {/* ---------------------------------------------------- 01 evidence */}
        <Step n={1} title="What we know, and how we know it" icon={Eye}
              hint="Every row names what it was checked against. A figure nobody has
                    corroborated is marked as such and costs confidence below —
                    a stock number no one has laid eyes on is genuinely worth less.">
          <div className="overflow-x-auto rounded-xl border">
            <table className="w-full border-collapse text-[12.5px]">
              <thead>
                <tr className="bg-muted/40">
                  {['Source', 'The question', 'What came back', 'Checked against', ''].map(
                    (h) => (
                      <th key={h} className="text-muted-foreground px-3 py-2.5 text-left
                                             text-[10px] font-medium tracking-[0.1em]
                                             uppercase">{h}</th>
                    ))}
                </tr>
              </thead>
              <tbody>
                {evidence.map((e, i) => {
                  const v = VERDICT[e.verdict] ?? VERDICT.single_source
                  return (
                    <tr key={i} className="border-t align-top">
                      <td className="px-3 py-3 font-medium">{e.source}</td>
                      <td className="text-muted-foreground max-w-[13rem] px-3 py-3
                                     leading-relaxed">{e.question}</td>
                      <td className="max-w-[16rem] px-3 py-3 leading-relaxed">
                        {e.finding}
                        {e.weight && (
                          <span className="text-muted-foreground mt-1 block text-[11px]
                                           leading-relaxed">{e.weight}</span>
                        )}
                      </td>
                      <td className="text-muted-foreground max-w-[12rem] px-3 py-3
                                     leading-relaxed">{e.checked_against}</td>
                      <td className="px-3 py-3">
                        <Badge variant="outline"
                               className={`shrink-0 gap-1 text-[9.5px] ${v.cls}`}>
                          <v.icon className="size-2.5" />{v.label}
                        </Badge>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </Step>

        {/* -------------------------------------------------- 02 conclusion */}
        <Step n={2} title="So what is true" icon={Sigma}
              hint="Arithmetic, shown. Every figure above feeds exactly one line here.">
          <p className="text-[15.5px] leading-relaxed">{conclusion.statement}</p>

          <div className="glass mt-5 flex flex-wrap items-stretch gap-1 rounded-xl p-1.5">
            {conclusion.arithmetic.map((a, i) => (
              <div key={a.label}
                   className={`min-w-[9.5rem] flex-1 rounded-lg px-4 py-3 ${
                     a.emphasis ? 'bg-danger/[0.09]' : ''}`}>
                <div className="text-muted-foreground text-[9.5px] font-medium
                                tracking-[0.12em] uppercase">{a.label}</div>
                <div className={`mt-1 font-mono text-[19px] leading-none tabular-nums ${
                  a.emphasis ? 'text-danger' : ''}`}>{a.value}</div>
                <div className="text-muted-foreground mt-1.5 text-[10.5px] leading-relaxed">
                  {a.note}
                </div>
              </div>
            ))}
          </div>

          {conclusion.coverage_days != null && (
            <p className="text-muted-foreground mt-3 text-[12.5px] leading-relaxed">
              At current consumption that is <b className={
                conclusion.coverage_days < 3 ? 'text-danger' : ''}>
                {conclusion.coverage_days} days
              </b> of production cover, against {conclusion.hours_left != null
                ? `${(conclusion.hours_left / 24).toFixed(1)} days` : 'the deadline'} until
              the run is due.
            </p>
          )}
        </Step>

        {/* ------------------------------------------------------ 03 action */}
        <Step n={3} title="What is being done" icon={Gavel}>
          <div className={`rounded-xl border p-5 ${
            action.committed ? 'border-ok/45 bg-ok/[0.05]'
            : action.status === 'none' ? 'border-danger/45 bg-danger/[0.05]'
            : 'border-warn/45 bg-warn/[0.05]'}`}>
            <div className="flex flex-wrap items-center gap-2.5">
              <Badge variant="outline" className="text-[10px]">
                {action.committed ? 'in progress'
                 : action.status === 'none' ? 'nothing viable' : 'proposed, not executed'}
              </Badge>
              <span className="text-[16px] font-semibold tracking-tight">{action.label}</span>
              {action.cost > 0 && (
                <span className="ml-auto font-mono text-[15px] tabular-nums">
                  {inr(action.cost)}
                </span>
              )}
            </div>

            <p className="text-muted-foreground mt-3 text-[13px] leading-relaxed">
              {action.authority === 'needs a human'
                ? <><b className="text-foreground">Stopped for you.</b>{' '}
                    {action.blocked_reason ?? 'This crosses the agent’s authority.'}{' '}
                    Nothing has been committed.</>
                : <><b className="text-foreground">Inside the agent&rsquo;s authority.</b>{' '}
                    It acted without asking, because the spend is under the limit and
                    nobody else&rsquo;s order moves.</>}
            </p>

            {action.approval_id && onGoto && (
              <Button size="lg" onClick={() => onGoto('approvals')}
                      className="mt-4 h-10 text-[13.5px]">
                Review and decide →
              </Button>
            )}
          </div>
        </Step>

        {/* --------------------------------------------------------- 04 why */}
        <Step n={4} title="Why that, and not something else" icon={Check}>
          <ul className="flex flex-col gap-3.5">
            {reasons.map((w, i) => (
              <li key={i} className="flex items-start gap-2.5">
                <Check className="text-ok mt-[3px] size-3.5 shrink-0" />
                <span className="text-[13px] leading-relaxed">
                  <b>{w.claim}</b>
                  <span className="text-muted-foreground"> — {w.because}</span>
                </span>
              </li>
            ))}
          </ul>

          {refusals.length > 0 && (
            <>
              <div className="text-muted-foreground mt-6 mb-2.5 flex items-center gap-1.5
                              text-[10px] font-medium tracking-[0.14em] uppercase">
                <Ban className="size-3" />Refused, with the rule that stopped them
              </div>
              <ul className="flex flex-col gap-2.5">
                {refusals.map((w, i) => (
                  <li key={i} className="flex items-start gap-2.5">
                    <Ban className="text-danger mt-[3px] size-3.5 shrink-0" />
                    <span className="text-[13px] leading-relaxed">
                      <b>{w.claim}</b>
                      <span className="text-muted-foreground"> — {w.because}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Step>

        {/* -------------------------------------------------- 05 confidence */}
        <Step n={5} title="How sure this is" icon={ShieldAlert}>
          <div className="flex flex-wrap items-end gap-6">
            <div>
              <div className={`font-mono text-[40px] leading-none font-semibold tabular-nums
                ${BAND_TONE[confidence.band] ?? ''}`}>
                {confidence.score.toFixed(2)}
              </div>
              <div className="text-muted-foreground mt-1.5 text-[11px] font-medium
                              tracking-[0.12em] uppercase">{confidence.band}</div>
            </div>
            <div className="min-w-[12rem] flex-1 pb-1.5">
              <Progress value={confidence.score * 100} className="h-1.5"
                        indicatorClassName={confidence.band === 'high' ? 'bg-ok'
                          : confidence.band === 'moderate' ? 'bg-warn' : 'bg-danger'} />
            </div>
          </div>

          {confidence.basis.length > 0 && (
            <div className="mt-5">
              <div className="text-muted-foreground mb-2 text-[10px] font-medium
                              tracking-[0.14em] uppercase">
                Starts at 1.00 — what took it down
              </div>
              <ul className="flex flex-col gap-2">
                {confidence.basis.map((b, i) => (
                  <li key={i} className="flex items-start gap-2.5 text-[12.5px]
                                         leading-relaxed">
                    <span className="text-danger mt-[1px] w-10 shrink-0 text-right font-mono
                                     tabular-nums">−{b.cost.toFixed(2)}</span>
                    <span className="text-muted-foreground">{b.why}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="mt-5">
            <div className="text-muted-foreground mb-2 text-[10px] font-medium
                            tracking-[0.14em] uppercase">What would change it</div>
            <ul className="flex flex-col gap-1.5">
              {confidence.would_change_it.map((w, i) => (
                <li key={i} className="text-muted-foreground flex items-start gap-2.5
                                       text-[12.5px] leading-relaxed">
                  <span className="bg-primary/60 mt-[7px] size-1.5 shrink-0 rounded-full" />
                  {w}
                </li>
              ))}
            </ul>
          </div>

          <p className="text-muted-foreground/70 mt-5 text-[11px] leading-relaxed">
            {confidence.method}
          </p>
        </Step>

        <Separator />

        <div>
          <div className="text-muted-foreground mb-2.5 flex items-center gap-1.5 text-[10px]
                          font-medium tracking-[0.14em] uppercase">
            <AlertTriangle className="size-3" />Residual risk
          </div>
          <ul className="flex flex-col gap-2">
            {residual_risk.map((r, i) => (
              <li key={i} className="text-muted-foreground flex items-start gap-2.5
                                     text-[12.5px] leading-relaxed">
                <span className="bg-warn/70 mt-[7px] size-1.5 shrink-0 rounded-full" />{r}
              </li>
            ))}
          </ul>
        </div>

        <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                  className="text-muted-foreground/70 text-[10.5px] leading-relaxed">
          Assembled from rows that already exist — inventory, carrier tracking, the
          messages as sent, the solver&rsquo;s own output. No sentence here was generated
          after the decision to justify it.
        </motion.p>
      </div>
    </ScrollArea>
  )
}
