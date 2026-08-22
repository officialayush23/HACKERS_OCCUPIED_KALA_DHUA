/**
 * Last-known-good, kept on the machine that asked for it.
 *
 * Every screen in this app is a projection of the database, and until now every
 * screen started from nothing: open the tab, get a spinner, wait for eight
 * round trips, then see the world. That reads as slowness even when the backend
 * answered in 40ms, because the honest empty state and the not-loaded-yet state
 * looked identical.
 *
 * So the cache survives a reload. On boot we paint the last snapshot
 * immediately and refetch underneath it — the numbers are a few seconds old for
 * a moment and then they are not, which is a far better trade than a blank
 * screen.
 *
 * Two deliberate limits:
 *
 *   - **Only stable keys.** Anything keyed by a live revision counter
 *     (`['kpis', 41]`) is a moving target; persisting it fills the quota with
 *     snapshots nobody will ask for again.
 *   - **Six hours.** Past that the snapshot is not "slightly stale", it is a
 *     description of a different afternoon. Better to show the spinner.
 *
 * This is a cache, never a source of truth. The backend's run scoping decides
 * what is real; this only decides what you look at during the first 200ms.
 */

const KEY = 'disruptionops-cache-v1'
const MAX_AGE_MS = 6 * 60 * 60 * 1000
const MAX_BYTES = 1.5 * 1024 * 1024      // well inside a 5MB localStorage quota

/** Keys made entirely of strings. A number in the key means it is versioned. */
const stable = (key) => Array.isArray(key) && key.every((k) => typeof k === 'string')

export function hydrate(qc) {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return 0
    const { at, entries } = JSON.parse(raw)
    if (!at || Date.now() - at > MAX_AGE_MS) {
      localStorage.removeItem(KEY)
      return 0
    }
    let n = 0
    for (const [key, data] of entries ?? []) {
      if (!stable(key)) continue
      // `updatedAt` in the past, so every hydrated query counts as stale and
      // refetches on mount. The cache paints; it never decides.
      qc.setQueryData(key, data, { updatedAt: at })
      n += 1
    }
    return n
  } catch {
    try { localStorage.removeItem(KEY) } catch { /* private mode */ }
    return 0
  }
}

export function persist(qc, { debounceMs = 2500 } = {}) {
  let timer = null

  const write = () => {
    timer = null
    try {
      const entries = qc.getQueryCache().getAll()
        .filter((q) => q.state.status === 'success'
                    && q.state.data !== undefined
                    && stable(q.queryKey))
        .map((q) => [q.queryKey, q.state.data])

      const blob = JSON.stringify({ at: Date.now(), entries })
      if (blob.length > MAX_BYTES) {
        // Too big to be worth it. Drop rather than half-write.
        localStorage.removeItem(KEY)
        return
      }
      localStorage.setItem(KEY, blob)
    } catch {
      // Quota, private browsing, storage disabled — all fine. The app works
      // without this; it is a convenience, not a dependency.
      try { localStorage.removeItem(KEY) } catch { /* nothing left to try */ }
    }
  }

  const unsubscribe = qc.getQueryCache().subscribe(() => {
    if (timer === null) timer = setTimeout(write, debounceMs)
  })

  // A reload can happen between debounce ticks; catch the last state.
  window.addEventListener('pagehide', () => { if (timer) { clearTimeout(timer); write() } })

  return unsubscribe
}

/** Used by the hard reset — a wiped backend behind a warm cache shows ghosts. */
export function clearPersisted() {
  try { localStorage.removeItem(KEY) } catch { /* nothing to clear */ }
}
