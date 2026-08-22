import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AnimatePresence, motion } from 'motion/react'
import {
  AlertTriangle, ArrowRight, CheckCircle2, ClipboardCheck, Loader2, PackageCheck,
  Truck, Warehouse as WarehouseIcon, Wifi, WifiOff,
} from 'lucide-react'
import { api, WS_URL } from '@/lib/api'
import { refresh } from '@/lib/refresh'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Textarea } from '@/components/ui/textarea'

/**
 * The Warehouse Portal — a separate actor, at its own URL.
 *
 * This is the point of the whole thing. Until now the agent "got" a stock figure
 * because the demo handed it one. Here it has to *ask a different human at a
 * different screen*, and wait. Open this in a second window next to the
 * operations dashboard and the loop becomes something a judge can physically
 * test rather than something we assert.
 *
 * The agent never writes to warehouse truth. It raises a task; the operator
 * answers; the answer becomes evidence; the world updates; the agent observes.
 * An agent that could set `usable_stock` itself would be pretending.
 *
 * Deliberately plainer than the operations dashboard. One question: what do I
 * need to do right now?
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

function Count({ label, value, onChange, hint, big }) {
  return (
    <label className="flex min-w-0 flex-col gap-2">
      <span className="text-muted-foreground text-[11px] font-medium
                       tracking-[0.1em] uppercase">{label}</span>
      <Input type="number" min={0} inputMode="numeric" value={value}
        onChange={(e) => {
          const n = e.target.value
          if (n === '') return onChange('')
          onChange(String(Math.max(0, Math.floor(Number(n) || 0))))
        }}
        className={`font-mono tabular-nums ${big ? 'h-14 w-36 text-[24px]'
                                                 : 'h-12 w-32 text-[19px]'}`} />
      {hint && <span className="text-muted-foreground text-[11.5px]">{hint}</span>}
    </label>
  )
}

function TaskCard({ task, stock, onSubmit, pending }) {
  const [usable, setUsable] = useState('')
  const [held, setHeld] = useState('')
  const [note, setNote] = useState('')

  useEffect(() => {
    if (stock && usable === '') setUsable(String(stock.usable_stock ?? 0))
    if (stock && held === '') setHeld(String(stock.quarantined_stock ?? 0))
  }, [stock])   // eslint-disable-line react-hooks/exhaustive-deps

  const erp = stock?.erp_stock ?? null
  const was = stock?.usable_stock ?? null
  const now = usable === '' ? null : Number(usable)
  const gap = erp != null && now != null ? erp - now : null
  const ready = usable !== ''

  return (
    <Card className="gap-0 border-warn/40 py-0">
      <div className="p-8">
        <div className="flex flex-wrap items-center gap-3">
          {task.priority === 'urgent' && (
            <Badge variant="outline"
                   className="border-danger/50 bg-danger/15 text-danger text-[11px]">
              urgent
            </Badge>
          )}
          <h2 className="text-[22px] font-semibold tracking-tight">
            {TASK_LABEL[task.task_type] ?? task.task_type.replace(/_/g, ' ')}
          </h2>
        </div>

        <p className="mt-3 text-[16px] font-medium">
          {task.component_name ?? task.component_id}
        </p>
        <p className="text-muted-foreground mt-2 text-[14px] leading-relaxed">
          {task.instructions}
        </p>

        {erp != null && (
          <div className="bg-muted/30 mt-7 flex flex-wrap items-center gap-10 rounded-xl
                          px-6 py-5">
            <div>
              <div className="text-muted-foreground text-[11px] font-medium
                              tracking-[0.1em] uppercase">The system says</div>
              <div className="mt-1.5 font-mono text-[30px] leading-none tabular-nums">{erp}</div>
            </div>
            <ArrowRight className="text-muted-foreground/50 size-5" />
            <div>
              <div className="text-muted-foreground text-[11px] font-medium
                              tracking-[0.1em] uppercase">You are counting</div>
              <div className="text-primary mt-1.5 font-mono text-[30px] leading-none
                              tabular-nums">{now ?? '—'}</div>
            </div>
            {gap != null && gap !== 0 && (
              <div className="border-warn/40 bg-warn/10 text-warn ml-auto rounded-lg border
                              px-3 py-2 text-[12.5px]">
                {gap > 0 ? `system is over by ${gap}` : `system is under by ${-gap}`}
              </div>
            )}
          </div>
        )}

        <div className="mt-8 flex flex-wrap items-end gap-8">
          <Count label="Usable" value={usable} onChange={setUsable} big
                 hint="fit to go on the line" />
          <Count label="On quality hold" value={held} onChange={setHeld}
                 hint="present but unusable" />
        </div>

        <label className="mt-6 flex flex-col gap-2">
          <span className="text-muted-foreground text-[11px] font-medium
                           tracking-[0.1em] uppercase">Anything worth saying</span>
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2}
                    placeholder="e.g. 410 units failed the last quality inspection"
                    className="text-[13.5px]" />
        </label>

        {ready && was != null && now !== was && (
          <div className={`mt-5 flex items-start gap-2.5 rounded-lg border px-4 py-3
                           text-[13px] leading-relaxed ${now < was
                             ? 'border-danger/40 bg-danger/[0.07]'
                             : 'border-ok/40 bg-ok/[0.07]'}`}>
            <ArrowRight className="mt-0.5 size-4 shrink-0 opacity-70" />
            <span>
              {now < was
                ? <>This tells the agent there are <b>{was - now} fewer</b> usable units than
                    it believed. It will recalculate the shortage immediately.</>
                : <>This tells the agent there are <b>{now - was} more</b> usable units than
                    it believed. It may be able to buy less.</>}
            </span>
          </div>
        )}

        <Button size="lg" disabled={!ready || pending}
                onClick={() => onSubmit(task, {
                  usable_stock: Number(usable),
                  quarantined_stock: Number(held || 0),
                  reason: note.trim() || 'Physical count by warehouse',
                })}
                className="mt-7 h-12 px-8 text-[15px]">
          {pending && <Loader2 className="size-4 animate-spin" />}
          Send to the agent
        </Button>
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
      <div className="p-7">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-[17px] font-semibold tracking-tight">{po.component_name}</span>
          <Badge variant="outline" className={`text-[11px] ${
            po.status === 'delayed' ? 'border-warn/50 bg-warn/15 text-warn' : ''}`}>
            {po.status}
          </Badge>
        </div>
        <p className="text-muted-foreground mt-1.5 text-[13.5px]">
          {po.quantity} units from {po.supplier_name} · <span className="font-mono">{po.id}</span>
        </p>

        {lying && (
          <div className="border-danger/40 bg-danger/[0.07] text-danger mt-4 flex items-start
                          gap-2 rounded-lg border px-4 py-3 text-[13px] leading-relaxed">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            The supplier says this shipped; the carrier says it never moved. Count what
            actually arrives.
          </div>
        )}

        {!open ? (
          <Button variant="secondary" size="lg" onClick={() => setOpen(true)}
                  className="mt-5 h-11 text-[14px]">
            <PackageCheck className="size-4" />It has arrived
          </Button>
        ) : (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}
                      className="overflow-hidden">
            <div className="mt-7 flex flex-wrap items-end gap-8">
              <Count label="Received" value={recv} onChange={setRecv} big
                     hint="units in the door" />
              <Count label="Passed inspection" value={passed} onChange={setPassed}
                     hint="fit for the line" />
              <div>
                <div className="text-muted-foreground text-[11px] font-medium
                                tracking-[0.1em] uppercase">Rejected</div>
                <div className={`mt-1.5 font-mono text-[30px] leading-none tabular-nums
                  ${rejected > 0 ? 'text-danger' : ''}`}>{rejected}</div>
              </div>
            </div>

            <div className={`mt-5 flex items-start gap-2.5 rounded-lg border px-4 py-3
                             text-[13px] leading-relaxed ${rejected > 0
                               ? 'border-danger/40 bg-danger/[0.07]'
                               : 'border-ok/40 bg-ok/[0.07]'}`}>
              <ArrowRight className="mt-0.5 size-4 shrink-0 opacity-70" />
              <span>
                {rejected > 0
                  ? <>Only <b>{passed}</b> units become usable. The shortage reopens and the
                      supplier's reliability drops.</>
                  : <>All <b>{passed}</b> units become usable stock. If that covers the
                      shortage, the agent closes the incident.</>}
              </span>
            </div>

            <div className="mt-6 flex items-center gap-3">
              <Button size="lg" disabled={pending || recv === ''}
                      onClick={() => onReceive(po, {
                        po_id: po.id,
                        quantity_received: Number(recv),
                        quantity_approved: Number(passed || 0),
                      })} className="h-12 px-8 text-[15px]">
                {pending && <Loader2 className="size-4 animate-spin" />}
                Confirm receipt
              </Button>
              <Button variant="ghost" size="lg" onClick={() => setOpen(false)}
                      className="text-muted-foreground h-12">cancel</Button>
            </div>
          </motion.div>
        )}
      </div>
    </Card>
  )
}

export default function WarehousePortal({ warehouseId = 'Pune-Plant-1' }) {
  const qc = useQueryClient()
  const [receipt, setReceipt] = useState(null)
  const [live, setLive] = useState(false)

  const { data } = useQuery({
    queryKey: ['warehouse'], queryFn: api.warehouse, refetchInterval: 3000 })

  // Same socket as the operations dashboard. When the agent raises a task, this
  // screen lights up without anybody refreshing anything.
  useEffect(() => {
    let closed = false, ws
    const connect = () => {
      if (closed) return
      ws = new WebSocket(WS_URL)
      ws.onopen = () => setLive(true)
      ws.onmessage = () => qc.invalidateQueries({ queryKey: ['warehouse'] })
      ws.onclose = () => { setLive(false); if (!closed) setTimeout(connect, 1500) }
      ws.onerror = () => ws.close()
    }
    connect()
    return () => { closed = true; ws?.close() }
  }, [qc])

  const done = () => refresh(qc, 'world')
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
    <div className="flex h-screen flex-col">
      <header className="glass-panel flex shrink-0 items-center gap-4 border-b px-8 py-5">
        <div className="bg-primary/15 ring-primary/30 flex size-11 items-center justify-center
                        rounded-xl ring-1">
          <WarehouseIcon className="text-primary size-5.5" />
        </div>
        <div className="min-w-0">
          <h1 className="text-[20px] font-semibold tracking-tight">Warehouse Portal</h1>
          <p className="text-muted-foreground text-[13px]">
            {warehouseId} · you are answering the agent directly
          </p>
        </div>
        <Badge variant="outline"
               className={`ml-auto gap-1.5 py-1.5 text-[12px] ${
                 live ? 'border-ok/40 bg-ok/10 text-ok' : 'text-muted-foreground'}`}>
          {live ? <Wifi className="size-3.5" /> : <WifiOff className="size-3.5" />}
          {live ? 'connected' : 'reconnecting'}
        </Badge>
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex max-w-4xl flex-col gap-10 p-10">

          <AnimatePresence>
            {receipt && (
              <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0 }}
                          className="border-ok/40 bg-ok/[0.07] flex items-start gap-3
                                     rounded-xl border px-5 py-4">
                <CheckCircle2 className="text-ok mt-0.5 size-5 shrink-0" />
                <div className="min-w-0">
                  <p className="text-[14.5px] leading-relaxed">{receipt}</p>
                  <button onClick={() => setReceipt(null)}
                          className="text-muted-foreground mt-1.5 text-[12px] underline">
                    dismiss
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <div>
            <div className="flex items-center gap-3">
              <ClipboardCheck className={`size-5 ${tasks.length ? 'text-warn' : 'text-ok'}`} />
              <h2 className="text-[24px] font-semibold tracking-tight">
                {tasks.length
                  ? `${tasks.length} thing${tasks.length > 1 ? 's' : ''} to check`
                  : 'Nothing to check'}
              </h2>
            </div>
            <p className="text-muted-foreground mt-2.5 text-[14px] leading-relaxed">
              {tasks.length
                ? 'The agent has stopped and is waiting for a physical answer before it acts.'
                : 'When the agent needs something verified on the floor, it appears here.'}
            </p>
          </div>

          <div className="flex flex-col gap-6">
            {tasks.map((t) => (
              <TaskCard key={t.id} task={t} pending={complete.isPending}
                        stock={inv.find((i) => i.component_id === t.component_id)}
                        onSubmit={(task, body) => complete.mutate({
                          id: task.id, body,
                          receipt: `Sent: ${body.usable_stock} usable, `
                            + `${body.quarantined_stock} on hold. The agent has it.`,
                        })} />
            ))}
          </div>

          {inbound.length > 0 && (
            <>
              <Separator />
              <div>
                <div className="flex items-center gap-3">
                  <Truck className="text-muted-foreground size-5" />
                  <h2 className="text-[24px] font-semibold tracking-tight">Arriving</h2>
                </div>
                <p className="text-muted-foreground mt-2.5 text-[14px] leading-relaxed">
                  Count what turns up. Received is not the same as usable.
                </p>
              </div>
              <div className="flex flex-col gap-6">
                {inbound.map((p) => (
                  <InboundCard key={p.id} po={p} pending={receive.isPending}
                               onReceive={(po, body) => receive.mutate({
                                 body,
                                 receipt: `Received ${body.quantity_received} ${po.component_name}, `
                                   + `${body.quantity_approved} passed. Stock updated.`,
                               })} />
                ))}
              </div>
            </>
          )}

          <Separator />

          <div>
            <h2 className="text-muted-foreground text-[11px] font-medium
                           tracking-[0.14em] uppercase">What is on the floor</h2>
            <div className="mt-4 flex flex-col gap-1">
              {inv.map((r) => {
                const gap = (r.erp_stock ?? 0) - (r.usable_stock ?? 0)
                return (
                  <div key={r.component_id}
                       className="flex items-baseline gap-3 rounded-lg px-4 py-3.5">
                    <span className="text-[14.5px] font-medium">
                      {r.display_name ?? r.component_id}
                    </span>
                    {gap > 0 && (
                      <span className="text-warn text-[12px]">
                        system thinks {r.erp_stock}
                      </span>
                    )}
                    <span className="ml-auto font-mono text-[19px] tabular-nums">
                      {r.usable_stock}
                    </span>
                    <span className="text-muted-foreground w-14 text-right text-[12px]">
                      usable
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      </ScrollArea>
    </div>
  )
}
