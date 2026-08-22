import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AnimatePresence, motion } from 'motion/react'
import {
  AlertTriangle, ArrowRight, CheckCircle2, ClipboardCheck, Loader2, PackageCheck,
  Truck, Undo2,
} from 'lucide-react'
import { api } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'

/**
 * The warehouse floor.
 *
 * The person reading this screen is holding a scanner, not running the company.
 * They do not need weighted scores, supplier risk, or an audit trail — they need
 * to know what to physically go and check, type what they actually found, and
 * see that it landed.
 *
 * Three rules this screen follows and the previous version broke:
 *
 *   1. **Never show a number that looks typed but isn't.** The old form used the
 *      system's values as *placeholders*, so a filled-looking form submitted
 *      nothing and the button stayed disabled for no visible reason. Fields are
 *      now prefilled with real values.
 *   2. **A count cannot be negative.** Obvious, and the old numeric stepper
 *      happily went to -2.
 *   3. **Say what the submission changed.** An operator who types a number and
 *      gets no consequence back has no reason to believe the system heard them.
 */

const TASK_LABEL = {
  physical_count:            'Count the physical stock',
  usable_stock_verification: 'Confirm what is actually usable',
  quality_hold_check:        'Check what is on quality hold',
  release_stock:             'Release stock from hold',
  receive_shipment:          'Receive a shipment',
  verify_lot:                'Verify a lot',
  expedite_unloading:        'Expedite unloading',
}

/** A number field that cannot go below zero and never lies about being filled. */
function Count({ label, value, onChange, hint }) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="text-muted-foreground text-[10px] font-medium tracking-[0.12em] uppercase">
        {label}
      </span>
      <Input
        type="number" min={0} inputMode="numeric"
        value={value}
        onChange={(e) => {
          const n = e.target.value
          if (n === '') return onChange('')
          onChange(String(Math.max(0, Math.floor(Number(n) || 0))))
        }}
        className="h-10 w-28 font-mono text-[15px] tabular-nums" />
      {hint && <span className="text-muted-foreground text-[10.5px]">{hint}</span>}
    </label>
  )
}

/** What the operator's numbers will do, before they commit them. */
function Consequence({ children, tone = 'info' }) {
  const cls = tone === 'danger' ? 'border-danger/40 bg-danger/[0.07] text-danger'
            : tone === 'ok'     ? 'border-ok/40 bg-ok/[0.07]'
                                : 'border-info/40 bg-info/[0.06]'
  return (
    <div className={`mt-4 flex items-start gap-2 rounded-lg border px-3 py-2.5
                     text-[12px] leading-relaxed ${cls}`}>
      <ArrowRight className="mt-0.5 size-3.5 shrink-0 opacity-70" />
      <span>{children}</span>
    </div>
  )
}

function TaskCard({ task, inventory, onDone, pending }) {
  const stock = inventory.find((i) => i.component_id === task.component_id)
  const [usable, setUsable] = useState('')
  const [held, setHeld] = useState('')

  // Prefill from what the system currently believes, so the operator is
  // correcting a number rather than inventing one.
  useEffect(() => {
    if (stock && usable === '') setUsable(String(stock.usable_stock ?? 0))
    if (stock && held === '') setHeld(String(stock.quarantined_stock ?? 0))
  }, [stock])   // eslint-disable-line react-hooks/exhaustive-deps

  const erp = stock?.erp_stock ?? null
  const was = stock?.usable_stock ?? null
  const now = usable === '' ? null : Number(usable)
  const delta = now != null && was != null ? now - was : null
  const ready = usable !== '' && !Number.isNaN(Number(usable))

  return (
    <Card className="gap-0 py-0">
      <div className="p-6">
        <div className="flex flex-wrap items-center gap-2.5">
          {task.priority === 'urgent' && (
            <Badge variant="outline" className="border-danger/50 bg-danger/15 text-danger
                                                text-[10px]">urgent</Badge>
          )}
          <span className="text-[16px] font-semibold tracking-tight">
            {TASK_LABEL[task.task_type] ?? task.task_type.replace(/_/g, ' ')}
          </span>
          <Badge variant="outline" className="ml-auto text-[10.5px]">
            {task.component_name ?? task.component_id}
          </Badge>
        </div>

        <p className="text-muted-foreground mt-3 text-[13.5px] leading-relaxed">
          {task.instructions}
        </p>

        {erp != null && (
          <div className="mt-5 flex flex-wrap items-center gap-8">
            <div>
              <div className="text-muted-foreground text-[10px] font-medium
                              tracking-[0.12em] uppercase">System thinks</div>
              <div className="mt-1 font-mono text-[22px] leading-none tabular-nums">{erp}</div>
              <div className="text-muted-foreground mt-1.5 text-[11px]">on the ERP</div>
            </div>
            <span className="text-muted-foreground/50">vs</span>
            <div>
              <div className="text-muted-foreground text-[10px] font-medium
                              tracking-[0.12em] uppercase">You found</div>
              <div className="mt-1 font-mono text-[22px] leading-none tabular-nums text-primary">
                {now ?? '—'}
              </div>
              <div className="text-muted-foreground mt-1.5 text-[11px]">physically usable</div>
            </div>
          </div>
        )}

        <div className="mt-6 flex flex-wrap items-end gap-6">
          <Count label="Usable" value={usable} onChange={setUsable}
                 hint="what can go on the line" />
          <Count label="On quality hold" value={held} onChange={setHeld}
                 hint="present but unusable" />

          <Button size="lg" disabled={!ready || pending}
                  onClick={() => onDone(task, {
                    usable_stock: Number(usable),
                    quarantined_stock: Number(held || 0),
                    reason: 'Physical count by warehouse',
                  })}
                  className="h-10">
            {pending && <Loader2 className="size-4 animate-spin" />}
            Submit count
          </Button>
        </div>

        {ready && delta != null && (
          <Consequence tone={delta < 0 ? 'danger' : delta > 0 ? 'ok' : 'info'}>
            {delta === 0 ? (
              <>Confirms the current figure of <b>{was}</b>. The agent stops waiting and
                 carries on with the plan it already has.</>
            ) : delta < 0 ? (
              <>Cuts usable stock by <b>{Math.abs(delta)}</b> units. The agent will recalculate
                 the shortage and may need to buy more — it will tell you if that crosses its
                 spending limit.</>
            ) : (
              <>Adds <b>{delta}</b> usable units. The agent will recalculate and may be able to
                 buy less, or nothing at all.</>
            )}
          </Consequence>
        )}
      </div>
    </Card>
  )
}

