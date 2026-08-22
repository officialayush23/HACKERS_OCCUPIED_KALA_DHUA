import { useQuery } from '@tanstack/react-query'
import { motion } from 'motion/react'
import { AlertTriangle, ArrowRight, Clock, Package, ShieldAlert } from 'lucide-react'
import { api } from '@/lib/api'
import { inr } from '@/lib/format'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'

const SEV = {
  critical: 'border-danger/50 bg-danger/15 text-danger',
  high:     'border-warn/50 bg-warn/15 text-warn',
  medium:   'border-info/40 bg-info/10 text-info',
  low:      'border-border bg-muted text-muted-foreground',
}

const STATUS_COPY = {
  open: 'Just opened', investigating: 'Investigating', planning: 'Evaluating options',
  awaiting_approval: 'Waiting for you', executing: 'Executing recovery',
  monitoring: 'Monitoring outcome', verifying: 'Verifying', reopened: 'Reopened — replanning',
  resolved: 'Resolved', failed: 'Failed',
}

/** The single incident that matters right now, in business language. */
export default function IncidentPanel({ revision, onOpenDecision }) {
  const { data, isLoading } = useQuery({
    queryKey: ['incidents', revision], queryFn: api.incidents, refetchInterval: 4000 })

  const open = (data?.incidents ?? []).filter(
    (i) => !['resolved', 'failed'].includes(i.status))
  const top = open[0]

  const { data: detail } = useQuery({
    queryKey: ['agentSteps', top?.id, revision],
    queryFn: () => api.agentSteps(top.id), enabled: !!top,
  })

  if (isLoading) return <div className="space-y-2 p-4"><Skeleton className="h-24 w-full" />
    <Skeleton className="h-16 w-full" /></div>

  if (!top) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <div className="bg-ok/10 ring-ok/25 flex size-11 items-center justify-center
                        rounded-full ring-1">
          <Package className="text-ok size-5" />
        </div>
        <p className="text-[14px] font-medium">All lines are covered</p>
        <p className="text-muted-foreground max-w-[15rem] text-[12px] leading-relaxed">
          No production order is short. The agent is monitoring inbound shipments and
          supplier messages.
        </p>
      </div>
    )
  }

  const plan = detail?.plan
  const st = detail?.state ?? {}
  const cover = st.coverage_days ?? detail?.incident?.details?.verdict?.coverage_days

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="p-5">
        <div className="flex items-center gap-2">
          <Badge variant="outline" className={SEV[top.severity]}>
            <AlertTriangle className="mr-1 size-2.5" />{top.severity}
          </Badge>
          <Badge variant="outline" className="text-[10px]">
            {STATUS_COPY[top.status] ?? top.status}
          </Badge>
          <span className="text-muted-foreground ml-auto font-mono text-[10px]">{top.id}</span>
        </div>

        <h3 className="mt-2.5 text-[15px] leading-snug font-medium">
          {top.title || top.type?.replace(/_/g, ' ')}
        </h3>

        <div className="mt-3 grid grid-cols-2 gap-2">
          <div className="glass rounded-lg px-2.5 py-2">
            <div className="text-muted-foreground flex items-center gap-1 text-[9.5px]
                            tracking-[0.12em] uppercase"><Clock className="size-2.5" />Cover</div>
            <div className={`font-mono text-lg leading-tight
              ${(cover ?? 9) < 3 ? 'text-danger' : (cover ?? 9) < 6 ? 'text-warn' : ''}`}>
              {cover != null ? `${cover}d` : '—'}
            </div>
          </div>
          <div className="glass rounded-lg px-2.5 py-2">
            <div className="text-muted-foreground flex items-center gap-1 text-[9.5px]
                            tracking-[0.12em] uppercase"><ShieldAlert className="size-2.5" />
              At risk</div>
            <div className="font-mono text-lg leading-tight">
              {st.threatened?.[0]?.shortfall ?? '—'}
              <span className="text-muted-foreground ml-1 text-[11px]">units</span>
            </div>
          </div>
        </div>

        {detail?.incident?.component_name && (
          <p className="text-muted-foreground mt-2 text-[11.5px]">
            {detail.incident.component_name}
            {detail.incident.part_number && <span className="ml-1 font-mono opacity-70">
              · {detail.incident.part_number}</span>}
          </p>
        )}
      </div>

      {plan && (
        <>
          <Separator />
          <div className="p-5">
            <div className="text-muted-foreground mb-1.5 text-[10px] font-medium
                            tracking-[0.14em] uppercase">Proposed recovery</div>
            <motion.div layout className="glass rounded-lg p-3">
              <div className="flex items-start justify-between gap-2">
                <span className="text-[13.5px] font-medium">{plan.label}</span>
                <span className="font-mono text-[13px]">{inr(plan.total_cost)}</span>
              </div>
              {plan.requires_approval && (
                <Badge variant="outline"
                       className="border-warn/50 bg-warn/15 text-warn mt-2">
                  needs your approval
                </Badge>
              )}
              {plan.rationale && (
                <p className="text-muted-foreground mt-2 text-[11.5px] leading-relaxed">
                  {plan.rationale.slice(0, 220)}
                  {plan.rationale.length > 220 && '…'}
                </p>
              )}
            </motion.div>
            <Button size="sm" variant="secondary" className="mt-2.5 w-full gap-1"
                    onClick={() => onOpenDecision?.(top)}>
              Open decision <ArrowRight className="size-3" />
            </Button>
          </div>
        </>
      )}

      {open.length > 1 && (
        <>
          <Separator />
          <div className="p-5">
            <div className="text-muted-foreground mb-1.5 text-[10px] font-medium
                            tracking-[0.14em] uppercase">
              {open.length - 1} other open
            </div>
            {open.slice(1).map((i) => (
              <div key={i.id} className="flex items-center gap-2 py-1">
                <Badge variant="outline" className={`${SEV[i.severity]} text-[9px]`}>
                  {i.severity}
                </Badge>
                <span className="truncate text-[11.5px]">{i.title || i.type}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
