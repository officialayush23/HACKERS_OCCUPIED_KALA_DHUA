import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Play, RotateCcw, Zap, PenLine, Loader2, AlertTriangle } from 'lucide-react'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Separator } from '@/components/ui/separator'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'

const HINTS = {
  supplier_delay:       '{ "po_id": "PO-7712", "delay_days": 5 }',
  inventory_correction: '{ "component_id": "COMP-104", "usable_stock": 250 }',
  supplier_claim:       '{ "po_id": "PO-7712", "claim": "dispatched" }',
  tracking_state:       '{ "po_id": "PO-7712", "tracking_status": "label_created_no_pickup" }',
  demand_spike:         '{ "component_id": "COMP-104", "daily_usage": 180 }',
  priority_change:      '{ "production_order_id": "PROD-882", "priority": "critical" }',
  deadline_pull_in:     '{ "production_order_id": "PROD-882", "hours_from_now": 12 }',
  quality_failure:      '{ "supplier_id": "SUP-18", "new_quality_score": 0.48 }',
  expedite_unavailable: '{ "reason": "Carrier capacity exhausted" }',
  hazmat_disruption:    '{ "po_id": "PO-7718" }',
}

export default function ControlPanel() {
  const qc = useQueryClient()
  const [type, setType] = useState('supplier_delay')
  const [params, setParams] = useState(HINTS.supplier_delay)
  const [note, setNote] = useState('')
  const [error, setError] = useState(null)

  const { data } = useQuery({
    queryKey: ['scenarios'],
    queryFn: api.scenarios,
  })

  const invalidate = () => {
    setError(null)
    qc.invalidateQueries({ queryKey: ['scenarios'] })
    qc.invalidateQueries({ queryKey: ['world'] })
    qc.invalidateQueries({ queryKey: ['runs'] })
  }
  const onError = (e) => setError(e.message)

  const inject = useMutation({ mutationFn: api.inject, onSuccess: invalidate, onError })
  const reset = useMutation({ mutationFn: api.reset, onSuccess: invalidate, onError })
  const fire = useMutation({ mutationFn: api.customEvent, onSuccess: invalidate, onError })
  const log = useMutation({
    mutationFn: api.log,
    onSuccess: () => { setNote(''); invalidate() },
    onError,
  })

  const running = data?.running ?? []

  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">
            Inject disruption
          </h2>
          <div className="flex gap-1">
            <Button size="sm" variant="ghost" disabled={reset.isPending}
                    onClick={() => reset.mutate('demo')} title="Reset world, keep run history">
              {reset.isPending ? <Loader2 className="animate-spin" /> : <RotateCcw />}
              Reset
            </Button>
            <Button size="sm" variant="ghost"
                    className="text-destructive hover:text-destructive"
                    onClick={() => reset.mutate('hard')} title="Also wipe all run history">
              Hard
            </Button>
          </div>
        </div>

        {(data?.scenarios ?? []).map((s) => {
          const isRunning = running.includes(s.id)
          return (
            <Card key={s.id}
              className={`cursor-pointer gap-0 py-0 transition-colors
                ${isRunning ? 'border-primary/50' : 'hover:border-primary/40'}`}
              onClick={() => !isRunning && !inject.isPending && inject.mutate(s.id)}>
              <CardContent className="p-3">
                <div className="flex items-start justify-between gap-2">
                  <span className="text-sm font-medium leading-tight">{s.title}</span>
                  {isRunning
                    ? <Badge className="shrink-0 gap-1"><Loader2 className="animate-spin" />live</Badge>
                    : <Badge variant="outline" className="shrink-0 font-mono">{s.id.split('-')[0]}</Badge>}
                </div>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{s.tests}</p>
                <div className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <Play className="size-3" />
                  {s.event_count} events · {s.span_sim_hours}h simulated
                </div>
              </CardContent>
            </Card>
          )
        })}
      </section>

      <Separator />

      <section className="flex flex-col gap-2">
        <h2 className="flex items-center gap-1.5 text-xs font-semibold tracking-widest text-muted-foreground uppercase">
          <Zap className="size-3.5" /> Custom event
        </h2>
        <Select value={type} onValueChange={(v) => { setType(v); setParams(HINTS[v] ?? '{}') }}>
          <SelectTrigger size="sm" className="w-full font-mono text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(data?.event_types ?? []).map((t) => (
              <SelectItem key={t} value={t} className="font-mono text-xs">{t}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Textarea rows={3} value={params} spellCheck={false}
          onChange={(e) => setParams(e.target.value)}
          className="resize-none font-mono text-xs" />
        <Button size="sm" disabled={fire.isPending}
          onClick={() => {
            let parsed
            try { parsed = JSON.parse(params) }
            catch { setError('Params must be valid JSON'); return }
            fire.mutate({ type, params: parsed })
          }}>
          {fire.isPending ? <Loader2 className="animate-spin" /> : <Zap />} Fire event
        </Button>
      </section>

      <Separator />

      <section className="flex flex-col gap-2">
        <h2 className="flex items-center gap-1.5 text-xs font-semibold tracking-widest text-muted-foreground uppercase">
          <PenLine className="size-3.5" /> Manual log
        </h2>
        <div className="flex gap-2">
          <Input value={note} placeholder="Note into the audit trail…"
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && note.trim() && log.mutate(note.trim())}
            className="h-8 text-xs" />
          <Button size="sm" variant="secondary" disabled={!note.trim() || log.isPending}
            onClick={() => log.mutate(note.trim())}>Add</Button>
        </div>
      </section>

      {error && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-destructive" />
          <p className="text-xs leading-relaxed text-destructive">{error}</p>
        </div>
      )}
    </div>
  )
}
