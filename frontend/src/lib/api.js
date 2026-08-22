const BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:8000'
export const WS_URL = BASE.replace(/^http/, 'ws') + '/ws'

async function req(path, opts = {}) {
  const res = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json' }, ...opts,
  })
  if (!res.ok) {
    const body = await res.text()
    let detail = body
    try { detail = JSON.parse(body).detail ?? body } catch { /* plain */ }
    throw new Error(detail || `${res.status} ${res.statusText}`)
  }
  return res.json()
}
const post = (p, b) => req(p, { method: 'POST', ...(b ? { body: JSON.stringify(b) } : {}) })

export const api = {
  // world
  health:      ()          => req('/api/health'),
  context:     ()          => req('/api/context'),
  world:       ()          => req('/api/world'),
  kpis:        ()          => req('/api/kpis'),
  network:     ()          => req('/api/network'),
  incidents:   ()          => req('/api/incidents'),
  audit:       (after = 0) => req(`/api/audit?after=${after}&limit=300`),

  // simulation
  scenarios:   ()          => req('/api/scenarios'),
  inject:      (id)        => post(`/api/scenarios/${id}/inject`),
  reset:       (m='demo')  => post(`/api/scenarios/reset?mode=${m}`),
  customEvent: (b)         => post('/api/events/custom', b),
  log:         (text)      => post('/api/logs', { text }),

  // agent
  agentSteps:  (id)        => req(`/api/agent/steps/${id}`),
  agentState:  ()          => req('/api/agent/state'),
  resume:      (id, b)     => post(`/api/agent/resume/${id}`, b),
  verify:      (id)        => post(`/api/agent/verify/${id}`),
  ask:         (q, id)     => post('/api/agent/ask', { question: q, incident_id: id }),
  llmHealth:   ()          => req('/api/llm/health'),

  // comms
  threads:     (id)        => req('/api/threads' + (id ? `?incident_id=${id}` : '')),
  sendMessage: (b)         => post('/api/threads/message', b),

  // warehouse
  warehouse:   ()          => req('/api/warehouse'),
  completeTask:(id, b)     => post(`/api/warehouse/tasks/${id}/complete`, b),
  receive:     (b)         => post('/api/warehouse/receive', b),

  // decisions
  approvals:   ()          => req('/api/approvals'),
  solve:       (po, rec, exclude = []) => req(
    `/api/solve/${po}?record=${rec ? 'true' : 'false'}` +
    (exclude.length ? `&exclude=${exclude.join(',')}` : '')),
  runs:        ()          => req('/api/runs'),
  score:       (id)        => post(`/api/runs/${id}/score`),
}