function InboundCard({ po, onReceive, pending }) {
  const [open, setOpen] = useState(false)
  const [recv, setRecv] = useState(String(po.quantity ?? 0))
  const [passed, setPassed] = useState(String(po.quantity ?? 0))

  const rejected = Math.max(0, Number(recv || 0) - Number(passed || 0))
  const lying = ['dispatched', 'in_transit'].includes(po.supplier_claim) &&
    ['label_created_no_pickup', 'not_shipped'].includes(po.tracking_status)

  return (
    <Card className="gap-0 py-0">
      <div className="p-5">
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="text-[14.5px] font-medium">{po.component_name}</span>
          <span className="text-muted-foreground text-[12.5px]">
            {po.quantity} units · {po.supplier_name}
          </span>
          <Badge variant="outline" className={`ml-auto text-[10.5px] ${
            po.status === 'delayed' ? 'border-warn/50 bg-warn/15 text-warn' : ''}`}>
            {po.status}
          </Badge>
        </div>

        <div className="text-muted-foreground mt-1.5 font-mono text-[11px]">{po.id}</div>

        {lying && (
          <div className="border-danger/40 bg-danger/[0.07] text-danger mt-3 flex items-start
                          gap-2 rounded-lg border px-3 py-2 text-[12px] leading-relaxed">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            The supplier says this shipped. The carrier says it never moved. Do not expect it —
            count what actually arrives.
          </div>
        )}

        {!open ? (
          <Button variant="secondary" size="sm" onClick={() => setOpen(true)}
                  className="mt-4 h-9 text-[12.5px]">
            <PackageCheck className="size-4" />Mark received
          </Button>
        ) : (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}
                      className="overflow-hidden">
            <div className="mt-5 flex flex-wrap items-end gap-6">
              <Count label="Received" value={recv} onChange={setRecv} hint="units in the door" />
              <Count label="Passed inspection" value={passed} onChange={setPassed}
                     hint="fit for the line" />
              <div className="min-w-0">
                <div className="text-muted-foreground text-[10px] font-medium
                                tracking-[0.12em] uppercase">Rejected</div>
                <div className={`mt-1 font-mono text-[22px] leading-none tabular-nums
                  ${rejected > 0 ? 'text-danger' : ''}`}>{rejected}</div>
                <div className="text-muted-foreground mt-1.5 text-[10.5px]">calculated</div>
              </div>

              <Button size="lg" disabled={pending || recv === ''}
                      onClick={() => onReceive(po, {
                        po_id: po.id,
                        quantity_received: Number(recv),
                        quantity_approved: Number(passed || 0),
                      })}
                      className="h-10">
                {pending && <Loader2 className="size-4 animate-spin" />}
                Confirm receipt
              </Button>

              <Button variant="ghost" size="sm" onClick={() => setOpen(false)}
                      className="text-muted-foreground h-9">
                <Undo2 className="size-3.5" />cancel
              </Button>
            </div>

            <Consequence tone={rejected > 0 ? 'danger' : 'ok'}>
              {rejected > 0
                ? <>Only <b>{passed}</b> units reach usable stock. The other {rejected} go on
                    quality hold, the shortage reopens, and the supplier's reliability drops.</>
                : <>All <b>{passed}</b> units become usable stock. If that covers the shortage the
                    agent closes the incident, and this supplier's reliability goes up.</>}
            </Consequence>
          </motion.div>
        )}
      </div>
    </Card>
  )
}

