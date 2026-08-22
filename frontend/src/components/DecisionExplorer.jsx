import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Ban, Check, Loader2, Scale } from 'lucide-react'
import { api } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { ScrollArea } from '@/components/ui/scroll-area'

const inr = (n) => '₹' + Number(n ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })

const CONSTRAINT = {
  REQUIRED_CERTIFICATION: 'certification',
  MIN_ORDER_QUANTITY: 'MOQ',
  HAZMAT_NO_AIR: 'hazmat',
  OVER_BUDGET: 'budget',
}

function Metric({ label, value, tone }) {
  return (
    <div>
      <div className="mb-1 flex justify-between text-[10px] text-muted-foreground">
        <span>{label}</span><span className="tabular-nums">{value.toFixed(2)}</span>
      </div>
      <Progress value={value * 100} className="h-1" indicatorClassName={tone} />
    </div>
  )
}

export default function DecisionExplorer() {
  const qc = useQueryClient()
  const [poId, setPoId] = useState('PROD-882')
  const [result, setResult] = useState(null)

  const solve = useMutation({
    mutationFn: ({ id, record }) => api.solve(id, record),
    onSuccess: (r) => { setResult(r); qc.invalidateQueries({ queryKey: ['world'] }) },
  })

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2">
        <h2 className="flex items-center gap-1.5 text-xs font-semibold tracking-widest text-muted-foreground uppercase">
          <Scale className="size-3.5" /> Decision explorer
        </h2>
        <Input value={poId} onChange={(e) => setPoId(e.target.value.toUpperCase())}
          className="ml-auto h-7 w-28 font-mono text-xs" />
        <Button size="sm" variant="secondary" disabled={solve.isPending}
          onClick={() => solve.mutate({ id: poId, record: false })}>Solve</Button>
        <Button size="sm" disabled={solve.isPending}
          onClick={() => solve.mutate({ id: poId, record: true })}>
          {solve.isPending && <Loader2 className="animate-spin" />} + audit
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="p-4">
          {solve.isError && <p className="text-xs text-destructive">{solve.error.message}</p>}
          {!result && !solve.isError && (
            <p className="text-xs leading-relaxed text-muted-foreground">
              Run the deterministic solver against a production order. No LLM involved —
              this is the code path that must never violate a constraint.
            </p>
          )}

          {result && (
            <div className="flex flex-col gap-4">
              <div className="grid grid-cols-4 gap-2">
                {[['Shortfall', `${result.shortfall}u`],
                  ['Time left', `${result.days_left_display}d`],
                  ['Budget', inr(result.budget_left)],
                  ['Threshold', inr(result.approval_threshold)]].map(([k, v]) => (
                  <div key={k} className="rounded-md border bg-card px-2 py-1.5">
                    <div className="text-[10px] tracking-wide text-muted-foreground uppercase">{k}</div>
                    <div className="font-mono text-sm">{v}</div>
                  </div>
                ))}
              </div>

              {result.rejections?.length > 0 && (
                <div>
                  <h3 className="mb-1.5 flex items-center gap-1.5 text-[10px] tracking-widest text-muted-foreground uppercase">
                    <Ban className="size-3" /> Rejected — and why
                  </h3>
                  <div className="flex flex-col gap-1">
                    {result.rejections.map((r, i) => (
                      <div key={i} className="rounded-md border bg-card px-2.5 py-2">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-xs">{r.supplier_id}</span>
                          <Badge variant="outline" className="border-danger/50 bg-danger/15 text-danger">
                            {CONSTRAINT[r.constraint] ?? r.constraint}
                          </Badge>
                        </div>
                        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{r.human_reason}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <h3 className="mb-1.5 text-[10px] tracking-widest text-muted-foreground uppercase">
                  Ranked options
                </h3>
                <div className="flex flex-col gap-1.5">
                  {result.options.map((o, i) => (
                    <div key={i} className={`rounded-md border px-3 py-2
                      ${i === 0 ? 'border-ok/50 bg-ok/5' : 'bg-card'}`}>
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          {i === 0 && (
                            <Badge variant="outline" className="gap-0.5 border-ok/50 bg-ok/15 text-ok">
                              <Check className="size-2.5" />chosen
                            </Badge>
                          )}
                          <span className="text-sm">{o.label}</span>
                          <Badge variant="outline" className="font-mono text-[10px]">{o.kind}</Badge>
                        </div>
                        <div className="flex items-center gap-2">
                          {o.requires_approval && (
                            <Badge variant="outline" className="border-warn/50 bg-warn/15 text-warn">approval</Badge>
                          )}
                          <span className="font-mono text-sm tabular-nums">{o.score.toFixed(3)}</span>
                        </div>
                      </div>
                      <p className="mt-1 text-[11px] text-muted-foreground">{o.rationale}</p>
                      <div className="mt-2 grid grid-cols-3 gap-3">
                        <Metric label="continuity" value={o.continuity} tone="bg-ok" />
                        <Metric label="cost" value={o.cost_score} tone="bg-info" />
                        <Metric label="risk" value={o.risk_score} tone="bg-primary" />
                      </div>
                      {o.lines?.length > 0 && (
                        <div className="mt-2 flex flex-wrap items-center gap-1.5">
                          {o.lines.map((l, j) => (
                            <Badge key={j} variant="outline" className="font-mono text-[10px]">
                              {l.supplier_id} · {l.quantity}u · {l.mode} · {inr(l.total_cost)}
                            </Badge>
                          ))}
                          <span className="ml-auto font-mono text-[11px]">{inr(o.total_cost)}</span>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
