import { useEffect, useState } from 'react'

const KEY = 'disruptionops-theme'

/** dark | light — persisted, applied as a class on <html>. */
export function useTheme() {
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem(KEY) || 'dark' } catch { return 'dark' }
  })

  useEffect(() => {
    const root = document.documentElement
    root.classList.toggle('dark', theme === 'dark')
    root.style.colorScheme = theme
    try { localStorage.setItem(KEY, theme) } catch { /* private mode */ }
  }, [theme])

  return { theme, setTheme, toggle: () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')) }
}
