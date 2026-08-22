import { useQuery } from '@tanstack/react-query'
import {
  Building2, ExternalLink, MessageSquareWarning, ShieldAlert, Truck, Users, Warehouse,
} from 'lucide-react'
import { api } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import {
  Popover, PopoverContent, PopoverTrigger,
} from '@/components/ui/popover'

/**
 * The other two actors, one click away.
 *
 * The multi-actor simulation is the strongest thing this system does and it was
 * invisible: the supplier portal and the warehouse screen were real, complete,
 * and reachable only by typing a URL nobody had been told about. A capability
 * you have to be told about in a README is a capability you will not be shown
 * in a five-minute demo.
 *
 * Everything opens in a new tab on purpose. Three windows side by side — the
 * manager, the supplier, the floor — is the demo, and nothing is piped between
 * them: every message goes through the database and the agent. That is what
 * makes the loop testable rather than asserted.
 *
 * Two live signals worth the space:
 *
 *   **staffed** — a person has that supplier's portal open, so the scripted
 *   persona has stood down and the agent is genuinely waiting for a human.
 *   That is the difference between a demo and a recording.
 *
 *   **waiting on them** — the agent has written and had no reply. These are the
 *   portals worth opening; the rest are just a directory.
 */

function Row({ href, icon: Icon, title, sub, right, tone }) {
  return (
    <a href={href} target="_blank" rel="noreferrer"
       className="hover:bg-accent/40 group flex items-center gap-3 rounded-lg px-3 py-2.5
                  transition-colors">
      <Icon className={`size-4 shrink-0 ${tone ?? 'text-muted-foreground'}`} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium">{title}</div>
        {sub && <div className="text-muted-foreground truncate text-[11px]">{sub}</div>}
      </div>
      {right}
      <ExternalLink className="text-muted-foreground/0 group-hover:text-muted-foreground/60
                               size-3.5 shrink-0 transition-colors" />
    </a>
  )
}

export default function PortalLauncher() {
  const { data } = useQuery({
    queryKey: ['supplier-directory'], queryFn: api.supplierDirectory,
    refetchInterval: 8000 })
  const { data: ctx } = useQuery({ queryKey: ['context'], queryFn: api.context })

  const suppliers = data?.suppliers ?? []
  const staffed = data?.staffed ?? []
  const waiting = suppliers.filter((s) => (s.waiting_on_them ?? 0) > 0)
  const rest = suppliers.filter((s) => !(s.waiting_on_them > 0))
  const warehouses = ctx?.warehouses ?? [{ id: 'Pune-Plant-1', name: 'Pune Plant' }]

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm"
                className="h-8 gap-1.5 px-2.5 text-[12px] font-normal">
          <Users className="size-3.5" />
          Portals
          {staffed.length > 0 && (
            <span className="bg-ok size-1.5 rounded-full" title="a person is answering" />
          )}
          {waiting.length > 0 && (
            <Badge variant="outline"
                   className="border-warn/40 bg-warn/10 text-warn ml-0.5 h-4 px-1 text-[9.5px]">
              {waiting.length}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>

      <PopoverContent align="end" className="w-[26rem] p-0">
        <div className="px-4 py-3.5">
          <div className="text-[13px] font-medium">Answer as someone else</div>
          <p className="text-muted-foreground mt-1 text-[11.5px] leading-relaxed">
            Each of these is a separate screen for a separate person. Open one in
            another window and reply to the agent by hand — nothing is piped between
            tabs, so whatever you say goes through the database and the agent reads
            it the way it would read a real email.
          </p>
        </div>

        <Separator />

        <ScrollArea className="max-h-[26rem]">
          <div className="p-2">
            {waiting.length > 0 && (
              <>
                <div className="text-muted-foreground px-3 pt-1.5 pb-1 text-[10px]
                                font-medium tracking-[0.12em] uppercase">
                  The agent is waiting on these
                </div>
                {waiting.map((s) => (
                  <Row key={s.id} href={`/supplier/${s.id}`} icon={MessageSquareWarning}
                       tone="text-warn"
                       title={s.name}
                       sub={`${s.id} · ${s.city ?? ''}${s.country ? `, ${s.country}` : ''}`}
                       right={
                         <div className="flex shrink-0 items-center gap-1.5">
                           {staffed.includes(s.id) && (
                             <Badge variant="outline"
                                    className="border-ok/40 bg-ok/10 text-ok text-[9.5px]">
                               staffed
                             </Badge>
                           )}
                           {s.contradictions_detected > 0 && (
                             <ShieldAlert className="text-danger size-3.5"
                                          title="has been caught contradicting tracking" />
                           )}
                           <Badge variant="outline"
                                  className="border-warn/40 bg-warn/10 text-warn text-[9.5px]">
                             {s.waiting_on_them} unanswered
                           </Badge>
                         </div>
                       } />
                ))}
                <Separator className="my-2" />
              </>
            )}

            <div className="text-muted-foreground px-3 pt-1.5 pb-1 text-[10px] font-medium
                            tracking-[0.12em] uppercase">
              The floor
            </div>
            {warehouses.map((w) => (
              <Row key={w.id} href={`/warehouse/${w.id}`} icon={Warehouse}
                   title={w.name ?? w.id}
                   sub="count stock, confirm what is actually usable" />
            ))}

            <Separator className="my-2" />

            <div className="text-muted-foreground px-3 pt-1.5 pb-1 text-[10px] font-medium
                            tracking-[0.12em] uppercase">
              Every supplier
            </div>
            {rest.length === 0 && waiting.length === 0 && (
              <p className="text-muted-foreground px-3 py-4 text-[12px] leading-relaxed">
                No suppliers loaded. Reset the world to re-seed the baseline.
              </p>
            )}
            {rest.map((s) => (
              <Row key={s.id} href={`/supplier/${s.id}`} icon={Building2}
                   title={s.name}
                   sub={`${s.id} · trust ${Number(s.effective_reliability ?? 0).toFixed(2)}`}
                   right={
                     staffed.includes(s.id) ? (
                       <Badge variant="outline"
                              className="border-ok/40 bg-ok/10 text-ok shrink-0 text-[9.5px]">
                         staffed
                       </Badge>
                     ) : s.contradictions_detected > 0 ? (
                       <ShieldAlert className="text-danger size-3.5 shrink-0"
                                    title="caught contradicting tracking" />
                     ) : null
                   } />
            ))}
          </div>
        </ScrollArea>

        <Separator />

        <div className="text-muted-foreground/70 flex items-start gap-2 px-4 py-3
                        text-[10.5px] leading-relaxed">
          <Truck className="mt-0.5 size-3 shrink-0" />
          While a supplier portal is open, the scripted persona for that supplier stands
          down and the agent waits for a real person. Close the tab and the script
          resumes, so an unattended demo still runs end to end.
        </div>
      </PopoverContent>
    </Popover>
  )
}
