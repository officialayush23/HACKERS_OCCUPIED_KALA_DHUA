import { useQuery } from '@tanstack/react-query'
import { motion } from 'motion/react'
import {
  CheckCircle2, Circle, Clock, Loader2, PackageCheck, Truck, XCircle,
} from 'lucide-react'
import { api } from '@/lib/api'
import { inr } from '@/lib/format'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import NoRun from '@/components/NoRun'

/**
 * The recovery plan, and how much of it has actually happened.
 *
 * The plan was the one artefact this dashboard never showed whole. It existed as
 * a line inside the incident panel, a row in Decisions, a cost in Approvals and
 * a set of purchase orders in Network — four places, none of which answered the
 * question anyone actually asks after the agent decides something: *is it
 * working?*
 *
 * Every state on this page is derived server-side from records the acting path
 * already wrote. Nothing here can show a step as done that did not happen,
 * because nothing here writes anything.
 */

const ICON = {
  done:    CheckCircle2,
  running: Loader2,
  waiting: Circle,
  failed:  XCircle,
}

const TONE = {
  done:    'text-ok',
  running: 'text-info',
  waiting: 'text-muted-foreground/50',
  failed:  'text-danger',
}

function Milestone({ step, last }) {
  const Icon = ICON[step.state] ?? Circle
  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center">
        <Icon className={`size-4 shrink-0 ${TONE[step.state]}
          ${step.state === 'running' ? 'animate-spin' : ''}`} />
        {/* The rail is coloured by the step above it, so a glance down the left
            edge reads as "how far did this actually get". */}
        {!last && <div className={`mt-1 w-px flex-1
          ${step.state === 'done' ? 'bg-ok/30' : 'bg-border'}`} />}
      </div>
      <div className={`min-w-0 pb-5 ${last ? 'pb-0' : ''}`}>
        <div className={`text-[13px] font-medium
          ${step.state === 'waiting' ? 'text-muted-foreground' : ''}`}>
          {step.label}
        </div>
        {step.detail && (
          <div className="text-muted-foreground mt-1 text-[11.5px] leading-relaxed">
            {step.detail}
          </div>
        )}
      </div>
    </div>
  )
}

function Units({ units }) {
  const total = Math.max(units.ordered, 1)
  const pctIn = (units.delivered / total) * 100
  const pctMove = (units.in_transit / total) * 100
  if (!units.ordered) return null
  return (
    <div className="mt-4">
      <div className="text-muted-foreground mb-1.5 flex items-center justify-between
                      text-[10px] tracking-[0.12em] uppercase">
        <span>Units</span>
        <span className="font-mono tabular-nums">
          {units.delivered} delivered · {units.in_transit} moving · {units.ordered} ordered
        </span>
      </div>
      <div className="bg-muted flex h-1.5 overflow-hidden rounded-full">
        <div className="bg-ok" style={{ width: `${pctIn}%` }} />
        <div className="bg-info/60" style={{ width: `${pctMove}%` }} />
      </div>
      {units.still_short > 0 && (
        <div className="text-muted-foreground mt-1.5 text-[11px]">
          {units.still_short} units still short on the worst line for this component —
          ordering is not the same as covering, and this stays red until stock lands.
        </div>
      )}
    </div>
  )
}

