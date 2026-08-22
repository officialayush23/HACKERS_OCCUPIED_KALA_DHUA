import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AnimatePresence, motion } from 'motion/react'
import { AlertTriangle, Factory, Package, ShieldCheck, Truck } from 'lucide-react'
import { api } from '@/lib/api'
import { inr } from '@/lib/format'
import { Badge } from '@/components/ui/badge'

/**
 * Schematic supply network — the default view.
 *
 * An equirectangular projection over a fixed Asia bounding box: real relative
 * geography, no tiles, no API key, nothing that can fail on conference wifi.
 * Mapbox is available on the Live Network page for when true geography matters.
 */
const BOX = { minLng: 68, maxLng: 124, minLat: -2, maxLat: 30 }
const W = 1000, H = 560

const project = (lng, lat) => ({
  x: ((lng - BOX.minLng) / (BOX.maxLng - BOX.minLng)) * W,
  y: H - ((lat - BOX.minLat) / (BOX.maxLat - BOX.minLat)) * H,
})

const STATE = {
  contradiction: { c: 'var(--danger)', label: 'Contradiction' },
  delayed:       { c: 'var(--danger)', label: 'Delayed' },
  in_transit:    { c: 'var(--ok)',     label: 'On schedule' },
  open:          { c: 'var(--info)',   label: 'Planned' },
  idle:          { c: 'var(--muted-foreground)', label: 'Idle' },
}

function laneState(sup, shipments) {
  const mine = shipments.filter((s) => s.supplier_id === sup.id)
  if (!mine.length) return 'idle'
  if (mine.some((s) => s.contradiction)) return 'contradiction'
  if (mine.some((s) => s.status === 'delayed')) return 'delayed'
  if (mine.some((s) => s.status === 'in_transit')) return 'in_transit'
  return 'open'
}

function trustTone(t) {
  return t < 0.5 ? 'text-danger' : t < 0.75 ? 'text-warn' : 'text-ok'
}

