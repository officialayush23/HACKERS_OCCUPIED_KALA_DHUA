import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AnimatePresence, motion } from 'motion/react'
import { ChevronDown, ScrollText, Search, X } from 'lucide-react'
import { api } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'

/**
 * The whole log, across every run.
 *
 * Distinct from the Decision Log, which groups the *active* run into cases. This
 * is the flat, unfiltered record — every event, every actor, every run — because
 * the question "what actually happened, in order" needs an answer that is not
 * curated.
 *
 * Three projections of the same row, again: the summary a manager reads, the
 * reason the agent gives, and the payload underneath. Never three logs.
 */

const ALL = '__all__'

export default function AuditPage() {
  const [runId, setRunId] = useState(ALL)
  const [actor, setActor] = useState(ALL)
  const [type, setType] = useState(ALL)
  const [q, setQ] = useState('')
  const [openRow, setOpenRow] = useState(null)

  // The whole history, not just the active run — that is the point of this page.
  const { data } = useQuery({
    queryKey: ['audit-all', runId],
    queryFn: () => api.auditAll(runId === ALL ? null : Number(runId)),
  })
  const { data: runs } = useQuery({ queryKey: ['runs'], queryFn: api.runs })

  const events = data?.events ?? []

  const actors = useMemo(
    () => [...new Set(events.map((e) => e.actor).filter(Boolean))].sort(), [events])
  const types = useMemo(
    () => [...new Set(events.map((e) => e.event_type).filter(Boolean))].sort(), [events])

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return events.filter((e) =>
      (actor === ALL || e.actor === actor) &&
      (type === ALL || e.event_type === type) &&
      (!needle ||
        (e.human_summary ?? '').toLowerCase().includes(needle) ||
        (e.agent_reason ?? '').toLowerCase().includes(needle) ||
        (e.incident_id ?? '').toLowerCase().includes(needle) ||
        (e.event_type ?? '').toLowerCase().includes(needle)))
  }, [events, actor, type, q])

  const clear = () => { setActor(ALL); setType(ALL); setQ(''); setRunId(ALL) }
  const filtering = actor !== ALL || type !== ALL || q.trim() || runId !== ALL

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2.5 border-b px-6 py-4">
        <h2 className="text-muted-foreground flex items-center gap-2 text-[10px] font-medium
                       tracking-[0.14em] uppercase">
          <ScrollText className="size-3.5" />Audit trail
        </h2>

        <Select value={runId} onValueChange={setRunId}>
          <SelectTrigger className="ml-auto h-8 w-[13rem] text-[12px]">
            <SelectValue placeholder="All runs" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL} className="text-[12px]">All runs</SelectItem>
            {(runs?.runs ?? []).map((r) => (
              <SelectItem key={r.id} value={String(r.id)} className="text-[12px]">
                run {r.id} · {r.scenario_id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={actor} onValueChange={setActor}>
          <SelectTrigger className="h-8 w-[10rem] text-[12px]">
            <SelectValue placeholder="All actors" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL} className="text-[12px]">All actors</SelectItem>
            {actors.map((a) => (
              <SelectItem key={a} value={a} className="text-[12px]">{a}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={type} onValueChange={setType}>
          <SelectTrigger className="h-8 w-[14rem] text-[12px]">
            <SelectValue placeholder="All event types" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL} className="text-[12px]">All event types</SelectItem>
            {types.map((t) => (
              <SelectItem key={t} value={t} className="font-mono text-[11.5px]">{t}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="relative">
          <Search className="text-muted-foreground absolute top-1/2 left-2.5 size-3.5
                             -translate-y-1/2" />
          <Input value={q} onChange={(e) => setQ(e.target.value)}
                 placeholder="Search…" className="h-8 w-[13rem] pl-8 text-[12px]" />
        </div>

        {filtering && (
          <Button variant="ghost" size="sm" onClick={clear}
                  className="text-muted-foreground h-8 gap-1 px-2 text-[11.5px]">
            <X className="size-3" />clear
          </Button>
        )}
      </div>

      <div className="text-muted-foreground border-b px-6 py-2 text-[11px]">
        {filtered.length} of {events.length} events
        {runId === ALL ? ' across every run' : ` in run ${runId}`}
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="px-6">
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-20 text-center">
              <ScrollText className="text-muted-foreground/40 size-7" />
              <p className="text-[14px] font-medium">Nothing matches</p>
              <p className="text-muted-foreground max-w-sm text-[12.5px] leading-relaxed">
                {events.length === 0
                  ? 'No events have been recorded yet. Run a scenario and every step lands here.'
                  : 'Try widening the filters.'}
              </p>
            </div>
          ) : filtered.map((e) => {
            const open = openRow === e.sequence
            const t = new Date(e.ts).toLocaleTimeString('en-IN',
              { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
            return (
              <div key={e.sequence} className="border-b last:border-0">
                <button onClick={() => setOpenRow(open ? null : e.sequence)}
                        className="hover:bg-accent/30 flex w-full items-start gap-3.5 py-3.5
                                   text-left transition-colors">
                  <span className="text-muted-foreground w-16 shrink-0 pt-0.5 font-mono
                                   text-[11px] tabular-nums">{t}</span>
                  <Badge variant="outline"
                         className="mt-px shrink-0 font-mono text-[9.5px]">
                    {e.event_type}
                  </Badge>
                  <span className="min-w-0 flex-1 text-[13px] leading-relaxed">
                    {e.human_summary}
                  </span>
                  <Badge variant="outline"
                         className="text-muted-foreground mt-px shrink-0 text-[9.5px]">
                    {e.actor}
                  </Badge>
                  {e.scenario_run_id != null && (
                    <span className="text-muted-foreground shrink-0 pt-0.5 font-mono
                                     text-[10px]">run {e.scenario_run_id}</span>
                  )}
                  <ChevronDown className={`text-muted-foreground mt-0.5 size-3.5 shrink-0
                    transition-transform ${open ? '' : '-rotate-90'}`} />
                </button>

                <AnimatePresence initial={false}>
                  {open && (
                    <motion.div initial={{ height: 0, opacity: 0 }}
                                animate={{ height: 'auto', opacity: 1 }}
                                exit={{ height: 0, opacity: 0 }}
                                className="overflow-hidden">
                      <div className="flex flex-col gap-4 pb-5 pl-[5.4rem]">
                        {e.agent_reason && (
                          <div>
                            <div className="text-muted-foreground text-[10px] font-medium
                                            tracking-[0.1em] uppercase">Agent's reason</div>
                            <p className="mt-1.5 text-[12.5px] leading-relaxed">
                              {e.agent_reason}
                            </p>
                          </div>
                        )}
                        <div>
                          <div className="text-muted-foreground text-[10px] font-medium
                                          tracking-[0.1em] uppercase">Technical</div>
                          <pre className="bg-muted/40 mt-1.5 max-h-72 overflow-auto rounded-lg
                                          border p-3 font-mono text-[10.5px] leading-relaxed">
{JSON.stringify({
  sequence: e.sequence,
  incident_id: e.incident_id,
  scenario_run_id: e.scenario_run_id,
  simulated_at_seconds: e.simulated_at_seconds,
  payload: e.technical_payload,
}, null, 2)}
                          </pre>
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            )
          })}
        </div>

        <p className="text-muted-foreground/70 px-6 py-6 text-[11px] leading-relaxed">
          Append-only. There is no UPDATE or DELETE grant on this table and no foreign key
          into the mutable world, so resetting the demo cannot rewrite what happened.
        </p>
      </ScrollArea>
    </div>
  )
}
