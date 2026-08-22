import { useEffect, useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { AnimatePresence, motion } from 'motion/react'
import { CornerDownLeft, Loader2, Search, Sparkles } from 'lucide-react'
import { api } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from '@/components/ui/command'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'

/**
 * ⌘K — navigation and the agent in the same box.
 *
 * "Ask the Agent" used to be a page you navigated to, which is exactly backwards:
 * the questions an operator asks are about whatever is already on screen, and
 * making them leave that screen to ask is what stops people asking. Here the
 * agent is one keystroke away from anywhere, and answers in place.
 */
const SUGGESTIONS = [
  'Why did you choose that supplier?',
  'What happens if PO-7712 slips another two days?',
  'Which incidents can stop production this week?',
  'Why was the cheapest supplier rejected?',
  'What is the agent waiting on right now?',
]

export default function CommandBar({ open, onOpenChange, pages, onGoto }) {
  const [q, setQ] = useState('')
  const [answer, setAnswer] = useState(null)
  const endRef = useRef(null)

  const ask = useMutation({
    mutationFn: (question) => api.ask(question, null),
    onSuccess: (r, question) => setAnswer({ question, ...r }),
  })

  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault(); onOpenChange(!open)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onOpenChange])

  useEffect(() => { if (!open) { setAnswer(null); setQ('') } }, [open])
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [answer])

  const submit = (text) => {
    const question = (text ?? q).trim()
    if (!question) return
    setAnswer(null)
    ask.mutate(question)
  }

  const go = (id) => { onGoto(id); onOpenChange(false) }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false}
                     className="glass overflow-hidden p-0 sm:max-w-[38rem]">
        <DialogTitle className="sr-only">Ask DisruptionOps or jump to a screen</DialogTitle>

        <Command shouldFilter={!q.trim().endsWith('?')} className="bg-transparent">
          <div className="relative border-b px-2 py-1.5">
            <CommandInput
              value={q} onValueChange={setQ}
              placeholder="Ask DisruptionOps anything, or jump to a screen…"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && q.trim().endsWith('?')) { e.preventDefault(); submit() }
              }}
              className="text-[13.5px]" />
            {ask.isPending && (
              <Loader2 className="text-primary absolute top-1/2 right-5 size-4
                                  -translate-y-1/2 animate-spin" />
            )}
          </div>

          <ScrollArea className="max-h-[26rem]">
            <CommandList className="max-h-none overflow-visible px-1.5 pb-2">
              {q.trim() && (
                <CommandGroup heading="Ask the agent">
                  <CommandItem value={`ask-${q}`} onSelect={() => submit()}
                               className="gap-2.5 py-2.5">
                    <Sparkles className="text-primary size-4" />
                    <span className="truncate text-[13px]">{q}</span>
                    <Badge variant="outline" className="ml-auto gap-1 text-[10px]">
                      <CornerDownLeft className="size-2.5" />ask
                    </Badge>
                  </CommandItem>
                </CommandGroup>
              )}

              <CommandGroup heading="Go to">
                {pages.map((p) => (
                  <CommandItem key={p.id} value={`${p.label} ${p.sub}`}
                               onSelect={() => go(p.id)} className="gap-2.5 py-2">
                    <p.icon className="text-muted-foreground size-4" />
                    <span className="text-[13px]">{p.label}</span>
                    <span className="text-muted-foreground ml-auto text-[11px]">{p.sub}</span>
                  </CommandItem>
                ))}
              </CommandGroup>

              {!q.trim() && (
                <CommandGroup heading="Try asking">
                  {SUGGESTIONS.map((s) => (
                    <CommandItem key={s} value={s} onSelect={() => submit(s)}
                                 className="gap-2.5 py-2">
                      <Sparkles className="text-muted-foreground size-3.5" />
                      <span className="text-muted-foreground text-[12.5px]">{s}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}

              <CommandEmpty className="text-muted-foreground py-8 text-center text-[12.5px]">
                End with a question mark to ask the agent instead of searching.
              </CommandEmpty>
            </CommandList>

            <AnimatePresence>
              {(answer || ask.isError) && (
                <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
                            className="border-t px-5 py-4">
                  {ask.isError ? (
                    <p className="text-danger text-[12.5px]">{String(ask.error.message)}</p>
                  ) : (
                    <>
                      <p className="text-muted-foreground text-[11.5px]">{answer.question}</p>
                      <p className="mt-2 text-[13.5px] leading-relaxed">{answer.answer}</p>

                      {answer.blocks?.length > 0 && (
                        <div className="mt-4 flex flex-col gap-4">
                          {answer.blocks.map((b, i) => <Block key={i} block={b} />)}
                        </div>
                      )}

                      {answer.grounding?.length > 0 && (
                        <div className="mt-3 flex flex-wrap gap-1.5">
                          {answer.grounding.slice(0, 6).map((g, i) => (
                            <Badge key={i} variant="outline" className="text-[10px]">{g}</Badge>
                          ))}
                        </div>
                      )}
                      <p className="text-muted-foreground/70 mt-3 text-[10.5px]">
                        Answered from live operational state, not from memory.
                      </p>
                    </>
                  )}
                  <div ref={endRef} />
                </motion.div>
              )}
            </AnimatePresence>
          </ScrollArea>
        </Command>
      </DialogContent>
    </Dialog>
  )
}

/**
 * The answer, rendered rather than narrated.
 *
 * Prose is the wrong shape for "how much, of what, by when". These blocks are
 * built server-side from the operational tables — the model never sees them and
 * never writes them — so a figure on screen here is a figure that exists in the
 * database, and the answer still carries its numbers when the model is
 * unreachable.
 */
function Block({ block }) {
  const title = (
    <div className="text-muted-foreground text-[10px] font-medium tracking-[0.12em] uppercase">
      {block.title}
    </div>
  )

  if (block.kind === 'facts') {
    return (
      <div>
        {title}
        <div className="mt-2 flex flex-wrap gap-2">
          {(block.items ?? []).map((it, i) => (
            <div key={i} className="min-w-[9rem] rounded-lg border px-3 py-2">
              <div className="text-muted-foreground font-mono text-[10px]">{it.label}</div>
              <div className="mt-0.5 text-[13px] font-medium">{it.value}</div>
              {it.sub && (
                <div className="text-muted-foreground mt-0.5 text-[11px]">{it.sub}</div>
              )}
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (block.kind === 'table') {
    const align = block.align ?? []
    return (
      <div>
        {title}
        <div className="mt-2 overflow-x-auto rounded-lg border">
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="bg-muted/40">
                {(block.columns ?? []).map((c, i) => (
                  <th key={i}
                      className={`text-muted-foreground px-3 py-2 text-[10px] font-medium
                                  tracking-[0.1em] uppercase
                                  ${align[i] === 'right' ? 'text-right' : 'text-left'}`}>
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(block.rows ?? []).map((row, ri) => (
                <tr key={ri} className="border-t">
                  {row.map((cell, ci) => (
                    <td key={ci}
                        className={`px-3 py-2 ${align[ci] === 'right'
                          ? 'text-right font-mono tabular-nums' : ''}`}>
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {block.note && (
          <p className="text-muted-foreground/70 mt-1.5 text-[10.5px] leading-relaxed">
            {block.note}
          </p>
        )}
      </div>
    )
  }

  if (block.kind === 'list') {
    return (
      <div>
        {title}
        <ul className="mt-2 flex flex-col gap-1.5">
          {(block.items ?? []).map((it, i) => (
            <li key={i} className="flex gap-2 text-[12.5px] leading-relaxed">
              <span className="text-muted-foreground/60 shrink-0">·</span>{it}
            </li>
          ))}
        </ul>
      </div>
    )
  }

  return null
}

/** The affordance that tells people the bar exists at all. */
export function CommandBarTrigger({ onClick }) {
  return (
    <Button variant="outline" size="sm" onClick={onClick}
            className="text-muted-foreground h-8 gap-2 px-2.5 font-normal">
      <Search className="size-3.5" />
      <span className="text-[12px]">Ask anything</span>
      <kbd className="bg-muted rounded px-1.5 py-0.5 font-mono text-[10px]">⌘K</kbd>
    </Button>
  )
}
