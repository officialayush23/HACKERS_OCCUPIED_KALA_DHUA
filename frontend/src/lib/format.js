export const inr = (n) =>
  '₹' + Number(n ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })

export const days = (h) => `${(Number(h ?? 0) / 24).toFixed(1)}d`

/** Name first, ID as quiet metadata. Never show a bare ID in a heading. */
export const label = (name, id) => name || id || '—'
