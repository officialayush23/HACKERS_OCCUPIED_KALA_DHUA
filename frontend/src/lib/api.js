const BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:8000'
export const WS_URL = BASE.replace(/^http/, 'ws') + '/ws'

async function req(path, opts = {}) {
  const res = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  })
  if (!res.ok) {
    const body = await res.text()
    let detail = body
    try { detail = JSON.parse(body).detail ?? body } catch { /* plain text */ }
    throw new Error(detail || `${res.status} ${res.statusText}`)
  }
  return res.json()
}

export const api = {
  health:      ()             => req('/api/health'),
  scenarios:   ()             => req('/api/scenarios'),
  inject:      (id)           => req(`/api/scenarios/${id}/inject`, { method: 'POST' }),
  reset:       (mode='demo')  => req(`/api/scenarios/reset?mode=${mode}`, { method: 'POST' }),
  runs:        ()             => req('/api/runs'),
  score:       (runId)        => req(`/api/runs/${runId}/score`, { method: 'POST' }),
  world:       ()             => req('/api/world'),
  kpis:        ()             => req('/api/kpis'),
  network:     ()             => req('/api/network'),
  incidents:   ()             => req('/api/incidents'),
  audit:       (after = 0)    => req(`/api/audit?after=${after}&limit=300`),
  solve:       (poId, record) => req(`/api/solve/${poId}?record=${record ? 'true' : 'false'}`),
  customEvent: (body)         => req('/api/events/custom', { method: 'POST', body: JSON.stringify(body) }),
  log:         (text)         => req('/api/logs', { method: 'POST', body: JSON.stringify({ text }) }),
}
