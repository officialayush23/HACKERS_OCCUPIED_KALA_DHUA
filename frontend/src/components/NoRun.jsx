import { FlaskConical, Network } from 'lucide-react'
import { Button } from '@/components/ui/button'

/**
 * The empty state that has to exist on every screen.
 *
 * With no test run there is no incident, no decision, no log and no score — and
 * a screen that renders 0% or "failed" in that situation is asserting something
 * about a thing that never happened. `null` is not `0`.
 *
 * The baseline world (suppliers, plants, lanes) is still real and may still be
 * shown; what must not appear is evidence.
 */
export default function NoRun({
  title = 'No active test run',
  what = 'Nothing has happened yet.',
  onRun,
  icon: Icon = FlaskConical,
  baseline,
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-10 text-center">
      <Icon className="text-muted-foreground/40 size-8" />
      <div>
        <p className="text-[17px] font-semibold tracking-tight">{title}</p>
        <p className="text-muted-foreground mx-auto mt-2.5 max-w-sm text-[13px] leading-relaxed">
          {what}
        </p>
      </div>

      {onRun && (
        <Button size="lg" onClick={onRun} className="mt-1 h-10">
          <FlaskConical className="size-4" />Run a scenario
        </Button>
      )}

      {baseline && (
        <div className="text-muted-foreground/70 mt-4 flex items-center gap-2 text-[11.5px]">
          <Network className="size-3.5" />{baseline}
        </div>
      )}
    </div>
  )
}
