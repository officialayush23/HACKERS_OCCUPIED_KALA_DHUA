import { useEffect, useState } from 'react'
import { api } from '../lib/api'

const EVENT_HINTS = {
  supplier_delay:        '{"po_id":"PO-7712","delay_days":5}',
  inventory_correction:  '{"component_id":"COMP-104","usable_stock":250}',
  supplier_claim:        '{"po_id":"PO-7712","claim":"dispatched"}',
  tracking_state:        '{"po_id":"PO-7712","tracking_status":"label_created_no_pickup"}',
  demand_spike:          '{"component_id":"COMP-104","daily_usage":180}',
  priority_change:       '{"production_order_id":"PROD-882","priority":"critical"}',
  deadline_pull_in:      '{"production_order_id":"PROD-882","hours_from_now":12}',
  quality_failure:       '{"supplier_id":"SUP-18","new_quality_score":0.48}',
  expedite_unavailable:  '{"reason":"Carrier capacity exhausted"}',
  hazmat_disruption:     '{"po_id":"PO-7718"}',
}

function Btn({ children, onClick, busy, tone = 'default', className = '', ...rest }) {
  const tones = {
    default: 'bg-neutral-800 hover:bg-neutral-700 text-neutral-100 border-neutral-700',
    primary: 'bg-amber-500 hover:bg-amber-400 text-neutral-950 border-amber-400 font-medium',
    danger:  'bg-neutral-900 hover:bg-red-900/40 text-red-300 border-red-900/60',
  }
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className={`rounded-md border px-3 py-2 text-sm transition-colors
                  disabled:opacity-40 disabled:cursor-not-allowed ${tones[tone]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  )
}

export default function ControlPanel({ onActivity }) {
  const [scenarios, setScenarios] = useState([])
  const [eventTypes, setEventTypes] = useState([])
  const [running, setRunning] = useState([])
  const [busy, setBusy] = useState(null)
  const [err, setErr] = useState(null)

  const [customType, setCustomType] = useState('supplier_delay')
  const [customParams, setCustomParams] = useState(EVENT_HINTS.supplier_delay)
  const [note, setNote] = useState('')

  const load = () =>
    api.scenarios()
      .then((d) => { setScenarios(d.scenarios); setEventTypes(d.event_types); setRunning(d.running) })
      .catch((e) => setErr(e.message))

  useEffect(() => { load() }, [])

  const guard = async (key, fn) => {
    setBusy(key); setErr(null)
    try { await fn(); await load(); onActivity?.() }
    catch (e) { setErr(e.message) }
    finally { setBusy(null) }
  }

  return (
    <div className="flex flex-col gap-5">
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-neutral-500">
            Inject disruption
          </h2>
          <Btn tone="danger" busy={busy === 'reset'}
               onClick={() => guard('reset', api.reset)}>
            Reset world
          </Btn>
        </div>

        <div className="flex flex-col gap-2">
          {scenarios.map((s) => {
            const isRunning = running.includes(s.id)
            return (
              <button
                key={s.id}
                disabled={!!busy || isRunning}
                onClick={() => guard(s.id, () => api.inject(s.id))}
                className="group rounded-lg border border-neutral-800 bg-neutral-900/60 p-3
                           text-left transition-colors hover:border-amber-500/50
                           hover:bg-neutral-900 disabled:opacity-50"
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="text-sm font-medium text-neutral-100">{s.title}</span>
                  <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide
                    ${isRunning ? 'bg-amber-500/20 text-amber-300' : 'bg-neutral-800 text-neutral-500'}`}>
                    {isRunning ? 'running' : s.id.split('-')[0]}
                  </span>
                </div>
                <p className="mt-1 text-xs leading-relaxed text-neutral-500">{s.tests}</p>
                <p className="mt-1 text-[11px] text-neutral-600">
                  {s.event_count} events over {s.span_sim_hours}h simulated
                </p>
              </button>
            )
          })}
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-widest text-neutral-500">
          Custom event
        </h2>
        <select
          value={customType}
          onChange={(e) => { setCustomType(e.target.value); setCustomParams(EVENT_HINTS[e.target.value] ?? '{}') }}
          className="mb-2 w-full rounded-md border border-neutral-800 bg-neutral-900 px-2 py-2
                     text-sm text-neutral-200 outline-none focus:border-amber-500/60"
        >
          {eventTypes.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <textarea
          rows={3}
          value={customParams}
          onChange={(e) => setCustomParams(e.target.value)}
          spellCheck={false}
          className="w-full resize-none rounded-md border border-neutral-800 bg-neutral-950
                     px-2 py-2 font-mono text-xs text-neutral-300 outline-none
                     focus:border-amber-500/60"
        />
        <Btn
          tone="primary"
          className="mt-2 w-full"
          busy={busy === 'custom'}
          onClick={() => guard('custom', async () => {
            let params
            try { params = JSON.parse(customParams) }
            catch { throw new Error('Params must be valid JSON') }
            await api.customEvent({ type: customType, params })
          })}
        >
          Fire event
        </Btn>
      </section>

      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-widest text-neutral-500">
          Manual log
        </h2>
        <div className="flex gap-2">
          <input
            value={note}
            placeholder="Type a note into the audit trail…"
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && note.trim()) {
                guard('log', () => api.log(note.trim())).then(() => setNote(''))
              }
            }}
            className="min-w-0 flex-1 rounded-md border border-neutral-800 bg-neutral-950 px-2 py-2
                       text-sm text-neutral-200 outline-none placeholder:text-neutral-600
                       focus:border-amber-500/60"
          />
          <Btn
            busy={busy === 'log' || !note.trim()}
            onClick={() => guard('log', () => api.log(note.trim())).then(() => setNote(''))}
          >
            Add
          </Btn>
        </div>
      </section>

      {err && (
        <p className="rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-300">
          {err}
        </p>
      )}
    </div>
  )
}
