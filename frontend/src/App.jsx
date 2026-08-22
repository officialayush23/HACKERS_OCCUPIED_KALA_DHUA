import { useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, ArrowRight } from 'lucide-react'
import { Sidebar, Topbar, NAV } from '@/components/Shell'
import KpiStrip from '@/components/KpiStrip'
import NetworkFlow from '@/components/NetworkFlow'
import ControlPanel from '@/components/ControlPanel'
import EventTimeline from '@/components/EventTimeline'
import WorldState from '@/components/WorldState'
import DecisionExplorer from '@/components/DecisionExplorer'
import RunHistory from '@/components/RunHistory'
import { useAgentStream } from '@/lib/useAgentStream'
import { api } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'

const SEV = {
  critical: 'border-danger/50 bg-danger/15 text-danger',
  high:     'border-warn/50 bg-warn/15 text-warn',
  medium:   'border-info/40 bg-info/10 text-info',
  low:      'border-border bg-muted text-muted-foreground',
}

function IncidentRail({ revision, onOpen }) {
  const { data } = useQuery({ queryKey: ['incidents', revision], queryFn: api.incidents })
  const open = (data?.incidents ?? []).filter((i) => !['resolved', 'failed'].includes(i.status))

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b px-4 py-2.5">
        <h2 className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">
          Active incidents
        </h2>
        <Badge variant="outline" className="ml-auto">{open.length}</Badge>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-2 p-3">
          <AnimatePresence initial={false}>
            {open.length === 0 && (
              <p className="px-1 py-6 text-center text-xs text-muted-foreground">
                No active incidents. Inject a scenario to begin.
              </p>
            )}
            {open.map((i) => (
              <motion.div key={i.id} layout
                initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 16 }}>
                <Card className="gap-0 py-0">
                  <div className="p-3">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs">{i.id}</span>
                      <Badge variant="outline" className={SEV[i.severity]}>{i.severity}</Badge>
                      <Badge variant="outline" className="ml-auto text-[10px]">{i.status}</Badge>
                    </div>
                    <p className="mt-1.5 text-[13px] leading-snug">
                      {i.type.replace(/_/g, ' ')}
                      {i.component_name && <span className="text-muted-foreground"> · {i.component_name}</span>}
                    </p>
                    {i.source_po_id && (
                      <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">{i.source_po_id}</p>
                    )}
                    <Button size="sm" variant="ghost" className="mt-1.5 h-6 gap-1 px-1.5 text-[11px]"
                            onClick={() => onOpen(i)}>
                      Open decision <ArrowRight className="size-3" />
                    </Button>
                  </div>
                </Card>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      </ScrollArea>
    </div>
  )
}

export default function App() {
  const { events, clock, status, revision } = useAgentStream()
  const [page, setPage] = useState('overview')
  const meta = NAV.find((n) => n.id === page)

  const { data: kpi } = useQuery({ queryKey: ['kpis', revision], queryFn: api.kpis })
  const criticals = kpi?.critical_incidents ?? 0

  return (
    <div className="flex h-screen">
      <Sidebar page={page} onPage={setPage} status={status} incidents={criticals} />

      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar
          title={meta?.label ?? 'Overview'}
          subtitle={
            page === 'overview' ? 'Inbound procurement recovery at a glance'
            : page === 'network' ? 'Supplier lanes, live shipments, contradictions'
            : page === 'decisions' ? 'What the solver chose, and everything it refused'
            : page === 'audit' ? 'Append-only event log, streamed live'
            : 'Runs scored against the judges’ own formula'}
          clock={clock}
          right={criticals > 0 && (
            <motion.div animate={{ opacity: [1, 0.55, 1] }}
                        transition={{ duration: 1.8, repeat: Infinity }}>
              <Badge variant="outline" className="gap-1 border-danger/50 bg-danger/15 text-danger">
                <AlertTriangle className="size-3" />{criticals} critical
              </Badge>
            </motion.div>
          )}
        />

        <AnimatePresence mode="wait">
          <motion.main key={page}
            initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="min-h-0 flex-1 overflow-hidden">

            {page === 'overview' && (
              <div className="grid h-full grid-cols-12 gap-0">
                <div className="col-span-8 flex min-h-0 flex-col gap-4 overflow-y-auto p-5">
                  <KpiStrip revision={revision} />
                  <Card className="min-h-[380px] gap-0 overflow-hidden py-0">
                    <div className="flex items-center gap-2 border-b px-4 py-2.5">
                      <h2 className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">
                        Inbound supply network
                      </h2>
                      <span className="text-[11px] text-muted-foreground">
                        live lanes into Pune-Plant-1
                      </span>
                    </div>
                    <div className="h-[360px]"><NetworkFlow revision={revision} /></div>
                  </Card>
                  <div className="min-h-[300px]">
                    <Card className="h-full gap-0 overflow-hidden py-0">
                      <EventTimeline events={events} status={status} />
                    </Card>
                  </div>
                </div>
                <div className="glass-panel col-span-4 flex min-h-0 flex-col border-l">
                  <div className="h-[46%] min-h-0 border-b"><IncidentRail revision={revision} /></div>
                  <ScrollArea className="min-h-0 flex-1">
                    <div className="p-4"><ControlPanel /></div>
                  </ScrollArea>
                </div>
              </div>
            )}

            {page === 'network' && (
              <div className="grid h-full grid-cols-12">
                <div className="col-span-8 min-h-0 border-r"><NetworkFlow revision={revision} /></div>
                <div className="glass-panel col-span-4 min-h-0"><WorldState revision={revision} /></div>
              </div>
            )}

            {page === 'decisions' && (
              <div className="grid h-full grid-cols-12">
                <div className="col-span-8 min-h-0 border-r"><DecisionExplorer /></div>
                <div className="col-span-4 min-h-0"><IncidentRail revision={revision} /></div>
              </div>
            )}

            {page === 'audit' && (
              <div className="grid h-full grid-cols-12">
                <div className="col-span-8 min-h-0 border-r">
                  <EventTimeline events={events} status={status} />
                </div>
                <ScrollArea className="col-span-4 min-h-0">
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
          </motion.main>
        </AnimatePresence>
      </div>
    </div>
  )
}
