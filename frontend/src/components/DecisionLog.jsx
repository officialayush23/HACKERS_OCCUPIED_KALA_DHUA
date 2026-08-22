import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AnimatePresence, motion } from 'motion/react'
import {
  Ban, Bot, Check, ChevronDown, Code2, FileText, MessageSquare, PackageCheck,
  ScrollText, ShieldCheck, TriangleAlert, User, Wrench,
} from 'lucide-react'
import { api } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'

/**
 * The decision log — every discrepancy, and what the agent did about it.
 *
 * The audit trail already held all of this, but as a flat stream of events, which
 * answers "what happened" and buries "why". Here each discrepancy becomes a
 * case: what was found, what it meant, what the agent did, what it refused, and
 * what a human was asked for.
 *
 * Three lenses over the same immutable record, because three different people
 * need it. A plant manager wants the story. An engineer wants the agent's
 * reasoning. A judge wants the payload. Nobody gets a different set of facts —
 * only a different amount of detail.
 */

const LENS = {
  business: {
    label: 'Business',
    hint: 'what happened, in plain language',
    keep: new Set([
      'RISK_ASSESSED', 'INCIDENT_OPENED', 'CLAIM_CONTRADICTED', 'OPTION_SELECTED',
      'APPROVAL_REQUIRED', 'PRODUCTION_RESCHEDULED', 'GOODS_RECEIVED',
      'PHYSICAL_COUNT_CONFIRMED', 'INCIDENT_RESOLVED', 'INCIDENT_REOPENED',
      'SUPPLIER_LEARNED',
    ]),
  },
  agent: {
    label: 'Agent',
    hint: 'every step, including the refusals',
    keep: null,     // everything except the raw noise below
  },
  technical: {
    label: 'Technical',
    hint: 'ids, payloads, state transitions',
    keep: null,
  },
}

const ICON = {
  CLAIM_CONTRADICTED:       { i: ShieldCheck,    tone: 'text-danger' },
  OPTION_REJECTED:          { i: Ban,            tone: 'text-muted-foreground' },
  OPTION_SELECTED:          { i: Check,          tone: 'text-ok' },
  APPROVAL_REQUIRED:        { i: User,           tone: 'text-warn' },
  PRODUCTION_RESCHEDULED:   { i: Wrench,         tone: 'text-warn' },
  GOODS_RECEIVED:           { i: PackageCheck,   tone: 'text-ok' },
  PHYSICAL_COUNT_CONFIRMED: { i: PackageCheck,   tone: 'text-ok' },
  MESSAGE_SENT:             { i: MessageSquare,  tone: 'text-muted-foreground' },
  MESSAGE_RECEIVED:         { i: MessageSquare,  tone: 'text-info' },
  MESSAGE_INTERPRETED:      { i: Bot,            tone: 'text-primary' },
  SUPPLIER_LEARNED:         { i: ShieldCheck,    tone: 'text-primary' },
  RISK_ASSESSED:            { i: TriangleAlert,  tone: 'text-warn' },
  INCIDENT_OPENED:          { i: TriangleAlert,  tone: 'text-danger' },
  INCIDENT_RESOLVED:        { i: Check,          tone: 'text-ok' },
}

/** Events that are plumbing rather than decisions. */
const NOISE = new Set(['SCENARIO_STARTED', 'SCENARIO_FINISHED', 'CLOCK_TICK'])

