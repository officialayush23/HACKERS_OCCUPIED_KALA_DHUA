import { lazy, Suspense, useCallback, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { useQuery } from '@tanstack/react-query'
import {
  AlertTriangle, FlaskConical, IndianRupee, ShieldCheck, Sparkles, Truck,
} from 'lucide-react'
import { Sidebar, Topbar, Stat, ALL_NAV } from '@/components/Shell'
import AgentActivity from '@/components/AgentActivity'
import IncidentPanel from '@/components/IncidentPanel'
import Communications from '@/components/Communications'
import WarehouseOps from '@/components/WarehouseOps'
import Approvals from '@/components/Approvals'
import NetworkFlow from '@/components/NetworkFlow'
import WorldState from '@/components/WorldState'
import DecisionExplorer from '@/components/DecisionExplorer'
import RunHistory from '@/components/RunHistory'
import DecisionLog from '@/components/DecisionLog'
import Accuracy from '@/components/Accuracy'
import NoRun from '@/components/NoRun'
import Evaluation from '@/components/Evaluation'
import HumanInput from '@/components/HumanInput'
import AuditPage from '@/components/AuditPage'
import NowBar from '@/components/NowBar'
import ActionQueue from '@/components/ActionQueue'
import AgentStatus from '@/components/AgentStatus'
import CommandBar, { CommandBarTrigger } from '@/components/CommandBar'
import SimulationDrawer from '@/components/SimulationDrawer'
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
  command:   'What needs you, what is happening, and what the agent is doing about it',
  network:   'Supplier lanes, live shipments and contradictions',
  incidents: 'Everything the agent is holding',
  decisions: 'What the solver chose, and everything it refused',
  approvals: 'Only what crosses the agent\u2019s authority reaches you',
  audit:     'Every action the agent took, and the evidence behind it',
  comms:     'Supplier, warehouse and carrier conversations',
  scoring:   'Runs scored against the judges\u2019 own formula',
  evaluation:'Did this run pass \u2014 criterion by criterion, with the evidence',
  questions: 'Decisions the agent refused to make, and why it refused them',
  auditlog:  'Every event, every actor, every run \u2014 append-only',
  warehouse: 'Physical reality at Pune Plant',
}

