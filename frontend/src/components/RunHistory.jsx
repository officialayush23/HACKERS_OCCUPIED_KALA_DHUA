import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Gauge, Loader2 } from 'lucide-react'
import { api } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'

const STATUS = {
  completed: 'border-ok/40 bg-ok/10 text-ok',
  running:   'border-info/40 bg-info/10 text-info',
  failed:    'border-danger/50 bg-danger/15 text-danger',
  cancelled: 'border-border bg-muted text-muted-foreground',
  reset:     'border-border bg-muted text-muted-foreground',
}

export default function RunHistory({ revision }) {
  const qc = useQueryClient()
  const { data } = useQuery({ queryKey: ['runs'], queryFn: api.runs })
  const score = useMutation({
    mutationFn: api.score,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['runs'] }),
  })

  const runs = data?.runs ?? []

  return (
    <div className="flex flex-col gap-2 p-3">
      <h2 className="flex items-center gap-1.5 text-xs font-semibold tracking-widest text-muted-foreground uppercase">
        <Gauge className="size-3.5" /> Self-scored runs
      </h2>
      {runs.length === 0 && (
        <p className="text-xs text-muted-foreground">No runs yet.</p>
      )}
      {runs.map((r) => (
        <div key={r.id} className="rounded-md border bg-card px-2.5 py-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <span className="font-mono text-xs">run {r.id}</span>
              <span className="text-[11px] text-muted-foreground">{r.scenario_id}</span>
            </div>
            <Badge variant="outline" className={STATUS[r.status] ?? ''}>{r.status}</Badge>
          </div>
          <div className="mt-1 flex items-center gap-2">
            <span className="text-[11px] text-muted-foreground">{r.event_count} events</span>
            {r.total != null ? (
              <>
                <span className="ml-auto font-mono text-sm tabular-nums">
                  {Number(r.total).toFixed(3)}
                </span>
                <Progress value={Number(r.total) * 100} className="h-1 w-16" />
              </>
            ) : (
              <Button size="sm" variant="secondary" className="ml-auto h-6 px-2 text-[11px]"
                disabled={score.isPending} onClick={() => score.mutate(r.id)}>
                {score.isPending ? <Loader2 className="animate-spin" /> : null} Score
              </Button>
            )}
          </div>
          {r.total != null && (
            <div className="mt-1.5 grid grid-cols-6 gap-1 text-[10px] text-muted-foreground">
              {[['cont', r.continuity], ['cost', r.cost], ['risk', r.risk],
                ['tool', r.tool_eff], ['recov', r.recovery], ['audit', r.audit]].map(([k, v]) => (
                <div key={k} className="text-center">
                  <div>{k}</div>
                  <div className="font-mono tabular-nums text-foreground">{Number(v).toFixed(2)}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
