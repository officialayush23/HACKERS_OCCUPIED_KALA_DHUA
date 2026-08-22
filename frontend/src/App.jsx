import { useState } from 'react'
import ControlPanel from './components/ControlPanel'
import EventTimeline from './components/EventTimeline'
import WorldState from './components/WorldState'
import DecisionExplorer from './components/DecisionExplorer'
import { useAgentStream } from './lib/useAgentStream'

const DOT = { live: 'bg-emerald-400', connecting: 'bg-amber-400', offline: 'bg-red-500' }

export default function App() {
  const { events, clock, status, revision } = useAgentStream()
  const [bump, setBump] = useState(0)
  const rev = revision + bump

  return (
    <div className="flex h-screen flex-col bg-neutral-950 text-neutral-200 antialiased">
      <header className="flex shrink-0 items-center gap-4 border-b border-neutral-800 px-5 py-3">
        <div>
          <h1 className="text-sm font-semibold tracking-tight text-neutral-100">
            Supply Chain Disruption Control Agent
          </h1>
          <p className="text-[11px] text-neutral-600">
            Pune-Plant-1 · automotive electronics · kala dhua
          </p>
        </div>

        <div className="ml-auto flex items-center gap-5 text-xs">
          {clock && (
            <div className="text-right">
              <div className="text-[10px] uppercase tracking-wide text-neutral-600">
                Simulated clock
              </div>
              <div className="font-mono text-neutral-300">
                T+{clock.elapsed_sim_hours.toFixed(1)}h
                <span className="ml-2 text-neutral-600">
                  1s = {clock.seconds_per_sim_hour}h
                </span>
              </div>
            </div>
          )}
          <div className="flex items-center gap-2">
            <span className={`h-2 w-2 rounded-full ${DOT[status]} ${status === 'live' ? 'animate-pulse' : ''}`} />
            <span className="text-neutral-500">{status}</span>
          </div>
        </div>
      </header>

      <main className="grid min-h-0 flex-1 grid-cols-12">
        <aside className="col-span-3 min-h-0 overflow-y-auto border-r border-neutral-800 p-4">
          <ControlPanel onActivity={() => setBump((b) => b + 1)} />
        </aside>

        <section className="col-span-5 flex min-h-0 flex-col border-r border-neutral-800">
          <div className="min-h-0 flex-1">
            <EventTimeline events={events} status={status} />
          </div>
          <div className="h-[45%] min-h-0 border-t border-neutral-800">
            <DecisionExplorer onRecorded={() => setBump((b) => b + 1)} />
          </div>
        </section>

        <aside className="col-span-4 min-h-0">
          <WorldState revision={rev} />
        </aside>
      </main>
    </div>
  )
}
