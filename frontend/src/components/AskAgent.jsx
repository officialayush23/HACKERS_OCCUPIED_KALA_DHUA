import { useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { motion } from 'motion/react'
import { Bot, Loader2, Send, Sparkles, User } from 'lucide-react'
import { api } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'

const SUGGESTIONS = [
  'Why is the Motor Driver IC at risk?',
  'Why did you reject Budget Semicon Traders?',
  'What happens if we do nothing?',
  'Show me the safest recovery plan.',
]

/**
 * Conversational agent. It READS the same deterministic state the solver uses
 * and explains it. It cannot execute — control actions go through the approval
 * flow, which is authorised deterministically.
 */
export default function AskAgent({ incidentId }) {
  const [turns, setTurns] = useState([])
  const [q, setQ] = useState('')
  const endRef = useRef(null)

  const ask = useMutation({
    mutationFn: (question) => api.ask(question, incidentId),
    onSuccess: (r, question) => {
      setTurns((t) => [...t, { role: 'user', text: question },
                              { role: 'agent', text: r.answer, llm: r.llm }])
      setTimeout(() => endRef.current?.scrollIntoView({ behavior: 'smooth' }), 50)
    },
  })

  const send = (text) => { if (text.trim()) { setQ(''); ask.mutate(text.trim()) } }

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col">
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-4 p-6">
          {turns.length === 0 && (
            <div className="py-10 text-center">
              <div className="bg-primary/10 ring-primary/25 mx-auto flex size-12 items-center
                              justify-center rounded-full ring-1">
                <Sparkles className="text-primary size-5" />
              </div>
              <h2 className="mt-3 text-[17px] font-semibold">Ask the agent</h2>
              <p className="text-muted-foreground mx-auto mt-1 max-w-md text-[12.5px]
                            leading-relaxed">
                It answers from live operational state — the same numbers the solver used.
                It will tell you when it does not know rather than guess.
              </p>
              <div className="mt-5 flex flex-wrap justify-center gap-2">
                {SUGGESTIONS.map((s) => (
                  <button key={s} onClick={() => send(s)}
                    className="glass hover:border-primary/40 rounded-full px-3 py-1.5
                               text-[12px] transition-colors">
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {turns.map((t, i) => (
            <motion.div key={i} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
                        className="flex gap-2.5">
              <div className={`mt-0.5 flex size-7 shrink-0 items-center justify-center
                               rounded-full ring-1 ${t.role === 'agent'
                  ? 'bg-primary/15 text-primary ring-primary/30'
                  : 'bg-ok/15 text-ok ring-ok/30'}`}>
                {t.role === 'agent' ? <Bot className="size-3.5" /> : <User className="size-3.5" />}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-[12.5px] font-medium">
                    {t.role === 'agent' ? 'DisruptionOps Agent' : 'You'}
                  </span>
                  {t.role === 'agent' && (
                    <Badge variant="outline" className={`text-[9px] ${t.llm
                      ? 'border-primary/40 bg-primary/10 text-primary'
                      : 'border-border bg-muted text-muted-foreground'}`}>
                      {t.llm ? 'gemini' : 'deterministic fallback'}
                    </Badge>
                  )}
                </div>
                <p className="mt-1 text-[13px] leading-relaxed whitespace-pre-wrap">{t.text}</p>
              </div>
            </motion.div>
          ))}

          {ask.isPending && (
            <div className="text-muted-foreground flex items-center gap-2 text-[12.5px]">
              <Loader2 className="size-3.5 animate-spin" />thinking…
            </div>
          )}
          <div ref={endRef} />
        </div>
      </ScrollArea>

      <div className="flex shrink-0 items-center gap-2 border-t p-4">
        <Input value={q} placeholder="Ask about the current situation…"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send(q)}
          className="text-[13px]" />
        <Button disabled={!q.trim() || ask.isPending} onClick={() => send(q)}>
          <Send className="size-4" />
        </Button>
      </div>
    </div>
  )
}
