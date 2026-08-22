import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AnimatePresence, motion } from 'motion/react'
import {
  AlertTriangle, Check, FlaskConical, Loader2, Play, Plus, RotateCcw,
} from 'lucide-react'
import { api } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle,
} from '@/components/ui/sheet'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'

const EXAMPLE = `[
  { "at_h": 0,  "type": "supplier_delay",
    "params": { "po_id": "PO-7712", "delay_days": 6 } },
  { "at_h": 8,  "type": "demand_spike",
    "params": { "component_id": "COMP-104", "daily_usage": 200 },
    "note": "an OEM pulls a bigger order forward" },
  { "at_h": 12, "type": "supplier_claim",
    "params": { "po_id": "PO-7712", "claim": "dispatched" } },
  { "at_h": 13, "type": "tracking_state",
    "params": { "po_id": "PO-7712", "tracking_status": "not_shipped" } }
]`

/** Write your own disruption. Same event types, same execution path. */
function CustomTab({ eventTypes, onDone }) {
  const [name, setName] = useState('')
  const [json, setJson] = useState(EXAMPLE)
  const [error, setError] = useState(null)

  const add = useMutation({
    mutationFn: (body) => api.customScenario(body),
    onSuccess: () => { setError(null); onDone() },
    onError: (e) => setError(e.message),
  })

  const submit = () => {
    let events
    try {
      events = JSON.parse(json)
    } catch (e) {
      return setError(`That is not valid JSON — ${e.message}`)
    }
    setError(null)
    add.mutate({ name: name || 'Custom scenario', events, run: true })
  }

  return (
    <div className="flex flex-col gap-5">
      <p className="text-muted-foreground text-[12.5px] leading-relaxed">
        Write your own disruption and the agent will handle it live. It runs down the
        same code path as the built-in scenarios — there is no separate mode. Custom
        scenarios live in memory only and disappear when the server restarts.
      </p>

      <label className="flex flex-col gap-1.5">
        <span className="text-muted-foreground text-[10px] font-medium
                         tracking-[0.12em] uppercase">Name it</span>
        <Input value={name} onChange={(e) => setName(e.target.value)}
               placeholder="e.g. Two suppliers fail at once"
               className="h-9 text-[13px]" />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-muted-foreground text-[10px] font-medium
                         tracking-[0.12em] uppercase">Events</span>
        <Textarea value={json} onChange={(e) => setJson(e.target.value)}
                  spellCheck={false} rows={14}
                  className="font-mono text-[11.5px] leading-relaxed" />
        <span className="text-muted-foreground text-[10.5px] leading-relaxed">
          <b>at_h</b> is when it fires, in simulated hours from the start.
          One real second is one simulated hour.
        </span>
      </label>

      <div>
        <div className="text-muted-foreground mb-2 text-[10px] font-medium
                        tracking-[0.12em] uppercase">Event types you can use</div>
        <div className="flex flex-wrap gap-1.5">
          {(eventTypes ?? []).map((t) => (
            <Badge key={t} variant="outline" className="font-mono text-[10px]">{t}</Badge>
          ))}
        </div>
      </div>

      {error && (
        <div className="border-danger/40 bg-danger/[0.07] text-danger flex items-start gap-2
                        rounded-xl border px-4 py-3 text-[12.5px] leading-relaxed">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />{error}
        </div>
      )}

      <Button size="lg" disabled={add.isPending} onClick={submit} className="h-10">
        {add.isPending ? <Loader2 className="size-4 animate-spin" />
                       : <Plus className="size-4" />}
        Register and run
      </Button>
    </div>
  )
}

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

  // Read everything out up front. AnimatePresence re-renders the exiting child,
  // so any dereference of `selected` inside it crashes the instant it is null.
  const selId    = selected?.id ?? 'none'
  const selTitle = selected?.title ?? ''
  const selFeed  = selected?.feed ?? []
  const selCount = selected?.event_count ?? 0
  const selSpan  = selected?.span_sim_hours ?? 0

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

        <Tabs defaultValue="built-in" className="flex min-h-0 flex-1 flex-col gap-0">
          <TabsList className="mx-7 mt-5 w-auto self-start">
            <TabsTrigger value="built-in" className="text-[12.5px]">Built-in</TabsTrigger>
            <TabsTrigger value="custom" className="text-[12.5px]">Write your own</TabsTrigger>
          </TabsList>

          <TabsContent value="custom" className="min-h-0 flex-1">
            <ScrollArea className="h-full">
              <div className="p-7">
                <CustomTab eventTypes={data?.event_types}
                           onDone={() => { qc.invalidateQueries(); onOpenChange(false) }} />
              </div>
            </ScrollArea>
          </TabsContent>

          <TabsContent value="built-in" className="min-h-0 flex-1">
        <ScrollArea className="h-full">
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
              {selFeed.length > 0 && (
                <motion.div key={selId}
                            initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0 }}>
                  <Separator className="mb-6" />
                  <h3 className="text-muted-foreground text-[10px] font-medium
                                 tracking-[0.14em] uppercase">
                    What gets fed in
                  </h3>
                  <p className="text-muted-foreground mt-2 text-[12px] leading-relaxed">
                    {selCount} event{selCount > 1 ? 's' : ''} over{' '}
                    {selSpan} simulated hours.
                  </p>

                  <ol className="mt-4 flex flex-col gap-3.5">
                    {selFeed.map((f, i) => (
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
          </TabsContent>
        </Tabs>

        {/* the only two things you can do here */}
        <div className="flex items-center gap-3 border-t px-7 py-5">
          <Button size="lg" disabled={!selected || run.isPending}
                  onClick={() => selected && run.mutate(selected.id)}
                  className="h-10 flex-1">
            {run.isPending ? <Loader2 className="size-4 animate-spin" />
                           : <Play className="size-4" />}
            Run{selTitle ? ` \u201c${selTitle}\u201d` : ''}
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
