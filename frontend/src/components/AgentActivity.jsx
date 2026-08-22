import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import {
  AlertTriangle, Ban, Check, ChevronRight, CircleDashed, Code2, Loader2, Sparkles,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'

/**
 * The agent narrating its own work, in plain language.
 *
 * Judges should read this and understand what happened without knowing what an
 * event type is. The raw payload is one click away under "Developer trace".
 */

const TONE = {
  done:    { icon: Check,          cls: 'text-ok' },
  warning: { icon: AlertTriangle,  cls: 'text-danger' },
  blocked: { icon: CircleDashed,   cls: 'text-warn' },
  error:   { icon: AlertTriangle,  cls: 'text-danger' },
  working: { icon: Loader2,        cls: 'text-primary animate-spin' },
}

//: Events that read as agent narration. Everything else lives in the Audit Trail.
const NARRATIVE = new Set([
  'AGENT_STEP', 'RISK_ASSESSED', 'INCIDENT_OPENED', 'CLAIM_CONTRADICTED',
  'OPTION_REJECTED', 'OPTION_SELECTED', 'APPROVAL_REQUIRED', 'ERP_UPDATED',
  'MESSAGE_SENT', 'MESSAGE_RECEIVED', 'MESSAGE_INTERPRETED',
  'WAREHOUSE_TASK_CREATED', 'PHYSICAL_COUNT_CONFIRMED', 'GOODS_RECEIVED',
  'INCIDENT_REOPENED', 'INCIDENT_RESOLVED', 'CONSTRAINT_ADDED',
  'PRODUCTION_RESCHEDULED',
])

function statusOf(ev) {
  const s = ev.technical_payload?.status
  if (s) return s
  if (['CLAIM_CONTRADICTED', 'INCIDENT_REOPENED'].includes(ev.event_type)) return 'warning'
  if (ev.event_type === 'APPROVAL_REQUIRED') return 'blocked'
  if (ev.event_type === 'OPTION_REJECTED') return 'rejected'
  return 'done'
}

function Line({ ev, index }) {
  const st = statusOf(ev)
  const rejected = st === 'rejected'
  const { icon: Icon, cls } = TONE[st] ?? TONE.done
  const t = new Date(ev.ts).toLocaleTimeString('en-IN',
    { hour: '2-digit', minute: '2-digit', hour12: false })

  return (
    <motion.li layout
      initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }}
      transition={{ delay: Math.min(index * 0.02, 0.3) }}
      className="flex items-start gap-2.5 py-[5px]">
      <span className="text-muted-foreground w-10 shrink-0 pt-[3px] font-mono text-[10.5px]
                       tabular-nums">{t}</span>
      {rejected
        ? <Ban className="text-muted-foreground mt-[3px] size-3.5 shrink-0" />
        : <Icon className={`mt-[3px] size-3.5 shrink-0 ${cls}`} />}
      <span className={`text-[13px] leading-snug ${
        rejected ? 'text-muted-foreground' : ''}`}>
        {ev.human_summary}
      </span>
    </motion.li>
  )
}

export default function AgentActivity({ events, incidentId, narrative, compact }) {
  const [showTrace, setShowTrace] = useState(false)
  const [showWhy, setShowWhy] = useState(false)
  const endRef = useRef(null)

  const feed = events.filter(
    (e) => NARRATIVE.has(e.event_type) &&
           (!incidentId || e.incident_id === incidentId))

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }) },
    [feed.length])

  const working = feed.length > 0 &&
    !feed.some((e) => ['INCIDENT_RESOLVED', 'APPROVAL_REQUIRED'].includes(e.event_type))

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b px-6 py-4">
        <h2 className="text-muted-foreground text-[10px] font-medium tracking-[0.14em] uppercase">
          Agent activity
        </h2>
        {working && (
          <Badge variant="outline" className="border-primary/40 bg-primary/10 text-primary gap-1">
            <Loader2 className="size-2.5 animate-spin" />working
          </Badge>
        )}
        <div className="ml-auto flex items-center gap-1">
          {narrative && (
            <Button variant="ghost" size="sm" className="h-6 gap-1 px-2 text-[11px]"
                    onClick={() => setShowWhy(!showWhy)}>
              <Sparkles className="size-3" />Why?
            </Button>
          )}
          <Button variant="ghost" size="sm" className="h-6 gap-1 px-2 text-[11px]"
                  onClick={() => setShowTrace(!showTrace)}>
            <Code2 className="size-3" />Trace
          </Button>
        </div>
      </div>

      <AnimatePresence>
        {showWhy && narrative && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
            <div className="bg-primary/5 border-primary/20 m-3 rounded-lg border p-3">
              <div className="text-primary mb-1 flex items-center gap-1.5 text-[10px]
                              font-medium tracking-[0.14em] uppercase">
                <Sparkles className="size-3" />Agent reasoning
              </div>
              <p className="text-[13px] leading-relaxed">{narrative}</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <ScrollArea className="min-h-0 flex-1">
        <div className="px-6 py-4">
          {feed.length === 0 ? (
            <div className="flex flex-col items-center gap-1.5 py-12 text-center">
              <CircleDashed className="text-muted-foreground/40 size-6" />
              <p className="text-muted-foreground text-[13px]">Agent is idle. Nothing at risk.</p>
              <p className="text-muted-foreground/70 max-w-xs text-[11.5px] leading-relaxed">
                It wakes by itself when an event threatens production — no one presses a button.
              </p>
            </div>
          ) : (
            <ul>
              {feed.map((e, i) => <Line key={e.sequence} ev={e} index={i} />)}
              <div ref={endRef} />
            </ul>
          )}

          {showTrace && feed.length > 0 && (
            <>
              <Separator className="my-3" />
              <div className="text-muted-foreground mb-1.5 text-[10px] font-medium
                              tracking-[0.14em] uppercase">Developer trace</div>
              <pre className="bg-muted/40 max-h-72 overflow-auto rounded-lg border p-2
                              font-mono text-[10.5px] leading-relaxed">
{JSON.stringify(feed.slice(-12).map((e) => ({
  seq: e.sequence, t: e.simulated_at_seconds, actor: e.actor,
  event: e.event_type, payload: e.technical_payload,
})), null, 1)}
              </pre>
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}

export { NARRATIVE }
