import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AnimatePresence, motion } from 'motion/react'
import {
  AlertTriangle, ArrowRight, Building2, CheckCircle2, Factory, Loader2, Ban,
  Send, ShieldCheck, Truck, Wifi, WifiOff,
} from 'lucide-react'
import { api, WS_URL } from '@/lib/api'
import { inr } from '@/lib/format'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Textarea } from '@/components/ui/textarea'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'

/**
 * The Supplier Portal — the third actor, at its own URL.
 *
 * The warehouse portal made physical truth something a human supplies. This
 * does the same for the counterparty, and it is the harder half: a scripted
 * liar proves nothing about an agent. Until now "the supplier claims dispatch
 * and the agent catches it" was a persona firing a hardcoded string at a timer,
 * and a judge had no way to disagree with it.
 *
 * Open this beside the operations dashboard and *you* decide whether to tell the
 * truth. Quote a real price and watch the recommendation move. Hedge, and watch
 * the agent refuse to treat your sentence as supply. Claim a dispatch that never
 * happened, and watch it check the carrier instead of believing you.
 *
 * While this page is open, that supplier's scripted persona stands down — the
 * agent genuinely waits for you. Close the tab and the personas resume, so an
 * unattended demo still runs end to end.
 *
 * Deliberately narrow. A supplier sees their own orders, their own enquiries and
 * their own trust score. They never see the buyer's plan, the other quotes, or
 * the comparison. A portal that leaked that would be a different, much worse
 * product.
 */

const MODES = ['ROAD', 'RAIL', 'AIR', 'SEA']
const CERTS = ['AEC-Q100', 'ISO-9001', 'IATF-16949', 'IEC-62133', 'RoHS']

function Field({ label, hint, children }) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="text-muted-foreground text-[10.5px] font-medium
                       tracking-[0.1em] uppercase">{label}</span>
      {children}
      {hint && <span className="text-muted-foreground text-[11px] leading-relaxed">{hint}</span>}
    </label>
  )
}

function Num({ value, onChange, placeholder, className = '' }) {
  return (
    <Input type="number" min={0} inputMode="decimal" value={value} placeholder={placeholder}
           onChange={(e) => onChange(e.target.value)}
           className={`h-10 font-mono text-[15px] tabular-nums ${className}`} />
  )
}

/* ------------------------------------------------------------ quote form -- */

