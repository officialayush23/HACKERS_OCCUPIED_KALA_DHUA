/**
 * Keeping every screen honest about the same moment.
 *
 * The WebSocket is the single push channel — the agent emits one event, the hub
 * fans it out, and every pane re-reads. There is no second channel (no Supabase
 * Realtime) on purpose: two push paths eventually disagree, and the one thing
 * this dashboard cannot afford is two panels telling different stories.
 *
 * The bug this replaces was not caching. It was an **allowlist**: the socket
 * invalidated a hand-written list of query keys, so every key added later —
 * `accuracy`, `activeRun`, `agentSteps` — silently never refreshed. Panels went
 * stale in exactly the places nobody thought to register.
 *
 * So the default is now a denylist. Anything derived from the world refreshes on
 * every event; only genuinely static things are excluded. A new query key is
 * covered the moment it exists, which is the failure mode that actually bit us.
 */

/** Things no world event can change. Everything else refreshes. */
const STATIC = new Set([
  'llm',        // model health — polled on its own, unaffected by the world
])

/** Narrow sets, for the cases where a full sweep is genuinely wasteful. */
const SETS = {
  comms:      ['threads', 'now', 'accuracy', 'intelligence'],
  decision:   ['now', 'approvals', 'incidents', 'solve', 'accuracy', 'kpis',
               'intelligence', 'activeRun'],
  simulation: null,   // null = everything; a run start changes the whole world
  world:      null,
}

export function refresh(qc, which = 'world') {
  const keys = SETS[which]

  if (!keys) {
    // Sweep. `predicate` sees every cached query, so nothing can be forgotten.
    qc.invalidateQueries({
      predicate: (q) => !STATIC.has(q.queryKey?.[0]),
      // 'active' is the React Query default and it leaves anything mounted but
      // not currently rendered — a page behind a tab, a panel in a closed
      // drawer — holding the data it had before the run started. You then
      // navigate to it and see the old world, which is exactly the "I had to
      // refresh the page" symptom.
      refetchType: 'all',
    })
    return
  }

  for (const key of keys) qc.invalidateQueries({ queryKey: [key] })
}
