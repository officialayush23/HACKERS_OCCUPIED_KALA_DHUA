import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AnimatePresence, motion } from 'motion/react'
import {
  Ban, CalendarClock, Check, ChevronDown, Clock, FlaskConical, Loader2, RotateCcw, Scale,
  TrendingDown, TrendingUp, TriangleAlert,
} from 'lucide-react'
import { api } from '@/lib/api'
import { inr } from '@/lib/format'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'

/**
 * Every option the solver considered, side by side, plus the ones it refused.
 *
 * Two things make this more than a table:
 *
 *   1. The refusals are first-class. A judge asking "why not the ₹108 supplier"
 *      gets the answer without opening a log.
 *   2. The what-if re-runs the *whole* solver with a supplier removed from the
 *      candidate pool, so the plan re-forms around the loss instead of just
 *      deleting the winning row. That is a fragility test, not a filter.
 *
 * No LLM touches this screen. It is the deterministic path, shown honestly.
 */

const CONSTRAINT = {
  REQUIRED_CERTIFICATION: 'not certified',
  MIN_ORDER_QUANTITY:     'minimum order too large',
  HAZMAT_NO_AIR:          'hazmat cannot fly',
  OVER_BUDGET:            'over budget',
}

const KIND = {
  single:           'One supplier',
  split:            'Split order',
  do_nothing:       'No action',
  reschedule:       'Reschedule this run',
  reschedule_other: 'Free up units',
}

const hrs = (h) => (h == null ? 'never' : h < 48 ? `${Math.round(h)}h` : `${(h / 24).toFixed(1)}d`)

/** Signed delta against the baseline plan, coloured by whether it hurts. */
function Delta({ now, was, kind = 'cost' }) {
  if (was == null || now == null || Math.abs(now - was) < 0.001) return null
  const worse = kind === 'score' ? now < was : now > was
  const Icon = now > was ? TrendingUp : TrendingDown
  const txt = kind === 'cost'
    ? `${now > was ? '+' : '−'}${inr(Math.abs(now - was))}`
    : kind === 'hours'
      ? `${now > was ? '+' : '−'}${hrs(Math.abs(now - was))}`
      : `${now > was ? '+' : '−'}${Math.abs(now - was).toFixed(3)}`
  return (
    <span className={`ml-1.5 inline-flex items-center gap-0.5 font-mono text-[10px]
                      ${worse ? 'text-danger' : 'text-ok'}`}>
      <Icon className="size-2.5" />{txt}
    </span>
  )
}

function Bar({ value, tone }) {
  return (
    <div className="flex items-center gap-1.5">
      <Progress value={(value ?? 0) * 100} className="h-1 flex-1"
                indicatorClassName={tone} />
      <span className="w-8 shrink-0 text-right font-mono text-[10.5px] tabular-nums">
        {(value ?? 0).toFixed(2)}
      </span>
    </div>
  )
}

/** One row of the matrix: a label plus one cell per option. */
function Row({ label, hint, cells, chosenIndex, className = '' }) {
  return (
    <tr className={`border-t ${className}`}>
      <th scope="row" className="text-muted-foreground w-[132px] py-2 pr-3 pl-4 text-left
                                 align-top text-[11px] font-normal">
        {label}
        {hint && <span className="block text-[9.5px] opacity-60">{hint}</span>}
      </th>
      {cells.map((c, i) => (
        <td key={i} className={`px-3 py-2 align-top text-[12px]
          ${i === chosenIndex ? 'bg-primary/[0.06]' : ''}`}>
          {c}
        </td>
      ))}
    </tr>
  )
}

