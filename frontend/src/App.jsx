import { lazy, Suspense, useCallback, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { useQuery } from '@tanstack/react-query'
import {
  AlertTriangle, Clock, IndianRupee, ShieldCheck, Sparkles, TriangleAlert, Truck,
} from 'lucide-react'
import { Sidebar, Topbar, Stat, ALL_NAV } from '@/components/Shell'
import AgentActivity from '@/components/AgentActivity'
import IncidentPanel from '@/components/IncidentPanel'
import Communications from '@/components/Communications'
import WarehouseOps from '@/components/WarehouseOps'
import Approvals from '@/components/Approvals'
import AskAgent from '@/components/AskAgent'
import NetworkFlow from '@/components/NetworkFlow'
import ControlPanel from '@/components/ControlPanel'
import EventTimeline from '@/components/EventTimeline'
import WorldState from '@/components/WorldState'
import DecisionExplorer from '@/components/DecisionExplorer'
import RunHistory from '@/components/RunHistory'
import { useAgentStream } from '@/lib/useAgentStream'
import { useTheme } from '@/lib/useTheme'
import { api } from '@/lib/api'
import { inr } from '@/lib/format'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Button } from '@/components/ui/button'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import { TooltipProvider } from '@/components/ui/tooltip'
import { GitBranch as SchematicIcon, Globe2 } from 'lucide-react'

/** Geography is a second opinion, not the primary view — so it loads only when
 *  asked for, and never blocks the rest of the bundle. */
const MapView = lazy(() => import('@/components/MapView'))

