import { useQuery } from '@tanstack/react-query'
import { motion } from 'motion/react'
import {
  Activity, Bot, CheckCircle2, ChevronRight, Clock, PackageCheck, TriangleAlert,
} from 'lucide-react'
import { api } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'

/**
 * The "now" strip.
 *
 * A supply-chain manager glancing at the screen should not have to assemble
 * their own status out of four panels. One line, always in the same place,
 * always answering the same question: what is happening right now, and does any
 * of it need me?
 *
 * Ranked by who it belongs to — things needing a human first, then what the
 * agent is doing, then what is simply true.
 */
function Item({ icon: Icon, tone = '', label, value, sub, onClick, pulse }) {
  const body = (
    <div className="flex min-w-0 items-center gap-2.5">
      <Icon className={`size-4 shrink-0 ${tone} ${pulse ? 'animate-pulse' : ''}`} />
      <div className="min-w-0 text-left">
        <div className={`truncate text-[13px] leading-tight font-medium ${tone}`}>{value}</div>
        <div className="text-muted-foreground truncate text-[11px] leading-tight">
          {sub ?? label}
        </div>
      </div>
    </div>
  )
  if (!onClick) return <div className="min-w-0 flex-1 px-1">{body}</div>
  return (
    <Button variant="ghost" onClick={onClick}
            className="h-auto min-w-0 flex-1 justify-start gap-2 px-2 py-1.5 font-normal">
      {body}
      <ChevronRight className="text-muted-foreground ml-auto size-3.5 shrink-0" />
    </Button>
  )
}

export default function NowBar({ onGoto }) {
  const { data } = useQuery({ queryKey: ['now'], queryFn: api.now, refetchInterval: 3000 })

  const queue = data?.queue ?? []
  const needsHuman = queue.filter((q) => q.kind === 'approval')
  const waitingOn = queue.filter((q) => q.kind !== 'approval')
  const incidents = data?.incidents ?? []
  const critical = incidents.filter((i) => i.severity === 'critical').length
  const cover = data?.min_coverage_days
  const busy = data?.agent_busy ?? 0
  const nd = data?.next_delivery
  const atRisk = data?.production_at_risk ?? false
  const worst = data?.worst ?? null
  // A delivery date behind the simulated clock is overdue, not "in -39 days".
  const overdue = nd && nd.hours_away < 0

  return (
    <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }}
                className="glass-panel flex shrink-0 items-center gap-1 border-b px-4 py-2">

      {needsHuman.length > 0 ? (
        <Item icon={TriangleAlert} tone="text-danger" pulse
              value={`${needsHuman.length} decision${needsHuman.length > 1 ? 's' : ''} waiting on you`}
              sub={needsHuman[0].title}
              onClick={() => onGoto('approvals')} />
      ) : (
        <Item icon={CheckCircle2} tone="text-ok"
              value="Nothing waiting on you"
              sub="the agent is inside its authority" />
      )}

      <Separator orientation="vertical" className="!h-8" />

      <Item icon={Bot} tone={busy || atRisk ? 'text-primary' : ''}
            value={busy > 0
              ? `Agent working ${busy} incident${busy > 1 ? 's' : ''}`
              : atRisk ? 'Agent picking this up' : 'Agent idle'}
            sub={busy > 0 ? 'investigating and replanning'
                 : atRisk ? `${worst?.component_name ?? 'a component'} is short`
                 : 'nothing at risk'}
            onClick={() => onGoto('incidents')} />

      <Separator orientation="vertical" className="!h-8" />

      <Item icon={Clock}
            tone={cover != null && cover < 3 ? 'text-danger'
                  : cover != null && cover < 6 ? 'text-warn' : ''}
            value={cover != null ? `${cover.toFixed(1)} days of cover` : 'Cover unknown'}
            sub={atRisk ? `${worst?.component_name ?? 'component'} \u2014 short ${worst?.shortfall ?? 0}`
                 : critical > 0 ? `${critical} critical incident open`
                 : 'tightest component'} />

      <Separator orientation="vertical" className="!h-8" />

      <Item icon={PackageCheck}
            tone={overdue ? 'text-danger' : ''}
            value={!nd ? 'No inbound deliveries'
                   : overdue
                     ? `${nd.supplier_name} overdue`
                     : `${nd.supplier_name} in ${(nd.hours_away / 24).toFixed(1)}d`}
            sub={!nd ? 'nothing in transit'
                 : overdue
                   ? `${Math.abs(nd.hours_away / 24).toFixed(1)}d past its promised date`
                   : `${nd.quantity} \u00d7 ${nd.component_name}`}
            onClick={() => onGoto('network')} />

      {waitingOn.length > 0 && (
        <>
          <Separator orientation="vertical" className="!h-8" />
          <Badge variant="outline" className="shrink-0 gap-1.5 py-1 text-[11px]">
            <Activity className="size-3" />{waitingOn.length} in flight
          </Badge>
        </>
      )}
    </motion.div>
  )
}
