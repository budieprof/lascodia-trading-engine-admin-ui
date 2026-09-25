import { formatIsoInZone } from '../core/format';
import type { PineLogOutput } from '../model/pine-outputs.types';

/**
 * Pine Logs filtering, as the Pine Logs pane does it: logging-level checkboxes, a start date, and a
 * search that is case-insensitive by default with "Match case", "Whole word" and "Regex" options.
 * Whole-word matching treats whitespace and . , : ; ' " as word separators (the manual's list).
 */

export type LogLevel = 'info' | 'warning' | 'error';

export interface LogFilter {
  levels: Record<LogLevel, boolean>;
  query: string;
  matchCase: boolean;
  wholeWord: boolean;
  regex: boolean;
  /** Only logs at or after this time (ms), or null. */
  fromTime: number | null;
}

export const DEFAULT_LOG_FILTER: LogFilter = {
  levels: { info: true, warning: true, error: true },
  query: '',
  matchCase: false,
  wholeWord: false,
  regex: false,
  fromTime: null,
};

export interface TextSegment {
  text: string;
  match: boolean;
}

export interface LogRow {
  /** Index in the source log list (stable identity for the row). */
  index: number;
  level: LogLevel;
  barIndex: number;
  time: number;
  line: number | null;
  realtime: boolean;
  /** Pine Logs prefix: ISO-8601 in the chart's time zone. */
  timeText: string;
  message: string;
  /** First line of the message, split into matched / unmatched runs for highlighting. */
  segments: TextSegment[];
  multiline: boolean;
}

export interface LogFilterResult {
  rows: LogRow[];
  counts: Record<LogLevel, number>;
  /** Invalid regular expression, or null. */
  error: string | null;
}

export function normalizeLevel(level: string): LogLevel {
  const l = level.toLowerCase();
  return l === 'warning' || l === 'warn' ? 'warning' : l === 'error' ? 'error' : 'info';
}

const SEPARATORS = `\\s.,:;'"`;

export interface Matcher {
  test(text: string): boolean;
  segments(text: string): TextSegment[];
}

/** A matcher for the search box, or `{ error }` for an invalid regex. Null query matches all. */
export function buildMatcher(
  filter: Pick<LogFilter, 'query' | 'matchCase' | 'wholeWord' | 'regex'>,
): Matcher | { error: string } | null {
  const q = filter.query;
  if (!q) return null;
  let source = filter.regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (filter.wholeWord) source = `(?<![^${SEPARATORS}])(?:${source})(?![^${SEPARATORS}])`;
  let re: RegExp;
  try {
    re = new RegExp(source, filter.matchCase ? 'g' : 'gi');
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Invalid regular expression' };
  }
  return {
    test(text: string): boolean {
      re.lastIndex = 0;
      return re.test(text);
    },
    segments(text: string): TextSegment[] {
      const out: TextSegment[] = [];
      re.lastIndex = 0;
      let last = 0;
      let m: RegExpExecArray | null;
      let guard = 0;
      while ((m = re.exec(text)) !== null && guard++ < 1000) {
        if (m[0].length === 0) {
          re.lastIndex++;
          continue;
        }
        if (m.index > last) out.push({ text: text.slice(last, m.index), match: false });
        out.push({ text: m[0], match: true });
        last = m.index + m[0].length;
      }
      if (last < text.length) out.push({ text: text.slice(last), match: false });
      return out.length ? out : [{ text, match: false }];
    },
  };
}

export function filterLogs(
  logs: readonly PineLogOutput[],
  filter: LogFilter,
  timeZone = 'UTC',
): LogFilterResult {
  const counts: Record<LogLevel, number> = { info: 0, warning: 0, error: 0 };
  const matcher = buildMatcher(filter);
  if (matcher && 'error' in matcher)
    return { rows: [], counts: countLevels(logs), error: matcher.error };
  const rows: LogRow[] = [];
  for (let i = 0; i < logs.length; i++) {
    const log = logs[i];
    const level = normalizeLevel(log.level);
    counts[level]++;
    if (!filter.levels[level]) continue;
    if (filter.fromTime !== null && log.time < filter.fromTime) continue;
    const message = log.message ?? '';
    if (matcher && !matcher.test(message)) continue;
    const firstLine = message.split(/\r?\n/, 1)[0] ?? '';
    rows.push({
      index: i,
      level,
      barIndex: log.barIndex,
      time: log.time,
      line: log.line ?? null,
      realtime: log.isRealtime,
      timeText: formatIsoInZone(log.time, timeZone),
      message,
      segments: matcher ? matcher.segments(firstLine) : [{ text: firstLine, match: false }],
      multiline: firstLine.length !== message.length,
    });
  }
  return { rows, counts, error: null };
}

function countLevels(logs: readonly PineLogOutput[]): Record<LogLevel, number> {
  const counts: Record<LogLevel, number> = { info: 0, warning: 0, error: 0 };
  for (const l of logs) counts[normalizeLevel(l.level)]++;
  return counts;
}