export default function DecisionExplorer({ onApprove }) {
  const { data: ctx } = useQuery({ queryKey: ['context'], queryFn: api.context })
  const orders = ctx?.production ?? []

  const [poId, setPoId] = useState(null)
  const [failed, setFailed] = useState([])     // suppliers the what-if has killed
  const [showRejects, setShowRejects] = useState(true)
  const [showMatrix, setShowMatrix] = useState(false)

  // Default to the order in the most trouble, not the first one alphabetically.
  useEffect(() => {
    if (poId || !orders.length) return
    const worst = [...orders].sort((a, b) => (b.shortfall ?? 0) - (a.shortfall ?? 0))[0]
    setPoId(worst?.id ?? orders[0].id)
  }, [orders, poId])

  useEffect(() => { setFailed([]) }, [poId])

  // Baseline: the real plan. Simulated: the same solve with suppliers removed.
  const base = useQuery({
    queryKey: ['solve', poId], queryFn: () => api.solve(poId, false),
    enabled: !!poId })
  const sim = useQuery({
    queryKey: ['solve', poId, failed.join(',')],
    queryFn: () => api.solve(poId, false, failed),
    enabled: !!poId && failed.length > 0 })

  const simulating = failed.length > 0
  const result = simulating ? sim.data : base.data
  const loading = simulating ? sim.isLoading : base.isLoading
  const error = (simulating ? sim.error : base.error) ?? null

  const options = useMemo(() => (result?.options ?? []).slice(0, 4), [result])
  const baseChosen = base.data?.chosen ?? null
  const order = orders.find((o) => o.id === poId)

  const toggle = (id) =>
    setFailed((f) => (f.includes(id) ? f.filter((x) => x !== id) : [...f, id]))

  const planChanged = simulating && baseChosen && result?.chosen &&
    result.chosen.label !== baseChosen.label

  return (
    <div className="flex h-full flex-col">
      {/* ---------------------------------------------------------- header */}
      <div className="flex shrink-0 items-center gap-2.5 border-b px-6 py-4">
        <h2 className="text-muted-foreground flex items-center gap-1.5 text-[10px]
                       font-medium tracking-[0.14em] uppercase">
          <Scale className="size-3.5" />Decision explorer
        </h2>

        <Select value={poId ?? undefined} onValueChange={setPoId}>
          <SelectTrigger className="ml-auto h-7 w-[300px] text-[12px]">
            <SelectValue placeholder="choose a production run" />
          </SelectTrigger>
          <SelectContent>
            {orders.map((o) => (
              <SelectItem key={o.id} value={o.id} className="text-[12px]">
                {o.product_name ?? o.id}
                <span className="text-muted-foreground"> · {o.oem_customer}</span>
                {o.shortfall > 0 && (
                  <span className="text-danger"> · {o.shortfall} short</span>
                )}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {loading && <Loader2 className="text-muted-foreground size-3.5 animate-spin" />}
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-5 p-6">

          {error && (
            <p className="text-danger text-[12px]">{String(error.message ?? error)}</p>
          )}

          {/* ------------------------------------------------ the situation */}
          {result && (
            <div className="glass grid grid-cols-4 gap-6 rounded-xl px-5 py-3.5">
              {[
                ['Short by', `${result.shortfall} units`,
                 order?.component_name ?? 'component'],
                ['Deadline in', hrs(result.hours_left),
                 order?.oem_customer ? `for ${order.oem_customer}` : ''],
                ['Budget left', inr(result.budget_left),
                 `spends over ${inr(result.approval_threshold)} need a human`],
                (result.reschedulable?.length
                  ? ['Held by other runs', `${result.reschedulable
                       .reduce((a, r) => a + r.units_held, 0)} units`,
                     `${result.reschedulable[0].product_name} could stand down`]
                  : ['Options costed', `${result.options?.length ?? 0}`,
                     `${result.rejections?.length ?? 0} suppliers refused`]),
              ].map(([k, v, s]) => (
                <div key={k} className="min-w-0">
                  <div className="text-muted-foreground text-[9.5px] font-medium
                                  tracking-[0.12em] uppercase">{k}</div>
                  <div className="mt-0.5 font-mono text-[19px] leading-none tabular-nums">{v}</div>
                  {s && <div className="text-muted-foreground mt-1 truncate text-[10.5px]">{s}</div>}
                </div>
              ))}
            </div>
          )}

          {/* ---------------------------------------------------- what-if */}
          {result?.suppliers_in_play?.length > 0 && (
            <div>
              <div className="mb-1.5 flex items-center gap-2">
                <h3 className="text-muted-foreground flex items-center gap-1.5 text-[10px]
                               font-medium tracking-[0.14em] uppercase">
                  <FlaskConical className="size-3" />What if a supplier fails?
                </h3>
                <span className="text-muted-foreground/70 text-[10.5px]">
                  click to knock one out — the whole plan re-forms
                </span>
                {simulating && (
                  <Button variant="ghost" size="sm" className="ml-auto h-6 gap-1 px-2 text-[11px]"
                          onClick={() => setFailed([])}>
                    <RotateCcw className="size-3" />reset
                  </Button>
                )}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {result.suppliers_in_play.map((s) => {
                  const dead = failed.includes(s.id)
                  const used = (baseChosen?.lines ?? []).some((l) => l.supplier_id === s.id)
                  return (
                    <Button key={s.id} variant="outline" size="sm" onClick={() => toggle(s.id)}
                      className={`h-7 rounded-md px-2 text-[11px] font-normal
                        ${dead
                          ? 'border-danger/50 bg-danger/15 text-danger line-through'
                          : used
                            ? 'border-primary/45 bg-primary/10 text-primary hover:bg-primary/20'
                            : 'text-muted-foreground'}`}>
                      {s.name}
                      {used && !dead && <span className="ml-1 opacity-70">· in plan</span>}
                    </Button>
                  )
                })}
              </div>
            </div>
          )}

          <AnimatePresence>
            {simulating && result && (
              <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0 }}
                          className={`flex items-start gap-2 rounded-lg border px-3 py-2
                            text-[12px] leading-relaxed ${planChanged
                              ? 'border-warn/40 bg-warn/10' : 'border-ok/40 bg-ok/10'}`}>
                <TriangleAlert className={`mt-0.5 size-3.5 shrink-0
                  ${planChanged ? 'text-warn' : 'text-ok'}`} />
                <span>
                  <b>Simulation.</b>{' '}
                  {result.excluded?.length
                    ? `${result.excluded.join(', ')} removed from the pool. `
                    : ''}
                  {result.chosen
                    ? planChanged
                      ? <>The plan changes to <b>{result.chosen.label}</b>
                        {baseChosen && <> — {inr(result.chosen.total_cost - baseChosen.total_cost)} more
                          than the real plan.</>}</>
                      : <>The plan holds: <b>{result.chosen.label}</b> is still the best option.</>
                    : <>There is <b>no viable recovery</b> without them. The line stops.</>}
                  {' '}Nothing here is recorded.
                </span>
              </motion.div>
            )}
          </AnimatePresence>

          {/* ------------------------------------------- the recommendation */}
          {options.length > 0 && (
            <div className="flex flex-col gap-3">
              {options.slice(0, 3).map((o, i) => {
                const late = o.arrival_hours != null && result?.hours_left != null &&
                  o.arrival_hours > result.hours_left
                const covers = o.units_covered >= (result?.shortfall ?? 0)
                return (
                  <div key={i}
                    className={`rounded-xl border p-5 ${i === 0
                      ? 'border-primary/50 bg-primary/[0.05]' : ''}`}>
                    <div className="flex flex-wrap items-center gap-2.5">
                      <Badge variant="outline" className={i === 0
                        ? 'border-primary/50 bg-primary/15 text-primary gap-1 text-[10px]'
                        : 'text-[10px]'}>
                        {i === 0 ? <><Check className="size-2.5" />recommended</>
                                 : i === 1 ? 'alternative' : 'backup'}
                      </Badge>
                      <span className="text-[16px] font-semibold tracking-tight">{o.label}</span>
                      <span className="text-muted-foreground ml-auto font-mono text-[15px]
                                       tabular-nums">
                        {o.total_cost ? inr(o.total_cost) : 'no cost'}
                        <span className="opacity-60"> · {hrs(o.arrival_hours)}</span>
                      </span>
                    </div>

                    {i === 0 ? (
                      <ul className="mt-4 flex flex-col gap-1.5">
                        {[
                          covers ? `Covers all ${result.shortfall} units` : null,
                          !late && o.arrival_hours != null ? 'Arrives before the line stops' : null,
                          !o.requires_approval ? 'Within your agent\u2019s authority'
                                               : 'Needs your approval before anything happens',
                          o.impact ? `Frees ${o.impact.units_freed} units without buying them`
                                   : null,
                          o.lines?.[0]?.supplier_name
                            ? `${o.lines[0].supplier_name} at ${inr(o.lines[0].unit_price)}/unit`
                            : null,
                        ].filter(Boolean).map((line, k) => (
                          <li key={k} className="flex items-start gap-2 text-[13px] leading-snug">
                            <Check className="text-ok mt-[3px] size-3.5 shrink-0" />{line}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-muted-foreground mt-3 flex items-start gap-2
                                    text-[12.5px] leading-relaxed">
                        <TriangleAlert className="text-warn mt-[3px] size-3.5 shrink-0" />
                        {late ? 'Arrives after the deadline — the line stops first.'
                          : !covers ? `Only covers ${o.units_covered} of ${result.shortfall} units.`
                          : o.kind === 'do_nothing' ? 'Accepts the shortfall. The line stops.'
                          : o.impact ? `Delays ${o.impact.oem_customer} by ${o.impact.delay_days} days.`
                          : o.rationale}
                      </p>
                    )}

                    {i === 0 && (
                      <div className="mt-5 flex flex-wrap items-center gap-2.5">
                        <Button size="lg" className="h-10"
                                disabled={!o.requires_approval}
                                onClick={() => onApprove?.(o)}>
                          {o.requires_approval
                            ? `Review and approve ${o.total_cost ? inr(o.total_cost) : ''} \u2192`
                            : 'Inside the agent\u2019s authority \u2014 already running'}
                        </Button>
                        <Button variant="ghost" size="sm"
                                onClick={() => setShowMatrix((v) => !v)}
                                className="text-muted-foreground h-9 gap-1.5 text-[12px]">
                          <Scale className="size-3.5" />
                          {showMatrix ? 'Hide the scoring' : 'View the scoring model'}
                          <ChevronDown className={`size-3 transition-transform
                            ${showMatrix ? '' : '-rotate-90'}`} />
                        </Button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {/* --------------------------------------------- comparison matrix */}
          {showMatrix && options.length > 0 && (
            <div className="overflow-x-auto rounded-xl border">
              <table className="w-full border-collapse">
                <thead>
                  <tr>
                    <th className="w-[132px] px-4 py-2.5" />
                    {options.map((o, i) => (
                      <th key={i} className={`min-w-[168px] px-3 py-2.5 text-left align-bottom
                        ${i === 0 ? 'bg-primary/[0.08]' : ''}`}>
                        {i === 0 && (
                          <Badge variant="outline"
                                 className="border-primary/50 bg-primary/15 text-primary mb-1
                                            gap-0.5 text-[9.5px]">
                            <Check className="size-2.5" />what the agent does
                          </Badge>
                        )}
                        <div className="text-[12.5px] leading-tight font-semibold">{o.label}</div>
                        <div className="text-muted-foreground mt-0.5 text-[10px]">
                          {KIND[o.kind] ?? o.kind}
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <Row label="Weighted score" hint="35/20/15 — the judges' formula"
                       chosenIndex={0}
                       cells={options.map((o, i) => (
                         <span className={`font-mono text-[15px] tabular-nums
                           ${i === 0 ? 'text-primary font-semibold' : ''}`}>
                           {o.score.toFixed(3)}
                           {i === 0 && <Delta now={o.score} was={baseChosen?.score} kind="score" />}
                         </span>
                       ))} />

                  <Row label="Units covered" hint={`need ${result?.shortfall ?? 0}`}
                       chosenIndex={0}
                       cells={options.map((o) => (
                         <span className={`font-mono tabular-nums ${
                           o.units_covered >= (result?.shortfall ?? 0)
                             ? '' : 'text-danger'}`}>
                           {o.units_covered}
                         </span>
                       ))} />

                  <Row label="Arrives in" hint="deadline is the bar" chosenIndex={0}
                       cells={options.map((o, i) => {
                         const late = o.arrival_hours != null &&
                           result?.hours_left != null && o.arrival_hours > result.hours_left
                         return (
                           <span className={`inline-flex items-center gap-1 font-mono tabular-nums
                             ${o.arrival_hours == null || late ? 'text-danger' : 'text-ok'}`}>
                             <Clock className="size-3" />{hrs(o.arrival_hours)}
                             {late && <span className="text-[10px]">late</span>}
                             {i === 0 && <Delta now={o.arrival_hours}
                                                was={baseChosen?.arrival_hours} kind="hours" />}
                           </span>
                         )
                       })} />

                  <Row label="Total cost" chosenIndex={0}
                       cells={options.map((o, i) => (
                         <span className="font-mono tabular-nums">
                           {o.total_cost ? inr(o.total_cost) : '—'}
                           {i === 0 && <Delta now={o.total_cost} was={baseChosen?.total_cost} />}
                         </span>
                       ))} />

                  <Row label="Continuity" hint="weight 0.35" chosenIndex={0}
                       cells={options.map((o) => <Bar value={o.continuity} tone="bg-ok" />)} />
                  <Row label="Cost efficiency" hint="weight 0.20" chosenIndex={0}
                       cells={options.map((o) => <Bar value={o.cost_score} tone="bg-info" />)} />
                  <Row label="Supplier risk" hint="weight 0.15" chosenIndex={0}
                       cells={options.map((o) => <Bar value={o.risk_score} tone="bg-primary" />)} />

                  <Row label="Authority" chosenIndex={0}
                       cells={options.map((o) => (
                         o.requires_approval
                           ? <Badge variant="outline"
                                    className="border-warn/50 bg-warn/15 text-warn text-[10px]">
                               needs a human
                             </Badge>
                           : <span className="text-muted-foreground text-[11px]">agent can act</span>
                       ))} />

                  <Row label="Where units come from" chosenIndex={0}
                       cells={options.map((o) => (
                         (o.lines?.length || o.impact)
                           ? <div className="flex flex-col gap-1">
                               {o.impact && (
                                 <div className="text-primary text-[11px] leading-tight">
                                   <span className="font-medium">Stock released</span>
                                   <span className="opacity-80">
                                     {' '}· {o.impact.units_freed}u · free
                                   </span>
                                 </div>
                               )}
                               {o.lines.map((l, j) => (
                                 <div key={j} className="text-[11px] leading-tight">
                                   <span className="font-medium">{l.supplier_name}</span>
                                   <span className="text-muted-foreground">
                                     {' '}· {l.quantity}u · {l.mode} · {inr(l.total_cost)}
                                   </span>
                                 </div>
                               ))}
                             </div>
                           : <span className="text-muted-foreground text-[11px]">nobody</span>
                       ))} />

                  {options.some((o) => o.impact) && (
                    <Row label="Who else pays" hint="in time, not money" chosenIndex={0}
                         cells={options.map((o) => (
                           o.impact
                             ? <div className="border-warn/40 bg-warn/10 flex items-start gap-1.5
                                               rounded-md border px-1.5 py-1 text-[10.5px]
                                               leading-relaxed">
                                 <CalendarClock className="text-warn mt-0.5 size-3 shrink-0" />
                                 <span>
                                   <b>{o.impact.oem_customer}</b> waits {o.impact.delay_days} more
                                   days for {o.impact.product_name}
                                   <span className="opacity-70"> ({o.impact.priority} priority)</span>
                                 </span>
                               </div>
                             : <span className="text-muted-foreground text-[11px]">nobody</span>
                         ))} />
                  )}

                  <Row label="Reasoning" chosenIndex={0}
                       cells={options.map((o) => (
                         <p className="text-muted-foreground max-w-[220px] text-[11px]
                                       leading-relaxed">{o.rationale}</p>
                       ))} />
                </tbody>
              </table>
            </div>
          )}

          {result && options.length === 0 && !loading && (
            <p className="text-muted-foreground text-[12.5px]">
              {result.note ?? 'No option covers this shortfall — every supplier was refused.'}
            </p>
          )}

          {/* ------------------------------------------------- the refusals */}
          {result?.rejections?.length > 0 && (
            <div>
              <Button variant="ghost" size="sm" onClick={() => setShowRejects(!showRejects)}
                      className="text-muted-foreground mb-1.5 h-6 gap-1.5 px-1.5 text-[10px]
                                 font-medium tracking-[0.14em] uppercase">
                <Ban className="size-3" />
                Considered and refused ({result.rejections.length})
                <ChevronDown className={`size-3 transition-transform
                  ${showRejects ? '' : '-rotate-90'}`} />
              </Button>
              <AnimatePresence initial={false}>
                {showRejects && (
                  <motion.div initial={{ height: 0, opacity: 0 }}
                              animate={{ height: 'auto', opacity: 1 }}
                              exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                    <div className="grid grid-cols-2 gap-1.5">
                      {result.rejections.map((r, i) => (
                        <div key={i} className="rounded-lg border px-2.5 py-2">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-[12px] font-medium">
                              {r.supplier_name ?? r.supplier_id}
                            </span>
                            <Badge variant="outline"
                                   className="border-danger/45 bg-danger/12 text-danger ml-auto
                                              shrink-0 text-[9.5px]">
                              {CONSTRAINT[r.constraint] ?? r.constraint}
                            </Badge>
                          </div>
                          <p className="text-muted-foreground mt-1 text-[11px] leading-relaxed">
                            {r.human_reason}
                          </p>
                        </div>
                      ))}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}

          <Separator />
          <p className="text-muted-foreground/70 text-[10.5px] leading-relaxed">
            Nothing on this screen is generated by a language model. Options are enumerated,
            filtered against hard constraints, and scored by the same weights the rubric uses —
            so the same input always produces the same decision.
          </p>
        </div>
      </ScrollArea>
    </div>
  )
}
