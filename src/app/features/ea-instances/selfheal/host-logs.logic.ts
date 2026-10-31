/** One numbered log line. */
export interface LogLine {
  n: number;
  text: string;
}

/** Number every line, then keep the ones containing `query` (case-insensitive); all of them when blank. */
export function filterLogLines(lines: readonly string[], query: string): LogLine[] {
  const numbered = lines.map((text, i) => ({ n: i + 1, text }));
  // Drop the empty line a trailing newline leaves behind.
  if (numbered.length > 0 && numbered[numbered.length - 1].text === '') numbered.pop();
  const q = query.trim().toLowerCase();
  if (!q) return numbered;
  return numbered.filter((l) => l.text.toLowerCase().includes(q));
}
