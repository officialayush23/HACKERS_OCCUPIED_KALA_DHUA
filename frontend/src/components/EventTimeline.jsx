import { useEffect, useRef, useState } from 'react'
import { ChevronRight, Bot, Cog, User, Gauge, Radio } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'

const KIND = {
  SCENARIO_STARTED:      ['info', 'scenario'],
  INCIDENT_OPENED:       ['warn', 'incident'],
  DISRUPTION_INJECTED:   ['warn', 'disruption'],
  INVENTORY_DISCREPANCY: ['warn', 'inventory'],
  SUPPLIER_CLAIM:        ['mute', 'claim'],
  TRACKING_UPDATED:      ['mute', 'tracking'],
  CLAIM_CONTRADICTED:    ['danger', 'contradiction'],
  DEMAND_SPIKE:          ['warn', 'demand'],
  PRIORITY_CHANGED:      ['info', 'priority'],
  DEADLINE_PULLED_IN:    ['danger', 'deadline'],
  QUALITY_FAILURE:       ['danger', 'quality'],
  EXPEDITE_UNAVAILABLE:  ['mute', 'logistics'],
  HAZMAT_SUPPLY_FAILURE: ['danger', 'hazmat'],
  OPTION_REJECTED:       ['mute', 'rejected'],
  OPTION_SELECTED:       ['ok', 'selected'],
  APPROVAL_REQUIRED:     ['warn', 'approval'],
  RUN_SCORED:            ['info', 'scored'],
  MANUAL_NOTE:           ['info', 'note'],
}

const TONE = {
  ok:     'border-ok/40 bg-ok/10 text-ok',
  warn:   'border-warn/40 bg-warn/10 text-warn',
  danger: 'border-danger/50 bg-danger/15 text-danger',
  info:   'border-info/40 bg-info/10 text-info',
  mute:   'border-border bg-muted text-muted-foreground',
}

const ACTOR = {
  injector: [Radio, 'text-warn'],
  solver:   [Cog, 'text-ok'],
  llm:      [Bot, 'text-info'],
  human:    [User, 'text-info'],
  scorer:   [Gauge, 'text-info'],
}

function Row({ ev }) {
  const [open, setOpen] = useState(false)
  const [tone, label] = KIND[ev.event_type] ?? ['mute', ev.event_type.toLowerCase()]
  const [Icon, colour] = ACTOR[ev.actor] ?? [Cog, 'text-muted-foreground']
  const payload = ev.technical_payload ?? {}
  const hasPayload = Object.keys(payload).length > 0
  const simH = (ev.simulated_at_seconds ?? 0) / 3600

  return (
    <li className="relative pl-7">
      <span className="absolute left-0 top-1 flex size-5 items-center justify-center rounded-full border bg-background">
        <Icon className={`size-3 ${colour}`} />
      </span>
      <div className="pb-4">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="outline" className={TONE[tone]}>{label}</Badge>
          <span className="font-mono text-[11px] text-muted-foreground">#{ev.sequence}</span>
          <span className="font-mono text-[11px] text-muted-foreground">T+{simH.toFixed(1)}h</span>
          {ev.incident_id && (
            <span className="font-mono text-[11px] text-muted-foreground">{ev.incident_id}</span>
          )}
          {ev.scenario_run_id && (
            <Badge variant="outline" className="font-mono text-[10px]">run {ev.scenario_run_id}</Badge>
          )}
        </div>
        <p className="mt-1 text-sm leading-relaxed">{ev.human_summary}</p>
        {hasPayload && (
          <>
            <Button variant="ghost" size="sm" onClick={() => setOpen(!open)}
              className="mt-1 h-6 gap-1 px-1.5 text-[11px] text-muted-foreground">
              <ChevronRight className={`size-3 transition-transform ${open ? 'rotate-90' : ''}`} />
              payload
            </Button>
            {open && (
              <pre className="mt-1 overflow-x-auto rounded-md border bg-muted/40 p-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
{JSON.stringify(payload, null, 2)}
              </pre>
            )}
          </>
        )}
      </div>
    </li>
  )
}

export default function EventTimeline({ events, status }) {
  const viewportRef = useRef(null)
  const [follow, setFollow] = useState(true)

  useEffect(() => {
    if (follow && viewportRef.current) {
      viewportRef.current.scrollTop = viewportRef.current.scrollHeight
    }
  }, [events.length, follow])

  return (
    <div className="flex h-full flex-col">
      <div className="glass-panel sticky top-0 z-10 flex shrink-0 items-center justify-between border-b px-4 py-2.5">
        <h2 className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">
          Agent timeline
        </h2>
        <div className="flex items-center gap-3">
          <span className="text-[11px] text-muted-foreground">{events.length} events</span>
          <Button size="sm" variant={follow ? 'secondary' : 'ghost'}
            className="h-6 px-2 text-[11px]" onClick={() => setFollow(!follow)}>
            follow
          </Button>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1" viewportRef={viewportRef}>
        <div className="px-4 py-4">
          {events.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-1 py-16 text-center">
              <p className="text-sm text-muted-foreground">No events yet.</p>
              <p className="max-w-xs text-xs leading-relaxed text-muted-foreground/70">
                {status === 'live'
                  ? 'Inject a scenario from the left and watch it arrive here in real time.'
                  : 'Waiting for the backend on :8000 — start it with uvicorn.'}
              </p>
            </div>
          ) : (
            <ul className="relative">
              <span className="absolute left-[10px] top-2 bottom-2 w-px bg-border" />
              {events.map((ev) => <Row key={ev.sequence} ev={ev} />)}
            </ul>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
