/**
 * Pure presentation helpers for the engine-log tail. No Angular, no I/O — the page binds them.
 */

/** Short operator label for a .NET log level ("Information" → "Info"). Unknown levels pass through. */
export function levelLabel(level: string | null | undefined): string {
  switch ((level ?? '').toLowerCase()) {
    case 'trace':
      return 'Trace';
    case 'debug':
      return 'Debug';
    case 'information':
      return 'Info';
    case 'warning':
      return 'Warn';
    case 'error':
      return 'Error';
    case 'critical':
      return 'Critical';
    default:
      return level ?? '';
  }
}

/**
 * The part of a logger category that tells entries apart: the class name (last segment).
 * "LascodiaTradingEngine.Application.Foo.BarQueryHandler" → "BarQueryHandler". Generic
 * types ("Foo.Bar`1[[...]]") are cut at the backtick so the type argument doesn't take over.
 */
export function categoryTail(category: string | null | undefined): string {
  if (!category) return '';
  const head = category.split('`')[0];
  const parts = head.split('.').filter((p) => p.length > 0);
  return parts.length === 0 ? category : parts[parts.length - 1];
}

/** The namespace in front of {@link categoryTail}, or '' when there is none. */
export function categoryNamespace(category: string | null | undefined): string {
  if (!category) return '';
  const head = category.split('`')[0];
  const i = head.lastIndexOf('.');
  return i <= 0 ? '' : head.slice(0, i);
}

/** First line of a log message — the rest (often a fully-qualified type name) shows on expand. */
export function firstLine(message: string | null | undefined): string {
  if (!message) return '';
  const i = message.indexOf('\n');
  return (i < 0 ? message : message.slice(0, i)).trimEnd();
}

/** True when the message carries more than its first line. */
export function isMultiline(message: string | null | undefined): boolean {
  return !!message && message.trimEnd().includes('\n');
}

/** Same local calendar day? Used to print a date only on entries that are not from today. */
export function isSameLocalDay(iso: string, now: Date = new Date()): boolean {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return true;
  return (
    t.getFullYear() === now.getFullYear() &&
    t.getMonth() === now.getMonth() &&
    t.getDate() === now.getDate()
  );
}

/** "2026-11-01 10:05:44.753 UTC" — the exact stamp for a title attribute. */
export function utcStamp(iso: string): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return iso;
  return t.toISOString().replace('T', ' ').replace('Z', ' UTC');
}
