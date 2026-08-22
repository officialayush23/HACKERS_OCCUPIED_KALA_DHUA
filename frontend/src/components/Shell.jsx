import { motion } from 'motion/react'
import {
  Activity, GitBranch, LayoutGrid, ScrollText, Scale, Gauge,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'

export const NAV = [
  { id: 'overview',  label: 'Overview',        sub: 'live operations',  icon: LayoutGrid },
  { id: 'network',   label: 'Supply Network',  sub: 'lanes & shipments', icon: GitBranch },
  { id: 'decisions', label: 'Decision Explorer', sub: 'chosen vs rejected', icon: Scale },
  { id: 'audit',     label: 'Audit Trail',     sub: 'immutable log',    icon: ScrollText },
  { id: 'scoring',   label: 'Self-Scoring',    sub: 'rubric runs',      icon: Gauge },
]

export function Sidebar({ page, onPage, status, incidents }) {
  return (
    <aside className="glass-panel text-sidebar-foreground border-sidebar-border flex w-[248px] shrink-0 flex-col border-r">
      <div className="flex items-center gap-2.5 px-4 py-4">
        <div className="flex size-9 items-center justify-center rounded-lg bg-sidebar-primary/15 ring-sidebar-primary/30 ring-1">
          <Activity className="text-sidebar-primary size-5" />
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold tracking-tight">DisruptionOps</div>
          <div className="truncate text-[11px] text-muted-foreground">Pune-Plant-1 · kala dhua</div>
        </div>
      </div>

      <nav className="flex flex-col gap-0.5 px-2">
        {NAV.map((n) => {
          const active = page === n.id
          return (
            <button key={n.id} onClick={() => onPage(n.id)}
              className={`relative flex items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors
                ${active ? 'text-sidebar-accent-foreground' : 'text-muted-foreground hover:text-sidebar-accent-foreground'}`}>
              {active && (
                <motion.span layoutId="navpill"
                  className="bg-sidebar-accent absolute inset-0 rounded-lg"
                  transition={{ type: 'spring', stiffness: 380, damping: 32 }} />
              )}
              <n.icon className={`relative size-4 ${active ? 'text-sidebar-primary' : ''}`} />
              <span className="relative min-w-0">
                <span className="block text-[13px] font-medium leading-tight">{n.label}</span>
                <span className="block text-[11px] text-muted-foreground">{n.sub}</span>
              </span>
              {n.id === 'overview' && incidents > 0 && (
                <span className="relative ml-auto size-1.5 rounded-full bg-danger" />
              )}
            </button>
          )
        })}
      </nav>

      <div className="mt-auto p-3">
        <div className="glass rounded-lg p-3">
          <div className="flex items-center gap-1.5">
            <span className={`size-1.5 rounded-full ${
              status === 'live' ? 'animate-pulse bg-ok' : status === 'connecting' ? 'bg-warn' : 'bg-danger'}`} />
            <span className="text-[11px] font-medium">
              {status === 'live' ? 'Live — real backend' : status}
            </span>
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
            Every number here is a Postgres read. No mock data.
          </p>
        </div>
      </div>
    </aside>
  )
}

export function Topbar({ title, subtitle, clock, right }) {
  return (
    <header className="glass-panel sticky top-0 z-20 flex shrink-0 items-center gap-4 border-b px-6 py-3">
      <div>
        <h1 className="text-[15px] font-semibold tracking-tight">{title}</h1>
        <p className="text-[11px] text-muted-foreground">{subtitle}</p>
      </div>
      <div className="ml-auto flex items-center gap-3">
        {right}
        {clock && (
          <Badge variant="outline" className="gap-2 font-mono text-[11px]">
            T+{clock.elapsed_sim_hours.toFixed(1)}h
            <span className="text-muted-foreground">1s={clock.seconds_per_sim_hour}h</span>
          </Badge>
        )}
        <Badge className="gap-1.5">HOP 2026</Badge>
      </div>
    </header>
  )
}
