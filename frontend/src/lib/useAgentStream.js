import { useEffect, useRef, useState, useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api, WS_URL } from './api'

/**
 * Live audit stream.
 *
 * Two things this has to get right, and both were previously wrong:
 *
 *   1. **History.** The socket only carries events that happen after it opens.
 *      Opening the dashboard mid-run therefore showed an agent that had
 *      apparently done nothing, while every other pane showed the consequences
 *      of work it had already done. We now backfill the whole audit log on
 *      connect, then stream on top of it.
 *
 *   2. **Fan-out.** The socket carries events, not world state. A pane that
 *      polls on its own timer is up to its interval out of date with the feed
 *      next to it, which is exactly how two panels come to disagree on screen.
 *      Every event now invalidates the derived queries immediately.
 */
export function useAgentStream() {
  const qc = useQueryClient()
  const [events, setEvents] = useState([])
  const [clock, setClock] = useState(null)
  const [status, setStatus] = useState('connecting')
  const [revision, setRevision] = useState(0)
  const [backfilled, setBackfilled] = useState(false)
  const wsRef = useRef(null)
  const retryRef = useRef(null)

  const clear = useCallback(() => setEvents([]), [])

  // Anything derived from the world rather than pushed down the socket.
  // Anything derived from the world, refreshed on every event. This is a
  // denylist rather than a list of keys to remember: the previous version was
  // an allowlist, and every query key added afterwards silently went stale.
  const refresh = useCallback(() => {
    qc.invalidateQueries({ predicate: (q) => q.queryKey?.[0] !== 'llm' })
  }, [qc])

  const merge = useCallback((incoming) => {
    setEvents((prev) => {
      const seen = new Set(prev.map((e) => e.sequence))
      const fresh = incoming.filter((e) => !seen.has(e.sequence))
      if (!fresh.length) return prev
      return [...prev, ...fresh]
        .sort((a, b) => a.sequence - b.sequence)
        .slice(-600)
    })
  }, [])

  useEffect(() => {
    let closed = false

    // 1. Everything that already happened, before we listen for what happens next.
    api.audit(0)
      .then((r) => { if (!closed) { merge(r.events ?? r ?? []); setBackfilled(true) } })
      .catch(() => { if (!closed) setBackfilled(true) })

    const connect = () => {
      if (closed) return
      setStatus('connecting')
      const ws = new WebSocket(WS_URL)
      wsRef.current = ws

      ws.onopen = () => {
        setStatus('live')
        // A reconnect may have missed events; re-read rather than guess.
        api.audit(0).then((r) => !closed && merge(r.events ?? r ?? [])).catch(() => {})
      }

      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data)

        if (msg.kind === 'clock' || msg.kind === 'hello') {
          setClock(msg.clock)
          return
        }

        if (msg.kind === 'audit_event') {
          merge([msg.event])
          setRevision((r) => r + 1)
          refresh()
          return
        }

        if (msg.kind === 'world_reset') {
          setEvents([])
          setClock(msg.clock)
          qc.clear()
        }

        setRevision((r) => r + 1)
        refresh()
      }

      ws.onclose = () => {
        setStatus('offline')
        if (!closed) retryRef.current = setTimeout(connect, 1500)
      }
      ws.onerror = () => ws.close()
    }

    connect()
    const ping = setInterval(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send('ping')
    }, 20000)

    return () => {
      closed = true
      clearInterval(ping)
      clearTimeout(retryRef.current)
      wsRef.current?.close()
    }
  }, [merge, refresh, qc])

  return { events, clock, status, revision, backfilled, clear }
}
