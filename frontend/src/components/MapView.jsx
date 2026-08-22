import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AnimatePresence, motion } from 'motion/react'
import { AlertTriangle, History, Loader2, MapPinned, ShieldCheck, Truck } from 'lucide-react'
import { api } from '@/lib/api'
import { inr } from '@/lib/format'
import { Badge } from '@/components/ui/badge'

/**
 * Real geography, only where it earns its place.
 *
 * The schematic is the default everywhere else. This exists because on the Live
 * Network screen the operator genuinely needs to know *where* — a Shenzhen lane
 * failing is a different problem from a Pune lane failing.
 *
 * If the token is missing or tiles fail, the caller falls back to the schematic.
 * Nothing about the demo depends on this loading.
 */
const TOKEN = import.meta.env.VITE_MAPBOX_TOKEN ?? ''

const TONE = {
  contradiction: '#ff5c5c',
  delayed:       '#ff5c5c',
  in_transit:    '#3ecf8e',
  open:          '#4aa8ff',
  idle:          '#6b7280',
}

const LABEL = {
  contradiction: 'Contradiction', delayed: 'Delayed',
  in_transit: 'On schedule', open: 'Planned', idle: 'Idle',
}

function laneState(supplierId, shipments) {
  const mine = shipments.filter((s) => s.supplier_id === supplierId)
  if (!mine.length) return 'idle'
  if (mine.some((s) => s.contradiction)) return 'contradiction'
  if (mine.some((s) => s.status === 'delayed')) return 'delayed'
  if (mine.some((s) => s.status === 'in_transit')) return 'in_transit'
  return 'open'
}

/** Great-circle-ish arc so long lanes read as routes rather than chords. */
function arc(from, to, bend = 0.22, steps = 48) {
  const [x1, y1] = from, [x2, y2] = to
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2
  const dx = x2 - x1, dy = y2 - y1
  const len = Math.hypot(dx, dy) || 1
  const cx = mx - (dy / len) * len * bend
  const cy = my + (dx / len) * len * bend
  const out = []
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, u = 1 - t
    out.push([u * u * x1 + 2 * u * t * cx + t * t * x2,
              u * u * y1 + 2 * u * t * cy + t * t * y2])
  }
  return out
}

