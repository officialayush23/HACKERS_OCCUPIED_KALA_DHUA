import { useQuery } from '@tanstack/react-query'
import { Flame, TriangleAlert } from 'lucide-react'
import { api } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'

const inr = (n) => '₹' + Number(n ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })

const PRIORITY = {
  critical: 'border-danger/50 bg-danger/15 text-danger',
  high:     'border-warn/40 bg-warn/10 text-warn',
  medium:   'border-border bg-muted text-muted-foreground',
  low:      'border-border bg-muted text-muted-foreground',
}
const PO_STATUS = {
  delayed:   'border-warn/40 bg-warn/10 text-warn',
  cancelled: 'border-danger/50 bg-danger/15 text-danger',
}

export default function WorldState({ revision }) {
  const { data, isError, error } = useQuery({
    queryKey: ['world'],
    queryFn: api.world,
  })

  if (isError) return <p className="p-4 text-xs text-destructive">{error.message}</p>
  if (!data) return <p className="p-4 text-xs text-muted-foreground">Loading world…</p>

  return (
    <Tabs defaultValue="inventory" className="flex h-full flex-col gap-0">
      <div className="shrink-0 border-b px-3 py-2">
        <TabsList className="w-full">
          <TabsTrigger value="inventory">Inventory</TabsTrigger>
          <TabsTrigger value="orders">Orders</TabsTrigger>
          <TabsTrigger value="suppliers">Suppliers</TabsTrigger>
        </TabsList>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="p-3">
          <TabsContent value="inventory" className="mt-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Component</TableHead>
                  <TableHead className="text-right">ERP</TableHead>
                  <TableHead className="text-right">Usable</TableHead>
                  <TableHead className="text-right">Cover</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.inventory.map((r) => {
                  const gap = r.erp_stock !== r.usable_stock
                  const cover = Number(r.coverage_days ?? 0)
                  return (
                    <TableRow key={r.component_id}>
                      <TableCell>
                        <div className="flex items-center gap-1.5">
                          <span className="font-mono text-xs">{r.component_id}</span>
                          {r.is_hazmat && (
                            <Badge variant="outline" className="border-danger/50 bg-danger/15 text-danger gap-0.5">
                              <Flame className="size-2.5" />hazmat
                            </Badge>
                          )}
                        </div>
                        <div className="text-[11px] text-muted-foreground">{r.name}</div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">{r.erp_stock}</TableCell>
                      <TableCell className={`text-right tabular-nums ${gap ? 'font-medium text-warn' : ''}`}>
                        {r.usable_stock}
                        {gap && <TriangleAlert className="ml-1 inline size-3 text-warn" />}
                      </TableCell>
                      <TableCell className={`text-right tabular-nums
                        ${cover < 3 ? 'text-danger' : cover < 6 ? 'text-warn' : 'text-muted-foreground'}`}>
                        {cover.toFixed(1)}d
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </TabsContent>

          <TabsContent value="orders" className="mt-0 flex flex-col gap-4">
            <div>
              <h3 className="mb-1.5 text-[10px] tracking-widest text-muted-foreground uppercase">
                Purchase orders
              </h3>
              {data.purchase_orders.map((p) => {
                const lie = ['dispatched', 'in_transit'].includes(p.supplier_claim)
                  && ['label_created_no_pickup', 'not_shipped'].includes(p.tracking_status)
                return (
                  <div key={p.id}
                    className={`mb-1.5 rounded-md border px-2.5 py-2 text-xs
                      ${lie ? 'border-danger/50 bg-danger/10' : 'bg-card'}`}>
                    <div className="flex items-center justify-between">
                      <span className="font-mono">{p.id}</span>
                      <Badge variant="outline" className={PO_STATUS[p.status] ?? ''}>{p.status}</Badge>
                    </div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground">
                      {p.component_id} · {p.supplier_id} · {p.quantity} × {inr(p.unit_price)} = {inr(p.total_value)} · {p.mode}
                    </div>
                    {lie && (
                      <div className="mt-1 flex items-center gap-1 text-[11px] text-danger">
                        <TriangleAlert className="size-3" />
                        claims “{p.supplier_claim}” · carrier “{p.tracking_status}”
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
            <div>
              <h3 className="mb-1.5 text-[10px] tracking-widest text-muted-foreground uppercase">
                Production
              </h3>
              {data.production_orders.map((p) => (
                <div key={p.id} className="mb-1.5 flex items-center justify-between rounded-md border bg-card px-2.5 py-2 text-xs">
                  <div>
                    <span className="font-mono">{p.id}</span>
                    <span className="ml-2 text-[11px] text-muted-foreground">
                      {p.required_component} × {p.units_planned * p.component_per_unit}
                    </span>
                  </div>
                  <Badge variant="outline" className={PRIORITY[p.priority]}>{p.priority}</Badge>
                </div>
              ))}
            </div>
          </TabsContent>

          <TabsContent value="suppliers" className="mt-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Supplier</TableHead>
                  <TableHead className="text-right">Trust</TableHead>
                  <TableHead className="text-right">Qual</TableHead>
                  <TableHead className="text-right">Flags</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.suppliers.map((s) => {
                  const rel = Number(s.derived_reliability ?? s.reliability_score)
                  const drift = rel - Number(s.reliability_score)
                  const flags = (s.contradictions_detected ?? 0) + (s.quality_failures ?? 0)
                  return (
                    <TableRow key={s.id}>
                      <TableCell>
                        <div className="font-mono text-xs">{s.id}</div>
                        <div className="text-[11px] text-muted-foreground">{s.name}</div>
                      </TableCell>
                      <TableCell className={`text-right tabular-nums
                        ${rel < 0.5 ? 'text-danger' : rel < 0.75 ? 'text-warn' : 'text-ok'}`}>
                        {rel.toFixed(2)}
                        {drift < -0.01 && (
                          <span className="ml-1 text-[10px] text-danger">{drift.toFixed(2)}</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {Number(s.quality_score).toFixed(2)}
                      </TableCell>
                      <TableCell className="text-right">
                        {flags > 0
                          ? <Badge variant="outline" className="border-danger/50 bg-danger/15 text-danger">{flags}</Badge>
                          : <span className="text-muted-foreground/50">—</span>}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </TabsContent>
        </div>
      </ScrollArea>
    </Tabs>
  )
}
