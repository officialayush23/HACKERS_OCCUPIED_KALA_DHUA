import { useQuery } from '@tanstack/react-query'
import { AnimatePresence, motion } from 'motion/react'
import {
  CheckCircle2, ClipboardCheck, Clock3, IndianRupee, MessageSquare, TriangleAlert,
} from 'lucide-react'
import { api } from '@/lib/api'
import { inr } from '@/lib/format'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'

/**
 * What needs me.
 *
 * The first thing on the screen, because it is the first question an operator
 * has. Everything here is something a human must do — sorted so the thing that
 * stops a production line sits above the thing that is merely waiting.
 *
 * Deliberately not a feed. A feed tells you what happened; a queue tells you
 * what to do, and shrinks as you do it.
 */
const KIND = {
  approval:  { icon: TriangleAlert,  label: 'Needs your decision', tone: 'danger' },
  warehouse: { icon: ClipboardCheck, label: 'Warehouse action',    tone: 'warn' },
  waiting:   { icon: MessageSquare,  label: 'Waiting on a reply',  tone: 'muted' },
}

const TONE = {
  danger: 'border-danger/45 bg-danger/[0.07]',
  warn:   'border-warn/40 bg-warn/[0.06]',
  muted:  '',
}

function Row({ item, onOpen, index }) {
  const meta = KIND[item.kind] ?? KIND.waiting
  const Icon = meta.icon
  return (
    <motion.div layout
      initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ delay: Math.min(index * 0.04, 0.25) }}
      className={`rounded-xl border p-4 ${TONE[meta.tone]}`}>

      <div className="flex items-center gap-2.5">
        <Icon className={`size-4 shrink-0 ${
          meta.tone === 'danger' ? 'text-danger'
          : meta.tone === 'warn' ? 'text-warn' : 'text-muted-foreground'}`} />
        <span className="text-muted-foreground text-[10px] font-medium tracking-[0.14em] uppercase">
          {meta.label}
        </span>
        {item.cost > 0 && (
          <Badge variant="outline" className="ml-auto shrink-0 gap-1 font-mono text-[10.5px]">
            <IndianRupee className="size-2.5" />{inr(item.cost).replace('₹', '')}
          </Badge>
        )}
      </div>

      <p className="mt-2.5 text-[14px] leading-snug font-medium">{item.title}</p>
      {item.detail && (
        <p className="text-muted-foreground mt-1.5 text-[12px] leading-relaxed">{item.detail}</p>
      )}

      <Button size="sm"
              variant={meta.tone === 'danger' ? 'default' : 'secondary'}
              onClick={() => onOpen(item)}
              className="mt-3.5 h-8 text-[12px]">
        {item.cta ?? 'Open'}
      </Button>
    </motion.div>
  )
}

export default function ActionQueue({ onGoto }) {
  const { data } = useQuery({ queryKey: ['now'], queryFn: api.now, refetchInterval: 3000 })
  const queue = data?.queue ?? []

  const open = (item) => {
    if (item.kind === 'approval') onGoto('approvals')
    else if (item.kind === 'warehouse') onGoto('warehouse')
    else onGoto('comms')
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2.5 border-b px-6 py-4">
        <h2 className="text-muted-foreground text-[10px] font-medium tracking-[0.14em] uppercase">
          What needs you
        </h2>
        {queue.length > 0 && (
          <Badge variant="outline" className="text-[10.5px]">{queue.length}</Badge>
        )}
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-3 p-5">
          <AnimatePresence mode="popLayout">
            {queue.length === 0 ? (
              <motion.div key="clear" initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                          className="flex flex-col items-center gap-2.5 py-16 text-center">
                <CheckCircle2 className="text-ok/60 size-7" />
                <p className="text-[14px] font-medium">Nothing needs you</p>
                <p className="text-muted-foreground max-w-[15rem] text-[12px] leading-relaxed">
                  The agent is operating inside its authority. It will stop and ask
                  the moment it isn't.
                </p>
              </motion.div>
            ) : (
              queue.map((q, i) => (
                <Row key={q.id} item={q} onOpen={open} index={i} />
              ))
            )}
          </AnimatePresence>

          {queue.length > 0 && (
            <p className="text-muted-foreground/70 mt-1 flex items-center gap-1.5 px-1
                          text-[11px] leading-relaxed">
              <Clock3 className="size-3 shrink-0" />
              Sorted by consequence — a stopped line outranks a slow reply.
            </p>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