export default function MapView({ revision, onFallback }) {
  const container = useRef(null)
  const map = useRef(null)
  const gl = useRef(null)
  const markers = useRef([])
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)
  const [sel, setSel] = useState(null)

  const { data } = useQuery({
    queryKey: ['network'], queryFn: api.network})

  const dark = typeof document !== 'undefined' &&
    document.documentElement.classList.contains('dark')

  // ---- init ---------------------------------------------------------------
  // mapbox-gl loads as its own chunk, only when this screen is opened, so the
  // 800kB engine never sits in the main bundle. If the chunk or the tiles fail
  // the caller drops back to the schematic — the map is an enhancement, never
  // something the demo depends on.
  useEffect(() => {
    if (!TOKEN) { setFailed(true); onFallback?.('No Mapbox token'); return }
    if (map.current || !container.current) return
    let dead = false

    ;(async () => {
      let mapboxgl
      try {
        mapboxgl = (await import('mapbox-gl')).default
      } catch (e) {
        setFailed(true); onFallback?.('Map engine could not load'); return
      }
      if (dead || !container.current) return
      gl.current = mapboxgl
      mapboxgl.accessToken = TOKEN
      try {
        map.current = new mapboxgl.Map({
          container: container.current,
          style: dark ? 'mapbox://styles/mapbox/dark-v11' : 'mapbox://styles/mapbox/light-v11',
          center: [92, 16], zoom: 2.6, attributionControl: false,
          projection: 'mercator',
        })
        map.current.on('load', () => !dead && setReady(true))
        map.current.on('error', (e) => {
          // Tiles unreachable — hand back to the schematic rather than show a void.
          if (String(e?.error?.message ?? '').match(/token|fetch|network|401|403/i)) {
            setFailed(true); onFallback?.('Mapbox tiles unavailable')
          }
        })
      } catch (e) {
        setFailed(true); onFallback?.(String(e))
      }
    })()

    return () => { dead = true; map.current?.remove(); map.current = null; setReady(false) }
  }, [dark, onFallback])

  // ---- draw ---------------------------------------------------------------
  useEffect(() => {
    if (!ready || !map.current || !gl.current || !data?.plant) return
    const m = map.current
    const mapboxgl = gl.current
    const plant = [Number(data.plant.lng), Number(data.plant.lat)]
    const shipments = data.shipments ?? []

    const features = (data.suppliers ?? [])
      .filter((s) => s.lat != null)
      .map((s) => {
        const state = laneState(s.id, shipments)
        return {
          type: 'Feature',
          properties: { state, color: TONE[state], supplier: s.id, dash: state === 'open' ? 1 : 0 },
          geometry: {
            type: 'LineString',
            coordinates: arc([Number(s.lng), Number(s.lat)], plant),
          },
        }
      })

    const geo = { type: 'FeatureCollection', features }

    if (m.getSource('lanes')) {
      m.getSource('lanes').setData(geo)
    } else {
      m.addSource('lanes', { type: 'geojson', data: geo })
      m.addLayer({
        id: 'lanes-glow', type: 'line', source: 'lanes',
        filter: ['!=', ['get', 'state'], 'idle'],
        paint: { 'line-color': ['get', 'color'], 'line-width': 7, 'line-blur': 5,
                 'line-opacity': 0.25 },
      })
      m.addLayer({
        id: 'lanes-line', type: 'line', source: 'lanes',
        paint: {
          'line-color': ['get', 'color'],
          'line-width': ['case', ['==', ['get', 'state'], 'idle'], 0.8, 2.1],
          'line-opacity': ['case', ['==', ['get', 'state'], 'idle'], 0.28, 0.9],
          'line-dasharray': [2, 2],
        },
      })
    }

    // markers — plant + suppliers
    markers.current.forEach((x) => x.remove())
    markers.current = []

    const plantEl = document.createElement('div')
    plantEl.className = 'mb-plant'
    plantEl.innerHTML =
      `<span class="mb-plant-ping"></span><span class="mb-plant-dot"></span>
       <span class="mb-label">${data.plant.name ?? 'Pune Plant'}</span>`
    markers.current.push(new mapboxgl.Marker({ element: plantEl }).setLngLat(plant).addTo(m))

    for (const s of data.suppliers ?? []) {
      if (s.lat == null) continue
      const state = laneState(s.id, shipments)
      const el = document.createElement('div')
      el.className = `mb-node${state === 'idle' ? ' mb-idle' : ''}`
      el.style.setProperty('--tone', TONE[state])
      el.innerHTML = state === 'contradiction'
        ? '<span class="mb-ping"></span><span class="mb-dot"></span>'
        : '<span class="mb-dot"></span>'
      el.addEventListener('mouseenter', () => setSel({
        ...s, state,
        shipments: shipments.filter((x) => x.supplier_id === s.id),
      }))
      el.addEventListener('mouseleave', () => setSel(null))
      markers.current.push(new mapboxgl.Marker({ element: el })
        .setLngLat([Number(s.lng), Number(s.lat)]).addTo(m))
    }
  }, [ready, data])

  if (failed || !TOKEN) {
    return (
      <div className="text-muted-foreground flex h-full flex-col items-center justify-center
                      gap-2 text-center">
        <MapPinned className="size-5 opacity-50" />
        <p className="text-[13px]">Map unavailable — using the schematic instead.</p>
        <p className="max-w-xs text-[11px] leading-relaxed opacity-70">
          {TOKEN ? 'Tiles could not be reached.' : 'No VITE_MAPBOX_TOKEN set.'}
        </p>
      </div>
    )
  }

  return (
    <div className="relative h-full w-full">
      <div ref={container} className="h-full w-full" />

      {!ready && (
        <div className="bg-background/60 text-muted-foreground absolute inset-0 flex items-center
                        justify-center gap-2 text-[12px] backdrop-blur">
          <Loader2 className="size-4 animate-spin" />loading map…
        </div>
      )}

      <AnimatePresence>
        {sel && (
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: 8 }}
                      className="glass pointer-events-none absolute top-4 left-4 z-20 w-[20rem] max-h-[70%] overflow-y-auto
                                 rounded-xl p-3 shadow-xl">
            <div className="flex items-start gap-2">
              <div className="min-w-0">
                <div className="truncate text-[13px] font-semibold">{sel.name}</div>
                <div className="text-muted-foreground text-[11px]">
                  {sel.city}{sel.country ? `, ${sel.country}` : ''}
                  <span className="ml-1.5 font-mono opacity-60">{sel.id}</span>
                </div>
              </div>
              <Badge variant="outline" className="ml-auto shrink-0 text-[9.5px]"
                     style={{ borderColor: TONE[sel.state], color: TONE[sel.state] }}>
                {LABEL[sel.state]}
              </Badge>
            </div>
            <div className="mt-2.5 grid grid-cols-2 gap-2">
              <div>
                <div className="text-muted-foreground flex items-center gap-1 text-[9.5px]
                                tracking-[0.1em] uppercase">
                  <ShieldCheck className="size-2.5" />Trust</div>
                <div className="font-mono text-[15px]">
                  {Number(sel.effective_reliability ?? 0).toFixed(2)}</div>
                <div className="text-muted-foreground text-[9.5px]">
                  {(sel.deliveries_on_time ?? 0) + (sel.deliveries_late ?? 0) > 0
                    ? `${sel.deliveries_on_time} on time \u00b7 ${sel.deliveries_late} late`
                    : 'no deliveries yet'}</div>
              </div>
              <div>
                <div className="text-muted-foreground flex items-center gap-1 text-[9.5px]
                                tracking-[0.1em] uppercase">
                  <Truck className="size-2.5" />Transit</div>
                <div className="font-mono text-[15px]">
                  {sel.transit_days != null ? `${sel.transit_days}d` : '—'}</div>
              </div>
            </div>
            {sel.contradictions_detected > 0 && (
              <div className="border-danger/40 bg-danger/10 text-danger mt-2 flex items-center
                              gap-1.5 rounded-md border px-2 py-1 text-[10.5px]">
                <AlertTriangle className="size-3 shrink-0" />
                {sel.contradictions_detected} claim(s) contradicted by carrier
              </div>
            )}
            {sel.shipments?.map((s) => (
              <div key={s.id} className="mt-1.5 flex items-center gap-1.5 text-[10.5px]">
                <span className="font-mono">{s.id}</span>
                <span className="text-muted-foreground">{s.quantity}u \u00b7 {s.mode}</span>
                <span className="ml-auto font-mono">{inr(s.total_value)}</span>
              </div>
            ))}

            {sel.trust_moves?.length > 0 && (
              <div className="mt-3">
                <div className="text-muted-foreground text-[9.5px] tracking-[0.1em] uppercase">
                  Why the score moved
                </div>
                <div className="mt-1.5 flex flex-col gap-1.5">
                  {sel.trust_moves.map((m, i) => (
                    <div key={i} className="flex items-start gap-1.5 text-[10.5px] leading-snug">
                      <span className={`shrink-0 font-mono ${
                        m.delta > 0 ? 'text-ok' : m.delta < 0 ? 'text-danger'
                                                             : 'text-muted-foreground'}`}>
                        {m.delta > 0 ? '+' : ''}{Number(m.delta).toFixed(2)}
                      </span>
                      <span className="text-muted-foreground">{m.reason}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {sel.actions?.length > 0 && (
              <div className="mt-3">
                <div className="text-muted-foreground flex items-center gap-1 text-[9.5px]
                                tracking-[0.1em] uppercase">
                  <History className="size-2.5" />What the agent did
                </div>
                <div className="mt-1.5 flex flex-col gap-1.5">
                  {sel.actions.map((a, i) => (
                    <div key={i} className="flex items-start gap-1.5 text-[10.5px] leading-snug">
                      <span className="bg-primary/60 mt-[6px] size-1 shrink-0 rounded-full" />
                      <span className="text-muted-foreground">{a.summary}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      <div className="pointer-events-none absolute bottom-4 left-4 flex flex-col gap-1.5">
        {['delayed', 'in_transit', 'open', 'idle'].map((k) => (
          <div key={k} className="text-muted-foreground flex items-center gap-1.5 text-[11px]">
            <span className="size-2 rounded-full" style={{ background: TONE[k] }} />{LABEL[k]}
          </div>
        ))}
        <div className="text-muted-foreground/70 mt-1 text-[10px]">
          scroll to zoom · drag to pan · hover a node for detail
        </div>
      </div>
    </div>
  )
}
