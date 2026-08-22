import { useState } from 'react'
import { Activity } from 'lucide-react'
import ControlPanel from '@/components/ControlPanel'
import EventTimeline from '@/components/EventTimeline'
import WorldState from '@/components/WorldState'
import DecisionExplorer from '@/components/DecisionExplorer'
import RunHistory from '@/components/RunHistory'
import { useAgentStream } from '@/lib/useAgentStream'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'

const DOT = {
  live: 'bg-ok', connecting: 'bg-warn', offline: 'bg-danger',
}

export default function App() {
  const { events, clock, status, revision } = useAgentStream()

  return (
    <div className="flex h-screen flex-col">
      <header className="flex shrink-0 items-center gap-4 border-b px-5 py-2.5">
        <div className="flex items-center gap-2.5">
          <Activity className="size-5 text-primary" />
          <div>
            <h1 className="text-sm font-semibold tracking-tight">
              Supply Chain Disruption Control Agent
            </h1>
            <p className="text-[11px] text-muted-foreground">
              Pune-Plant-1 · automotive electronics · kala dhua
            </p>
          </div>
        </div>

        <div className="ml-auto flex items-center gap-4">
          {clock && (
            <div className="text-right">
              <div className="text-[10px] tracking-wide text-muted-foreground uppercase">
                Simulated clock
              </div>
              <div className="font-mono text-xs tabular-nums">
                T+{clock.elapsed_sim_hours.toFixed(1)}h
                <span className="ml-2 text-muted-foreground">1s = {clock.seconds_per_sim_hour}h</span>
              </div>
            </div>
          )}
          <Badge variant="outline" className="gap-1.5">
            <span className={`size-1.5 rounded-full ${DOT[status]} ${status === 'live' ? 'animate-pulse' : ''}`} />
            {status}
          </Badge>
        </div>
      </header>

      <main className="grid min-h-0 flex-1 grid-cols-12">
        <aside className="col-span-3 min-h-0 border-r">
          <ScrollArea className="h-full">
            <div className="p-4"><ControlPanel /></div>
            <Separator />
            <RunHistory revision={revision} />
          </ScrollArea>
        </aside>

        <section className="col-span-5 flex min-h-0 flex-col border-r">
          <div className="min-h-0 flex-1"><EventTimeline events={events} status={status} /></div>
          <div className="h-[46%] min-h-0 border-t"><DecisionExplorer /></div>
        </section>

        <aside className="col-span-4 min-h-0"><WorldState revision={revision} /></aside>
      </main>
    </div>
  )
}