function QuoteForm({ catalog, onSend, pending }) {
  // The catalogue is already loaded by the time this mounts — the parent only
  // renders it when catalog.length — so seeding from index 0 is safe here.
  const [componentId, setComponentId] = useState(catalog[0]?.component_id ?? '')
  const [qty, setQty] = useState('')
  const [price, setPrice] = useState('')
  const [lead, setLead] = useState('')
  const [mode, setMode] = useState('ROAD')
  const [moq, setMoq] = useState('')
  const [certs, setCerts] = useState([])
  const [note, setNote] = useState('')

  const row = catalog.find((c) => c.component_id === componentId)

  // Prefill from what we already have on file, so the common case is "change one
  // number and send" rather than "retype your own catalogue".
  useEffect(() => {
    if (!row) return
    setQty(String(row.available_quantity ?? ''))
    setPrice(String(row.unit_price ?? ''))
    // An applied portal quote parks its lead time on the lane, not the
    // catalogue row, so a 0 here means "not stated" rather than "same day".
    setLead(row.lead_time_days ? String(row.lead_time_days) : '')
    setMoq(String(row.min_order_quantity ?? ''))
  }, [componentId])   // eslint-disable-line react-hooks/exhaustive-deps

  const required = row?.required_certifications ?? []
  const missing = required.filter((c) => !certs.includes(c))
  const ready = componentId && qty !== '' && price !== ''

  const toggleCert = (c) =>
    setCerts((v) => (v.includes(c) ? v.filter((x) => x !== c) : [...v, c]))

  return (
    <div className="flex flex-col gap-6">
      <Field label="What are you quoting for">
        <Select value={componentId} onValueChange={setComponentId}>
          <SelectTrigger className="h-10 text-[13.5px]">
            <SelectValue placeholder="pick a part" />
          </SelectTrigger>
          <SelectContent>
            {catalog.map((c) => (
              <SelectItem key={c.component_id} value={c.component_id} className="text-[13px]">
                {c.component_name}
                <span className="text-muted-foreground"> · {c.part_number}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <div className="grid grid-cols-2 gap-5 sm:grid-cols-4">
        <Field label="Quantity"><Num value={qty} onChange={setQty} placeholder="500" /></Field>
        <Field label="₹ per unit"><Num value={price} onChange={setPrice} placeholder="145" /></Field>
        <Field label="Lead time" hint="days until it leaves you">
          <Num value={lead} onChange={setLead} placeholder="2" />
        </Field>
        <Field label="Minimum order"><Num value={moq} onChange={setMoq} placeholder="100" /></Field>
      </div>

      <Field label="How it travels">
        <div className="flex flex-wrap gap-1.5">
          {MODES.map((m) => (
            <Button key={m} type="button" size="sm"
                    variant={mode === m ? 'default' : 'outline'}
                    onClick={() => setMode(m)}
                    className="h-8 px-3 text-[12px] font-normal">{m}</Button>
          ))}
        </div>
      </Field>

      <Field
        label="Certifications you are asserting"
        hint="Asserting one here does not grant it. The buyer records the claim and
              checks it against your certification file — a certification is a
              document, not a sentence in an email.">
        <div className="flex flex-wrap gap-1.5">
          {CERTS.map((c) => (
            <Button key={c} type="button" size="sm"
                    variant={certs.includes(c) ? 'secondary' : 'outline'}
                    onClick={() => toggleCert(c)}
                    className={`h-8 px-3 text-[12px] font-normal ${
                      certs.includes(c) ? 'border-primary/45' : 'text-muted-foreground'}`}>
              {certs.includes(c) && <CheckCircle2 className="size-3" />}{c}
            </Button>
          ))}
        </div>
      </Field>

      {required.length > 0 && (
        <div className={`flex items-start gap-2.5 rounded-lg border px-4 py-3 text-[12.5px]
                         leading-relaxed ${missing.length
                           ? 'border-warn/40 bg-warn/[0.07]' : 'border-ok/40 bg-ok/[0.07]'}`}>
          <ShieldCheck className={`mt-0.5 size-4 shrink-0 ${
            missing.length ? 'text-warn' : 'text-ok'}`} />
          <span>
            {missing.length
              ? <>This part requires <b>{required.join(', ')}</b>. You have not asserted{' '}
                  {missing.join(', ')} — expect to be refused on certification whatever
                  your price is.</>
              : <>You have asserted everything this part requires. The buyer will still
                  check it against your file.</>}
          </span>
        </div>
      )}

      <Field label="Anything else you want to say">
        <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2}
                  placeholder="e.g. we can expedite for an additional Rs 12,000"
                  className="text-[13.5px]" />
      </Field>

      <div className="flex items-center gap-3">
        <Button size="lg" disabled={!ready || pending} className="h-11 px-7 text-[14.5px]"
                onClick={() => onSend({
                  kind: 'quote', note: note.trim(),
                  offer: {
                    component_id: componentId,
                    quantity: Number(qty || 0),
                    unit_price: Number(price || 0),
                    lead_time_days: lead === '' ? null : Number(lead),
                    mode,
                    min_order_quantity: moq === '' ? null : Number(moq),
                    certifications: certs,
                  },
                })}>
          {pending && <Loader2 className="size-4 animate-spin" />}
          <Send className="size-4" />Send this quote
        </Button>
        {ready && (
          <span className="text-muted-foreground text-[12px]">
            {inr(Number(qty || 0) * Number(price || 0))} for {qty} units
          </span>
        )}
      </div>
    </div>
  )
}

/* -------------------------------------------------------- the other three -- */

function OtherAnswers({ catalog, onSend, pending }) {
  const [text, setText] = useState('')
  const [componentId, setComponentId] = useState(catalog[0]?.component_id ?? '')

  return (
    <div className="flex flex-col gap-7">
      <div>
        <h3 className="text-[15px] font-semibold tracking-tight">Say something vague</h3>
        <p className="text-muted-foreground mt-1.5 text-[13px] leading-relaxed">
          The hardest supplier is not the one who lies — it is the one who writes four
          sentences that sound like an offer and commit to nothing. The agent should
          refuse to plan against this, and say so.
        </p>
        <Button variant="outline" size="lg" disabled={pending}
                onClick={() => onSend({ kind: 'vague',
                                        offer: componentId ? { component_id: componentId } : null })}
                className="mt-4 h-10 text-[13.5px]">
          {pending && <Loader2 className="size-4 animate-spin" />}
          Send a non-committal reply
        </Button>
      </div>

      <Separator />

      <div>
        <h3 className="text-[15px] font-semibold tracking-tight">Decline</h3>
        <p className="text-muted-foreground mt-1.5 text-[13px] leading-relaxed">
          An honest no is worth as much as a yes. It takes you out of the pool instead
          of leaving the buyer costing an option that does not exist.
        </p>
        <div className="mt-4 flex flex-wrap items-end gap-4">
          <div className="min-w-[16rem] flex-1">
            <Field label="For which part">
              <Select value={componentId} onValueChange={setComponentId}>
                <SelectTrigger className="h-10 text-[13.5px]">
                  <SelectValue placeholder="everything you supply" />
                </SelectTrigger>
                <SelectContent>
                  {catalog.map((c) => (
                    <SelectItem key={c.component_id} value={c.component_id}
                                className="text-[13px]">{c.component_name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <Button variant="outline" size="lg" disabled={pending}
                  onClick={() => onSend({ kind: 'decline',
                                          offer: componentId ? { component_id: componentId } : null })}
                  className="border-danger/40 text-danger hover:bg-danger/10 h-10 text-[13.5px]">
            <Ban className="size-4" />We cannot supply this
          </Button>
        </div>
      </div>

      <Separator />

      <div>
        <h3 className="text-[15px] font-semibold tracking-tight">Write it yourself</h3>
        <p className="text-muted-foreground mt-1.5 text-[13px] leading-relaxed">
          Anything at all. It arrives as prose and the agent has to read it back out —
          which is the whole difficulty of the job, and the reason the structured form
          above still sends a sentence rather than a dictionary.
        </p>
        <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={4}
                  placeholder="We can release 300 units immediately at Rs 132 per unit, four-day road transit, AEC-Q100 certified."
                  className="mt-4 text-[13.5px]" />
        <Button size="lg" disabled={!text.trim() || pending}
                onClick={() => { onSend({ kind: 'freeform', body: text.trim() }); setText('') }}
                className="mt-4 h-10 text-[13.5px]">
          {pending && <Loader2 className="size-4 animate-spin" />}
          <Send className="size-4" />Send
        </Button>
      </div>
    </div>
  )
}

/* ----------------------------------------------------------- the lie tab -- */

function DispatchClaims({ orders, onClaim, pending }) {
  const [poId, setPoId] = useState(orders[0]?.id ?? '')
  const po = orders.find((o) => o.id === poId)
  const willContradict = po && ['not_shipped', 'label_created_no_pickup']
    .includes(po.tracking_status)

  if (!orders.length) {
    return (
      <p className="text-muted-foreground text-[13px] leading-relaxed">
        You have no open orders to make a claim about.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <p className="text-muted-foreground text-[13px] leading-relaxed">
        Tell the buyer a shipment has left. You may say it whether or not it has —
        that is the point. The carrier system is not yours to edit, so if you claim
        something the tracking data does not support, the agent will find it.
      </p>

      <Field label="Which order">
        <Select value={poId} onValueChange={setPoId}>
          <SelectTrigger className="h-10 text-[13.5px]">
            <SelectValue placeholder="pick an order" />
          </SelectTrigger>
          <SelectContent>
            {orders.map((o) => (
              <SelectItem key={o.id} value={o.id} className="text-[13px]">
                {o.id} — {o.component_name} — {o.quantity} units
                <span className="text-muted-foreground"> · {o.status}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      {po && (
        <div className="bg-muted/30 flex flex-wrap items-center gap-8 rounded-xl px-5 py-4">
          <div>
            <div className="text-muted-foreground text-[10.5px] font-medium
                            tracking-[0.1em] uppercase">Carrier currently shows</div>
            <div className="mt-1 font-mono text-[15px]">
              {po.tracking_status ?? 'no scan'}
            </div>
          </div>
          <ArrowRight className="text-muted-foreground/50 size-4" />
          <div>
            <div className="text-muted-foreground text-[10.5px] font-medium
                            tracking-[0.1em] uppercase">You would be saying</div>
            <div className="text-primary mt-1 font-mono text-[15px]">dispatched</div>
          </div>
        </div>
      )}

      {willContradict && (
        <div className="border-danger/40 bg-danger/[0.07] flex items-start gap-2.5 rounded-lg
                        border px-4 py-3 text-[12.5px] leading-relaxed">
          <AlertTriangle className="text-danger mt-0.5 size-4 shrink-0" />
          <span>
            This will contradict the carrier record. The buyer's agent cross-checks
            claims against tracking, so expect it to catch this, stop treating your
            shipment as supply, and mark your reliability down permanently.
          </span>
        </div>
      )}

      <div className="flex flex-wrap gap-3">
        <Button size="lg" disabled={!poId || pending} className="h-10 text-[13.5px]"
                onClick={() => onClaim({ po_id: poId, claim: 'dispatched' })}>
          {pending && <Loader2 className="size-4 animate-spin" />}
          <Truck className="size-4" />Claim it has been dispatched
        </Button>
        <Button variant="outline" size="lg" disabled={!poId || pending}
                className="h-10 text-[13.5px]"
                onClick={() => onClaim({ po_id: poId, claim: 'delayed' })}>
          Report it as delayed
        </Button>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ page -- */

const TABS = [
  { id: 'quote',   label: 'Quote' },
  { id: 'other',   label: 'Other replies' },
  { id: 'claim',   label: 'Shipment status' },
  { id: 'threads', label: 'Conversation' },
]

export default function SupplierPortal({ supplierId }) {
  const qc = useQueryClient()
  const [tab, setTab] = useState('quote')
  const [receipt, setReceipt] = useState(null)
  const [live, setLive] = useState(false)

  const { data, error } = useQuery({
    queryKey: ['supplier', supplierId], queryFn: () => api.supplier(supplierId),
    refetchInterval: 3000, retry: false })

  // Presence is what stands the scripted persona down. Announce arrival
  // immediately, keep it warm, and announce departure — a stale heartbeat would
  // leave the agent waiting for a person who has gone home.
  useEffect(() => {
    let alive = true
    const beat = () => { if (alive) api.supplierPresence(supplierId).catch(() => {}) }
    beat()
    const t = setInterval(beat, 15000)
    const bye = () => { navigator.sendBeacon?.(
      `${import.meta.env.VITE_API_BASE ?? 'http://localhost:8000'}` +
      `/api/supplier/${supplierId}/presence?leaving=true`) }
    window.addEventListener('pagehide', bye)
    return () => {
      alive = false
      clearInterval(t)
      window.removeEventListener('pagehide', bye)
      api.supplierPresence(supplierId, true).catch(() => {})
    }
  }, [supplierId])

  useEffect(() => {
    let closed = false, ws
    const connect = () => {
      if (closed) return
      ws = new WebSocket(WS_URL)
      ws.onopen = () => setLive(true)
      ws.onmessage = () => qc.invalidateQueries({ queryKey: ['supplier'] })
      ws.onclose = () => { setLive(false); if (!closed) setTimeout(connect, 1500) }
      ws.onerror = () => ws.close()
    }
    connect()
    return () => { closed = true; ws?.close() }
  }, [qc])

  const done = (msg) => {
    setReceipt(msg)
    qc.invalidateQueries({ queryKey: ['supplier'] })
  }

  const reply = useMutation({
    mutationFn: (b) => api.supplierReply(supplierId, b),
    onSuccess: (r) => done(r.interpretation?.needs_human
      ? 'Sent. The buyer’s agent read it and could not act on it — it has asked a '
        + 'human what to do rather than guessing.'
      : `Sent. The agent read it as: ${r.interpretation?.summary ?? 'a reply'}`),
    onError: (e) => setReceipt(`Could not send — ${e.message}`),
  })
  const claim = useMutation({
    mutationFn: (b) => api.supplierClaim(supplierId, b),
    onSuccess: (r) => done(r.summary ?? 'Claim recorded.'),
    onError: (e) => setReceipt(`Could not send — ${e.message}`),
  })

  const sup = data?.supplier
  const catalog = data?.catalog ?? []
  const orders = useMemo(
    () => (data?.purchase_orders ?? []).filter((p) => p.status !== 'delivered'),
    [data])
  const threads = data?.threads ?? []
  const waiting = threads.filter((t) => t.awaiting_you)
  const trust = Number(sup?.effective_reliability ?? 0)

  if (error) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 p-10 text-center">
        <Building2 className="text-muted-foreground/40 size-8" />
        <p className="text-[16px] font-medium">No supplier called {supplierId}</p>
        <p className="text-muted-foreground max-w-md text-[13px] leading-relaxed">
          {String(error.message)}
        </p>
        <a href="/supplier" className="text-primary mt-2 text-[13px] underline">
          see who there is
        </a>
      </div>
    )
  }

  return (
    <div className="flex h-screen flex-col">
      <header className="glass-panel flex shrink-0 flex-wrap items-center gap-4 border-b
                         px-8 py-5">
        <div className="bg-primary/15 ring-primary/30 flex size-11 items-center justify-center
                        rounded-xl ring-1">
          <Factory className="text-primary size-5.5" />
        </div>
        <div className="min-w-0">
          <h1 className="truncate text-[20px] font-semibold tracking-tight">
            {sup?.legal_name ?? sup?.name ?? supplierId}
          </h1>
          <p className="text-muted-foreground text-[13px]">
            {sup?.city}{sup?.country ? `, ${sup.country}` : ''} ·{' '}
            <span className="font-mono">{supplierId}</span> · you are answering
            NEXA Mobility directly
          </p>
        </div>

        <div className="ml-auto flex items-center gap-2.5">
          <Badge variant="outline"
                 className={`gap-1.5 py-1.5 text-[12px] ${
                   trust >= 0.8 ? 'border-ok/40 bg-ok/10 text-ok'
                   : trust >= 0.6 ? 'border-warn/40 bg-warn/10 text-warn'
                   : 'border-danger/45 bg-danger/10 text-danger'}`}>
            trust {trust.toFixed(2)}
          </Badge>
          <Badge variant="outline"
                 className={`gap-1.5 py-1.5 text-[12px] ${
                   live ? 'border-ok/40 bg-ok/10 text-ok' : 'text-muted-foreground'}`}>
            {live ? <Wifi className="size-3.5" /> : <WifiOff className="size-3.5" />}
            {live ? 'connected' : 'reconnecting'}
          </Badge>
        </div>
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex max-w-4xl flex-col gap-9 p-10">

          <AnimatePresence>
            {receipt && (
              <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0 }}
                          className="border-ok/40 bg-ok/[0.07] flex items-start gap-3
                                     rounded-xl border px-5 py-4">
                <CheckCircle2 className="text-ok mt-0.5 size-5 shrink-0" />
                <div className="min-w-0">
                  <p className="text-[14px] leading-relaxed">{receipt}</p>
                  <button onClick={() => setReceipt(null)}
                          className="text-muted-foreground mt-1.5 text-[12px] underline">
                    dismiss
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* --------------------------------------------- what they want */}
          <div>
            <div className="flex items-center gap-3">
              <Send className={`size-5 ${waiting.length ? 'text-warn' : 'text-ok'}`} />
              <h2 className="text-[24px] font-semibold tracking-tight">
                {waiting.length
                  ? `${waiting.length} enquir${waiting.length > 1 ? 'ies' : 'y'} waiting on you`
                  : 'Nothing waiting on you'}
              </h2>
            </div>
            <p className="text-muted-foreground mt-2.5 text-[14px] leading-relaxed">
              {waiting.length
                ? 'The buyer’s agent has written and stopped. While this page is open '
                  + 'it will not invent an answer on your behalf — it is genuinely waiting.'
                : 'When NEXA’s agent needs something from you it appears here. While this '
                  + 'page is open, nothing answers in your name.'}
            </p>
          </div>

          {waiting.map((t) => {
            const last = [...t.messages].reverse().find((m) => m.direction === 'outbound')
            return (
              <Card key={t.id} className="border-warn/40 gap-0 py-0">
                <div className="p-7">
                  <div className="text-muted-foreground text-[10.5px] font-medium
                                  tracking-[0.1em] uppercase">
                    from NEXA Mobility · DisruptionOps Agent
                  </div>
                  <h3 className="mt-2 text-[16px] font-semibold tracking-tight">{t.subject}</h3>
                  {last && (
                    <p className="mt-3 text-[13.5px] leading-relaxed whitespace-pre-wrap">
                      {last.body}
                    </p>
                  )}
                </div>
              </Card>
            )
          })}

          <Separator />

          {/* ------------------------------------------------ how to answer */}
          <div>
            <div className="flex flex-wrap gap-1.5">
              {TABS.map((t) => (
                <Button key={t.id} size="sm"
                        variant={tab === t.id ? 'secondary' : 'ghost'}
                        onClick={() => setTab(t.id)}
                        className={`h-9 px-4 text-[13px] font-normal ${
                          tab === t.id ? 'border-primary/40 border' : 'text-muted-foreground'}`}>
                  {t.label}
                  {t.id === 'threads' && threads.length > 0 && (
                    <Badge variant="outline" className="ml-1 text-[10px]">{threads.length}</Badge>
                  )}
                </Button>
              ))}
            </div>

            <div className="mt-7">
              {tab === 'quote' && (
                catalog.length
                  ? <QuoteForm catalog={catalog} pending={reply.isPending}
                               onSend={(b) => reply.mutate(b)} />
                  : <p className="text-muted-foreground text-[13px] leading-relaxed">
                      You have nothing on NEXA&rsquo;s approved catalogue yet, so there is
                      nothing to quote against. Use <b>Other replies</b> to write to them
                      directly.
                    </p>
              )}
              {tab === 'other' && (
                <OtherAnswers catalog={catalog} pending={reply.isPending}
                              onSend={(b) => reply.mutate(b)} />
              )}
              {tab === 'claim' && (
                <DispatchClaims orders={orders} pending={claim.isPending}
                                onClaim={(b) => claim.mutate(b)} />
              )}
              {tab === 'threads' && (
                <div className="flex flex-col gap-6">
                  {threads.length === 0 && (
                    <p className="text-muted-foreground text-[13px]">
                      No conversation yet.
                    </p>
                  )}
                  {threads.map((t) => (
                    <div key={t.id}>
                      <div className="text-[13.5px] font-medium">{t.subject}</div>
                      <div className="mt-3 flex flex-col gap-3">
                        {t.messages.map((m) => (
                          <div key={m.id}
                               className={`rounded-lg border px-4 py-3 text-[13px]
                                 leading-relaxed ${m.direction === 'inbound'
                                   ? 'border-primary/35 bg-primary/[0.05] ml-8' : 'glass mr-8'}`}>
                            <div className="text-muted-foreground mb-1.5 flex items-center
                                            gap-2 text-[10.5px]">
                              <span className="font-medium">
                                {m.direction === 'inbound' ? 'You' : m.author_name}
                              </span>
                              <span className="font-mono">
                                T+{((m.simulated_at_seconds ?? 0) / 3600).toFixed(1)}h
                              </span>
                            </div>
                            <p className="whitespace-pre-wrap">{m.body}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <Separator />

          {/* ------------------------------------------ your standing with them */}
          <div>
            <h2 className="text-muted-foreground text-[10.5px] font-medium
                           tracking-[0.14em] uppercase">
              How NEXA rates you, and why
            </h2>
            <p className="text-muted-foreground mt-2.5 text-[13px] leading-relaxed">
              Delivering when you said you would is the only thing that raises this.
              Contradicting the carrier record and failing inspection are what lower it.
            </p>
            <div className="mt-4 flex flex-wrap gap-8">
              {[
                ['trust now', trust.toFixed(2)],
                ['on time', sup?.deliveries_on_time ?? 0],
                ['late', sup?.deliveries_late ?? 0],
                ['contradictions', sup?.contradictions_detected ?? 0],
              ].map(([k, v]) => (
                <div key={k}>
                  <div className="text-muted-foreground text-[10px] font-medium
                                  tracking-[0.12em] uppercase">{k}</div>
                  <div className="mt-1 font-mono text-[22px] leading-none tabular-nums">{v}</div>
                </div>
              ))}
            </div>
            {(data?.trust_history ?? []).length > 0 && (
              <ul className="mt-5 flex flex-col gap-2">
                {data.trust_history.slice(0, 5).map((h, i) => (
                  <li key={i} className="flex items-start gap-2.5 text-[12.5px] leading-relaxed">
                    <span className={`mt-1.5 size-1.5 shrink-0 rounded-full ${
                      Number(h.delta) >= 0 ? 'bg-ok' : 'bg-danger'}`} />
                    <span>
                      <span className="font-mono">
                        {Number(h.delta) >= 0 ? '+' : ''}{Number(h.delta).toFixed(2)}
                      </span>{' '}
                      <span className="text-muted-foreground">{h.reason}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <p className="text-muted-foreground/70 text-[11.5px] leading-relaxed">
            You are one of three windows. The operations dashboard is at <b>/</b>, the
            plant floor at <b>/warehouse</b>. Open them side by side — nothing here is
            piped between tabs, it all goes through the same database and the same
            agent.
          </p>
        </div>
      </ScrollArea>
    </div>
  )
}

/* ------------------------------------------------------------ the picker -- */

export function SupplierDirectory() {
  const { data } = useQuery({
    queryKey: ['supplier-directory'], queryFn: api.supplierDirectory,
    refetchInterval: 4000 })
  const suppliers = data?.suppliers ?? []

  return (
    <div className="flex h-screen flex-col">
      <header className="glass-panel flex shrink-0 items-center gap-4 border-b px-8 py-5">
        <div className="bg-primary/15 ring-primary/30 flex size-11 items-center justify-center
                        rounded-xl ring-1">
          <Building2 className="text-primary size-5.5" />
        </div>
        <div>
          <h1 className="text-[20px] font-semibold tracking-tight">Supplier portals</h1>
          <p className="text-muted-foreground text-[13px]">
            Pick a supplier to answer as. The one waiting on a reply is at the top.
          </p>
        </div>
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex max-w-3xl flex-col gap-2 p-10">
          {suppliers.map((s) => (
            <a key={s.id} href={`/supplier/${s.id}`}
               className="hover:bg-accent/40 flex items-center gap-4 rounded-xl border
                          px-5 py-4 transition-colors">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2.5">
                  <span className="text-[15px] font-medium">{s.name}</span>
                  <span className="text-muted-foreground font-mono text-[11.5px]">{s.id}</span>
                  {s.origin === 'test' && (
                    <Badge variant="outline" className="text-[10px]">test entity</Badge>
                  )}
                  {s.staffed && (
                    <Badge variant="outline"
                           className="border-ok/40 bg-ok/10 text-ok text-[10px]">
                      somebody is here
                    </Badge>
                  )}
                </div>
                <div className="text-muted-foreground mt-1 text-[12.5px]">
                  {s.city}, {s.country} · supplies {(s.components ?? []).length} part
                  {(s.components ?? []).length === 1 ? '' : 's'}
                  {s.contradictions_detected > 0 &&
                    ` · ${s.contradictions_detected} contradiction${
                      s.contradictions_detected > 1 ? 's' : ''} on record`}
                </div>
              </div>
              {s.waiting_on_them > 0 && (
                <Badge variant="outline"
                       className="border-warn/45 bg-warn/10 text-warn shrink-0 text-[11px]">
                  {s.waiting_on_them} waiting
                </Badge>
              )}
              <span className="text-muted-foreground shrink-0 font-mono text-[13px] tabular-nums">
                {Number(s.effective_reliability ?? 0).toFixed(2)}
              </span>
            </a>
          ))}
        </div>
      </ScrollArea>
    </div>
  )
}
