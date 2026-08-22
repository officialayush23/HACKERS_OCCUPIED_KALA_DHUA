import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { motion } from 'motion/react'
import {
  AlertTriangle, Bot, Building2, ExternalLink, FileText, Hand, Loader2, Send,
  Truck, User, UserCheck, Warehouse as WhIcon, Zap,
} from 'lucide-react'
import { api } from '@/lib/api'
import { refresh } from '@/lib/refresh'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'

/**
 * The inbox.
 *
 * Two things a list of conversations was not doing:
 *
 * **Sorting by who is stuck.** Showing every thread equally means reading all of
 * them to find the two that need you. `Needs you` is now its own tab and its own
 * count, and a thread lands there when a draft is held, a question is attached,
 * or the agent has been told to keep its hands off.
 *
 * **Saying who is allowed to write.** "The agent emailed my supplier in my name"
 * is the most common reason a buyer refuses to switch a tool like this on. So
 * autonomy is a property of the conversation, not a global setting: let it chase
 * a freight forwarder by itself, hand-hold the relationship that matters. In
 * draft mode it still writes — you just get the last word before it leaves.
 */

const ICON = {
  supplier: Building2, warehouse: WhIcon, carrier: Truck, internal: User, customer: User,
}
const AUTHOR = {
  agent:     { icon: Bot,       cls: 'bg-primary/15 text-primary ring-primary/30' },
  supplier:  { icon: Building2, cls: 'bg-muted text-muted-foreground ring-border' },
  warehouse: { icon: WhIcon,    cls: 'bg-info/15 text-info ring-info/30' },
  carrier:   { icon: Truck,     cls: 'bg-muted text-muted-foreground ring-border' },
  human:     { icon: User,      cls: 'bg-ok/15 text-ok ring-ok/30' },
}
const STATE_TONE = {
  awaiting_response: 'border-warn/40 bg-warn/10 text-warn',
  replied: 'border-ok/40 bg-ok/10 text-ok',
  escalated: 'border-danger/50 bg-danger/15 text-danger',
  draft: 'border-info/45 bg-info/10 text-info',
}

const MODES = [
  { id: 'autonomous', label: 'Autonomous', icon: Zap,
    blurb: 'It writes and sends by itself.' },
  { id: 'draft', label: 'Draft only', icon: FileText,
    blurb: 'It writes; nothing leaves until you release it.' },
  { id: 'human', label: 'I have this', icon: Hand,
    blurb: 'It stops writing here entirely.' },
]

const TABS = [
  { id: 'needs',     label: 'Needs reply' },
  { id: 'ai',        label: 'AI conversations' },
  { id: 'suppliers', label: 'Suppliers' },
  { id: 'warehouse', label: 'Warehouse' },
  { id: 'all',       label: 'All' },
]

function AutonomyPicker({ thread, onSet, pending }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="text-muted-foreground text-[10px] font-medium tracking-[0.14em]
                      uppercase">Who may write here</div>
      <div className="flex flex-wrap gap-1.5">
        {MODES.map((m) => {
          const on = (thread.autonomy ?? 'autonomous') === m.id
          return (
            <Button key={m.id} size="sm" variant={on ? 'secondary' : 'outline'}
                    disabled={pending} onClick={() => onSet(m.id)}
                    className={`h-8 gap-1.5 px-3 text-[12px] font-normal ${
                      on ? 'border-primary/45 border' : 'text-muted-foreground'}`}>
              <m.icon className="size-3" />{m.label}
            </Button>
          )
        })}
      </div>
      <p className="text-muted-foreground/80 text-[11px] leading-relaxed">
        {MODES.find((m) => m.id === (thread.autonomy ?? 'autonomous'))?.blurb}
      </p>
    </div>
  )
}

function Draft({ msg, onSend, pending }) {
  const [body, setBody] = useState(msg.body)
  const edited = body.trim() !== msg.body.trim()

  return (
    <div className="border-info/45 bg-info/[0.05] rounded-xl border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="border-info/45 bg-info/12 text-info gap-1
                                            text-[10px]">
          <FileText className="size-2.5" />held — not sent
        </Badge>
        <span className="text-muted-foreground text-[11.5px]">
          the agent wrote this and stopped
        </span>
      </div>
      <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={5}
                className="mt-3 text-[12.5px] leading-relaxed" />
      <div className="mt-3 flex flex-wrap items-center gap-2.5">
        <Button size="sm" disabled={pending} className="h-8 text-[12px]"
                onClick={() => onSend(msg.id, edited ? body.trim() : null)}>
          {pending && <Loader2 className="size-3.5 animate-spin" />}
          <Send className="size-3.5" />Send{edited ? ' my edit' : ' as written'}
        </Button>
        {edited && (
          <span className="text-muted-foreground text-[11px]">
            your edit is recorded as yours, not the agent&rsquo;s
          </span>
        )}
      </div>
    </div>
  )
}

