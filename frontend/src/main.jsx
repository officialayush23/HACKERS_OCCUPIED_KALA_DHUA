import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { toast } from 'sonner'
import Root from './Root.jsx'
import { hydrate, persist } from './lib/persist.js'
import './index.css'

// Theme is owned by useTheme(); this only avoids a flash of the wrong theme.
try {
  const t = localStorage.getItem('disruptionops-theme') || 'dark'
  document.documentElement.classList.toggle('dark', t === 'dark')
  document.documentElement.style.colorScheme = t
} catch { document.documentElement.classList.add('dark') }

// Sockets are the fast path, not the only path. A dropped WebSocket used to
// mean panes sat on whatever they last fetched, with nothing on screen saying
// so — which is indistinguishable from a broken backend. A short poll is the
// floor underneath the socket: nothing on this dashboard can be more than a
// few seconds behind the database, socket or no socket.
// The socket is the fast path. The poll underneath it is a *heartbeat*, not a
// data source: 4s was cheap per request and expensive in aggregate — a dozen
// keys times a dozen panels produced the request storm in the server log, and
// every one of those responses re-rendered the page. 12s catches a dropped
// socket without the app talking to itself.
/** What a mutation says when it lands. `meta.toast` overrides; `meta.silent` opts out. */
function toastFor(mutation, data) {
  const meta = mutation?.options?.meta ?? {}
  if (meta.silent) return null
  if (typeof meta.toast === 'function') return meta.toast(data)
  if (meta.toast) return meta.toast
  // Fall back to whatever the endpoint said about itself before inventing a
  // sentence — the server usually knows better than we do here.
  return data?.summary || data?.message || 'Done'
}

const queryClient = new QueryClient({
  // Every write confirms itself. Silence after clicking a button is how people
  // end up clicking it twice, and how a failed write looks exactly like a
  // successful one.
  mutationCache: new MutationCache({
    onSuccess: (data, _vars, _ctx, mutation) => {
      const msg = toastFor(mutation, data)
      if (msg) toast.success(msg)
    },
    onError: (error, _vars, _ctx, mutation) => {
      if (mutation?.options?.meta?.silent) return
      toast.error(String(error?.message || error), {
        description: 'Nothing was changed. The server rejected the request.',
      })
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 1500,
      gcTime: 30 * 60_000,          // long, so the persisted cache has something to hold
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      refetchInterval: 12_000,
      refetchIntervalInBackground: false,
      retry: 1,
    },
  },
})

// Paint the last snapshot before the first request goes out, then refetch under
// it. Everything hydrated is marked stale, so nothing here can outlive the truth.
hydrate(queryClient)
persist(queryClient)

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <Root />
    </QueryClientProvider>
  </StrictMode>
)
