import { useQuery } from '@tanstack/react-query'
import { motion } from 'motion/react'
import {
  ArrowRight, Bot, Check, CircleDashed, Loader2, PauseCircle,
} from 'lucide-react'
import { api } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'

/**
 * What the AI is doing — in three tenses.
 *
 * A full event log answers "what happened" and buries "what now". Splitting it
 * into done / waiting / next is what turns a stream into a status: the operator
 * can see the agent is alive, see what it is blocked on, and see what it will
 * do without reading anything.
 */

// What the agent does after each state, in the operator's language rather than
// the state machine's.
const NEXT = {
  detected:      'Pull physical stock and open shipments',
  investigating: 'Compare supplier claims against carrier tracking',
  planning:      'Cost every recovery option and pick one',
  awaiting_approval: 'Execute the moment you approve',
  executing:     'Raise the purchase orders and notify suppliers',
  monitoring:    'Confirm the stock physically lands before closing',
}

const DONE_EVENTS = new Set([
  'RISK_ASSESSED', 'INCIDENT_OPENED', 'CLAIM_CONTRADICTED', 'OPTION_SELECTED',
  'ERP_UPDATED', 'MESSAGE_SENT', 'MESSAGE_INTERPRETED', 'PHYSICAL_COUNT_CONFIRMED',
  'GOODS_RECEIVED', 'PRODUCTION_RESCHEDULED', 'SUPPLIER_LEARNED', 'CONSTRAINT_ADDED',
])

function Line({ tone, icon: Icon, children, spin }) {
  return (
    <li className="flex items-start gap-2.5 py-[3px]">
      <Icon className={`mt-[3px] size-3.5 shrink-0 ${tone} ${spin ? 'animate-spin' : ''}`} />
      <span className="text-[12.5px] leading-snug">{children}</span>
    </li>
  )
}

function Group({ label, children, count }) {
  if (!count) return null
  return (
    <div>
      <div className="text-muted-foreground mb-1.5 text-[10px] font-medium
                      tracking-[0.14em] uppercase">{label}</div>
      <ul>{children}</ul>
    </div>
  )
}

export default function AgentStatus({ events, onGoto }) {
  const { data: now } = useQuery({
    queryKey: ['now'], queryFn: api.now, refetchInterval: 3000 })

  const incident = (now?.incidents ?? [])[0] ?? null
  const mine = incident
    ? events.filter((e) => e.incident_id === incident.id)
    : events

  const done = mine.filter(
    (e) => DONE_EVENTS.has(e.event_type) ||
           (e.event_type === 'AGENT_STEP' && e.technical_payload?.status === 'done'))
  const blocked = mine.filter(
    (e) => e.event_type === 'APPROVAL_REQUIRED' ||
           (e.event_type === 'AGENT_STEP' &&
            ['blocked', 'working'].includes(e.technical_payload?.status)))

  // Only the tail of each matters — this is a status, not an archive.
  const recentDone = done.slice(-5)
  const stillWaiting = blocked.slice(-3)
  const next = NEXT[incident?.status] ?? null
  const working = incident && !['resolved', 'failed'].includes(incident.status)

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2.5 border-b px-6 py-4">
        <Bot className={`size-4 ${working ? 'text-primary' : 'text-muted-foreground'}`} />
        <h2 className="text-muted-foreground text-[10px] font-medium tracking-[0.14em] uppercase">
          What the agent is doing
        </h2>
        {working && (
          <Badge variant="outline"
                 className="border-primary/40 bg-primary/10 text-primary ml-auto gap-1
                            text-[10.5px]">
            <Loader2 className="size-2.5 animate-spin" />live
          </Badge>
        )}
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-5 p-5">
          {!incident ? (
            <div className="flex flex-col items-center gap-2.5 py-16 text-center">
              <CircleDashed className="text-muted-foreground/40 size-7" />
              <p className="text-[14px] font-medium">Idle — nothing at risk</p>
              <p className="text-muted-foreground max-w-[15rem] text-[12px] leading-relaxed">
                It wakes by itself the moment an event threatens production.
                Nobody presses a button.
              </p>
            </div>
          ) : (
            <>
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                <div className="text-[14px] leading-snug font-medium">
                  {incident.title ?? `${incident.component_name} at risk`}
                </div>
                <div className="text-muted-foreground mt-1 text-[11.5px]">
                  {incident.severity} · {incident.status.replace(/_/g, ' ')}
                </div>
              </motion.div>

              <Separator />

              <Group label="Done" count={recentDone.length}>
                {recentDone.map((e) => (
                  <Line key={e.sequence} icon={Check} tone="text-ok">{e.human_summary}</Line>
                ))}
              </Group>

              <Group label="Waiting on" count={stillWaiting.length}>
                {stillWaiting.map((e) => (
                  <Line key={e.sequence} icon={PauseCircle} tone="text-warn">
                    {e.human_summary}
                  </Line>
                ))}
              </Group>

              {next && (
                <div>
                  <div className="text-muted-foreground mb-1.5 text-[10px] font-medium
                                  tracking-[0.14em] uppercase">Next</div>
                  <Line icon={ArrowRight} tone="text-muted-foreground">{next}</Line>
                </div>
              )}

              <Button variant="ghost" size="sm" onClick={() => onGoto('audit')}
                      className="text-muted-foreground h-8 justify-start px-2 text-[12px]">
                View full timeline →
              </Button>
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
