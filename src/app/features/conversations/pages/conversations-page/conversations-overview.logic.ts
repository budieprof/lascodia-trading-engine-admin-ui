import type { AnalysisConversationSummaryDto } from '@core/api/api.types';

export interface ConversationsOverview {
  sample: number;
  byKind: Array<{ kind: string; count: number; pct: number }>;
  symbols: number;
  followUps: number;
  activeMonitors: number;
  withMonitors: number;
  lastActivityAt: string | null;
  resume: AnalysisConversationSummaryDto[];
}

/**
 * What the right-hand pane shows before a conversation is picked: a breakdown of the loaded
 * (most recent) conversations by kind, how many carry follow-ups or live monitors, and the
 * threads most worth resuming — the ones with a live monitor first, then the most recently active.
 */
export function conversationsOverview(
  rows: readonly AnalysisConversationSummaryDto[],
  resumeCount = 5,
): ConversationsOverview {
  const kinds = new Map<string, number>();
  const symbols = new Set<string>();
  let followUps = 0;
  let activeMonitors = 0;
  let withMonitors = 0;
  let last: string | null = null;
  for (const r of rows) {
    const k = r.kind?.trim() || 'Other';
    kinds.set(k, (kinds.get(k) ?? 0) + 1);
    if (r.symbol && r.symbol !== '—') symbols.add(r.symbol);
    followUps += r.followUpCount ?? 0;
    activeMonitors += r.activeMonitorCount ?? 0;
    if ((r.activeMonitorCount ?? 0) > 0) withMonitors++;
    const at = r.lastActivityAtUtc ?? r.invokedAt;
    if (at && (!last || at > last)) last = at;
  }
  const n = rows.length;
  const byKind = [...kinds.entries()]
    .map(([kind, count]) => ({ kind, count, pct: n ? Math.round((count / n) * 100) : 0 }))
    .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));
  const activity = (r: AnalysisConversationSummaryDto) => r.lastActivityAtUtc ?? r.invokedAt ?? '';
  const resume = [...rows]
    .sort(
      (a, b) =>
        Number((b.activeMonitorCount ?? 0) > 0) - Number((a.activeMonitorCount ?? 0) > 0) ||
        (activity(a) < activity(b) ? 1 : activity(a) > activity(b) ? -1 : 0),
    )
    .slice(0, resumeCount);
  return {
    sample: n,
    byKind,
    symbols: symbols.size,
    followUps,
    activeMonitors,
    withMonitors,
    lastActivityAt: last,
    resume,
  };
}
