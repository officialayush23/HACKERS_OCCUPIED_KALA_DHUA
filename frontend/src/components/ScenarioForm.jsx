import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AnimatePresence, motion } from 'motion/react'
import { AlertTriangle, ChevronDown, Code2, Plus, Trash2 } from 'lucide-react'
import { api } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'

/**
 * Build a test case without writing JSON.
 *
 * The JSON editor stays — it is the honest, copyable representation and a judge
 * should be able to see exactly what will be fed in. But nobody should *have* to
 * compose it by hand under demo pressure, and the previous version put a raw
 * textarea in front of people and returned a 400 the moment a comma moved.
 *
 * Every field that references something real (a purchase order, a supplier, a
 * component, a production run) is a picker populated from the live world. You
 * cannot invent `PO-9999` here, which was the single largest source of
 * unrunnable custom scenarios.
 */

/** What each event needs, and where the choices come from. */
const EVENTS = {
  supplier_delay: {
    label: 'Supplier delays a shipment',
    tests: 'Baseline triage — does it notice, and recompute coverage?',
    fields: [
      { key: 'po_id', label: 'Which shipment', source: 'purchase_orders' },
      { key: 'delay_days', label: 'Slips by (days)', type: 'number', default: 5 },
    ],
  },
  inventory_correction: {
    label: 'Physical count disagrees with the ERP',
    tests: 'Does it trust the system of record, or the floor?',
    fields: [
      { key: 'component_id', label: 'Component', source: 'components' },
      { key: 'usable_stock', label: 'Actually usable', type: 'number', default: 250 },
    ],
  },
  supplier_claim: {
    label: 'Supplier claims something',
    tests: 'Sets up the contradiction — pair it with carrier tracking.',
    fields: [
      { key: 'po_id', label: 'About which shipment', source: 'purchase_orders' },
      { key: 'claim', label: 'They say', type: 'choice',
        choices: ['dispatched', 'in_transit', 'delayed', 'unable_to_supply'],
        default: 'dispatched' },
    ],
  },
  tracking_state: {
    label: 'Carrier tracking says otherwise',
    tests: 'The money beat — does it believe the supplier or the carrier?',
    fields: [
      { key: 'po_id', label: 'Which shipment', source: 'purchase_orders' },
      { key: 'tracking_status', label: 'Carrier shows', type: 'choice',
        choices: ['not_shipped', 'label_created_no_pickup', 'in_transit', 'delivered'],
        default: 'label_created_no_pickup' },
    ],
  },
  demand_spike: {
    label: 'Demand jumps',
    tests: 'Coverage shrinks without any supplier doing anything wrong.',
    fields: [
      { key: 'component_id', label: 'Component', source: 'components' },
      { key: 'daily_usage', label: 'New daily usage', type: 'number', default: 200 },
    ],
  },
  priority_change: {
    label: 'A run becomes more urgent',
    tests: 'Does the lateness penalty move with priority?',
    fields: [
      { key: 'production_order_id', label: 'Production run', source: 'production_orders' },
      { key: 'priority', label: 'New priority', type: 'choice',
        choices: ['low', 'medium', 'high', 'critical'], default: 'critical' },
    ],
  },
  deadline_pull_in: {
    label: 'Deadline is pulled in',
    tests: 'Can anything still arrive in time — and does it say so honestly?',
    fields: [
      { key: 'production_order_id', label: 'Production run', source: 'production_orders' },
      { key: 'hours_from_now', label: 'Now due in (hours)', type: 'number', default: 12 },
    ],
  },
  quality_failure: {
    label: 'Incoming inspection fails',
    tests: 'Cost versus quality — the cheap source becomes the bad source.',
    fields: [
      { key: 'supplier_id', label: 'Supplier', source: 'suppliers' },
      { key: 'new_quality_score', label: 'Quality score', type: 'number',
        step: '0.01', default: 0.48 },
    ],
  },
  supplier_reply: {
    label: 'Supplier sends a message',
    tests: 'Interpretation — write something vague and watch it refuse to guess.',
    fields: [
      { key: 'supplier_id', label: 'From', source: 'suppliers' },
      { key: 'body', label: 'What they wrote', type: 'text',
        default: 'We should be able to arrange around 400-500 units, subject to confirmation.' },
    ],
  },
  warehouse_reply: {
    label: 'Warehouse answers a count',
    tests: 'Physical reality overrides the ERP.',
    fields: [
      { key: 'component_id', label: 'Component', source: 'components' },
      { key: 'body', label: 'What they wrote', type: 'text',
        default: 'Physical count 800. 410 units on quality hold.' },
    ],
  },
  expedite_unavailable: {
    label: 'Expedited freight is unavailable',
    tests: 'Removes the easy way out.',
    fields: [
      { key: 'reason', label: 'Because', type: 'text',
        default: 'Carrier capacity exhausted' },
    ],
  },
  hazmat_disruption: {
    label: 'Hazmat routing is blocked',
    tests: 'Prohibited, not expensive — does it treat those differently?',
    fields: [{ key: 'po_id', label: 'Which shipment', source: 'purchase_orders' }],
  },
}

