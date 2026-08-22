import { Component } from 'react'
import { AlertTriangle, RotateCcw } from 'lucide-react'

/**
 * A thrown render is a fact, not a blank page.
 *
 * React unmounts the whole tree when a component throws, so one bad field
 * access in one panel takes the entire dashboard white — no message, no stack,
 * nothing in the UI to distinguish it from a dead server. That has happened
 * more than once here and every time the first ten minutes went into working
 * out *which* screen died.
 *
 * The boundary is per page, so a broken panel costs you that panel and not the
 * session: the sidebar still works, the socket stays open, and you can navigate
 * away and back. The error and its component stack are on screen because the
 * person looking at it is the person who can fix it.
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null, info: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    // Also to the console, so the browser's own stack trace with source maps is
    // available — this panel shows the summary, devtools shows the detail.
    console.error('[DisruptionOps] render failed', error, info)
    this.setState({ info })
  }

  componentDidUpdate(prev) {
    // Navigating away is the natural "try again". Without this the boundary
    // would latch and every subsequent page would show the same dead error.
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null, info: null })
    }
  }

  render() {
    const { error, info } = this.state
    if (!error) return this.props.children

    return (
      <div className="h-full overflow-auto p-8">
        <div className="mx-auto flex max-w-2xl flex-col gap-4">
          <div className="flex items-center gap-2.5">
            <AlertTriangle className="text-danger size-5" />
            <h2 className="text-[17px] font-semibold tracking-tight">
              This screen failed to render
            </h2>
          </div>

          <p className="text-muted-foreground text-[13px] leading-relaxed">
            The rest of the app is still running — the socket is open and the other
            pages work. Only this panel threw. Nothing in the database has changed
            because of it.
          </p>

          <div className="border-danger/40 bg-danger/[0.06] rounded-xl border px-4 py-3">
            <div className="text-danger font-mono text-[12.5px] leading-relaxed break-words">
              {String(error?.message || error)}
            </div>
          </div>

          {info?.componentStack && (
            <div>
              <div className="text-muted-foreground mb-1.5 text-[10px] font-medium
                              tracking-[0.12em] uppercase">Where</div>
              <pre className="bg-muted/40 max-h-64 overflow-auto rounded-lg border p-3
                              font-mono text-[10.5px] leading-relaxed">
{info.componentStack.trim()}
              </pre>
            </div>
          )}

          <button onClick={() => this.setState({ error: null, info: null })}
                  className="border-border hover:bg-accent/40 inline-flex w-fit items-center
                             gap-2 rounded-lg border px-3.5 py-2 text-[13px] transition-colors">
            <RotateCcw className="size-3.5" />Try rendering it again
          </button>
        </div>
      </div>
    )
  }
}
