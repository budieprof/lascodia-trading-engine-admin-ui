import { describe, expect, it } from 'vitest';
import type { AnalysisConversationSummaryDto } from '@core/api/api.types';
import { conversationsOverview } from './conversations-overview.logic';

const c = (over: Partial<AnalysisConversationSummaryDto>): AnalysisConversationSummaryDto => ({
  llmInvocationId: 1,
  symbol: 'EURUSD',
  timeframe: 'H1',
  purpose: 'admin_assistant.session',
  kind: 'Assistant',
  preview: '',
  model: '',
  provider: '',
  invokedAt: '2026-10-28T10:00:00Z',
  lastActivityAtUtc: '2026-10-28T10:00:00Z',
  followUpCount: 0,
  activeMonitorCount: 0,
  ...over,
});

describe('conversationsOverview', () => {
  const rows = [
    c({
      llmInvocationId: 1,
      followUpCount: 17,
      activeMonitorCount: 2,
      lastActivityAtUtc: '2026-10-28T19:00:00Z',
    }),
    c({ llmInvocationId: 2, followUpCount: 24, lastActivityAtUtc: '2026-10-28T20:00:00Z' }),
    c({
      llmInvocationId: 3,
      kind: 'Engineer',
      symbol: '—',
      lastActivityAtUtc: '2026-10-28T18:00:00Z',
    }),
    c({
      llmInvocationId: 4,
      kind: 'Journal',
      symbol: 'DE40',
      lastActivityAtUtc: '2026-10-28T16:00:00Z',
    }),
  ];

  it('breaks down by kind and totals follow-ups / monitors', () => {
    const o = conversationsOverview(rows);
    expect(o.sample).toBe(4);
    expect(o.byKind[0]).toEqual({ kind: 'Assistant', count: 2, pct: 50 });
    expect(o.symbols).toBe(2);
    expect(o.followUps).toBe(41);
    expect(o.activeMonitors).toBe(2);
    expect(o.withMonitors).toBe(1);
    expect(o.lastActivityAt).toBe('2026-10-28T20:00:00Z');
  });

  it('resume list puts live monitors first, then most recent', () => {
    expect(conversationsOverview(rows, 3).resume.map((r) => r.llmInvocationId)).toEqual([1, 2, 3]);
  });

  it('empty input is all zeros', () => {
    const o = conversationsOverview([]);
    expect(o).toMatchObject({ sample: 0, byKind: [], lastActivityAt: null, resume: [] });
  });
});
