import { useQuery } from '@tanstack/react-query'
import { motion } from 'motion/react'
import { Check, ClipboardCheck, Loader2, Minus, ShieldAlert, X } from 'lucide-react'
import { api } from '@/lib/api'
import NoRun from '@/components/NoRun'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'

/**
 * Did this run pass?
 *
 * Every criterion is recomputed from the run's own artefacts when the run ends.
 * Nothing is pre-seeded, so a world with no runs shows *not evaluated* rather
 * than a wall of failures — those are different claims and only one is honest.
 *
 * Three states per criterion, not two. **Not applicable** matters: a scenario
 * that contained no contradiction cannot be marked down for failing to catch
 * one, and marking it passed would be just as misleading.
 */

const CATEGORY = {
  constraint: { label: 'Constraint compliance',
                blurb: 'Hard rules. One failure fails the run, whatever else it scored.' },
  execution:  { label: 'Agent execution',
                blurb: 'Did it actually do the work, end to end?' },
  handoff:    { label: 'Human handoff',
                blurb: 'Did it stop in the right places — and resume correctly?' },
}

function Mark({ passed }) {
  if (passed === null || passed === undefined) {
    return <Minus className="text-muted-foreground/50 mt-0.5 size-4 shrink-0" />
  }
  return passed
    ? <Check className="text-ok mt-0.5 size-4 shrink-0" />
    : <X className="text-danger mt-0.5 size-4 shrink-0" />
}