function Line({ ev, lens }) {
  const [open, setOpen] = useState(false)
  const meta = ICON[ev.event_type] ?? { i: ScrollText, tone: 'text-muted-foreground' }
  const Icon = meta.i
  const rejected = ev.event_type === 'OPTION_REJECTED'
  const t = new Date(ev.ts).toLocaleTimeString('en-IN',
    { hour: '2-digit', minute: '2-digit', hour12: false })

  return (
    <div className="border-b py-4 last:border-0">
      <div className="flex items-start gap-3.5">
        <span className="text-muted-foreground w-11 shrink-0 pt-0.5 font-mono text-[11px]
                         tabular-nums">{t}</span>
        <Icon className={`mt-0.5 size-4 shrink-0 ${meta.tone}`} />
        <div className="min-w-0 flex-1">
          <p className={`text-[13.5px] leading-relaxed ${
            rejected ? 'text-muted-foreground' : ''}`}>
            {ev.human_summary}
          </p>

          {lens !== 'business' && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="font-mono text-[9.5px]">
                {ev.event_type}
              </Badge>
              <Badge variant="outline" className="text-[9.5px]">{ev.actor}</Badge>
              {ev.simulated_at_seconds != null && (
                <span className="text-muted-foreground font-mono text-[10px]">
                  T+{(ev.simulated_at_seconds / 3600).toFixed(1)}h
                </span>
              )}
              {lens === 'technical' && (
                <Button variant="ghost" size="sm"
                        onClick={() => setOpen((v) => !v)}
                        className="text-muted-foreground h-6 gap-1 px-1.5 text-[10.5px]">
                  <Code2 className="size-3" />payload
                  <ChevronDown className={`size-3 transition-transform
                    ${open ? '' : '-rotate-90'}`} />
                </Button>
              )}
            </div>
          )}

          <AnimatePresence>
            {open && (
              <motion.pre initial={{ height: 0, opacity: 0 }}
                          animate={{ height: 'auto', opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          className="bg-muted/40 mt-2.5 max-h-60 overflow-auto rounded-lg
                                     border p-3 font-mono text-[10.5px] leading-relaxed">
{JSON.stringify({ sequence: ev.sequence, incident_id: ev.incident_id,
                  payload: ev.technical_payload }, null, 2)}
              </motion.pre>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  )
}

/** One discrepancy, start to finish. */
function Case({ incident, events, lens }) {
  const [open, setOpen] = useState(true)

  const contradiction = events.find((e) => e.event_type === 'CLAIM_CONTRADICTED')
  const chosen = events.filter((e) => e.event_type === 'OPTION_SELECTED').slice(-1)[0]
  const refused = events.filter((e) => e.event_type === 'OPTION_REJECTED')
  const asked = events.find((e) => e.event_type === 'APPROVAL_REQUIRED')
  const resolved = events.find((e) => e.event_type === 'INCIDENT_RESOLVED')

  return (
    <div className="rounded-xl border">
      <button onClick={() => setOpen((v) => !v)}
              className="flex w-full items-start gap-3.5 p-6 text-left">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2.5">
            <span className={`size-2 shrink-0 rounded-full ${
              resolved ? 'bg-ok' : 'bg-danger animate-pulse'}`} />
            <span className="text-[16px] font-semibold tracking-tight">
              {incident?.title ?? incident?.component_name ?? incident?.id ?? 'Discrepancy'}
            </span>
            <Badge variant="outline" className="text-[10px]">
              {resolved ? 'resolved' : (incident?.status ?? 'open').replace(/_/g, ' ')}
            </Badge>
            <span className="text-muted-foreground ml-auto shrink-0 text-[11px]">
              {events.length} events
            </span>
          </div>

          {/* the four questions, answered above the fold */}
          <dl className="mt-4 grid grid-cols-2 gap-x-8 gap-y-3.5">
            <div>
              <dt className="text-muted-foreground text-[10px] font-medium
                             tracking-[0.12em] uppercase">What was found</dt>
              <dd className="mt-1 text-[12.5px] leading-relaxed">
                {contradiction?.human_summary
                  ?? events.find((e) => e.event_type === 'RISK_ASSESSED')?.human_summary
                  ?? '—'}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-[10px] font-medium
                             tracking-[0.12em] uppercase">What the agent did</dt>
              <dd className="mt-1 text-[12.5px] leading-relaxed">
                {chosen?.human_summary ?? 'Still deciding.'}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-[10px] font-medium
                             tracking-[0.12em] uppercase">What it refused</dt>
              <dd className="mt-1 text-[12.5px] leading-relaxed">
                {refused.length
                  ? `${refused.length} option${refused.length > 1 ? 's' : ''} — `
                    + refused[0].human_summary
                  : 'Nothing was refused.'}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-[10px] font-medium
                             tracking-[0.12em] uppercase">What it asked of you</dt>
              <dd className="mt-1 text-[12.5px] leading-relaxed">
                {asked?.human_summary ?? 'Nothing — it stayed inside its authority.'}
              </dd>
            </div>
          </dl>
        </div>
        <ChevronDown className={`text-muted-foreground mt-1 size-4 shrink-0
          transition-transform ${open ? '' : '-rotate-90'}`} />
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
            <Separator />
            <div className="px-6">
              {events.map((e) => <Line key={e.sequence} ev={e} lens={lens} />)}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export default function DecisionLog({ events }) {
  const [lens, setLens] = useState('business')
  const { data: now } = useQuery({
    queryKey: ['now'], queryFn: api.now})

  const incidents = now?.incidents ?? []

  // Group the immutable log into cases. Anything without an incident is
  // world-level and gets its own bucket rather than being dropped.
  const cases = useMemo(() => {
    const keep = LENS[lens].keep
    const usable = events.filter((e) =>
      !NOISE.has(e.event_type) && (!keep || keep.has(e.event_type)))

    const byIncident = new Map()
    for (const e of usable) {
      const k = e.incident_id ?? '__world__'
      if (!byIncident.has(k)) byIncident.set(k, [])
      byIncident.get(k).push(e)
    }
    return [...byIncident.entries()]
      .map(([id, evs]) => ({
        id,
        incident: incidents.find((i) => i.id === id) ?? (id === '__world__'
          ? { id: '__world__', title: 'World events', status: 'ongoing' } : { id }),
        events: evs,
      }))
      .sort((a, b) => {
        const la = a.events[a.events.length - 1]?.sequence ?? 0
        const lb = b.events[b.events.length - 1]?.sequence ?? 0
        return lb - la
      })
  }, [events, lens, incidents])

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-4 border-b px-6 py-4">
        <h2 className="text-muted-foreground flex items-center gap-2 text-[10px] font-medium
                       tracking-[0.14em] uppercase">
          <FileText className="size-3.5" />Decision log
        </h2>

        <Tabs value={lens} onValueChange={setLens} className="ml-auto">
          <TabsList>
            {Object.entries(LENS).map(([k, v]) => (
              <TabsTrigger key={k} value={k} className="text-[12px]">{v.label}</TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <span className="text-muted-foreground hidden text-[11px] lg:block">
          {LENS[lens].hint}
        </span>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-5 p-6">
          {cases.length === 0 ? (
            <div className="flex flex-col items-center gap-2.5 py-20 text-center">
              <FileText className="text-muted-foreground/40 size-7" />
              <p className="text-[14px] font-medium">Nothing decided yet</p>
              <p className="text-muted-foreground max-w-sm text-[12.5px] leading-relaxed">
                Run a simulation and every discrepancy the agent finds will appear here as a
                case — what was found, what it did, what it refused, and what it asked of you.
              </p>
            </div>
          ) : (
            cases.map((c) => (
              <Case key={c.id} incident={c.incident} events={c.events} lens={lens} />
            ))
          )}

          <p className="text-muted-foreground/70 px-1 text-[11px] leading-relaxed">
            This is the append-only audit log, grouped. Nothing here can be edited or deleted —
            there is no UPDATE or DELETE grant on the table, and no foreign key into the mutable
            world, so resetting the demo cannot erase what happened.
          </p>
        </div>
      </ScrollArea>
    </div>
  )
}