export default function Recovery() {
  const { data, isLoading } = useQuery({ queryKey: ['recovery'], queryFn: api.recovery })

  if (isLoading) {
    return <div className="space-y-3 p-7">
      <Skeleton className="h-28 w-full" /><Skeleton className="h-56 w-full" />
    </div>
  }

  if (!data?.has_run) {
    return <NoRun
      title="No active test run"
      what="A recovery plan is something the agent produces in response to a disruption.
            Nothing has been injected, so there is nothing to recover from and no plan
            to track."
      baseline="Baseline topology loaded · no active disruption" />
  }

  const recoveries = data?.recoveries ?? []

  if (!recoveries.length) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-7 text-center">
        <PackageCheck className="text-muted-foreground/60 size-8" />
        <p className="text-[14px] font-medium">No recovery plan yet in this run</p>
        <p className="text-muted-foreground max-w-sm text-[12px] leading-relaxed">
          The agent produces one only after it has read the position, counted what is
          already inbound and found at least one option that clears every hard
          constraint. If it never gets there it says why instead of inventing a plan.
        </p>
      </div>
    )
  }

  return (
    <ScrollArea className="h-full">
      <div className="space-y-5 p-7">
        {recoveries.map((r) => {
          const p = r.plan
          const pct = Math.round(r.progress * 100)
          return (
            <motion.div key={p.id} layout
                        className="glass overflow-hidden rounded-xl">
              <div className="p-5">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className="text-[10px]">{p.option_kind}</Badge>
                  {p.severity && (
                    <Badge variant="outline" className="text-[10px]">{p.severity}</Badge>
                  )}
                  <Badge variant="outline" className={`text-[10px] ${
                    r.failed ? 'border-danger/50 bg-danger/15 text-danger'
                    : r.blocked ? 'border-warn/50 bg-warn/15 text-warn'
                    : pct === 100 ? 'border-ok/50 bg-ok/15 text-ok' : ''}`}>
                    {r.failed ? 'stopped'
                      : r.blocked ? 'waiting for you'
                      : pct === 100 ? 'recovered' : 'in progress'}
                  </Badge>
                  <span className="text-muted-foreground ml-auto font-mono text-[10px]">
                    {p.incident_id}
                  </span>
                </div>

                <div className="mt-3 flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <h3 className="text-[16px] leading-snug font-medium">{p.label}</h3>
                    <p className="text-muted-foreground mt-1 text-[12px]">
                      {p.component_name ?? p.incident_title}
                      {p.score != null && <span className="ml-2 font-mono opacity-70">
                        score {p.score}</span>}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="font-mono text-[18px] leading-none tabular-nums">
                      {inr(p.total_cost)}
                    </div>
                    <div className="text-muted-foreground mt-1 text-[10px]">
                      {p.requires_approval ? 'needed approval' : 'within authority'}
                    </div>
                  </div>
                </div>

                {/* Progress is steps-completed, not a guess at effort. The
                    denominator is on screen so the bar cannot flatter itself. */}
                <div className="mt-4">
                  <div className="text-muted-foreground mb-1.5 flex items-center
                                  justify-between text-[10px] tracking-[0.12em] uppercase">
                    <span>Progress</span>
                    <span className="font-mono tabular-nums">
                      {r.done_steps} of {r.total_steps} steps
                    </span>
                  </div>
                  <div className="bg-muted h-1.5 overflow-hidden rounded-full">
                    <motion.div layout
                      className={pct === 100 ? 'bg-ok h-full' : 'bg-info h-full'}
                      style={{ width: `${pct}%` }} />
                  </div>
                </div>

                <Units units={r.units} />
              </div>

              <Separator />

              <div className="p-5">
                <div className="text-muted-foreground mb-3 text-[10px] font-medium
                                tracking-[0.14em] uppercase">
                  What has actually happened
                </div>
                {r.steps.map((s, i) => (
                  <Milestone key={s.key} step={s} last={i === r.steps.length - 1} />
                ))}
              </div>

              {r.purchase_orders?.length > 0 && (
                <>
                  <Separator />
                  <div className="p-5">
                    <div className="text-muted-foreground mb-2 text-[10px] font-medium
                                    tracking-[0.14em] uppercase">
                      Orders raised under this plan
                    </div>
                    <div className="space-y-1.5">
                      {r.purchase_orders.map((po) => (
                        <div key={po.id}
                             className="flex items-center gap-2.5 text-[12px]">
                          <Truck className="text-muted-foreground size-3 shrink-0" />
                          <span className="font-mono text-[11px] opacity-70">{po.id}</span>
                          <span className="truncate">
                            {po.quantity} units · {po.supplier}
                          </span>
                          <Badge variant="outline" className="ml-auto shrink-0 text-[9px]">
                            {po.status?.replace(/_/g, ' ')}
                          </Badge>
                          <span className="shrink-0 font-mono text-[11px] tabular-nums">
                            {inr(po.total_value)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              )}

              {p.rationale && (
                <>
                  <Separator />
                  <div className="p-5">
                    <div className="text-muted-foreground mb-1.5 flex items-center gap-1.5
                                    text-[10px] font-medium tracking-[0.14em] uppercase">
                      <Clock className="size-2.5" />Why this one
                    </div>
                    <p className="text-muted-foreground text-[12px] leading-relaxed">
                      {p.rationale}
                    </p>
                  </div>
                </>
              )}
            </motion.div>
          )
        })}
      </div>
    </ScrollArea>
  )
}
