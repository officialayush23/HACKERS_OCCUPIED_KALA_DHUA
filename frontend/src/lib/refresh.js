/**
 * Targeted refetching.
 *
 * `queryClient.invalidateQueries()` with no argument invalidates *everything*,
 * including the scenario list and the audit backfill. Sending one message
 * therefore refetched the entire application and the screen visibly reloaded.
 *
 * These are the sets that actually change together.
 */
const SETS = {
  // a physical count, a receipt, a supplier reply — the world moved
  world: ['now', 'kpis', 'warehouse', 'incidents', 'network', 'world', 'solve',
          'context', 'accuracy'],
  // someone decided something
  decision: ['now', 'approvals', 'incidents', 'solve', 'accuracy', 'kpis'],
  // a conversation advanced
  comms: ['threads', 'now', 'accuracy'],
  // a scenario started, stopped, or the world was re-seeded
  simulation: ['scenarios', 'now', 'kpis', 'world', 'context', 'runs', 'incidents',
               'network', 'warehouse', 'solve', 'accuracy'],
}

export function refresh(qc, which = 'world') {
  for (const key of SETS[which] ?? SETS.world) {
    qc.invalidateQueries({ queryKey: [key] })
  }
}
