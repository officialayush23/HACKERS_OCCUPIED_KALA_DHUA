import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { motion } from 'motion/react'
import { AlertTriangle, Check, Loader2, PencilLine, X } from 'lucide-react'
import { api } from '@/lib/api'
import { refresh } from '@/lib/refresh'
import { inr } from '@/lib/format'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'

/**
 * Approval is not the end of the story.
 *
 * Approve  → the agent resumes and executes.
 * Reject   → the agent replans from scratch.
 * Modify   → the note becomes a hard CONSTRAINT that survives into every future
 *            plan for this incident. Human feedback changes agent state, it does
 *            not sit in a comment box.
 */
export default function Approvals({ revision }) {
  const qc = useQueryClient()
  const [modifying, setModifying] = useState(null)
  const [exclude, setExclude] = useState('')
  const [note, setNote] = useState('')

  const { data } = useQuery({
    queryKey: ['approvals', revision], queryFn: api.approvals, refetchInterval: 3000 })

  const decide = useMutation({
    // Decide the approval row itself. The old call only resumed the agent and
    // left the approval sitting on `pending`, so the screen never changed.
    mutationFn: ({ id, body }) => api.decide(id, body),
    onSuccess: () => { setModifying(null); setExclude(''); setNote(''); refresh(qc, 'decision') },
  })

  const list = data?.approvals ?? []
  const pending = list.filter((a) => a.status === 'pending')

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto max-w-3xl p-6">
        {pending.length === 0 && (
          <div className="flex flex-col items-center gap-2 py-16 text-center">
            <div className="bg-ok/10 ring-ok/25 flex size-11 items-center justify-center
                            rounded-full ring-1">
              <Check className="text-ok size-5" />
            </div>
            <p className="text-[14px] font-medium">Nothing needs your approval</p>
            <p className="text-muted-foreground max-w-sm text-[12.5px] leading-relaxed">
              The agent executes on its own below ₹1,50,000. It stops here only when a
              recovery crosses that authority, delays another customer's order, or has no
              safe option.
            </p>
          </div>
        )}

        {pending.map((a) => {
          const plan = a.plan?.chosen
          const alt = (a.plan?.options ?? [])[1]
          return (
            <motion.div key={a.id} layout initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }} className="mb-4">
              <Card className="border-warn/40 gap-0 py-0">
                <div className="p-5">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline"
                      className="border-warn/50 bg-warn/15 text-warn gap-1">
                      <AlertTriangle className="size-3" />approval required
                    </Badge>
                    <span className="text-muted-foreground ml-auto font-mono text-[10.5px]">
                      {a.incident_id}
                    </span>
                  </div>

                  <h3 className="mt-3 text-[17px] leading-snug font-semibold">{a.title}</h3>
                  <p className="text-muted-foreground mt-1 text-[12.5px]">{a.reason}</p>

                  <div className="mt-4 grid grid-cols-3 gap-4">
                    <div>
                      <div className="text-muted-foreground text-[10px] tracking-[0.12em] uppercase">
                        Proposed action</div>
                      <div className="mt-0.5 text-[13.5px] font-medium">{a.action}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground text-[10px] tracking-[0.12em] uppercase">
                        Cost</div>
                      <div className="text-danger mt-0.5 font-mono text-[17px]">
                        {inr(a.estimated_cost)}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground text-[10px] tracking-[0.12em] uppercase">
                        Your limit</div>
                      <div className="mt-0.5 font-mono text-[17px]">{inr(150000)}</div>
                    </div>
                  </div>

                  {a.brief && (
                    <>
                      <Separator className="my-4" />
                      <div className="text-muted-foreground mb-1 text-[10px] tracking-[0.12em] uppercase">
                        Agent reasoning</div>
                      <p className="text-[13px] leading-relaxed">{a.brief}</p>
                    </>
                  )}

                  {alt && (
                    <div className="glass mt-4 rounded-lg p-3">
                      <div className="text-muted-foreground text-[10px] tracking-[0.12em] uppercase">
                        If you reject, next best is</div>
                      <div className="mt-1 flex items-center gap-2">
                        <span className="text-[13px]">{alt.label}</span>
                        <span className="ml-auto font-mono text-[13px]">{inr(alt.total_cost)}</span>
                      </div>
                    </div>
                  )}

                  {modifying === a.incident_id ? (
                    <div className="glass mt-4 rounded-lg p-3">
                      <div className="text-muted-foreground mb-2 text-[10px] tracking-[0.12em] uppercase">
                        Add a constraint the agent must respect from now on
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Input value={exclude} placeholder="SUP-33"
                          onChange={(e) => setExclude(e.target.value.toUpperCase())}
                          className="h-8 w-32 font-mono text-[12px]" />
                        <Input value={note} placeholder="reason — e.g. reliability too low"
                          onChange={(e) => setNote(e.target.value)}
                          className="h-8 flex-1 text-[12px]" />
                        <Button size="sm" className="h-8" disabled={!exclude || decide.isPending}
                          onClick={() => decide.mutate({ id: a.incident_id, body: {
                            decision: 'modify', note, exclude: exclude.split(/[,\s]+/).filter(Boolean) } })}>
                          Apply & replan
                        </Button>
                      </div>
                      <p className="text-muted-foreground mt-2 text-[11px]">
                        This invalidates the current plan and forces the agent to solve again
                        without that supplier.
                      </p>
                    </div>
                  ) : (
                    <div className="mt-5 flex gap-2">
                      <Button className="gap-1.5" disabled={decide.isPending}
                        onClick={() => decide.mutate({ id: a.id,
                                                       body: { decision: 'approve' } })}>
                        {decide.isPending ? <Loader2 className="size-3.5 animate-spin" />
                                          : <Check className="size-3.5" />}
                        Approve
                      </Button>
                      <Button variant="secondary" className="gap-1.5"
                        onClick={() => setModifying(a.incident_id)}>
                        <PencilLine className="size-3.5" />Modify
                      </Button>
                      <Button variant="ghost" className="text-destructive gap-1.5"
                        onClick={() => decide.mutate({ id: a.id,
                                                       body: { decision: 'reject' } })}>
                        <X className="size-3.5" />Reject
                      </Button>
                    </div>
                  )}
                </div>
              </Card>
            </motion.div>
          )
        })}

        {list.filter((a) => a.status !== 'pending').length > 0 && (
          <>
            <h2 className="text-muted-foreground mt-8 mb-2 text-[10px] font-medium
                           tracking-[0.14em] uppercase">Decided</h2>
            {list.filter((a) => a.status !== 'pending').map((a) => (
              <div key={a.id} className="flex items-center gap-2 border-b py-2 text-[12.5px]">
                <Badge variant="outline" className={`text-[10px] ${
                  a.status === 'approved' ? 'border-ok/40 bg-ok/10 text-ok'
                                          : 'border-border bg-muted text-muted-foreground'}`}>
                  {a.status}</Badge>
                <span className="truncate">{a.action}</span>
                <span className="ml-auto font-mono">{inr(a.estimated_cost)}</span>
              </div>
            ))}
          </>
        )}
      </div>
    </ScrollArea>
  )
}
