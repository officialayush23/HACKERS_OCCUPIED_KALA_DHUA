import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { motion } from 'motion/react'
import { AlertTriangle, Factory } from 'lucide-react'
import { api } from '@/lib/api'
import { Badge } from '@/components/ui/badge'

/**
 * Inbound supply network. Deliberately NOT a map engine — an equirectangular
 * projection over a fixed Asia bounding box gives real relative geography with
 * zero tiles, zero API keys, zero billing.
 */
const BOX = { minLng: 68, maxLng: 124, minLat: -2, maxLat: 30 }
const W = 1000, H = 560

const project = (lng, lat) => ({
  x: ((lng - BOX.minLng) / (BOX.maxLng - BOX.minLng)) * W,
  y: H - ((lat - BOX.minLat) / (BOX.maxLat - BOX.minLat)) * H,
})

const STATE = {
  delayed:      { c: 'var(--danger)',      label: 'Delayed' },
  contradiction:{ c: 'var(--danger)',      label: 'Contradiction' },
  in_transit:   { c: 'var(--ok)',   label: 'On schedule' },
  open:         { c: 'var(--info)',   label: 'Planned' },
  idle:         { c: 'var(--muted-foreground)',        label: 'Idle' },
}

function laneState(sup, shipments) {
  const mine = shipments.filter((s) => s.supplier_id === sup.id)
  if (!mine.length) return 'idle'
  if (mine.some((s) => s.contradiction)) return 'contradiction'
  if (mine.some((s) => s.status === 'delayed')) return 'delayed'
  if (mine.some((s) => s.status === 'in_transit')) return 'in_transit'
  return 'open'
}

