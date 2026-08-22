import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { motion } from 'motion/react'
import {
  AlertTriangle, Bot, Building2, Send, Truck, User, Warehouse as WhIcon,
} from 'lucide-react'
import { api } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'

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
}

/**
 * One chronological operational thread per counterparty — supplier, warehouse,
 * carrier and human in the same conversation. Rendered as email, because that
 * is what it is. Not a chatbot.
 */
export default function Communications({ revision, incidentId }) {
  const qc = useQueryClient()
  const [active, setActive] = useState(null)
  const [draft, setDraft] = useState('')

  const { data, isLoading } = useQuery({
    queryKey: ['threads', incidentId, revision],
    queryFn: () => api.threads(incidentId), refetchInterval: 3000,
  })
  const send = useMutation({
    mutationFn: api.sendMessage,
    onSuccess: () => { setDraft(''); qc.invalidateQueries({ queryKey: ['threads'] }) },
  })

  const threads = data?.threads ?? []
  const current = threads.find((t) => t.id === active) ?? threads[0]

  if (isLoading) return <div className="space-y-2 p-4">
    {[0, 1, 2].map((i) => <Skeleton key={i} className="h-16 w-full" />)}</div>

  if (!threads.length) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
        <Send className="text-muted-foreground/40 size-6" />
        <p className="text-[14px] font-medium">No conversations yet</p>
        <p className="text-muted-foreground max-w-sm text-[12px] leading-relaxed">
          When production is threatened the agent writes to suppliers, the warehouse and
          the carrier by itself. Those conversations appear here.
        </p>
      </div>
    )
  }

  return (
    <div className="grid h-full grid-cols-12">
      <div className="col-span-4 min-h-0 border-r">
        <ScrollArea className="h-full">
          <div className="flex flex-col gap-1 p-2">
            {threads.map((t) => {
              const Icon = ICON[t.counterparty_type] ?? Building2
              const last = t.messages[t.messages.length - 1]
              const on = current?.id === t.id
              const lying = t.messages.some((m) => m.is_contradiction)
              return (
                <Button key={t.id} variant="ghost" onClick={() => setActive(t.id)}
                  className={`h-auto flex-col items-stretch gap-0 rounded-lg border p-2.5
                    text-left font-normal whitespace-normal
                    ${on ? 'border-primary/40 bg-accent' : 'hover:bg-accent/50 border-transparent'}`}>
                  <div className="flex items-center gap-1.5">
                    <Icon className="text-muted-foreground size-3.5 shrink-0" />
                    <span className="truncate text-[12.5px] font-medium">
                      {t.counterparty_name}
                    </span>
                    {lying && <AlertTriangle className="text-danger ml-auto size-3 shrink-0" />}
                  </div>
                  <div className="text-muted-foreground mt-0.5 truncate text-[11px]">
                    {t.subject}
                  </div>
                  {last && (
                    <div className="text-muted-foreground/70 mt-1 truncate text-[10.5px]">
                      {last.author_name}: {last.body.split('\n')[0]}
                    </div>
                  )}
                </Button>
              )
            })}
          </div>
        </ScrollArea>
      </div>

      <div className="col-span-8 flex min-h-0 flex-col">
        {current && (
          <>
            <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2.5">
              <div>
                <div className="text-[13.5px] font-medium">{current.counterparty_name}</div>
                <div className="text-muted-foreground text-[11px]">{current.subject}</div>
              </div>
              <Badge variant="outline" className="ml-auto text-[10px]">
                {current.counterparty_type}
              </Badge>
            </div>

            <ScrollArea className="min-h-0 flex-1">
              <div className="flex flex-col gap-3 p-4">
                {current.messages.map((m, i) => {
                  const a = AUTHOR[m.author_type] ?? AUTHOR.supplier
                  const mine = m.direction === 'outbound'
                  return (
                    <motion.div key={m.id} initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.03 }}
                      className={`flex gap-2.5 ${mine ? '' : ''}`}>
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
                              className="border-danger/50 bg-danger/15 text-danger gap-1 text-[9px]">
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