export default function Evaluation({ onRunSim }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['evaluation'], queryFn: api.evaluation})
  const { data: run } = useQuery({
    queryKey: ['activeRun'], queryFn: api.activeRun})

  // While the first fetch is in flight `data` is undefined, and every `?? 0`
  // below then renders as a real answer: "0/0 criteria met", verdict "—". That
  // is a scoreboard reporting a result nobody has computed. Say "working it
  // out" instead — it is the honest sentence and it is also the true one.
  // A failing endpoint used to spin here forever: `isLoading` goes false, `data`
  // stays undefined, and the spinner outlives the request that caused it. An
  // error is a fact about the system and belongs on screen like any other.
  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-10 text-center">
        <ShieldAlert className="text-danger/70 size-7" />
        <p className="text-[15px] font-medium">Could not evaluate this run</p>
        <p className="text-muted-foreground max-w-md text-[12.5px] leading-relaxed">
          {String(error.message)}
        </p>
        <p className="text-muted-foreground/70 max-w-md text-[11.5px] leading-relaxed">
          The run's own artefacts are untouched — this is the scoring pass failing,
          not the record of what happened.
        </p>
      </div>
    )
  }

  if (isLoading || !data) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center gap-2.5
                      text-[13px]">
        <Loader2 className="size-4 animate-spin" />Recomputing this run's criteria…
      </div>
    )
  }

  if (!data?.evaluated) {
    return (
      <NoRun icon={ClipboardCheck}
             title="Not evaluated"
             what={data?.reason
               ?? 'Criteria are judged against a run’s own artefacts. With no run there is nothing to judge.'}
             onRun={onRunSim} />
    )
  }

  const criteria = data?.criteria ?? []
  const groups = ['constraint', 'execution', 'handoff']
    .map((k) => ({ key: k, ...CATEGORY[k],
                   items: criteria.filter((c) => c.category === k) }))
    .filter((g) => g.items.length)

  const failed = data?.verdict === 'FAILED'
  const active = run?.active

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-7 p-7">

        {/* which run, in case anyone is in doubt */}
        <div className="flex flex-wrap items-center gap-3">
          <Badge variant="outline" className="font-mono text-[10.5px]">
            run {active?.id ?? '—'}
          </Badge>
          <span className="text-[15px] font-semibold tracking-tight">
            {active?.title ?? active?.scenario_id ?? 'Current run'}
          </span>
          <Badge variant="outline" className="text-[10.5px]">
            {active?.status ?? 'running'}
          </Badge>
        </div>

        {active?.tests && (
          <p className="text-muted-foreground -mt-4 text-[13px] leading-relaxed">
            <span className="text-muted-foreground/70">What this scenario tests — </span>
            {active.tests}
          </p>
        )}

        {/* the verdict */}
        <Card className={`gap-0 py-0 ${failed ? 'border-danger/50' : 'border-ok/40'}`}>
          <div className="p-7">
            <div className="flex flex-wrap items-end gap-10">
              <div>
                <div className="text-muted-foreground text-[10px] font-medium
                                tracking-[0.12em] uppercase">Verdict</div>
                <div className={`mt-2 text-[32px] leading-none font-semibold tracking-tight
                  ${failed ? 'text-danger' : 'text-ok'}`}>
                  {data?.verdict ?? '—'}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground text-[10px] font-medium
                                tracking-[0.12em] uppercase">Criteria met</div>
                <div className="mt-2 font-mono text-[32px] leading-none tabular-nums">
                  {data?.passed ?? 0}<span className="text-muted-foreground text-[20px]">
                    /{data?.applicable ?? 0}</span>
                </div>
              </div>
              {data?.score_pct != null && (
                <div>
                  <div className="text-muted-foreground text-[10px] font-medium
                                  tracking-[0.12em] uppercase">Score</div>
                  <div className="mt-2 font-mono text-[32px] leading-none tabular-nums">
                    {data.score_pct}%
                  </div>
                </div>
              )}
              {data?.not_applicable > 0 && (
                <div>
                  <div className="text-muted-foreground text-[10px] font-medium
                                  tracking-[0.12em] uppercase">Not applicable</div>
                  <div className="text-muted-foreground mt-2 font-mono text-[32px]
                                  leading-none tabular-nums">{data.not_applicable}</div>
                </div>
              )}
            </div>

            {failed && data?.blocking_failures?.length > 0 && (
              <div className="border-danger/40 bg-danger/[0.07] mt-6 rounded-lg border
                              px-4 py-3">
                <div className="text-danger flex items-center gap-2 text-[13px] font-medium">
                  <ShieldAlert className="size-4" />
                  Failed on a hard constraint
                </div>
                <ul className="text-muted-foreground mt-2 flex flex-col gap-1 text-[12.5px]">
                  {data.blocking_failures.map((f) => <li key={f}>· {f}</li>)}
                </ul>
              </div>
            )}

            <p className="text-muted-foreground/70 mt-5 text-[11.5px] leading-relaxed">
              {data?.note}
            </p>
          </div>
        </Card>

        {/* every criterion, with its evidence */}
        {groups.map((g, gi) => (
          <motion.div key={g.key} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: gi * 0.06 }}>
            <div className="mb-3">
              <h3 className="text-[14px] font-semibold tracking-tight">{g.label}</h3>
              <p className="text-muted-foreground mt-1 text-[12px]">{g.blurb}</p>
            </div>
            <Card className="gap-0 py-0">
              <div className="px-6">
                {g.items.map((c, i) => (
                  <div key={c.criterion}
                       className={`flex items-start gap-3 py-4 ${i ? 'border-t' : ''}`}>
                    <Mark passed={c.passed} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`text-[13.5px] font-medium ${
                          c.passed === false ? 'text-danger' : ''}`}>
                          {c.criterion}
                        </span>
                        {c.passed === null && (
                          <Badge variant="outline" className="text-[9.5px]">
                            not applicable
                          </Badge>
                        )}
                      </div>
                      <p className="text-muted-foreground mt-1 text-[12.5px] leading-relaxed">
                        {c.detail}
                      </p>
                      {c.evidence && Object.keys(c.evidence).length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {Object.entries(c.evidence)
                            .filter(([, v]) => v !== null && v !== undefined
                                            && !(Array.isArray(v) && !v.length))
                            .map(([k, v]) => (
                              <Badge key={k} variant="outline" className="font-mono text-[9.5px]">
                                {k}: {Array.isArray(v) ? v.join(', ') : String(v)}
                              </Badge>
                            ))}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          </motion.div>
        ))}

        <Separator />
        <p className="text-muted-foreground/70 text-[11px] leading-relaxed">
          Recomputed from this run's audit log, incidents, plans, orders and approvals when
          the run ended — not written by the agent about itself, and not seeded anywhere.
          Re-run the scenario and the same inputs produce the same verdict.
        </p>
      </div>
    </ScrollArea>
  )
}
