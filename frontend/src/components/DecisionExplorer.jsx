import { useState } from 'react'
import { api } from '../lib/api'

const inr = (n) => '₹' + Number(n ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })

const CONSTRAINT_LABEL = {
  REQUIRED_CERTIFICATION: 'certification',
  MIN_ORDER_QUANTITY: 'MOQ',
  HAZMAT_NO_AIR: 'hazmat',
  OVER_BUDGET: 'budget',
}

function Bar({ value, tone }) {
  return (
    <div className="h-1 w-full overflow-hidden rounded-full bg-neutral-800">
      <div className={`h-full rounded-full ${tone}`} style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
    </div>
  )
}

export default function DecisionExplorer({ onRecorded }) {
  const [poId, setPoId] = useState('PROD-882')
  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  const run = async (record) => {
    setBusy(true); setErr(null)
    try {
      const r = await api.solve(poId, record)
      setResult(r)
      if (record) onRecorded?.()
    } catch (e) { setErr(e.message) }
    finally { setBusy(false) }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-neutral-800 px-4 py-2.5">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-neutral-500">
          Decision explorer
        </h2>
        <input
          value={poId}
          onChange={(e) => setPoId(e.target.value.toUpperCase())}
          className="ml-auto w-28 rounded border border-neutral-800 bg-neutral-950 px-2 py-1
                     font-mono text-xs text-neutral-300 outline-none focus:border-amber-500/60"
        />
        <button onClick={() => run(false)} disabled={busy}
          className="rounded border border-neutral-700 bg-neutral-800 px-2.5 py-1 text-xs
                     text-neutral-200 hover:bg-neutral-700 disabled:opacity-40">
          Solve
        </button>
        <button onClick={() => run(true)} disabled={busy}
          className="rounded border border-amber-400 bg-amber-500 px-2.5 py-1 text-xs font-medium
                     text-neutral-950 hover:bg-amber-400 disabled:opacity-40">
          Solve + audit
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {err && <p className="text-xs text-red-400">{err}</p>}
        {!result && !err && (
          <p className="text-xs text-neutral-600">
            Run the deterministic solver against a production order. No LLM involved —
            this is the code path that must never violate a constraint.
          </p>
        )}

        {result && (
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-4 gap-2">
              {[
                ['Shortfall', `${result.shortfall} units`],
                ['Time left', `${result.days_left_display}d`],
                ['Budget left', inr(result.budget_left)],
                ['Threshold', inr(result.approval_threshold)],
              ].map(([k, v]) => (
                <div key={k} className="rounded border border-neutral-800 bg-neutral-900/60 px-2 py-1.5">
                  <div className="text-[10px] uppercase tracking-wide text-neutral-600">{k}</div>
                  <div className="font-mono text-sm text-neutral-200">{v}</div>
                </div>
              ))}
            </div>

            {result.rejections?.length > 0 && (
              <div>
                <h3 className="mb-1.5 text-[10px] uppercase tracking-widest text-neutral-600">
                  Rejected — and why
                </h3>
                <div className="flex flex-col gap-1">
                  {result.rejections.map((r, i) => (
                    <div key={i} className="rounded border border-neutral-800 bg-neutral-950 px-2.5 py-2">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs text-neutral-400">{r.supplier_id}</span>
                        <span className="rounded bg-red-500/15 px-1.5 py-0.5 text-[10px] uppercase text-red-300">
                          {CONSTRAINT_LABEL[r.constraint] ?? r.constraint}
                        </span>
                      </div>
                      <p className="mt-1 text-xs leading-relaxed text-neutral-400">{r.human_reason}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div>
              <h3 className="mb-1.5 text-[10px] uppercase tracking-widest text-neutral-600">
                Ranked options
              </h3>
              <div className="flex flex-col gap-1.5">
                {result.options.map((o, i) => (
                  <div key={i}
                       className={`rounded border px-3 py-2
                         ${i === 0 ? 'border-emerald-500/40 bg-emerald-950/20'
                                   : 'border-neutral-800 bg-neutral-900/40'}`}>
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        {i === 0 && (
                          <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px]
                                           uppercase text-emerald-300">chosen</span>
                        )}
                        <span className="text-sm text-neutral-200">{o.label}</span>
                        <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px]
                                         uppercase text-neutral-500">{o.kind}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        {o.requires_approval && (
                          <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px]
                                           uppercase text-amber-300">approval</span>
                        )}
                        <span className="font-mono text-sm text-neutral-300">{o.score.toFixed(3)}</span>
                      </div>
                    </div>
                    <p className="mt-1 text-[11px] text-neutral-500">{o.rationale}</p>
                    <div className="mt-2 grid grid-cols-3 gap-3">
                      {[['continuity', o.continuity, 'bg-emerald-500'],
                        ['cost', o.cost_score, 'bg-sky-500'],
                        ['risk', o.risk_score, 'bg-violet-500']].map(([k, v, tone]) => (
                        <div key={k}>
                          <div className="mb-1 flex justify-between text-[10px] text-neutral-600">
                            <span>{k}</span><span className="tabular-nums">{v.toFixed(2)}</span>
                          </div>
                          <Bar value={v} tone={tone} />
                        </div>
                      ))}
                    </div>
                    {o.lines?.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {o.lines.map((l, j) => (
                          <span key={j} className="rounded border border-neutral-800 bg-neutral-950
                                                   px-1.5 py-0.5 font-mono text-[10px] text-neutral-400">
                            {l.supplier_id} · {l.quantity}u · {l.mode} · {inr(l.total_cost)}
                          </span>
                        ))}
                        <span className="ml-auto font-mono text-[11px] text-neutral-300">
                          {inr(o.total_cost)}
                        </span>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
