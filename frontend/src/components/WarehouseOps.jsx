import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { motion } from 'motion/react'
import {
  AlertTriangle, ClipboardCheck, Flame, Loader2, PackageCheck, Truck,
} from 'lucide-react'
import { api } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Stat } from '@/components/Shell'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'

/**
 * Warehouse Operations — physical reality.
 *
 * No supply-chain map here on purpose. The operator cares about what is on the
 * floor, what is arriving, and what the agent has asked them to check.
 */
export default function WarehouseOps({ revision }) {
  const qc = useQueryClient()
  const [counts, setCounts] = useState({})

  const { data } = useQuery({
    queryKey: ['warehouse', revision], queryFn: api.warehouse, refetchInterval: 3000 })

  const complete = useMutation({
    mutationFn: ({ id, body }) => api.completeTask(id, body),
    onSuccess: () => qc.invalidateQueries(),
  })
  const receive = useMutation({
    mutationFn: api.receive, onSuccess: () => qc.invalidateQueries(),
  })

  const tasks = (data?.tasks ?? []).filter((t) => t.status !== 'cancelled')
  const openTasks = tasks.filter((t) => t.status === 'open')
  const inv = data?.inventory ?? []
  const inbound = data?.inbound ?? []
  const held = inv.reduce((s, r) => s + (r.quarantined_stock ?? 0), 0)

  return (
    <div className="grid h-full grid-cols-12">
      <div className="col-span-7 flex min-h-0 flex-col overflow-y-auto p-5">
        <div className="glass grid grid-cols-4 gap-6 rounded-xl px-5 py-4">
          <Stat label="Action required" value={openTasks.length} icon={ClipboardCheck}
                sub={openTasks.length ? 'agent is waiting' : 'nothing pending'}
                tone={openTasks.length ? 'text-warn' : ''} />
          <Stat label="Inbound today" value={inbound.length} icon={Truck}
                sub={`${inbound.filter((i) => i.status === 'delayed').length} delayed`} />
          <Stat label="On quality hold" value={held} icon={Flame}
                sub="units not usable" tone={held ? 'text-danger' : ''} />
          <Stat label="Components" value={inv.length} icon={PackageCheck}
                sub="tracked at this plant" />
        </div>

        <h2 className="text-muted-foreground mt-5 mb-2 text-[10px] font-medium
                       tracking-[0.14em] uppercase">Agent requests</h2>

        {openTasks.length === 0 && (
          <p className="text-muted-foreground py-4 text-[12.5px]">
            No open requests. The agent will raise a task here when it needs the floor to
            confirm something.
          </p>
        )}

        <div className="flex flex-col gap-2.5">
          {openTasks.map((t) => {
            const c = counts[t.id] ?? {}
            return (
              <motion.div key={t.id} layout initial={{ opacity: 0, y: 8 }}
                          animate={{ opacity: 1, y: 0 }}>
                <Card className="gap-0 py-0">
                  <div className="p-4">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline"
                        className="border-warn/50 bg-warn/15 text-warn">{t.priority}</Badge>
                      <span className="text-[13.5px] font-medium">
                        {t.component_name || t.component_id}
                      </span>
                      <span className="text-muted-foreground ml-auto font-mono text-[10px]">
                        task #{t.id}
                      </span>
                    </div>
                    <p className="text-muted-foreground mt-1.5 text-[12.5px] leading-relaxed">
                      {t.instructions}
                    </p>

                    <div className="mt-3 flex flex-wrap items-end gap-2">
                      <label className="flex flex-col gap-1">
                        <span className="text-muted-foreground text-[10px] tracking-wide uppercase">
                          Usable
                        </span>
                        <Input type="number" className="h-8 w-24 font-mono text-[12.5px]"
                          value={c.usable ?? ''} placeholder="390"
                          onChange={(e) => setCounts({ ...counts,
                            [t.id]: { ...c, usable: e.target.value } })} />
                      </label>
                      <label className="flex flex-col gap-1">
                        <span className="text-muted-foreground text-[10px] tracking-wide uppercase">
                          Quality hold
                        </span>
                        <Input type="number" className="h-8 w-24 font-mono text-[12.5px]"
                          value={c.held ?? ''} placeholder="410"
                          onChange={(e) => setCounts({ ...counts,
                            [t.id]: { ...c, held: e.target.value } })} />
                      </label>
                      <Button size="sm" className="h-8"
                        disabled={complete.isPending || c.usable === undefined || c.usable === ''}
                        onClick={() => complete.mutate({ id: t.id, body: {
                          usable_stock: Number(c.usable),
                          quarantined_stock: Number(c.held || 0),
                          reason: 'Quality inspection' } })}>
                        {complete.isPending && <Loader2 className="size-3.5 animate-spin" />}
                        Submit count
                      </Button>
                      <span className="text-muted-foreground text-[11px]">
                        This goes straight to the agent.
                      </span>
                    </div>
                  </div>
                </Card>
              </motion.div>
            )
          })}
        </div>

        <h2 className="text-muted-foreground mt-6 mb-2 text-[10px] font-medium
                       tracking-[0.14em] uppercase">Inbound — receive & inspect</h2>
        <div className="flex flex-col gap-2">
          {inbound.map((p) => {
            const c = counts[p.id] ?? {}
            const lying = ['dispatched', 'in_transit'].includes(p.supplier_claim) &&
              ['label_created_no_pickup', 'not_shipped'].includes(p.tracking_status)
            return (
              <Card key={p.id} className="gap-0 py-0">
                <div className="p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[11.5px]">{p.id}</span>
                    <span className="text-[12.5px]">{p.component_name}</span>
                    <span className="text-muted-foreground text-[11.5px]">
                      {p.supplier_name} · {p.quantity} units
                    </span>
                    <Badge variant="outline" className={`ml-auto text-[10px] ${
                      p.status === 'delayed' ? 'border-warn/50 bg-warn/15 text-warn' : ''}`}>
                      {p.status}
                    </Badge>
                  </div>
                  {lying && (
                    <div className="text-danger mt-1.5 flex items-center gap-1 text-[11px]">
                      <AlertTriangle className="size-3" />
                      supplier claims “{p.supplier_claim}”, carrier shows “{p.tracking_status}”
                    </div>
                  )}
                  <div className="mt-2 flex flex-wrap items-end gap-2">
                    <Input type="number" placeholder="received" className="h-7 w-24 text-[12px]"
                      value={c.recv ?? ''} onChange={(e) => setCounts({ ...counts,
                        [p.id]: { ...c, recv: e.target.value } })} />
                    <Input type="number" placeholder="passed QC" className="h-7 w-24 text-[12px]"
                      value={c.ok ?? ''} onChange={(e) => setCounts({ ...counts,
                        [p.id]: { ...c, ok: e.target.value } })} />
                    <Button size="sm" variant="secondary" className="h-7 text-[11.5px]"
                      disabled={!c.recv || receive.isPending}
                      onClick={() => receive.mutate({ po_id: p.id,
                        quantity_received: Number(c.recv),
                        quantity_approved: Number(c.ok ?? c.recv) })}>
                      Receive
                    </Button>
                    <span className="text-muted-foreground text-[10.5px]">
                      received ≠ usable — failures reopen the incident
                    </span>
                  </div>
                </div>
              </Card>
            )
          })}
        </div>
      </div>

      <div className="glass-panel col-span-5 min-h-0 border-l">
        <div className="border-b px-4 py-2.5">
          <h2 className="text-muted-foreground text-[10px] font-medium tracking-[0.14em] uppercase">
            Stock on the floor
          </h2>
        </div>
        <ScrollArea className="h-[calc(100%-42px)]">
          <div className="p-3">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Component</TableHead>
                  <TableHead className="text-right">ERP</TableHead>
                  <TableHead className="text-right">Usable</TableHead>
                  <TableHead className="text-right">Hold</TableHead>
                  <TableHead className="text-right">Cover</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {inv.map((r) => {
                  const gap = r.erp_stock !== r.usable_stock
                  const cover = Number(r.coverage_days ?? 0)
                  return (
                    <TableRow key={r.component_id}>
                      <TableCell>
                        <div className="flex items-center gap-1.5 text-[12.5px]">
                          {r.display_name || r.component_id}
                          {r.is_hazmat && (
                            <Badge variant="outline"
                              className="border-danger/50 bg-danger/15 text-danger gap-0.5 text-[9px]">
                              <Flame className="size-2" />hazmat
                            </Badge>
                          )}
                        </div>
                        <div className="text-muted-foreground font-mono text-[10px]">
                          {r.part_number || r.component_id}
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground text-right tabular-nums">
                        {r.erp_stock}</TableCell>
                      <TableCell className={`text-right tabular-nums ${gap ? 'text-warn font-medium' : ''}`}>
                        {r.usable_stock}</TableCell>
                      <TableCell className={`text-right tabular-nums ${
                        r.quarantined_stock ? 'text-danger' : 'text-muted-foreground/50'}`}>
                        {r.quarantined_stock || '—'}</TableCell>
                      <TableCell className={`text-right tabular-nums ${
                        cover < 3 ? 'text-danger' : cover < 6 ? 'text-warn' : 'text-muted-foreground'}`}>
                        {cover.toFixed(1)}d</TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}
