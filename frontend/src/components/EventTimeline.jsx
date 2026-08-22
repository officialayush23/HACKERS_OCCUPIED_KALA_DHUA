import { useEffect, useRef, useState } from 'react'

const STYLES = {
  SCENARIO_STARTED:      ['bg-sky-500/15 text-sky-300 border-sky-500/30', 'scenario'],
  INCIDENT_OPENED:       ['bg-amber-500/15 text-amber-300 border-amber-500/30', 'incident'],
  DISRUPTION_INJECTED:   ['bg-orange-500/15 text-orange-300 border-orange-500/30', 'disruption'],
  INVENTORY_DISCREPANCY: ['bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-500/30', 'inventory'],
  SUPPLIER_CLAIM:        ['bg-neutral-700/40 text-neutral-300 border-neutral-600/40', 'claim'],
  TRACKING_UPDATED:      ['bg-neutral-700/40 text-neutral-300 border-neutral-600/40', 'tracking'],
  CLAIM_CONTRADICTED:    ['bg-red-500/20 text-red-300 border-red-500/40', 'contradiction'],
  DEMAND_SPIKE:          ['bg-orange-500/15 text-orange-300 border-orange-500/30', 'demand'],
  PRIORITY_CHANGED:      ['bg-violet-500/15 text-violet-300 border-violet-500/30', 'priority'],
  DEADLINE_PULLED_IN:    ['bg-red-500/15 text-red-300 border-red-500/30', 'deadline'],
  QUALITY_FAILURE:       ['bg-red-500/15 text-red-300 border-red-500/30', 'quality'],
  EXPEDITE_UNAVAILABLE:  ['bg-neutral-700/40 text-neutral-300 border-neutral-600/40', 'logistics'],
  HAZMAT_SUPPLY_FAILURE: ['bg-red-500/20 text-red-300 border-red-500/40', 'hazmat'],
  OPTION_REJECTED:       ['bg-neutral-800 text-neutral-400 border-neutral-700', 'rejected'],
  OPTION_SELECTED:       ['bg-emerald-500/15 text-emerald-300 border-emerald-500/30', 'selected'],
  APPROVAL_REQUIRED:     ['bg-amber-500/20 text-amber-200 border-amber-500/40', 'approval'],
  MANUAL_NOTE:           ['bg-blue-500/15 text-blue-300 border-blue-500/30', 'note'],
}
const fallback = ['bg-neutral-800 text-neutral-400 border-neutral-700', 'event']

const ACTOR_DOT = {
  injector: 'bg-orange-400',
  solver:   'bg-emerald-400',
  llm:      'bg-sky-400',
  human:    'bg-blue-400',
}

function Row({ ev }) {
  const [open, setOpen] = useState(false)
  const [cls, label] = STYLES[ev.event_type] ?? fallback
  const hasPayload = ev.technical_payload && Object.keys(ev.technical_payload).length > 0

  return (
    <li className="relative pl-6">
      <span className={`absolute left-[7px] top-[9px] h-2 w-2 rounded-full ring-4 ring-neutral-950
                        ${ACTOR_DOT[ev.actor] ?? 'bg-neutral-500'}`} />
      <div className="pb-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${cls}`}>
            {label}
          </span>
          <span className="font-mono text-[11px] text-neutral-600">#{ev.sequence}</span>
          <span className="font-mono text-[11px] text-neutral-600">{ev.actor}</span>
          {ev.incident_id && (
            <span className="font-mono text-[11px] text-neutral-500">{ev.incident_id}</span>
          )}
        </div>
        <p className="mt-1 text-sm leading-relaxed text-neutral-200">{ev.human_summary}</p>
        {hasPayload && (
          <>
            <button
              onClick={() => setOpen(!open)}
              className="mt-1 text-[11px] text-neutral-600 underline-offset-2 hover:text-neutral-400 hover:underline"
            >
              {open ? 'hide' : 'show'} technical payload
            </button>
            {open && (
              <pre className="mt-1 overflow-x-auto rounded-md border border-neutral-800
                              bg-neutral-950 p-2 font-mono text-[11px] leading-relaxed text-neutral-400">
{JSON.stringify(ev.technical_payload, null, 2)}
              </pre>
            )}
          </>
        )}
      </div>
    </li>
  )
}

export default function EventTimeline({ events, status }) {
  const endRef = useRef(null)
  const [follow, setFollow] = useState(true)

  useEffect(() => {
    if (follow) endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [events.length, follow])

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-neutral-500">
          Agent timeline
        </h2>
        <div className="flex items-center gap-3">
          <span className="text-[11px] text-neutral-600">{events.length} events</span>
          <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-neutral-500">
            <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)}
                   className="accent-amber-500" />
            follow
          </label>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {events.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <p className="text-sm text-neutral-600">No events yet.</p>
            <p className="max-w-xs text-xs leading-relaxed text-neutral-700">
              {status === 'live'
                ? 'Inject a scenario from the left panel and watch it arrive here in real time.'
                : 'Waiting for the backend on :8000 — start it with ./run.sh'}
            </p>
          </div>
        ) : (
          <ul className="relative">
            <span className="absolute left-[11px] top-1 bottom-1 w-px bg-neutral-800" />
            {events.map((ev) => <Row key={ev.sequence} ev={ev} />)}
            <div ref={endRef} />
          </ul>
        )}
      </div>
    </div>
  )
}
