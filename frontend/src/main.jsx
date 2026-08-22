import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import Root from './Root.jsx'
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
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 0,
      gcTime: 60_000,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      refetchInterval: 4000,
      refetchIntervalInBackground: false,
    },
  },
})

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <Root />
    </QueryClientProvider>
  </StrictMode>
)
