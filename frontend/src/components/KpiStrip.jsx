import { useQuery } from '@tanstack/react-query'
import { motion } from 'motion/react'
import { Area, AreaChart } from 'recharts'
import { AlertTriangle, Clock, IndianRupee, ShieldCheck, Truck } from 'lucide-react'
import { api } from '@/lib/api'
import { Card } from '@/components/ui/card'
import { ChartContainer } from '@/components/ui/chart'

const inr = (n) => '₹' + Number(n ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })

function Kpi({ icon: Icon, label, value, sub, tone, data, delay, alarm }) {
  const config = { n: { label, color: tone } }
  const series = (data?.length ? data : Array.from({ length: 10 }, () => ({ n: 0 })))
    .map((x, i) => ({ i, n: x.n }))
  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
                transition={{ delay, duration: 0.35, ease: 'easeOut' }}>
      <Card className={`gap-0 overflow-hidden py-0 ${alarm ? 'border-danger/40' : ''}`}>
        <div className="px-4 pt-3.5">
          <div className="flex items-center gap-1.5 text-[10px] tracking-widest text-muted-foreground uppercase">
            <Icon className="size-3" />{label}
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <motion.span key={String(value)}
              initial={{ opacity: 0.3, y: -4 }} animate={{ opacity: 1, y: 0 }}
              className="font-mono text-[26px] leading-none font-semibold tabular-nums">
              {value}
            </motion.span>
            {sub && <span className="text-[11px] text-muted-foreground">{sub}</span>}
          </div>
        </div>
        <ChartContainer config={config} className="aspect-auto h-[46px] w-full">
          <AreaChart data={series} margin={{ top: 6, right: 0, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id={`fill-${label.replace(/\s/g, '')}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--color-n)" stopOpacity={0.45} />
                <stop offset="100%" stopColor="var(--color-n)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <Area type="monotone" dataKey="n" stroke="var(--color-n)" strokeWidth={1.75}
                  fill={`url(#fill-${label.replace(/\s/g, '')})`} dot={false}
                  isAnimationActive={false} />
          </AreaChart>
        </ChartContainer>
      </Card>
    </motion.div>
  )
}

export default function KpiStrip({ revision }) {
  const { data: k } = useQuery({ queryKey: ['kpis', revision], queryFn: api.kpis })
  const a = k?.activity ?? []
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
      <Kpi icon={AlertTriangle} label="Open incidents" value={k?.open_incidents ?? '—'}
           sub={k?.critical_incidents ? `${k.critical_incidents} critical` : 'all clear'}
           tone="var(--chart-1)" data={a} delay={0} alarm={!!k?.critical_incidents} />
      <Kpi icon={Clock} label="Min coverage" value={k ? `${k.min_coverage_days.toFixed(1)}d` : '—'}
           sub="until line stops" tone="var(--chart-3)" data={a} delay={0.05}
           alarm={(k?.min_coverage_days ?? 9) < 3} />
      <Kpi icon={Truck} label="Delayed POs" value={k?.delayed_pos ?? '—'}
           sub={`${k?.erp_gap_units ?? 0}u ERP gap`} tone="var(--chart-2)" data={a} delay={0.1} />
      <Kpi icon={ShieldCheck} label="Lies caught" value={k?.contradictions_caught ?? '—'}
           sub={k ? `trust ${k.avg_trust.toFixed(2)}` : ''} tone="var(--chart-4)" data={a} delay={0.15} />
      <Kpi icon={IndianRupee} label="Agent spend" value={k ? inr(k.agent_spend_inr) : '—'}
           sub={k ? `cap ${inr(k.approval_threshold)}` : ''} tone="var(--chart-5)" data={a} delay={0.2} />
    </div>
  )
}
