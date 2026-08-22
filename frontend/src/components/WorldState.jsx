import { useEffect, useState } from 'react'
import { api } from '../lib/api'

const inr = (n) => '₹' + Number(n ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })

function Tabs({ tabs, active, onChange }) {
  return (
    <div className="flex gap-1 border-b border-neutral-800 px-3 pt-2">
      {tabs.map((t) => (
        <button
          key={t}
          onClick={() => onChange(t)}
          className={`rounded-t px-3 py-2 text-xs transition-colors
            ${active === t
              ? 'border-b-2 border-amber-500 text-neutral-100'
              : 'text-neutral-500 hover:text-neutral-300'}`}
        >
          {t}
        </button>
      ))}
    </div>
  )
}

export default function WorldState({ revision }) {
  const [data, setData] = useState(null)
  const [tab, setTab] = useState('Inventory')
  const [err, setErr] = useState(null)

  useEffect(() => {
    api.world().then(setData).catch((e) => setErr(e.message))
  }, [revision])

  if (err) return <p className="p-4 text-xs text-red-400">{err}</p>
  if (!data) return <p className="p-4 text-xs text-neutral-600">Loading world…</p>

  return (
    <div className="flex h-full flex-col">
      <Tabs tabs={['Inventory', 'Orders', 'Suppliers']} active={tab} onChange={setTab} />
      <div className="min-h-0 flex-1 overflow-y-auto p-3">

        {tab === 'Inventory' && (
          <table className="w-full text-xs">
            <thead className="text-neutral-600">
              <tr className="border-b border-neutral-800">
                <th className="pb-2 text-left font-medium">Component</th>
                <th className="pb-2 text-right font-medium">ERP</th>
                <th className="pb-2 text-right font-medium">Usable</th>
                <th className="pb-2 text-right font-medium">Cover</th>
              </tr>
            </thead>
            <tbody className="text-neutral-300">
              {data.inventory.map((r) => {
                const gap = r.erp_stock !== r.usable_stock
                const cover = Number(r.coverage_days ?? 0)
                return (
                  <tr key={r.component_id} className="border-b border-neutral-900">
                    <td className="py-2">
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-neutral-400">{r.component_id}</span>
                        {r.is_hazmat && (
                          <span className="rounded bg-red-500/15 px-1 text-[9px] uppercase text-red-300">
                            hazmat
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-neutral-600">{r.name}</div>
                    </td>
                    <td className="text-right tabular-nums text-neutral-500">{r.erp_stock}</td>
                    <td className={`text-right tabular-nums ${gap ? 'text-fuchsia-300' : ''}`}>
                      {r.usable_stock}
                    </td>
                    <td className={`text-right tabular-nums
                      ${cover < 3 ? 'text-red-400' : cover < 6 ? 'text-amber-400' : 'text-neutral-400'}`}>
                      {cover.toFixed(1)}d
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}

        {tab === 'Orders' && (
          <div className="flex flex-col gap-3">
            <div>
              <h3 className="mb-1 text-[10px] uppercase tracking-widest text-neutral-600">
                Purchase orders
              </h3>
              {data.purchase_orders.map((p) => {
                const contradiction =
                  ['dispatched', 'in_transit'].includes(p.supplier_claim) &&
                  ['label_created_no_pickup', 'not_shipped'].includes(p.tracking_status)
                return (
                  <div key={p.id}
                       className={`mb-1 rounded border px-2 py-1.5 text-xs
                         ${contradiction
                           ? 'border-red-500/50 bg-red-950/30'
                           : 'border-neutral-800 bg-neutral-900/50'}`}>
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-neutral-300">{p.id}</span>
                      <span className={`rounded px-1.5 py-0.5 text-[10px] uppercase
                        ${p.status === 'delayed' ? 'bg-orange-500/20 text-orange-300'
                          : p.status === 'cancelled' ? 'bg-red-500/20 text-red-300'
                          : 'bg-neutral-800 text-neutral-400'}`}>
                        {p.status}
                      </span>
                    </div>
                    <div className="text-[11px] text-neutral-500">
                      {p.component_id} · {p.supplier_id} · {p.quantity} × {inr(p.unit_price)} = {inr(p.total_value)} · {p.mode}
                    </div>
                    {contradiction && (
                      <div className="mt-1 text-[11px] text-red-300">
                        claims “{p.supplier_claim}” · carrier “{p.tracking_status}”
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
            <div>
              <h3 className="mb-1 text-[10px] uppercase tracking-widest text-neutral-600">
                Production
              </h3>
              {data.production_orders.map((p) => (
                <div key={p.id}
                     className="mb-1 flex items-center justify-between rounded border
                                border-neutral-800 bg-neutral-900/50 px-2 py-1.5 text-xs">
                  <div>
                    <span className="font-mono text-neutral-300">{p.id}</span>
                    <span className="ml-2 text-[11px] text-neutral-500">
                      {p.required_component} × {p.units_planned * p.component_per_unit}
                    </span>
                  </div>
                  <span className={`rounded px-1.5 py-0.5 text-[10px] uppercase
                    ${p.priority === 'critical' ? 'bg-red-500/20 text-red-300'
                      : p.priority === 'high' ? 'bg-amber-500/20 text-amber-300'
                      : 'bg-neutral-800 text-neutral-400'}`}>
                    {p.priority}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === 'Suppliers' && (
          <table className="w-full text-xs">
            <thead className="text-neutral-600">
              <tr className="border-b border-neutral-800">
                <th className="pb-2 text-left font-medium">Supplier</th>
                <th className="pb-2 text-right font-medium">Rel.</th>
                <th className="pb-2 text-right font-medium">Qual.</th>
                <th className="pb-2 text-right font-medium">Flags</th>
              </tr>
            </thead>
            <tbody className="text-neutral-300">
              {data.suppliers.map((s) => {
                const rel = Number(s.derived_reliability ?? s.reliability_score)
                const flags = (s.contradictions_detected ?? 0) + (s.quality_failures ?? 0)
                return (
                  <tr key={s.id} className="border-b border-neutral-900">
                    <td className="py-2">
                      <div className="font-mono text-neutral-400">{s.id}</div>
                      <div className="text-[11px] text-neutral-600">{s.name}</div>
                    </td>
                    <td className={`text-right tabular-nums
                      ${rel < 0.5 ? 'text-red-400' : rel < 0.75 ? 'text-amber-400' : 'text-emerald-400'}`}>
                      {rel.toFixed(2)}
                    </td>
                    <td className="text-right tabular-nums text-neutral-400">
                      {Number(s.quality_score).toFixed(2)}
                    </td>
                    <td className="text-right">
                      {flags > 0
                        ? <span className="rounded bg-red-500/20 px-1.5 text-[10px] text-red-300">{flags}</span>
                        : <span className="text-neutral-700">—</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