function LiveNetwork({ revision }) {
  const [mode, setMode] = useState('schematic')
  const [mapNote, setMapNote] = useState(null)

  const fallback = useCallback((why) => { setMapNote(why); setMode('schematic') }, [])

  return (
    <div className="grid h-full grid-cols-12">
      <div className="relative col-span-8 min-h-0 border-r">
        <div className="absolute top-3 right-3 z-30 flex items-center gap-1 rounded-lg
                        border p-0.5 backdrop-blur-md
                        bg-[color-mix(in_oklab,var(--card)_70%,transparent)]">
          {[
            { id: 'schematic', label: 'Schematic', icon: SchematicIcon },
            { id: 'map',       label: 'Geography', icon: Globe2 },
          ].map((t) => (
            <Button key={t.id} size="sm"
                    variant={mode === t.id ? 'secondary' : 'ghost'}
                    onClick={() => setMode(t.id)}
                    className="h-6 gap-1.5 px-2 text-[11px]">
              <t.icon className="size-3" />{t.label}
            </Button>
          ))}
        </div>

        {mapNote && mode === 'schematic' && (
          <div className="text-muted-foreground absolute bottom-3 left-1/2 z-30 -translate-x-1/2
                          rounded-md border px-2 py-1 text-[10.5px] backdrop-blur-md
                          bg-[color-mix(in_oklab,var(--card)_70%,transparent)]">
            {mapNote} — showing the schematic
          </div>
        )}

        {mode === 'map' ? (
          <Suspense fallback={
            <div className="text-muted-foreground flex h-full items-center justify-center
                            text-[12px]">loading map…</div>}>
            <MapView revision={revision} onFallback={fallback} />
          </Suspense>
        ) : (
          <NetworkFlow revision={revision} />
        )}
      </div>
      <div className="glass-panel col-span-4 min-h-0">
        <WorldState revision={revision} />
      </div>
    </div>
  )
}

const SUBTITLE = {
  command:   'What is happening, where, and whether you need to step in',
  network:   'Supplier lanes, live shipments and contradictions',
  incidents: 'Everything the agent is holding',
  decisions: 'What the solver chose, and everything it refused',
  approvals: 'Only what crosses the agent’s authority reaches you',
  audit:     'Append-only event log, streamed live',
  ask:       'Answers from live operational state',
  comms:     'Supplier, warehouse and carrier conversations',
  scoring:   'Runs scored against the judges’ own formula',
  warehouse: 'Physical reality at Pune Plant',
}

function CommandCenter({ events, revision, status, onGoto }) {
  const { data: kpi } = useQuery({
    queryKey: ['kpis', revision], queryFn: api.kpis, refetchInterval: 4000 })
  const { data: ctx } = useQuery({ queryKey: ['context'], queryFn: api.context })

  const worst = (ctx?.production ?? [])
    .filter((p) => p.shortfall > 0)
    .sort((a, b) => a.shortfall - b.shortfall)[0]

  const cover = kpi?.min_coverage_days ?? null
  const critical = kpi?.critical_incidents ?? 0

  return (
    <div className="grid h-full grid-cols-12">
      <ScrollArea className="col-span-8 min-h-0">
       <div className="flex min-h-full flex-col p-5">
        {/* hero — three numbers, big, no card clutter */}
        <div className="glass grid grid-cols-3 gap-8 rounded-xl px-6 py-5">
          <Stat label="Production risk" icon={TriangleAlert}
                value={critical > 0 ? `${critical} critical` : (kpi?.open_incidents || 0) + ' open'}
                sub={critical ? 'a line will stop' : 'nothing urgent'}
                tone={critical ? 'text-danger' : ''} pulse={critical > 0} />
          <Stat label="Production cover" icon={Clock}
                value={cover != null ? `${cover.toFixed(1)} days` : '—'}
                sub={worst ? `${worst.component_name} is tightest` : 'all components healthy'}
                tone={cover != null && cover < 3 ? 'text-danger'
                      : cover != null && cover < 6 ? 'text-warn' : ''} />
          <Stat label="Committed recovery" icon={IndianRupee}
                value={inr(kpi?.agent_spend_inr ?? 0)}
                sub={`authority ${inr(kpi?.approval_threshold ?? 150000)}`} />
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-3 px-1">
          <Badge variant="outline" className="gap-1.5 text-[11px]">
            <Truck className="size-3" />{kpi?.delayed_pos ?? 0} delayed shipments
          </Badge>
          <Badge variant="outline" className="gap-1.5 text-[11px]">
            <ShieldCheck className="size-3" />{kpi?.contradictions_caught ?? 0} supplier claims caught
          </Badge>
          {(kpi?.erp_gap_units ?? 0) > 0 && (
            <Badge variant="outline"
                   className="border-warn/40 bg-warn/10 text-warn gap-1.5 text-[11px]">
              <AlertTriangle className="size-3" />ERP overstates by {kpi.erp_gap_units} units
            </Badge>
          )}
        </div>

        <Card className="mt-4 min-h-[330px] gap-0 overflow-hidden py-0">
          <div className="flex items-center gap-2 border-b px-4 py-2.5">
            <h2 className="text-muted-foreground text-[10px] font-medium
                           tracking-[0.14em] uppercase">Inbound supply network</h2>
            <Button variant="ghost" size="sm" onClick={() => onGoto('network')}
                    className="text-muted-foreground ml-auto h-6 px-2 text-[11px]">
              open ↗
            </Button>
          </div>
          <div className="h-[310px]"><NetworkFlow revision={revision} /></div>
        </Card>

        <Card className="mt-4 min-h-[300px] flex-1 gap-0 overflow-hidden py-0">
          <AgentActivity events={events} />
        </Card>
       </div>
      </ScrollArea>

      <div className="glass-panel col-span-4 flex min-h-0 flex-col border-l">
        <div className="border-b px-4 py-2.5">
          <h2 className="text-muted-foreground text-[10px] font-medium
                         tracking-[0.14em] uppercase">Live incident</h2>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <IncidentPanel revision={revision} onOpenDecision={() => onGoto('decisions')} />
        </ScrollArea>
        <Separator />
        <ScrollArea className="h-[42%] min-h-0">
          <div className="p-4"><ControlPanel /></div>
        </ScrollArea>
      </div>
    </div>
  )
}

export default function App() {
  const { events, clock, status, revision } = useAgentStream()
  const { theme, toggle } = useTheme()
  const [page, setPage] = useState('command')
  const meta = ALL_NAV.find((n) => n.id === page)

  const { data: kpi } = useQuery({
    queryKey: ['kpis', revision], queryFn: api.kpis, refetchInterval: 5000 })
  const { data: ctx } = useQuery({ queryKey: ['context'], queryFn: api.context })
  const { data: wh } = useQuery({
    queryKey: ['warehouse', revision], queryFn: api.warehouse, refetchInterval: 5000 })
  const { data: apr } = useQuery({
    queryKey: ['approvals', revision], queryFn: api.approvals, refetchInterval: 5000 })
  const { data: llm } = useQuery({ queryKey: ['llm'], queryFn: api.llmHealth })

  const criticals = kpi?.critical_incidents ?? 0
  const openTasks = (wh?.tasks ?? []).filter((t) => t.status === 'open').length
  const pendingApprovals = (apr?.approvals ?? []).filter((a) => a.status === 'pending').length

  return (
   <TooltipProvider delayDuration={200}>
    <SidebarProvider className="h-screen min-h-0">
      <Sidebar page={page} onPage={setPage} status={status} criticals={criticals}
               tasks={openTasks} approvals={pendingApprovals}
               org={ctx?.organization} />

      <SidebarInset className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <Topbar
          title={meta?.label ?? 'Command Center'}
          subtitle={SUBTITLE[page]}
          clock={clock} theme={theme} onToggleTheme={toggle}
          right={
            <>
              {llm && (
                <Badge variant="outline" className={`gap-1.5 text-[10.5px] ${llm.ok
                  ? 'border-primary/40 bg-primary/10 text-primary' : ''}`}>
                  <Sparkles className="size-3" />{llm.ok ? llm.model : 'deterministic'}
                </Badge>
              )}
              {criticals > 0 && (
                <motion.div animate={{ opacity: [1, 0.5, 1] }}
                            transition={{ duration: 1.8, repeat: Infinity }}>
                  <Badge variant="outline"
                         className="border-danger/50 bg-danger/15 text-danger gap-1">
                    <AlertTriangle className="size-3" />{criticals} critical
                  </Badge>
                </motion.div>
              )}
            </>
          }
        />

        <AnimatePresence mode="wait">
          <motion.div key={page}
            initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }} className="min-h-0 flex-1 overflow-hidden">

            {page === 'command' && (
              <CommandCenter events={events} revision={revision} status={status}
                             onGoto={setPage} />
            )}

            {page === 'network' && <LiveNetwork revision={revision} />}

            {page === 'incidents' && (
              <div className="grid h-full grid-cols-12">
                <div className="col-span-5 min-h-0 border-r">
                  <IncidentPanel revision={revision} onOpenDecision={() => setPage('decisions')} />
                </div>
                <div className="col-span-7 min-h-0">
                  <AgentActivity events={events} />
                </div>
              </div>
            )}

            {page === 'decisions' && (
              <div className="grid h-full grid-cols-12">
                <div className="col-span-8 min-h-0 border-r"><DecisionExplorer /></div>
                <div className="glass-panel col-span-4 min-h-0">
                  <IncidentPanel revision={revision} />
                </div>
              </div>
            )}

            {page === 'approvals' && <Approvals revision={revision} />}
            {page === 'comms' && <Communications revision={revision} />}
            {page === 'warehouse' && <WarehouseOps revision={revision} />}
            {page === 'ask' && <AskAgent />}

            {page === 'audit' && (
              <div className="grid h-full grid-cols-12">
                <div className="col-span-8 min-h-0 border-r">
                  <EventTimeline events={events} status={status} />
                </div>
                <ScrollArea className="glass-panel col-span-4 min-h-0">
                  <div className="p-4"><ControlPanel /></div>
                </ScrollArea>
              </div>
            )}

            {page === 'scoring' && (
              <div className="grid h-full grid-cols-12">
                <ScrollArea className="col-span-5 min-h-0 border-r">
                  <RunHistory revision={revision} />
                </ScrollArea>
                <div className="col-span-7 min-h-0"><WorldState revision={revision} /></div>
              </div>
            )}
          </motion.div>
        </AnimatePresence>
      </SidebarInset>
    </SidebarProvider>
   </TooltipProvider>
  )
}