/** Hover card — the detail that makes a dot mean something. */
function HoverCard({ hover }) {
  if (!hover) return null
  const { kind, data, x, y } = hover
  const left = x > 0.62 ? undefined : `${x * 100}%`
  const right = x > 0.62 ? `${(1 - x) * 100}%` : undefined

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: 6, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, scale: 0.97 }}
        transition={{ duration: 0.12 }}
        style={{ left, right, top: `${y * 100}%` }}
        className="glass pointer-events-none absolute z-30 w-[16.5rem] -translate-y-1/2
                   rounded-xl p-3 shadow-xl"
      >
        {kind === 'supplier' && (
          <>
            <div className="flex items-start gap-2">
              <div className="min-w-0">
                <div className="truncate text-[13px] font-semibold">
                  {data.name}
                </div>
                <div className="text-muted-foreground text-[11px]">
                  {data.city}{data.country ? `, ${data.country}` : ''}
                  <span className="ml-1.5 font-mono opacity-60">{data.id}</span>
                </div>
              </div>
              <Badge variant="outline"
                     className="ml-auto shrink-0 text-[9.5px]"
                     style={{ borderColor: STATE[data.state].c, color: STATE[data.state].c }}>
                {STATE[data.state].label}
              </Badge>
            </div>

            <div className="mt-2.5 grid grid-cols-2 gap-2 text-[11px]">
              <div>
                <div className="text-muted-foreground flex items-center gap-1 text-[9.5px]
                                tracking-[0.1em] uppercase">
                  <ShieldCheck className="size-2.5" />Trust
                </div>
                <div className={`font-mono text-[15px] ${trustTone(data.trust)}`}>
                  {data.trust.toFixed(2)}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground flex items-center gap-1 text-[9.5px]
                                tracking-[0.1em] uppercase">
                  <Truck className="size-2.5" />Fastest lane
                </div>
                <div className="font-mono text-[15px]">
                  {data.transit_days != null ? `${data.transit_days}d` : '—'}
                </div>
              </div>
            </div>

            {data.contradictions > 0 && (
              <div className="border-danger/40 bg-danger/10 text-danger mt-2 flex items-center
                              gap-1.5 rounded-md border px-2 py-1 text-[10.5px]">
                <AlertTriangle className="size-3 shrink-0" />
                {data.contradictions} claim{data.contradictions > 1 ? 's' : ''} contradicted by carrier
              </div>
            )}

            {data.modes?.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {data.modes.filter(Boolean).map((m) => (
                  <Badge key={m} variant="outline" className="font-mono text-[9px]">{m}</Badge>
                ))}
              </div>
            )}

            {data.components?.filter(Boolean).length > 0 && (
              <div className="mt-2">
                <div className="text-muted-foreground text-[9.5px] tracking-[0.1em] uppercase">
                  Supplies
                </div>
                <div className="mt-0.5 text-[11px] leading-snug">
                  {data.componentNames.join(' · ')}
                </div>
              </div>
            )}

            {data.shipments?.length > 0 && (
              <div className="mt-2 border-t pt-2">
                {data.shipments.map((s) => (
                  <div key={s.id} className="flex items-center gap-1.5 text-[10.5px]">
                    <Package className="text-muted-foreground size-2.5 shrink-0" />
                    <span className="font-mono">{s.id}</span>
                    <span className="text-muted-foreground truncate">
                      {s.quantity}u · {s.mode}
                    </span>
                    <span className="ml-auto font-mono">{inr(s.total_value)}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {kind === 'plant' && (
          <>
            <div className="text-[13px] font-semibold">{data.name}</div>
            <div className="text-muted-foreground text-[11px]">
              {data.city} · final assembly
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2 text-[11px]">
              <div>
                <div className="text-muted-foreground text-[9.5px] tracking-[0.1em] uppercase">
                  Active lanes</div>
                <div className="font-mono text-[15px]">{data.activeLanes}</div>
              </div>
              <div>
                <div className="text-muted-foreground text-[9.5px] tracking-[0.1em] uppercase">
                  Inbound units</div>
                <div className="font-mono text-[15px]">{data.inboundUnits}</div>
              </div>
            </div>
          </>
        )}

        {kind === 'shipment' && (
          <>
            <div className="flex items-center gap-2">
              <span className="font-mono text-[12px] font-semibold">{data.id}</span>
              <Badge variant="outline" className="ml-auto text-[9.5px]"
                     style={{ borderColor: STATE[data.state].c, color: STATE[data.state].c }}>
                {STATE[data.state].label}
              </Badge>
            </div>
            <div className="mt-1 text-[11.5px]">{data.componentName}</div>
            <div className="text-muted-foreground mt-0.5 text-[11px]">
              {data.supplierName} · {data.quantity} units · {data.mode}
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <div>
                <div className="text-muted-foreground text-[9.5px] tracking-[0.1em] uppercase">
                  Value</div>
                <div className="font-mono text-[13px]">{inr(data.total_value)}</div>
              </div>
              <div>
                <div className="text-muted-foreground text-[9.5px] tracking-[0.1em] uppercase">
                  ETA</div>
                <div className="font-mono text-[13px]">
                  {data.hours_to_eta > 0 ? `${(data.hours_to_eta / 24).toFixed(1)}d` : 'overdue'}
                </div>
              </div>
            </div>
            {data.contradiction && (
              <div className="border-danger/40 bg-danger/10 text-danger mt-2 rounded-md border
                              px-2 py-1 text-[10.5px] leading-snug">
                Supplier claims “{data.supplier_claim}”. Carrier shows “{data.tracking_status}”.
              </div>
            )}
          </>
        )}
      </motion.div>
    </AnimatePresence>
  )
}

export default function NetworkFlow({ revision, highlight = [] }) {
  const [hover, setHover] = useState(null)
  const { data } = useQuery({
    queryKey: ['network', revision], queryFn: api.network, refetchInterval: 4000 })
  const { data: ctx } = useQuery({ queryKey: ['context'], queryFn: api.context })

  const nameOf = useMemo(() => {
    const m = {}
    for (const p of ctx?.production ?? []) m[p.component_name] = p.component_name
    return m
  }, [ctx])

  const lanes = useMemo(() => {
    if (!data?.plant) return []
    const p = project(Number(data.plant.lng), Number(data.plant.lat))
    return (data.suppliers ?? [])
      .filter((s) => s.lat != null)
      .map((s) => {
        const a = project(Number(s.lng), Number(s.lat))
        const state = laneState(s, data.shipments ?? [])
        const mx = (a.x + p.x) / 2, my = (a.y + p.y) / 2
        const dx = p.x - a.x, dy = p.y - a.y
        const len = Math.hypot(dx, dy) || 1
        const bow = Math.min(120, len * 0.22)
        const cx = mx - (dy / len) * bow, cy = my + (dx / len) * bow
        return {
          s, a, p, state,
          d: `M ${a.x} ${a.y} Q ${cx} ${cy} ${p.x} ${p.y}`,
          trust: Number(s.effective_reliability ?? 0.5),
          shipments: (data.shipments ?? []).filter((x) => x.supplier_id === s.id),
          isHighlight: highlight.includes(s.id),
        }
      })
      .sort((x, y) => (x.state === 'idle' ? -1 : 1))
  }, [data, highlight])

  if (!data?.plant) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center text-xs">
        Loading network…
      </div>
    )
  }

  const plant = project(Number(data.plant.lng), Number(data.plant.lat))
  const active = lanes.filter((l) => l.state !== 'idle')
  const inboundUnits = (data.shipments ?? []).reduce((s, x) => s + (x.quantity ?? 0), 0)

  const showSupplier = (l) => setHover({
    kind: 'supplier', x: l.a.x / W, y: l.a.y / H,
    data: {
      id: l.s.id, name: l.s.name, city: l.s.city, country: l.s.country,
      trust: l.trust, state: l.state, transit_days: l.s.transit_days,
      contradictions: l.s.contradictions_detected ?? 0,
      modes: l.s.modes ?? [], components: l.s.components ?? [],
      componentNames: (l.s.components ?? []).filter(Boolean),
      shipments: l.shipments,
    },
  })

  return (
    <div className="relative h-full w-full overflow-hidden">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-full w-full"
           preserveAspectRatio="xMidYMid meet"
           onMouseLeave={() => setHover(null)}>
        <defs>
          <radialGradient id="plantGlow">
            <stop offset="0%" stopColor="var(--primary)" stopOpacity="0.35" />
            <stop offset="100%" stopColor="var(--primary)" stopOpacity="0" />
          </radialGradient>
          <pattern id="grid" width="50" height="50" patternUnits="userSpaceOnUse">
            <path d="M 50 0 L 0 0 0 50" fill="none" stroke="var(--border)" strokeWidth="1" />
          </pattern>
        </defs>

        <rect width={W} height={H} fill="url(#grid)" />

        {lanes.filter((l) => l.state === 'idle').map((l) => (
          <path key={l.s.id} d={l.d} fill="none" stroke="var(--border)"
                strokeWidth="1" strokeDasharray="3 6" />
        ))}

        {active.map((l, i) => {
          const tone = STATE[l.state].c
          const dim = hover?.kind === 'supplier' && hover.data.id !== l.s.id
          return (
            <g key={l.s.id} opacity={dim ? 0.25 : 1}
               style={{ transition: 'opacity .15s' }}>
              <motion.path
                d={l.d} fill="none" stroke={tone}
                strokeWidth={l.isHighlight ? 3 : 1.8}
                strokeOpacity={l.isHighlight ? 1 : 0.65}
                strokeDasharray={l.state === 'open' ? '6 6' : undefined}
                initial={{ pathLength: 0, opacity: 0 }}
                animate={{ pathLength: 1, opacity: 1 }}
                transition={{ duration: 1.1, delay: i * 0.09, ease: 'easeOut' }} />
              {/* invisible fat stroke = easy hover target for the lane */}
              <path d={l.d} fill="none" stroke="transparent" strokeWidth="18"
                    className="cursor-pointer"
                    onMouseEnter={() => {
                      const s = l.shipments[0]
                      if (s) setHover({
                        kind: 'shipment', x: 0.5, y: 0.28,
                        data: { ...s, state: l.state, supplierName: l.s.name,
                                componentName: s.component_id },
                      })
                      else showSupplier(l)
                    }} />
              <motion.circle r={l.state === 'contradiction' ? 6 : 4.5} fill={tone}
                initial={{ offsetDistance: '0%' }} animate={{ offsetDistance: '100%' }}
                transition={{ duration: l.state === 'delayed' ? 6.5 : 3.4,
                              repeat: Infinity, ease: 'linear', delay: i * 0.4 }}
                style={{ offsetPath: `path("${l.d}")`, offsetRotate: '0deg' }} />
            </g>
          )
        })}

        {/* plant */}
        <g className="cursor-pointer"
           onMouseEnter={() => setHover({
             kind: 'plant', x: plant.x / W, y: plant.y / H,
             data: { name: data.plant.name, city: data.plant.city,
                     activeLanes: active.length, inboundUnits } })}>
          <circle cx={plant.x} cy={plant.y} r="70" fill="url(#plantGlow)" />
          <motion.circle cx={plant.x} cy={plant.y} r={22} fill="none"
            stroke="var(--primary)" strokeWidth="1.5"
            initial={{ r: 22, opacity: 0.7 }} animate={{ r: [22, 40], opacity: [0.7, 0] }}
            transition={{ duration: 2.4, repeat: Infinity, ease: 'easeOut' }} />
          <circle cx={plant.x} cy={plant.y} r="15"
                  fill="var(--card)" stroke="var(--primary)" strokeWidth="2" />
          <text x={plant.x} y={plant.y + 40} textAnchor="middle"
                className="fill-foreground text-[15px] font-medium">Pune Plant</text>
          <text x={plant.x} y={plant.y + 58} textAnchor="middle"
                className="fill-muted-foreground text-[12px]">Chakan · final assembly</text>
        </g>

        {/* suppliers */}
        {lanes.map((l, i) => {
          const tone = STATE[l.state].c
          const idle = l.state === 'idle'
          const on = hover?.kind === 'supplier' && hover.data.id === l.s.id
          return (
            <motion.g key={l.s.id} className="cursor-pointer"
              initial={{ opacity: 0, scale: 0.6 }}
              animate={{ opacity: idle ? (on ? 1 : 0.45) : 1, scale: on ? 1.15 : 1 }}
              transition={{ delay: 0.2 + i * 0.05, type: 'spring', stiffness: 220, damping: 20 }}
              style={{ transformOrigin: `${l.a.x}px ${l.a.y}px` }}
              onMouseEnter={() => showSupplier(l)}>
              {l.state === 'contradiction' && (
                <motion.circle cx={l.a.x} cy={l.a.y} r={12} fill="none" stroke={tone}
                  strokeWidth="1.5" initial={{ r: 12, opacity: 0.9 }}
                  animate={{ r: [12, 26], opacity: [0.9, 0] }}
                  transition={{ duration: 1.5, repeat: Infinity }} />
              )}
              <circle cx={l.a.x} cy={l.a.y} r="16" fill="transparent" />
              <circle cx={l.a.x} cy={l.a.y} r={idle ? 4 : 8}
                      fill={idle ? 'var(--muted)' : tone}
                      stroke="var(--background)" strokeWidth="2" />
              <text x={l.a.x} y={l.a.y - 15} textAnchor="middle"
                className={idle
                  ? 'fill-muted-foreground text-[11px]'
                  : 'fill-foreground text-[12px] font-medium'}>
                {(l.s.name || l.s.id).split(' ').slice(0, 2).join(' ')}
              </text>
              {!idle && (
                <text x={l.a.x} y={l.a.y + 24} textAnchor="middle"
                      className="fill-muted-foreground text-[11px]">{l.s.city}</text>
              )}
            </motion.g>
          )
        })}
      </svg>

      <HoverCard hover={hover} />

      <div className="pointer-events-none absolute top-3 left-3 flex flex-col gap-1.5">
        {['delayed', 'in_transit', 'open', 'idle'].map((k) => (
          <div key={k} className="text-muted-foreground flex items-center gap-1.5 text-[11px]">
            <span className="size-2 rounded-full" style={{ background: STATE[k].c }} />
            {STATE[k].label}
          </div>
        ))}
      </div>

      <div className="absolute top-3 right-3 flex max-w-[22rem] flex-col items-end gap-1.5">
        {(data.shipments ?? []).filter((s) => s.contradiction).map((s) => (
          <motion.div key={s.id} initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }}>
            <Badge variant="outline"
                   className="border-danger/50 bg-danger/15 text-danger gap-1 text-right">
              <AlertTriangle className="size-3 shrink-0" />
              {s.id} claims “{s.supplier_claim}”, carrier says “{s.tracking_status}”
            </Badge>
          </motion.div>
        ))}
      </div>

      <div className="text-muted-foreground absolute bottom-3 left-3 flex items-center gap-2
                      text-[11px]">
        <Factory className="size-3.5" />
        {active.length} active lanes · {lanes.length - active.length} idle suppliers
        <span className="opacity-60">· hover any node for detail</span>
      </div>
    </div>
  )
}