function Overview({ events, revision, onGoto, onRunSim }) {
  const { data: kpi } = useQuery({
    queryKey: ['kpis', revision], queryFn: api.kpis, refetchInterval: 4000 })
  const { data: ctx } = useQuery({ queryKey: ['context'], queryFn: api.context })
  const { data: now } = useQuery({
    queryKey: ['now'], queryFn: api.now, refetchInterval: 3000 })

  // One source of truth. Reading risk from `incidents` while reading the numbers
  // from `context` is what let this screen say "all clear" and "short by 310"
  // in the same breath.
  // No run means no evidence. The baseline topology is still real, but nothing
  // that claims something happened may render.
  // Belt and braces. `has_run` is the contract, but an older backend that does
  // not send the field must not be read as "a run exists" — an undefined field
  // is not evidence. Anything that claims something happened needs a run id.
  const hasRun = now?.has_run === true && now?.active_run_id != null
  const atRisk = hasRun && (now?.production_at_risk ?? false)
  const order = now?.worst ?? null
  const incident = (now?.incidents ?? [])[0] ?? null
  const cover = now?.min_coverage_days ?? null

  if (!hasRun) {
    return (
      <NoRun
        title="No active test run"
        what="Nothing has been injected yet, so there is no incident, no decision and
              no agent activity to show. The supplier network below is the static
              baseline — it is the world a test will run against, not a result."
        onRun={onRunSim}
        baseline="Baseline topology loaded · no active disruption" />
    )
  }

  return (
    <div className="grid h-full grid-cols-12">
      {/* LEFT — what needs me */}
      <div className="col-span-3 min-h-0 border-r">
        <ActionQueue onGoto={onGoto} />
      </div>

      {/* CENTRE — one operational story */}
      <ScrollArea className="col-span-6 min-h-0">
        <div className="flex min-h-full flex-col gap-6 p-7">
          {atRisk ? (
            <div>
              <div className="flex items-center gap-2.5">
                <span className={`size-2 rounded-full ${
                  cover != null && cover < 3 ? 'bg-danger animate-pulse' : 'bg-warn'}`} />
                <span className="text-muted-foreground text-[10px] font-medium
                                 tracking-[0.14em] uppercase">
                  {incident
                    ? `${incident.severity} · ${incident.status.replace(/_/g, ' ')}`
                    : 'detected · agent is picking this up'}
                </span>
              </div>
              <h2 className="mt-2.5 text-[26px] leading-tight font-semibold tracking-tight">
                {order?.component_name ?? incident?.component_name} shortage
              </h2>
              <p className="text-muted-foreground mt-2 text-[14px] leading-relaxed">
                {cover != null
                  ? `Production stops in ${cover.toFixed(1)} days unless this is recovered.`
                  : 'Assessing production impact.'}
                {order && ` ${order.product_name ?? order.id} for ${order.oem_customer}.`}
              </p>
            </div>
          ) : (
            <div>
              <div className="flex items-center gap-2.5">
                <span className="bg-ok size-2 rounded-full" />
                <span className="text-muted-foreground text-[10px] font-medium
                                 tracking-[0.14em] uppercase">all clear</span>
              </div>
              <h2 className="mt-2.5 text-[26px] leading-tight font-semibold tracking-tight">
                Nothing threatens production
              </h2>
              <p className="text-muted-foreground mt-2 text-[14px] leading-relaxed">
                Every component is covered. Inject a disruption to watch the agent wake up.
              </p>
            </div>
          )}

          {/* the chain, in one line of plain arithmetic */}
          {order && (
            <div className="glass flex items-center gap-5 rounded-xl px-6 py-5">
              {[
                ['have', `${order.available} usable`, 'net of other runs\u2019 claims'],
                ['need', `${order.required_units} units`, order.component_name],
                ['short by', `${order.shortfall}`,
                 incident ? 'agent is recovering this' : 'agent is waking up'],
              ].map(([k, v, sub], i) => (
                <div key={k} className="flex min-w-0 items-center gap-5">
                  {i > 0 && <span className="text-muted-foreground/50 shrink-0">→</span>}
                  <div className="min-w-0">
                    <div className="text-muted-foreground text-[9.5px] font-medium
                                    tracking-[0.12em] uppercase">{k}</div>
                    <div className={`mt-1 font-mono text-[22px] leading-none tabular-nums
                      ${k === 'short by' ? 'text-danger' : ''}`}>{v}</div>
                    <div className="text-muted-foreground mt-1.5 truncate text-[11px]">{sub}</div>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <Badge variant="outline" className="gap-1.5 py-1 text-[11.5px]">
              <Truck className="size-3" />{kpi?.delayed_pos ?? 0} delayed shipments
            </Badge>
            <Badge variant="outline" className="gap-1.5 py-1 text-[11.5px]">
              <ShieldCheck className="size-3" />{kpi?.contradictions_caught ?? 0} claims caught
            </Badge>
            <Badge variant="outline" className="gap-1.5 py-1 text-[11.5px]">
              <IndianRupee className="size-3" />{inr(kpi?.agent_spend_inr ?? 0)} committed
            </Badge>
            {(kpi?.erp_gap_units ?? 0) > 0 && (
              <Badge variant="outline"
                     className="border-warn/40 bg-warn/10 text-warn gap-1.5 py-1 text-[11.5px]">
                <AlertTriangle className="size-3" />ERP overstates by {kpi.erp_gap_units} units
              </Badge>
            )}
          </div>

          {/* the recommendation, if there is one */}
          <IncidentPanel revision={revision} onOpenDecision={() => onGoto('decisions')} />

          <Card className="min-h-[280px] flex-1 gap-0 overflow-hidden py-0">
            <div className="flex items-center gap-2.5 border-b px-6 py-4">
              <h2 className="text-muted-foreground text-[10px] font-medium
                             tracking-[0.14em] uppercase">Inbound supply network</h2>
              <Button variant="ghost" size="sm" onClick={() => onGoto('network')}
                      className="text-muted-foreground ml-auto h-6 px-2 text-[11px]">
                open ↗
              </Button>
            </div>
            <div className="h-[300px]"><NetworkFlow revision={revision} /></div>
          </Card>
        </div>
      </ScrollArea>

      {/* RIGHT — what the AI is doing */}
      <div className="glass-panel col-span-3 min-h-0 border-l">
        <AgentStatus events={events} onGoto={onGoto} />
      </div>
    </div>
  )
}

export default function App() {
  const { events, clock, status, revision } = useAgentStream()
  const { theme, toggle } = useTheme()
  const [page, setPage] = useState('command')
  const [cmdOpen, setCmdOpen] = useState(false)
  const [simOpen, setSimOpen] = useState(false)
  const meta = ALL_NAV.find((n) => n.id === page)

  const { data: kpi } = useQuery({
    queryKey: ['kpis', revision], queryFn: api.kpis, refetchInterval: 5000 })
  const { data: ctx } = useQuery({ queryKey: ['context'], queryFn: api.context })
  const { data: wh } = useQuery({
    queryKey: ['warehouse', revision], queryFn: api.warehouse, refetchInterval: 5000 })
  const { data: apr } = useQuery({
    queryKey: ['approvals', revision], queryFn: api.approvals, refetchInterval: 5000 })
  // This one really does hit the model, so it is deliberately exempt from the
  // global short poll. A liveness badge is not worth a request every 4 seconds.
  const { data: llm } = useQuery({
    queryKey: ['llm'], queryFn: api.llmHealth,
    staleTime: 120_000, refetchInterval: 120_000 })

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
              <Button variant="outline" size="sm" onClick={() => setSimOpen(true)}
                      className="h-8 gap-1.5 px-2.5 text-[12px] font-normal">
                <FlaskConical className="size-3.5" />Run simulation
              </Button>
              <CommandBarTrigger onClick={() => setCmdOpen(true)} />
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

        <NowBar onGoto={setPage} />

        <AnimatePresence mode="wait">
          <motion.div key={page}
            initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }} className="min-h-0 flex-1 overflow-hidden">

            {page === 'command' && (
              <Overview events={events} revision={revision} onGoto={setPage}
                        onRunSim={() => setSimOpen(true)} />
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
                <div className="col-span-8 min-h-0 border-r">
                  <DecisionExplorer onApprove={() => setPage('approvals')} />
                </div>
                <div className="glass-panel col-span-4 min-h-0">
                  <IncidentPanel revision={revision} />
                </div>
              </div>
            )}

            {page === 'approvals' && <Approvals revision={revision} />}
            {page === 'comms' && <Communications revision={revision} />}
            {page === 'warehouse' && <WarehouseOps revision={revision} />}

            {page === 'audit' && <DecisionLog events={events} />}

            {page === 'scoring' && (
              <div className="grid h-full grid-cols-12">
                <div className="col-span-7 min-h-0 border-r">
                  <Accuracy revision={revision} onRunSim={() => setSimOpen(true)} />
                </div>
                <ScrollArea className="glass-panel col-span-5 min-h-0">
                  <RunHistory revision={revision} />
                </ScrollArea>
              </div>
            )}

            {page === 'evaluation' && (
              <Evaluation onRunSim={() => setSimOpen(true)} />
            )}

            {page === 'questions' && <HumanInput />}

            {page === 'auditlog' && <AuditPage />}
          </motion.div>
        </AnimatePresence>
        <CommandBar open={cmdOpen} onOpenChange={setCmdOpen}
                    pages={ALL_NAV} onGoto={setPage} />
        <SimulationDrawer open={simOpen} onOpenChange={setSimOpen} />
      </SidebarInset>
    </SidebarProvider>
   </TooltipProvider>
  )
}
