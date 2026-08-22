import { useEffect, useRef, useState, useCallback } from 'react'
import { WS_URL } from './api'

/**
 * Live audit stream. The socket carries EVENTS; it does not carry world state.
 * When something structural changes we bump `revision` so panes refetch.
 */
export function useAgentStream() {
  const [events, setEvents] = useState([])
  const [clock, setClock] = useState(null)
  const [status, setStatus] = useState('connecting')
  const [revision, setRevision] = useState(0)
  const wsRef = useRef(null)
  const retryRef = useRef(null)

  const clear = useCallback(() => setEvents([]), [])

  useEffect(() => {
    let closed = false

    const connect = () => {
      if (closed) return
      setStatus('connecting')
      const ws = new WebSocket(WS_URL)
      wsRef.current = ws

      ws.onopen = () => setStatus('live')

      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data)
        if (msg.kind === 'clock' || msg.kind === 'hello') {
          setClock(msg.clock)
          return
        }
        if (msg.kind === 'audit_event') {
          setEvents((prev) => {
            if (prev.some((x) => x.sequence === msg.event.sequence)) return prev
            return [...prev, msg.event].slice(-400)
          })
          setRevision((r) => r + 1)
          return
        }
        if (msg.kind === 'world_reset') {
          setEvents([])
          setClock(msg.clock)
        }
        setRevision((r) => r + 1)
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
  }, [])

  return { events, clock, status, revision, clear }
}
