import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AnimatePresence, motion } from 'motion/react'
import {
  AlertTriangle, Check, FlaskConical, Loader2, Play, Plus, RotateCcw, Trash2,
} from 'lucide-react'
import { api } from '@/lib/api'
import { refresh } from '@/lib/refresh'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import {
  Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle,
} from '@/components/ui/drawer'
import ScenarioForm from '@/components/ScenarioForm'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Input } from '@/components/ui/input'

/** Write your own disruption. Same event types, same execution path. */
function CustomTab({ onDone }) {
  const [name, setName] = useState('')
  const [tests, setTests] = useState('')
  const [events, setEvents] = useState([
    { at_h: 0, type: 'supplier_delay', params: { po_id: '', delay_days: 5 } },
  ])
  const [error, setError] = useState(null)

  const add = useMutation({
    mutationFn: (body) => api.customScenario(body),
    onSuccess: () => { setError(null); onDone() },
    onError: (e) => setError(e.message),
  })

  const incomplete = events.some((e) =>
    Object.values(e.params ?? {}).some((v) => v === '' || v === undefined || v === null))

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className="text-muted-foreground text-[10px] font-medium
                           tracking-[0.12em] uppercase">Name this test</span>
          <Input value={name} onChange={(e) => setName(e.target.value)}
                 placeholder="e.g. Two suppliers fail at once"
                 className="h-9 text-[13px]" />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-muted-foreground text-[10px] font-medium
                           tracking-[0.12em] uppercase">What is it testing?</span>
          <Input value={tests} onChange={(e) => setTests(e.target.value)}
                 placeholder="e.g. Does it refuse the cheap uncertified source?"
                 className="h-9 text-[13px]" />
        </label>
      </div>

      <ScenarioForm value={events} onChange={setEvents} />

      {error && (
        <div className="border-danger/40 bg-danger/[0.07] text-danger flex items-start gap-2
                        rounded-xl border px-4 py-3 text-[12.5px] leading-relaxed">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />{error}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button size="lg" disabled={add.isPending || !events.length || incomplete}
                onClick={() => add.mutate({
                  name: name || 'Custom test', tests: tests || undefined,
                  events, run: true })}
                className="h-11">
          {add.isPending ? <Loader2 className="size-4 animate-spin" />
                         : <Plus className="size-4" />}
          Register and run
        </Button>
        {incomplete && (
          <span className="text-muted-foreground text-[11.5px]">
            Every step needs all its fields filled in.
          </span>
        )}
      </div>
    </div>
  )
}

/**
 * Run a simulation.
 *
 * Layout note, because this broke once and the failure was invisible in code
 * review: `DrawerContent` ships with `h-auto`. A percentage or `flex-1` height
 * inside an auto-height column has nothing to resolve against, so the
 * ScrollArea collapses, the content renders at its natural height, and the
 * footer draws straight through the list above it. The fix is a *definite*
 * height on the content element and an unbroken `min-h-0` chain from there
 * down to the scroll viewport. Header and footer are `shrink-0` siblings of
 * the scrolling region — never overlays.
 */
export default function SimulationDrawer({ open, onOpenChange }) {
  const qc = useQueryClient()
  const [picked, setPicked] = useState(null)
  const [error, setError] = useState(null)

  const { data } = useQuery({
    queryKey: ['scenarios'], queryFn: api.scenarios,
    refetchInterval: open ? 2000 : false })

  const done = () => { setError(null); refresh(qc, 'simulation') }
  const fail = (e) => setError(e.message)

  // Starting a run is the one moment where "invalidate and hope" is not enough.
  // The backend answers the moment the scenario is *accepted*; the events it
  // describes are written by a background task over the following seconds. A
  // plain invalidate fires once, refetches an empty world, and then nothing
  // asks again — which is why the dashboard used to need a manual refresh
  // before any of the run appeared.
  //
  // So: sweep everything (including inactive queries), then explicitly refetch
  // the two queries the whole app is scoped by, and await them, so the run is
  // real on screen before the drawer closes. The socket and the poll carry it
  // from there.
  const run = useMutation({
    mutationFn: api.inject,
    onSuccess: async () => {
      setError(null)
      await qc.invalidateQueries({
        predicate: (q) => q.queryKey?.[0] !== 'llm',
        refetchType: 'all',
      })
      await Promise.all([
        qc.refetchQueries({ queryKey: ['now'] }),
        qc.refetchQueries({ queryKey: ['activeRun'] }),
      ])
      onOpenChange(false)
    },
    onError: fail,
  })
  const reset = useMutation({ mutationFn: api.reset, onSuccess: done, onError: fail })
  // A clean backend behind a stale React cache still shows ghosts, so the hard
  // reset clears both.
  const wipe = useMutation({
    mutationFn: api.hardReset,
    onSuccess: () => { setError(null); qc.clear(); refresh(qc, 'simulation') },
    onError: fail,
  })

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
    <Drawer open={open} onOpenChange={onOpenChange}>
      {/* definite height — everything below depends on it */}
      <DrawerContent className="h-[86vh] max-h-[86vh]">
        <div className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col overflow-hidden">

          <DrawerHeader className="shrink-0 gap-2 border-b px-7 py-5 text-left">
            <DrawerTitle className="flex items-center gap-2.5 text-[18px]">
              <FlaskConical className="text-primary size-4.5" />Run a simulation
            </DrawerTitle>
            <DrawerDescription className="max-w-2xl text-[13px] leading-relaxed">
              Each scenario feeds real events into the world on a simulated clock —
              one second of real time is one hour of plant time. The agent is never
              told which scenario is running, or what it is meant to conclude.
            </DrawerDescription>
          </DrawerHeader>

          <Tabs defaultValue="built-in"
                className="flex min-h-0 flex-1 flex-col gap-0 overflow-hidden">
            <TabsList className="mx-7 mt-4 mb-1 w-auto shrink-0 self-start">
              <TabsTrigger value="built-in" className="text-[12.5px]">Built-in</TabsTrigger>
              <TabsTrigger value="custom" className="text-[12.5px]">Write your own</TabsTrigger>
            </TabsList>

            <TabsContent value="built-in"
                         className="min-h-0 flex-1 overflow-hidden data-inactive:hidden">
              <ScrollArea className="h-full">
                <div className="flex flex-col gap-6 px-7 py-6">

                  {running.length > 0 && (
                    <div className="border-primary/40 bg-primary/[0.07] flex items-center
                                    gap-2.5 rounded-xl border px-4 py-3">
                      <Loader2 className="text-primary size-4 shrink-0 animate-spin" />
                      <span className="text-[13px]">
                        <b>{running.join(', ')}</b> is running now.
                      </span>
                    </div>
                  )}

                  {error && (
                    <div className="border-danger/40 bg-danger/[0.07] text-danger flex
                                    items-start gap-2 rounded-xl border px-4 py-3 text-[12.5px]">
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
                            ${on ? 'border-primary/50 bg-primary/[0.06]'
                                 : 'hover:bg-accent/40'}`}>
                          <div className="flex items-center gap-2.5">
                            {on && <Check className="text-primary size-3.5 shrink-0" />}
                            <span className="text-[14px] font-medium">{s.title}</span>
                            {live && (
                              <Badge variant="outline"
                                     className="border-primary/40 bg-primary/10 text-primary
                                                ml-auto shrink-0 text-[10px]">live</Badge>
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

                  {/* what the two destructive buttons below actually destroy */}
                  <Separator />
                  <div className="text-muted-foreground/70 grid gap-x-6 gap-y-2 text-[11px]
                                  leading-relaxed sm:grid-cols-2">
                    <div>
                      <b className="text-muted-foreground">Reset world</b> — re-seeds
                      inventory, orders and shipments, and clears the active run. Past runs
                      and their scores survive, so you keep the comparison you were tuning
                      against.
                    </div>
                    <div>
                      <b className="text-danger/80">Wipe everything</b> — deletes every run,
                      incident, decision, message, task, approval and score. Only the
                      baseline world survives: suppliers, components, plants and policies.
                    </div>
                  </div>
                </div>
              </ScrollArea>
            </TabsContent>

            <TabsContent value="custom"
                         className="min-h-0 flex-1 overflow-hidden data-inactive:hidden">
              <ScrollArea className="h-full">
                <div className="px-7 py-6">
                  <CustomTab onDone={() => { refresh(qc, 'simulation'); onOpenChange(false) }} />
                </div>
              </ScrollArea>
            </TabsContent>
          </Tabs>

          {/* footer — a sibling of the scroll region, never an overlay */}
          <div className="bg-popover shrink-0 border-t px-7 py-4">
            <div className="flex flex-wrap items-center gap-3">
              <Button size="lg" disabled={!selected || run.isPending}
                      onClick={() => selected && run.mutate(selected.id)}
                      className="h-11 flex-1 min-w-[14rem]">
                {run.isPending ? <Loader2 className="size-4 animate-spin" />
                               : <Play className="size-4" />}
                Run{selTitle ? ` “${selTitle}”` : ''}
              </Button>

              <Button variant="outline" size="lg" disabled={reset.isPending}
                      onClick={() => reset.mutate('demo')} className="h-11">
                {reset.isPending ? <Loader2 className="size-4 animate-spin" />
                                 : <RotateCcw className="size-4" />}
                Reset world
              </Button>

              <Button variant="outline" size="lg" disabled={wipe.isPending}
                      onClick={() => wipe.mutate()}
                      className="border-danger/40 text-danger hover:bg-danger/10 h-11">
                {wipe.isPending ? <Loader2 className="size-4 animate-spin" />
                                : <Trash2 className="size-4" />}
                Wipe everything
              </Button>
            </div>

            {wipe.isSuccess && (
              <div className="border-ok/40 bg-ok/[0.07] mt-3 rounded-lg border px-3 py-2
                              text-[12px] leading-relaxed">
                Everything cleared. No run, no incidents, no decisions, no logs, no score.
              </div>
            )}
          </div>
        </div>
      </DrawerContent>
    </Drawer>
  )
}
