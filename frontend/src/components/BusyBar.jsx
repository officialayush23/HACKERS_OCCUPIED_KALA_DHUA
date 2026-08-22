import { useIsFetching, useIsMutating } from '@tanstack/react-query'
import { AnimatePresence, motion } from 'motion/react'

/**
 * "Is it broken, or is it working?"
 *
 * A scenario writes its events over several seconds of background work. During
 * that window the dashboard was indistinguishable from a dead one: no spinner,
 * no progress, just panels that were empty and then suddenly were not. People
 * reload at that point, which is how "I have to refresh" became the diagnosis
 * for what was really "nothing told me to wait".
 *
 * One line, always in the same place, showing that the app is talking to the
 * backend right now. Deliberately not a blocking overlay — the data underneath
 * is still readable and still true, it is simply about to be truer.
 */
export default function BusyBar() {
  const fetching = useIsFetching({ predicate: (q) => q.queryKey?.[0] !== 'llm' })
  const mutating = useIsMutating()
  const busy = fetching > 0 || mutating > 0

  return (
    <AnimatePresence>
      {busy && (
        <motion.div
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          className="pointer-events-none relative z-40 h-[2px] w-full shrink-0 overflow-hidden">
          <motion.div
            className="bg-primary/70 absolute inset-y-0 w-1/3 rounded-full"
            animate={{ left: ['-33%', '100%'] }}
            transition={{ duration: 1.1, repeat: Infinity, ease: 'easeInOut' }} />
        </motion.div>
      )}
    </AnimatePresence>
  )
}
