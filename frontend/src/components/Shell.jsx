import { motion } from 'motion/react'
import {
  Activity, Boxes, CheckCircle2, CircleHelp, Gauge, GitBranch, LayoutGrid,
  MessageSquare, Moon, Scale, Sun, TriangleAlert, Warehouse,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Sidebar as SidebarRoot, SidebarContent, SidebarFooter, SidebarGroup,
  SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarMenu,
  SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem, SidebarRail,
  SidebarTrigger, useSidebar,
} from '@/components/ui/sidebar'
import { Separator } from '@/components/ui/separator'

export const NAV_GROUPS = [
  {
    group: 'Operations',
    items: [
      { id: 'command',   label: 'Overview',   icon: LayoutGrid,    sub: 'what needs you now' },
      { id: 'incidents', label: 'Incidents',  icon: TriangleAlert, sub: 'open & resolved' },
      { id: 'network',   label: 'Network',    icon: GitBranch,     sub: 'lanes & shipments' },
    ],
  },
  {
    group: 'AI agent',
    items: [
      { id: 'audit',     label: 'Agent Activity', icon: Activity,      sub: 'what it did, and why' },
      { id: 'comms',     label: 'Conversations',  icon: MessageSquare, sub: 'suppliers & warehouse' },
      { id: 'questions', label: 'Its Questions',  icon: CircleHelp,    sub: 'what it would not guess' },
      { id: 'approvals', label: 'Approvals',      icon: CheckCircle2,  sub: 'over its authority' },
    ],
  },
  {
    group: 'Execution',
    items: [
      { id: 'warehouse', label: 'Warehouse', icon: Warehouse, sub: 'stock & tasks' },
    ],
  },
  {
    group: 'Governance',
    items: [
      { id: 'decisions', label: 'Decisions',   icon: Scale,      sub: 'chosen vs refused' },
      { id: 'scoring',   label: 'Performance', icon: Gauge,      sub: 'rubric runs' },
    ],
  },
]

export const ALL_NAV = NAV_GROUPS.flatMap((g) => g.items)

/**
 * shadcn's Sidebar, collapsible to an icon rail (⌘B / ctrl-B, or the rail edge).
 * Collapsed, every item keeps its badge and gains a tooltip — an operator who
 * has folded the nav away should still see that three approvals are waiting.
 */
export function Sidebar({ page, onPage, status, criticals, tasks, approvals,
                          questions = 0, org }) {
  const { state } = useSidebar()
  const collapsed = state === 'collapsed'

  return (
    <SidebarRoot collapsible="icon" className="glass-panel">
      <SidebarHeader>
        <div className="flex items-center gap-3 px-1.5 py-2.5">
          <div className="bg-sidebar-primary/15 ring-sidebar-primary/30 flex size-8 shrink-0
                          items-center justify-center rounded-xl ring-1">
            <Activity className="text-sidebar-primary size-4.5" />
          </div>
          <div className="min-w-0 group-data-[collapsible=icon]:hidden">
            <div className="truncate text-sm font-semibold tracking-tight">DisruptionOps</div>
            <div className="text-muted-foreground truncate text-[11px]">
              {org?.name?.split(' ').slice(0, 2).join(' ') || 'NEXA Mobility'}
            </div>
          </div>
        </div>
      </SidebarHeader>

      <SidebarContent>
        {NAV_GROUPS.map((g) => (
          <SidebarGroup key={g.group}>
            <SidebarGroupLabel className="text-[10px] tracking-[0.14em] uppercase">
              {g.group}
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {g.items.map((n) => {
                  const active = page === n.id
                  const badge =
                    n.id === 'command' ? criticals :
                    n.id === 'approvals' ? approvals :
                    n.id === 'questions' ? questions :
                    n.id === 'warehouse' ? tasks : 0
                  return (
                    <SidebarMenuItem key={n.id}>
                      <SidebarMenuButton
                        isActive={active}
                        onClick={() => onPage(n.id)}
                        tooltip={badge > 0 ? `${n.label} — ${badge} waiting` : n.label}
                        className="h-auto py-2.5">
                        <n.icon className={active ? 'text-sidebar-primary' : ''} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] leading-tight font-medium">
                            {n.label}
                          </span>
                          <span className="text-muted-foreground block truncate text-[10.5px]">
                            {n.sub}
                          </span>
                        </span>
                      </SidebarMenuButton>
                      {badge > 0 && (
                        <SidebarMenuBadge
                          className={`bg-danger text-background top-1/2 size-4 -translate-y-1/2
                                      justify-center rounded-full p-0 text-[9px] font-semibold
                                      ${collapsed
                                        ? 'right-1 top-1.5 translate-y-0 size-3.5 text-[8px]'
                                        : ''}`}>
                          {badge}
                        </SidebarMenuBadge>
                      )}
                    </SidebarMenuItem>
                  )
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarFooter>
        <Separator className="group-data-[collapsible=icon]:hidden" />
        <div className="px-1.5 py-2">
          <div className="flex items-center gap-1.5">
            <span className={`size-1.5 shrink-0 rounded-full ${
              status === 'live' ? 'bg-ok animate-pulse'
              : status === 'connecting' ? 'bg-warn' : 'bg-danger'}`} />
            <span className="truncate text-[11px] font-medium
                             group-data-[collapsible=icon]:hidden">
              {status === 'live' ? 'Live — real backend' : status}
            </span>
          </div>
          <p className="text-muted-foreground mt-1 text-[10.5px] leading-relaxed
                        group-data-[collapsible=icon]:hidden">
            {org?.name ?? 'NEXA Mobility Systems'} · Pune Plant
          </p>
        </div>
      </SidebarFooter>

      {/* Drag or click the edge to fold the nav away. */}
      <SidebarRail />
    </SidebarRoot>
  )
}

export function Topbar({ title, subtitle, clock, theme, onToggleTheme, right }) {
  return (
    <header className="glass-panel sticky top-0 z-20 flex shrink-0 items-center gap-3.5
                       border-b px-5 py-4">
      <SidebarTrigger className="text-muted-foreground hover:text-foreground -ml-1 size-8" />
      <Separator orientation="vertical" className="!h-5" />

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