export default function NetworkFlow({ revision, highlight = [] }) {
  const { data } = useQuery({ queryKey: ['network', revision], queryFn: api.network })

  const lanes = useMemo(() => {
    if (!data?.plant) return []
    const p = project(Number(data.plant.lng), Number(data.plant.lat))
    return data.suppliers
      .filter((s) => s.lat != null)
      .map((s) => {
        const a = project(Number(s.lng), Number(s.lat))
        const state = laneState(s, data.shipments ?? [])
        // quadratic bezier bowed away from the straight line — reads as a route
        const mx = (a.x + p.x) / 2, my = (a.y + p.y) / 2
        const dx = p.x - a.x, dy = p.y - a.y
        const len = Math.hypot(dx, dy) || 1
        const bow = Math.min(120, len * 0.22)
        const cx = mx - (dy / len) * bow, cy = my + (dx / len) * bow
        return {
          s, a, p, state, d: `M ${a.x} ${a.y} Q ${cx} ${cy} ${p.x} ${p.y}`,
          trust: Number(s.effective_reliability),
          isHighlight: highlight.includes(s.id),
        }
      })
      .sort((x, y) => (x.state === 'idle' ? -1 : 1))
  }, [data, highlight])

  if (!data?.plant) {
    return <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
      Loading network…
    </div>
  }

  const plant = project(Number(data.plant.lng), Number(data.plant.lat))
  const active = lanes.filter((l) => l.state !== 'idle')

  return (
    <div className="relative h-full w-full overflow-hidden">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-full w-full" preserveAspectRatio="xMidYMid meet">
        <defs>
          <radialGradient id="plantGlow">
            <stop offset="0%" stopColor="var(--primary)" stopOpacity="0.35" />
            <stop offset="100%" stopColor="var(--primary)" stopOpacity="0" />
          </radialGradient>
          <pattern id="grid" width="50" height="50" patternUnits="userSpaceOnUse">
            <path d="M 50 0 L 0 0 0 50" fill="none"
                  stroke="var(--border)" strokeWidth="1" />
          </pattern>
        </defs>

        <rect width={W} height={H} fill="url(#grid)" />

        {/* idle lanes first, muted */}
        {lanes.filter((l) => l.state === 'idle').map((l) => (
          <path key={l.s.id} d={l.d} fill="none" stroke="var(--border)"
                strokeWidth="1" strokeDasharray="3 6" />
        ))}

        {/* active lanes */}
        {active.map((l, i) => {
          const tone = STATE[l.state].c
          return (
            <g key={l.s.id}>
              <motion.path
                d={l.d} fill="none" stroke={tone}
                strokeWidth={l.isHighlight ? 3 : 1.8}
                strokeOpacity={l.isHighlight ? 1 : 0.65}
                strokeDasharray={l.state === 'open' ? '6 6' : undefined}
                initial={{ pathLength: 0, opacity: 0 }}
                animate={{ pathLength: 1, opacity: 1 }}
                transition={{ duration: 1.1, delay: i * 0.09, ease: 'easeOut' }}
              />
              {/* travelling pulse */}
              <motion.circle r={l.state === 'contradiction' ? 6 : 4.5} fill={tone}
                initial={{ offsetDistance: '0%' }}
                animate={{ offsetDistance: '100%' }}
                transition={{ duration: l.state === 'delayed' ? 6.5 : 3.4,
                              repeat: Infinity, ease: 'linear', delay: i * 0.4 }}
                style={{ offsetPath: `path("${l.d}")`, offsetRotate: '0deg' }} />
            </g>
          )
        })}

        {/* plant */}
        <circle cx={plant.x} cy={plant.y} r="70" fill="url(#plantGlow)" />
        <motion.circle cx={plant.x} cy={plant.y} r={22} fill="none"
          stroke="var(--primary)" strokeWidth="1.5"
          initial={{ r: 22, opacity: 0.7 }}
          animate={{ r: [22, 40], opacity: [0.7, 0] }}
          transition={{ duration: 2.4, repeat: Infinity, ease: 'easeOut' }} />
        <circle cx={plant.x} cy={plant.y} r="15"
                fill="var(--card)" stroke="var(--primary)" strokeWidth="2" />
        <text x={plant.x} y={plant.y + 40} textAnchor="middle"
              className="fill-foreground text-[15px] font-medium">Pune-Plant-1</text>
        <text x={plant.x} y={plant.y + 58} textAnchor="middle"
              className="fill-muted-foreground text-[12px]">Chakan · assembly</text>

        {/* suppliers */}
        {lanes.map((l, i) => {
          const tone = STATE[l.state].c
          const idle = l.state === 'idle'
          return (
            <motion.g key={l.s.id}
              initial={{ opacity: 0, scale: 0.6 }} animate={{ opacity: idle ? 0.45 : 1, scale: 1 }}
              transition={{ delay: 0.2 + i * 0.05, type: 'spring', stiffness: 200, damping: 18 }}
              style={{ transformOrigin: `${l.a.x}px ${l.a.y}px` }}>
              {l.state === 'contradiction' && (
                <motion.circle cx={l.a.x} cy={l.a.y} r={12} fill="none" stroke={tone}
                  strokeWidth="1.5"
                  initial={{ r: 12, opacity: 0.9 }}
                  animate={{ r: [12, 26], opacity: [0.9, 0] }}
                  transition={{ duration: 1.5, repeat: Infinity }} />
              )}
              <circle cx={l.a.x} cy={l.a.y} r={idle ? 4 : 8}
                      fill={idle ? 'var(--muted)' : tone}
                      stroke="var(--background)" strokeWidth="2" />
              <text x={l.a.x} y={l.a.y - 15} textAnchor="middle"
                    className={idle ? 'fill-muted-foreground text-[11px]' : 'fill-foreground text-[12px] font-medium'}>
                {l.s.id}
              </text>
              {!idle && (
                <text x={l.a.x} y={l.a.y + 24} textAnchor="middle"
                      className="fill-muted-foreground text-[11px]">{l.s.city}</text>
              )}
            </motion.g>
          )
        })}
      </svg>

      <div className="pointer-events-none absolute top-3 left-3 flex flex-col gap-1.5">
        {Object.entries(STATE).filter(([k]) => k !== 'contradiction').map(([k, v]) => (
          <div key={k} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="size-2 rounded-full" style={{ background: v.c }} />{v.label}
          </div>
        ))}
      </div>

      <div className="absolute top-3 right-3 flex flex-col items-end gap-1.5">
        {(data.shipments ?? []).filter((s) => s.contradiction).map((s) => (
          <motion.div key={s.id} initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }}>
            <Badge variant="outline" className="gap-1 border-danger/50 bg-danger/15 text-danger">
              <AlertTriangle className="size-3" />
              {s.id} claims “{s.supplier_claim}”, carrier says “{s.tracking_status}”
            </Badge>
          </motion.div>
        ))}
        {(data.shipments ?? []).filter((s) => s.status === 'delayed' && !s.contradiction).map((s) => (
          <Badge key={s.id} variant="outline" className="border-warn/50 bg-warn/15 text-warn">
            {s.id} delayed · {s.component_id}
          </Badge>
        ))}
      </div>

      <div className="absolute bottom-3 left-3 flex items-center gap-2 text-[11px] text-muted-foreground">
        <Factory className="size-3.5" />
        {active.length} active lanes · {lanes.length - active.length} idle suppliers
      </div>
    </div>
  )
}
