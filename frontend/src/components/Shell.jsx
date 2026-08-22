import { motion } from 'motion/react'
import {
  Activity, Boxes, CheckCircle2, Gauge, GitBranch, LayoutGrid, MessageSquare,
  Moon, ScrollText, Scale, Sparkles, Sun, TriangleAlert, Warehouse,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'

export const NAV_GROUPS = [
  {
    group: 'Operations',
    items: [
      { id: 'command',   label: 'Command Center', icon: LayoutGrid, sub: 'live operations' },
      { id: 'network',   label: 'Live Network',   icon: GitBranch,  sub: 'lanes & shipments' },
      { id: 'incidents', label: 'Incidents',      icon: TriangleAlert, sub: 'open & resolved' },
    ],
  },
  {
    group: 'Decisions',
    items: [
      { id: 'decisions', label: 'Decision Explorer', icon: Scale,       sub: 'chosen vs rejected' },
      { id: 'approvals', label: 'Approvals',         icon: CheckCircle2, sub: 'over authority' },
      { id: 'audit',     label: 'Audit Trail',       icon: ScrollText,  sub: 'immutable log' },
    ],
  },
  {
    group: 'Intelligence',
    items: [
      { id: 'ask',      label: 'Ask the Agent', icon: Sparkles, sub: 'conversational' },
      { id: 'comms',    label: 'Communications', icon: MessageSquare, sub: 'supplier & warehouse' },
      { id: 'scoring',  label: 'Performance',   icon: Gauge,    sub: 'rubric runs' },
    ],
  },
  {
    group: 'Warehouse',
    items: [
      { id: 'warehouse', label: 'Plant Operations', icon: Warehouse, sub: 'stock & tasks' },
    ],
  },
]

export const ALL_NAV = NAV_GROUPS.flatMap((g) => g.items)

export function Sidebar({ page, onPage, status, criticals, tasks, approvals, org }) {
  return (
    <aside className="glass-panel border-sidebar-border text-sidebar-foreground
                      flex w-[244px] shrink-0 flex-col border-r">
      <div className="flex items-center gap-2.5 px-4 py-4">
        <div className="bg-sidebar-primary/15 ring-sidebar-primary/30 flex size-9
                        items-center justify-center rounded-xl ring-1">
          <Activity className="text-sidebar-primary size-5" />
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold tracking-tight">DisruptionOps</div>
          <div className="text-muted-foreground truncate text-[11px]">
            {org?.name?.split(' ').slice(0, 2).join(' ') || 'NEXA Mobility'}
          </div>
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-2 pb-2">
        {NAV_GROUPS.map((g) => (
          <div key={g.group}>
            <div className="text-muted-foreground px-3 pb-1 text-[10px] font-medium
                            tracking-[0.14em] uppercase">
              {g.group}
            </div>
            <div className="flex flex-col gap-0.5">
              {g.items.map((n) => {
                const active = page === n.id
                const badge =
                  n.id === 'command' ? criticals :
                  n.id === 'approvals' ? approvals :
                  n.id === 'warehouse' ? tasks : 0
                return (
                  <button key={n.id} onClick={() => onPage(n.id)}
                    className={`relative flex items-center gap-2.5 rounded-lg px-3 py-2 text-left
                      transition-colors ${active
                        ? 'text-sidebar-accent-foreground'
                        : 'text-muted-foreground hover:text-sidebar-accent-foreground'}`}>
                    {active && (
                      <motion.span layoutId="navpill"
                        className="bg-sidebar-accent absolute inset-0 rounded-lg"
                        transition={{ type: 'spring', stiffness: 420, damping: 34 }} />
                    )}
                    <n.icon className={`relative size-4 ${active ? 'text-sidebar-primary' : ''}`} />
                    <span className="relative min-w-0 flex-1">
                      <span className="block text-[13px] leading-tight font-medium">{n.label}</span>
                      <span className="text-muted-foreground block text-[10.5px]">{n.sub}</span>
                    </span>
                    {badge > 0 && (
                      <span className="bg-danger text-background relative flex size-4 items-center
                                       justify-center rounded-full text-[9px] font-semibold">
                        {badge}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      </div>

      <Separator />
      <div className="p-3">
        <div className="flex items-center gap-1.5">
          <span className={`size-1.5 rounded-full ${
            status === 'live' ? 'bg-ok animate-pulse'
            : status === 'connecting' ? 'bg-warn' : 'bg-danger'}`} />
          <span className="text-[11px] font-medium">
            {status === 'live' ? 'Live — real backend' : status}
          </span>
        </div>
        <p className="text-muted-foreground mt-1 text-[10.5px] leading-relaxed">
          {org?.name ?? 'NEXA Mobility Systems'} · Pune Plant
        </p>
      </div>
    </aside>
  )
}

export function Topbar({ title, subtitle, clock, theme, onToggleTheme, right }) {
  return (
    <header className="glass-panel sticky top-0 z-20 flex shrink-0 items-center gap-4
                       border-b px-6 py-3">
      <div className="min-w-0">
        <h1 className="truncate text-[17px] font-semibold tracking-tight">{title}</h1>
        <p className="text-muted-foreground truncate text-[11.5px]">{subtitle}</p>
      </div>

      <div className="ml-auto flex items-center gap-2.5">
        {right}
        {clock && (
          <Badge variant="outline" className="gap-2 font-mono text-[11px]">
            T+{clock.elapsed_sim_hours.toFixed(1)}h
            <span className="text-muted-foreground">1s={clock.seconds_per_sim_hour}h</span>
          </Badge>
        )}
        <Button variant="ghost" size="icon" onClick={onToggleTheme}
                aria-label="Toggle theme" className="size-8">
          {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
        </Button>
      </div>
    </header>
  )
}

/** Big number, quiet label. Used across Command Center. */
export function Stat({ value, label, sub, tone = '', icon: Icon, pulse }) {
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
                className="min-w-0">
      <div className="text-muted-foreground flex items-center gap-1.5 text-[10px]
                      font-medium tracking-[0.14em] uppercase">
        {Icon && <Icon className="size-3" />}{label}
      </div>
      <div className={`mt-1 font-mono text-[30px] leading-none font-semibold tabular-nums ${tone}
                       ${pulse ? 'animate-pulse' : ''}`}>
        {value}
      </div>
      {sub && <div className="text-muted-foreground mt-1 text-[11.5px]">{sub}</div>}
    </motion.div>
  )
}

export { Boxes }
