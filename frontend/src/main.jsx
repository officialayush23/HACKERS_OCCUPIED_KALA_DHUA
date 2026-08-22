import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
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
const queryClient = new QueryClient({
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
