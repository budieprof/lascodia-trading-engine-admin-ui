/** Presentation helpers for the Paper Trading page. Pure — no Angular, no I/O. */

/**
 * An engine enum token as words: `PaperTrading` → "Paper trading", `ShadowLive` → "Shadow live",
 * `StopLoss` → "Stop loss". Acronyms (`TP`, `SL`) stay as they are; empty → "—".
 */
export function enumLabel(raw: string | null | undefined): string {
  const v = (raw ?? '').trim();
  if (!v) return '—';
  return v
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .split(/\s+/)
    .map((w, i) => {
      if (w.length > 1 && w === w.toUpperCase()) return w;
      return i === 0 ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase();
    })
    .join(' ');
}

/** Pill tone for a strategy run status. */
export function statusTone(status: string | null | undefined): 'ok' | 'warn' | 'bad' | null {
  switch ((status ?? '').toLowerCase()) {
    case 'active':
      return 'ok';
    case 'paused':
      return null;
    case 'stopped':
    case 'failed':
      return 'bad';
    default:
      return null;
  }
}