export default function WarehouseOps({ revision }) {
  const qc = useQueryClient()
  const [receipt, setReceipt] = useState(null)   // the last thing that happened

  const { data } = useQuery({
    queryKey: ['warehouse', revision], queryFn: api.warehouse, refetchInterval: 4000 })

  const done = () => qc.invalidateQueries()

  const complete = useMutation({
    mutationFn: ({ id, body }) => api.completeTask(id, body),
    onSuccess: (_r, v) => { setReceipt(v.receipt); done() },
  })
  const receive = useMutation({
    mutationFn: ({ body }) => api.receive(body),
    onSuccess: (_r, v) => { setReceipt(v.receipt); done() },
  })

  const tasks = (data?.tasks ?? []).filter((t) => ['open', 'in_progress'].includes(t.status))
  const inv = data?.inventory ?? []
  const inbound = (data?.inbound ?? []).filter((p) => p.status !== 'delivered')

  return (
    <div className="grid h-full grid-cols-12">
      {/* the operator's whole job */}
      <ScrollArea className="col-span-8 min-h-0 border-r">
        <div className="flex flex-col gap-8 p-8">

          <AnimatePresence>
            {receipt && (
              <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0 }}
                          className="border-ok/40 bg-ok/[0.07] flex items-start gap-2.5
                                     rounded-xl border px-4 py-3.5">
                <CheckCircle2 className="text-ok mt-0.5 size-4 shrink-0" />
                <div className="min-w-0">
                  <p className="text-[13.5px] leading-relaxed">{receipt}</p>
                  <button onClick={() => setReceipt(null)}
                          className="text-muted-foreground mt-1 text-[11px] underline">
                    dismiss
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <div>
            <div className="flex items-center gap-3">
              <ClipboardCheck className={`size-4 ${tasks.length ? 'text-warn' : 'text-ok'}`} />
              <h2 className="text-[19px] font-semibold tracking-tight">
                {tasks.length ? `${tasks.length} thing${tasks.length > 1 ? 's' : ''} to check`
                              : 'Nothing to check'}
              </h2>
            </div>
            <p className="text-muted-foreground mt-2 text-[13px] leading-relaxed">
              {tasks.length
                ? 'The agent will not act on a number it has not had confirmed on the floor.'
                : 'The agent has everything it asked for. New requests appear here.'}
            </p>
          </div>

          <div className="flex flex-col gap-5">
            {tasks.map((t) => (
              <TaskCard key={t.id} task={t} inventory={inv} pending={complete.isPending}
                        onDone={(task, body) => complete.mutate({
                          id: task.id, body,
                          receipt: `Counted ${body.usable_stock} usable ${
                            task.component_name ?? task.component_id}. The agent has it.`,
                        })} />
            ))}
          </div>

          {inbound.length > 0 && (
            <>
              <Separator />
              <div>
                <div className="flex items-center gap-3">
                  <Truck className="text-muted-foreground size-4" />
                  <h2 className="text-[19px] font-semibold tracking-tight">Arriving</h2>
                </div>
                <p className="text-muted-foreground mt-2 text-[13px] leading-relaxed">
                  Count what turns up. Received is not the same as usable.
                </p>
              </div>

              <div className="flex flex-col gap-5">
                {inbound.map((p) => (
                  <InboundCard key={p.id} po={p} pending={receive.isPending}
                               onReceive={(po, body) => receive.mutate({
                                 body,
                                 receipt: `Received ${body.quantity_received} ${
                                   po.component_name}, ${body.quantity_approved} passed. `
                                   + 'Stock updated and the agent has been told.',
                               })} />
                ))}
              </div>
            </>
          )}
        </div>
      </ScrollArea>

      {/* the shelf, as a fact — no scores, no risk, no jargon */}
      <div className="glass-panel col-span-4 min-h-0">
        <div className="border-b px-6 py-5">
          <h2 className="text-muted-foreground text-[10px] font-medium
                         tracking-[0.14em] uppercase">Stock on the floor</h2>
        </div>
        <ScrollArea className="h-[calc(100%-4.5rem)]">
          <div className="flex flex-col gap-1 p-4">
            {inv.map((r) => {
              const gap = (r.erp_stock ?? 0) - (r.usable_stock ?? 0)
              const cover = r.daily_usage > 0 ? r.usable_stock / r.daily_usage : null
              return (
                <div key={r.component_id} className="rounded-lg px-3 py-3.5">
                  <div className="flex items-baseline gap-2">
                    <span className="truncate text-[13.5px] font-medium">
                      {r.display_name ?? r.component_id}
                    </span>
                    <span className={`ml-auto shrink-0 font-mono text-[17px] tabular-nums
                      ${cover != null && cover < 3 ? 'text-danger'
                        : cover != null && cover < 6 ? 'text-warn' : ''}`}>
                      {r.usable_stock}
                    </span>
                  </div>
                  <div className="text-muted-foreground mt-1 flex items-center gap-2
                                  text-[11px]">
                    <span>usable</span>
                    {cover != null && <span>· {cover.toFixed(1)} days of cover</span>}
                    {gap > 0 && (
                      <span className="text-warn ml-auto">ERP says {r.erp_stock}</span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}