export default function Communications({ revision, incidentId, onGoto }) {
  const qc = useQueryClient()
  const [tab, setTab] = useState('needs')
  const [active, setActive] = useState(null)
  const [draft, setDraft] = useState('')

  const { data, isLoading } = useQuery({
    queryKey: ['threads', incidentId, revision],
    queryFn: () => api.threads(incidentId), refetchInterval: 3000,
  })

  const threads = useMemo(() => data?.threads ?? [], [data])

  const send = useMutation({
    mutationFn: api.sendMessage,
    onSuccess: () => { setDraft(''); refresh(qc, 'comms') },
  })
  const setMode = useMutation({
    mutationFn: ({ id, mode }) => api.setAutonomy(id, mode),
    onSuccess: () => refresh(qc, 'comms'),
  })
  const release = useMutation({
    mutationFn: ({ id, body }) => api.sendDraft(id, body),
    onSuccess: () => refresh(qc, 'comms'),
  })

  const BUCKET = {
    needs:     (t) => t.needs_you,
    ai:        (t) => (t.autonomy ?? 'autonomous') !== 'human',
    suppliers: (t) => t.counterparty_type === 'supplier',
    warehouse: (t) => t.counterparty_type === 'warehouse',
    all:       () => true,
  }
  const counts = Object.fromEntries(
    TABS.map((t) => [t.id, threads.filter(BUCKET[t.id]).length]))
  const shown = threads.filter(BUCKET[tab])
  const current = shown.find((t) => t.id === active) ?? shown[0]

  // A tab that empties under you should not strand the reading pane on a thread
  // that is no longer in it.
  useEffect(() => {
    if (current && active !== current.id) setActive(current.id)
  }, [current, active])

  if (isLoading) {
    return <div className="space-y-2 p-4">
      {[0, 1, 2].map((i) => <Skeleton key={i} className="h-16 w-full" />)}</div>
  }

  if (!threads.length) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
        <Send className="text-muted-foreground/40 size-6" />
        <p className="text-[14px] font-medium">No conversations yet</p>
        <p className="text-muted-foreground max-w-sm text-[12.5px] leading-relaxed">
          When production is threatened the agent writes to suppliers, the warehouse and
          the carrier by itself. Those conversations appear here — and you can take any
          one of them off it.
        </p>
      </div>
    )
  }

  const drafts = (current?.messages ?? []).filter((m) => m.delivery_state === 'draft')
  const visible = (current?.messages ?? []).filter((m) => m.delivery_state !== 'draft')

  return (
    <div className="grid h-full grid-cols-12">
      {/* ------------------------------------------------------------- list */}
      <div className="col-span-4 flex min-h-0 flex-col border-r">
        <div className="flex shrink-0 flex-wrap gap-1 border-b px-2.5 py-2">
          {TABS.map((t) => (
            <Button key={t.id} size="sm" variant={tab === t.id ? 'secondary' : 'ghost'}
                    onClick={() => setTab(t.id)}
                    className={`h-7 gap-1.5 px-2.5 text-[11.5px] font-normal ${
                      tab === t.id ? '' : 'text-muted-foreground'}`}>
              {t.label}
              {counts[t.id] > 0 && (
                <span className={`rounded-full px-1.5 text-[9.5px] tabular-nums ${
                  t.id === 'needs' ? 'bg-danger text-background' : 'bg-muted'}`}>
                  {counts[t.id]}
                </span>
              )}
            </Button>
          ))}
        </div>

        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-1 p-2">
            {shown.length === 0 && (
              <p className="text-muted-foreground px-3 py-8 text-center text-[12px]
                            leading-relaxed">
                {tab === 'needs'
                  ? 'Nothing is waiting on you. Every conversation is either running '
                    + 'autonomously or already answered.'
                  : 'Nothing in this view.'}
              </p>
            )}
            {shown.map((t) => {
              const Icon = ICON[t.counterparty_type] ?? Building2
              const last = t.last_message
              const on = current?.id === t.id
              const mode = t.autonomy ?? 'autonomous'
              return (
                <Button key={t.id} variant="ghost" onClick={() => setActive(t.id)}
                  className={`h-auto flex-col items-stretch gap-0 rounded-lg border p-2.5
                    text-left font-normal whitespace-normal
                    ${on ? 'border-primary/40 bg-accent'
                         : 'hover:bg-accent/50 border-transparent'}`}>
                  <div className="flex items-center gap-1.5">
                    <Icon className="text-muted-foreground size-3.5 shrink-0" />
                    <span className="truncate text-[12.5px] font-medium">
                      {t.counterparty_name}
                    </span>
                    {t.has_contradiction &&
                      <AlertTriangle className="text-danger ml-auto size-3 shrink-0" />}
                  </div>
                  <div className="text-muted-foreground mt-0.5 truncate text-[11px]">
                    {t.subject}
                  </div>
                  {last && (
                    <div className="text-muted-foreground/70 mt-1 truncate text-[10.5px]">
                      {last.author_name}: {last.body.split('\n')[0]}
                    </div>
                  )}
                  <div className="mt-1.5 flex flex-wrap items-center gap-1">
                    {t.drafts > 0 && (
                      <Badge variant="outline"
                             className="border-info/45 bg-info/10 text-info text-[9px]">
                        {t.drafts} draft{t.drafts > 1 ? 's' : ''} held
                      </Badge>
                    )}
                    {t.open_question && (
                      <Badge variant="outline"
                             className="border-warn/45 bg-warn/10 text-warn text-[9px]">
                        question open
                      </Badge>
                    )}
                    {mode !== 'autonomous' && (
                      <Badge variant="outline" className="text-[9px]">
                        {mode === 'human' ? 'yours' : 'draft only'}
                      </Badge>
                    )}
                    {t.counterparty_staffed && (
                      <Badge variant="outline"
                             className="border-ok/40 bg-ok/10 text-ok gap-0.5 text-[9px]">
                        <UserCheck className="size-2.5" />person there
                      </Badge>
                    )}
                  </div>
                </Button>
              )
            })}
          </div>
        </ScrollArea>
      </div>

      {/* ---------------------------------------------------------- reading */}
      <div className="col-span-8 flex min-h-0 flex-col">
        {current && (
          <>
            <div className="flex shrink-0 flex-wrap items-start gap-3 border-b px-6 py-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[14px] font-medium">{current.counterparty_name}</span>
                  {current.counterparty_type === 'supplier' && current.counterparty_id && (
                    <a href={`/supplier/${current.counterparty_id}`} target="_blank"
                       rel="noreferrer"
                       className="text-muted-foreground hover:text-foreground
                                  inline-flex items-center gap-1 text-[11px]">
                      <ExternalLink className="size-3" />their portal
                    </a>
                  )}
                </div>
                <div className="text-muted-foreground text-[11.5px]">{current.subject}</div>
              </div>
              <div className="ml-auto">
                <AutonomyPicker thread={current} pending={setMode.isPending}
                                onSet={(mode) => setMode.mutate({ id: current.id, mode })} />
              </div>
            </div>

            {current.counterparty_staffed && (
              <div className="border-ok/40 bg-ok/[0.06] mx-6 mt-4 flex items-start gap-2.5
                              rounded-lg border px-4 py-2.5 text-[12px] leading-relaxed">
                <UserCheck className="text-ok mt-0.5 size-3.5 shrink-0" />
                <span>
                  Somebody is at this supplier&rsquo;s portal right now, so their scripted
                  persona has stood down. Whatever comes back is a person&rsquo;s answer,
                  and the agent is genuinely waiting for it.
                </span>
              </div>
            )}

            <ScrollArea className="min-h-0 flex-1">
              <div className="flex flex-col gap-4 p-5">
                {visible.map((m, i) => {
                  const a = AUTHOR[m.author_type] ?? AUTHOR.supplier
                  return (
                    <motion.div key={m.id} initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.03 }}
                      className="flex gap-2.5">
                      <div className={`mt-0.5 flex size-7 shrink-0 items-center justify-center
                                       rounded-full ring-1 ${a.cls}`}>
                        <a.icon className="size-3.5" />
                      </div>
                      <div className={`min-w-0 flex-1 rounded-lg border p-3
                        ${m.is_contradiction ? 'border-danger/50 bg-danger/5' : 'glass'}`}>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-[12.5px] font-medium">{m.author_name}</span>
                          <span className="text-muted-foreground font-mono text-[10px]">
                            T+{((m.simulated_at_seconds ?? 0) / 3600).toFixed(1)}h
                          </span>
                          {m.delivery_state !== 'sent' && (
                            <Badge variant="outline"
                              className={`text-[9px] ${STATE_TONE[m.delivery_state] ?? ''}`}>
                              {m.delivery_state.replace(/_/g, ' ')}
                            </Badge>
                          )}
                          {m.is_contradiction && (
                            <Badge variant="outline"
                              className="border-danger/50 bg-danger/15 text-danger gap-1
                                         text-[9px]">
                              <AlertTriangle className="size-2.5" />contradicted by carrier
                            </Badge>
                          )}
                        </div>
                        <p className="mt-1.5 text-[12.5px] leading-relaxed whitespace-pre-wrap">
                          {m.body}
                        </p>
                      </div>
                    </motion.div>
                  )
                })}

                {drafts.map((m) => (
                  <Draft key={m.id} msg={m} pending={release.isPending}
                         onSend={(id, body) => release.mutate({ id, body })} />
                ))}
              </div>
            </ScrollArea>

            <div className="flex shrink-0 items-center gap-2 border-t p-3">
              <Input value={draft} placeholder="Reply as operator…"
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && draft.trim() &&
                  send.mutate({ thread_id: current.id, body: draft.trim(),
                                incident_id: current.incident_id })}
                className="h-8 text-[12.5px]" />
              <Button size="sm" disabled={!draft.trim() || send.isPending}
                onClick={() => send.mutate({ thread_id: current.id, body: draft.trim(),
                                            incident_id: current.incident_id })}>
                <Send className="size-3.5" />
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
