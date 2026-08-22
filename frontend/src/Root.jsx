import { lazy, Suspense } from 'react'
import App from './App.jsx'

/**
 * Which actor is this browser window?
 *
 * No router dependency — one read of the path is enough, and it keeps the
 * operations bundle out of the warehouse window entirely. Two windows side by
 * side is the whole demo:
 *
 *   /                        operations — the supply-chain manager
 *   /warehouse               the floor at Pune-Plant-1
 *   /warehouse/<id>          a specific facility
 */
const WarehousePortal = lazy(() => import('./WarehousePortal.jsx'))

export default function Root() {
  const path = typeof window !== 'undefined' ? window.location.pathname : '/'
  const wh = path.match(/^\/warehouse\/?(.*)$/)

  if (wh) {
    const id = decodeURIComponent(wh[1] || '') || 'Pune-Plant-1'
    return (
      <Suspense fallback={
        <div className="text-muted-foreground flex h-screen items-center justify-center
                        text-[13px]">opening the warehouse…</div>}>
        <WarehousePortal warehouseId={id} />
      </Suspense>
    )
  }
  return <App />
}
