import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AnimatePresence, motion } from 'motion/react'
import {
  AlertTriangle, Check, FlaskConical, Loader2, Play, RotateCcw, Square,
} from 'lucide-react'
import { api } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle,
} from '@/components/ui/sheet'

/**
 * Run a simulation.
 *
 * This replaces a raw JSON textarea that produced a 400 whenever anyone typed
 * anything slightly wrong — which is every time, under demo pressure. A
 * scenario is now a thing you pick and can read: what it feeds in, in what
 * order, and what it is testing about the agent.
 *
 * Nothing here is hidden. Judges should be able to see the exact inputs and
 * satisfy themselves that the agent is not being told the answer.
 */
export default function SimulationDrawer({ open, onOpenChange }) {
  const qc = useQueryClient()
  const [picked, setPicked] = useState(null)
  const [error, setError] = useState(null)

  const { data } = useQuery({
    queryKey: ['scenarios'], queryFn: api.scenarios,
    refetchInterval: open ? 2000 : false })

  const done = () => { setError(null); qc.invalidateQueries() }
  const fail = (e) => setError(e.message)

  const run = useMutation({ mutationFn: api.inject, onSuccess: done, onError: fail })
  const reset = useMutation({ mutationFn: api.reset, onSuccess: done, onError: fail })

  const scenarios = data?.scenarios ?? []
  const running = data?.running ?? []
  const selected = scenarios.find((s) => s.id === picked) ?? scenarios[0] ?? null

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-[34rem]">
        <SheetHeader className="gap-2 border-b px-7 py-6">
          <SheetTitle className="flex items-center gap-2.5 text-[18px]">
            <FlaskConical className="text-primary size-4.5" />Run a simulation
          </SheetTitle>
          <SheetDescription className="text-[13px] leading-relaxed">
            Each scenario feeds real events into the world on a simulated clock —
            one second of real time is one hour of plant time. The agent is never
            told which scenario is running, or what it is meant to conclude.
          </SheetDescription>
        </SheetHeader>

        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-6 p-7">

            {running.length > 0 && (
              <div className="border-primary/40 bg-primary/[0.07] flex items-center gap-2.5
                              rounded-xl border px-4 py-3">
                <Loader2 className="text-primary size-4 shrink-0 animate-spin" />
                <span className="text-[13px]">
                  <b>{running.join(', ')}</b> is running now.
                </span>
              </div>
            )}

            {error && (
              <div className="border-danger/40 bg-danger/[0.07] text-danger flex items-start
                              gap-2 rounded-xl border px-4 py-3 text-[12.5px]">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />{error}
              </div>
            )}

            {/* pick one */}
            <div className="flex flex-col gap-2">
              {scenarios.map((s) => {
                const on = selected?.id === s.id
                const live = running.includes(s.id)
                return (
                  <button key={s.id} onClick={() => setPicked(s.id)}
                    className={`rounded-xl border px-4 py-3.5 text-left transition-colors
                      ${on ? 'border-primary/50 bg-primary/[0.06]' : 'hover:bg-accent/40'}`}>
                    <div className="flex items-center gap-2.5">
                      {on && <Check className="text-primary size-3.5 shrink-0" />}
                      <span className="text-[14px] font-medium">{s.title}</span>
                      {live && (
                        <Badge variant="outline"
                               className="border-primary/40 bg-primary/10 text-primary ml-auto
                                          shrink-0 text-[10px]">live</Badge>
                      )}
                    </div>
                    <p className="text-muted-foreground mt-1.5 text-[12px] leading-relaxed">
                      {s.tests}
                    </p>
                  </button>
                )
              })}
            </div>

            {/* what it feeds in */}
            <AnimatePresence mode="wait">
              {selected && (
                <motion.div key={selected.id}
                            initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0 }}>
                  <Separator className="mb-6" />
                  <h3 className="text-muted-foreground text-[10px] font-medium
                                 tracking-[0.14em] uppercase">
                    What gets fed in
                  </h3>
                  <p className="text-muted-foreground mt-2 text-[12px] leading-relaxed">
                    {selected.event_count} event{selected.event_count > 1 ? 's' : ''} over
                    {' '}{selected.span_sim_hours} simulated hours.
                  </p>

                  <ol className="mt-4 flex flex-col gap-3.5">
                    {(selected.feed ?? []).map((f, i) => (
                      <li key={i} className="flex gap-3">
                        <span className="text-muted-foreground w-10 shrink-0 pt-[1px]
                                         font-mono text-[11px] tabular-nums">
                          +{f.at_h}h
                        </span>
                        <span className="min-w-0">
                          <span className="block text-[13px] leading-snug">{f.what}</span>
                          {f.note && (
                            <span className="text-muted-foreground block text-[11.5px]
                                             leading-relaxed">{f.note}</span>
                          )}
                        </span>
                      </li>
                    ))}
                  </ol>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </ScrollArea>

        {/* the only two things you can do here */}
        <div className="flex items-center gap-3 border-t px-7 py-5">
          <Button size="lg" disabled={!selected || run.isPending}
                  onClick={() => run.mutate(selected.id)} className="h-10 flex-1">
            {run.isPending ? <Loader2 className="size-4 animate-spin" />
                           : <Play className="size-4" />}
            Run {selected?.title ? `“${selected.title}”` : ''}
          </Button>

          <Button variant="outline" size="lg" disabled={reset.isPending}
                  onClick={() => reset.mutate('demo')} className="h-10"
                  title="Re-seed the world. Run history is kept.">
            {reset.isPending ? <Loader2 className="size-4 animate-spin" />
                             : <RotateCcw className="size-4" />}
            Reset world
          </Button>
        </div>

        <p className="text-muted-foreground/70 px-7 pb-5 text-[11px] leading-relaxed">
          Reset re-seeds inventory, orders and shipments. The audit log and past run scores
          survive it, so you never lose the comparison you are tuning against.
        </p>
      </SheetContent>
    </Sheet>
  )
}
