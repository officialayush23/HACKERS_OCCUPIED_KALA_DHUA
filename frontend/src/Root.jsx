import { lazy, Suspense } from 'react'
import App from './App.jsx'
import { Toaster } from '@/components/ui/sonner'

/**
 * Which actor is this browser window?
 *
 * No router dependency — one read of the path is enough, and it keeps each
 * actor's bundle out of the other two windows entirely. Three windows side by
 * side is the whole demo:
 *
 *   /                        operations — the supply-chain manager
 *   /warehouse               the floor at Pune-Plant-1
 *   /warehouse/<id>          a specific facility
 *   /supplier                who you could answer as
 *   /supplier/<id>           a supplier, answering the agent in their own words
 *
 * The point of splitting them is that nothing is piped between tabs. Everything
 * one actor tells another goes through the database and the agent, which is the
 * only way the loops are testable rather than asserted.
 */
const WarehousePortal = lazy(() => import('./WarehousePortal.jsx'))
const SupplierPortal = lazy(() => import('./SupplierPortal.jsx'))
const SupplierDirectory = lazy(() =>
  import('./SupplierPortal.jsx').then((m) => ({ default: m.SupplierDirectory })))

function Loading({ what }) {
  return (
    <div className="text-muted-foreground flex h-screen items-center justify-center
                    text-[13px]">opening {what}…</div>
  )
}

function Shell({ children }) {
  // Mounted once, above the actor split, so the supplier and warehouse windows
  // get the same confirmations the operations window does.
  return (
    <>
      {children}
      <Toaster position="bottom-right" closeButton richColors />
    </>
  )
}

export default function Root() {
  const path = typeof window !== 'undefined' ? window.location.pathname : '/'

  const wh = path.match(/^\/warehouse\/?(.*)$/)
  if (wh) {
    const id = decodeURIComponent(wh[1] || '') || 'Pune-Plant-1'
    return (
      <Shell>
        <Suspense fallback={<Loading what="the warehouse" />}>
          <WarehousePortal warehouseId={id} />
        </Suspense>
      </Shell>
    )
  }

  const sup = path.match(/^\/supplier\/?(.*)$/)
  if (sup) {
    const id = decodeURIComponent(sup[1] || '').replace(/\/$/, '')
    return (
      <Shell>
        <Suspense fallback={<Loading what={id ? id : 'the supplier list'} />}>
          {id ? <SupplierPortal supplierId={id.toUpperCase()} /> : <SupplierDirectory />}
        </Suspense>
      </Shell>
    )
  }

  return <Shell><App /></Shell>
}