function defaults(type) {
  const out = {}
  for (const f of EVENTS[type]?.fields ?? []) {
    if (f.default !== undefined) out[f.key] = f.default
  }
  return out
}

export default function ScenarioForm({ value, onChange }) {
  const [showJson, setShowJson] = useState(false)
  const [jsonError, setJsonError] = useState(null)

  const { data: world } = useQuery({ queryKey: ['world'], queryFn: api.world })
  const { data: ctx } = useQuery({ queryKey: ['context'], queryFn: api.context })

  // Pickers, populated from the world that actually exists. You cannot type an
  // id that is not there — which is what made most hand-written scenarios fail.
  const options = useMemo(() => ({
    purchase_orders: (world?.purchase_orders ?? []).map((p) => ({
      value: p.id,
      label: `${p.id} · ${p.component_id} · ${p.quantity} units`,
    })),
    components: (world?.inventory ?? []).map((i) => ({
      value: i.component_id,
      label: `${i.display_name ?? i.component_id} · ${i.usable_stock} usable`,
    })),
    suppliers: (world?.suppliers ?? []).map((s) => ({
      value: s.id, label: `${s.name} · ${s.id}`,
    })),
    production_orders: (ctx?.production ?? []).map((p) => ({
      value: p.id,
      label: `${p.product_name ?? p.id} · ${p.oem_customer ?? ''}`.trim(),
    })),
  }), [world, ctx])

  const events = value ?? []
  const set = (next) => { setJsonError(null); onChange(next) }

  const add = () => {
    const type = 'supplier_delay'
    const at = events.length ? Math.max(...events.map((e) => e.at_h ?? 0)) + 4 : 0
    set([...events, { at_h: at, type, params: defaults(type) }])
  }

  const update = (i, patch) =>
    set(events.map((e, k) => (k === i ? { ...e, ...patch } : e)))

  const setType = (i, type) =>
    update(i, { type, params: defaults(type) })

  const setParam = (i, key, v) =>
    update(i, { params: { ...events[i].params, [key]: v } })

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3">
        <AnimatePresence initial={false}>
          {events.map((ev, i) => {
            const spec = EVENTS[ev.type] ?? {}
            return (
              <motion.div key={i} layout
                initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, height: 0 }}
                className="rounded-xl border p-4">

                <div className="flex flex-wrap items-center gap-2.5">
                  <Badge variant="outline" className="shrink-0 font-mono text-[10px]">
                    step {i + 1}
                  </Badge>

                  <Select value={ev.type} onValueChange={(t) => setType(i, t)}>
                    <SelectTrigger className="h-8 min-w-[16rem] flex-1 text-[12.5px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(EVENTS).map(([k, v]) => (
                        <SelectItem key={k} value={k} className="text-[12.5px]">
                          {v.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  <label className="flex shrink-0 items-center gap-1.5">
                    <span className="text-muted-foreground text-[11px]">at</span>
                    <Input type="number" min={0} value={ev.at_h ?? 0}
                           onChange={(e) => update(i, {
                             at_h: Math.max(0, Number(e.target.value) || 0) })}
                           className="h-8 w-16 font-mono text-[12.5px]" />
                    <span className="text-muted-foreground text-[11px]">h</span>
                  </label>

                  <Button variant="ghost" size="icon"
                          onClick={() => set(events.filter((_, k) => k !== i))}
                          className="text-muted-foreground hover:text-danger size-8 shrink-0">
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>

                {spec.tests && (
                  <p className="text-muted-foreground mt-2 text-[11.5px] leading-relaxed">
                    {spec.tests}
                  </p>
                )}

                <div className="mt-3.5 flex flex-wrap gap-3">
                  {(spec.fields ?? []).map((f) => {
                    const v = ev.params?.[f.key] ?? ''
                    const choices = f.source ? options[f.source] ?? []
                                             : (f.choices ?? []).map((c) => ({ value: c, label: c }))
                    if (f.type === 'text') {
                      return (
                        <label key={f.key} className="flex w-full flex-col gap-1.5">
                          <span className="text-muted-foreground text-[10px] font-medium
                                           tracking-[0.1em] uppercase">{f.label}</span>
                          <Textarea rows={2} value={v}
                                    onChange={(e) => setParam(i, f.key, e.target.value)}
                                    className="text-[12.5px]" />
                        </label>
                      )
                    }
                    if (f.type === 'number') {
                      return (
                        <label key={f.key} className="flex flex-col gap-1.5">
                          <span className="text-muted-foreground text-[10px] font-medium
                                           tracking-[0.1em] uppercase">{f.label}</span>
                          <Input type="number" step={f.step} value={v}
                                 onChange={(e) => setParam(i, f.key, Number(e.target.value))}
                                 className="h-9 w-32 font-mono text-[12.5px]" />
                        </label>
                      )
                    }
                    return (
                      <label key={f.key} className="flex min-w-[13rem] flex-1 flex-col gap-1.5">
                        <span className="text-muted-foreground text-[10px] font-medium
                                         tracking-[0.1em] uppercase">{f.label}</span>
                        <Select value={String(v)} onValueChange={(x) => setParam(i, f.key, x)}>
                          <SelectTrigger className="h-9 text-[12.5px]">
                            <SelectValue placeholder={
                              choices.length ? 'choose one' : 'nothing available'} />
                          </SelectTrigger>
                          <SelectContent>
                            {choices.map((c) => (
                              <SelectItem key={c.value} value={String(c.value)}
                                          className="text-[12.5px]">{c.label}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </label>
                    )
                  })}
                </div>
              </motion.div>
            )
          })}
        </AnimatePresence>

        <Button variant="outline" onClick={add} className="h-10 border-dashed">
          <Plus className="size-4" />Add a step
        </Button>

        {events.length === 0 && (
          <p className="text-muted-foreground text-center text-[12px] leading-relaxed">
            A scenario is a list of things that happen, in simulated time.
            One real second is one simulated hour.
          </p>
        )}
      </div>

      {/* the same thing, as JSON — for anyone who wants to check or paste */}
      <div>
        <Button variant="ghost" size="sm" onClick={() => setShowJson((v) => !v)}
                className="text-muted-foreground h-8 gap-1.5 px-2 text-[11.5px]">
          <Code2 className="size-3.5" />
          {showJson ? 'Hide the JSON' : 'Show it as JSON'}
          <ChevronDown className={`size-3 transition-transform
            ${showJson ? '' : '-rotate-90'}`} />
        </Button>

        <AnimatePresence>
          {showJson && (
            <motion.div initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
              <Textarea
                rows={12} spellCheck={false}
                value={JSON.stringify(events, null, 2)}
                onChange={(e) => {
                  try {
                    const parsed = JSON.parse(e.target.value)
                    if (!Array.isArray(parsed)) throw new Error('expected a list of events')
                    set(parsed)
                  } catch (err) {
                    setJsonError(err.message)
                  }
                }}
                className="mt-2 font-mono text-[11.5px] leading-relaxed" />
              {jsonError && (
                <p className="text-danger mt-2 flex items-start gap-1.5 text-[11.5px]">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                  {jsonError} — the form above still holds the last valid version.
                </p>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}
