import { describe, expect, it } from 'vitest';
import type { PromptTemplateSummary } from '@core/services/prompt-template.service';
import { defaultDiffPair, templateCounts, versionEvents } from './prompt-templates.logic';

const row = (over: Partial<PromptTemplateSummary>): PromptTemplateSummary => ({
  id: 1,
  name: 'spot-analysis',
  version: 'v',
  systemPromptLength: 27000,
  isActive: false,
  isArchived: false,
  notes: null,
  createdBy: 'system',
  createdAt: '2026-06-20T04:18:02Z',
  promotedAt: null,
  archivedAt: null,
  forkedFromId: null,
  ...over,
});

// The live table on 2026-10-28.
const rows = [
  row({
    id: 5,
    version: 'v4',
    isActive: true,
    createdAt: '2026-09-02T14:38:19Z',
    promotedAt: '2026-09-02T15:07:54Z',
    forkedFromId: 1,
  }),
  row({
    id: 4,
    version: 'smoke',
    isArchived: true,
    systemPromptLength: 73,
    createdAt: '2026-06-20T08:20:34Z',
    archivedAt: '2026-06-20T08:20:35Z',
    forkedFromId: 1,
  }),
  row({
    id: 1,
    version: 'v3',
    isArchived: true,
    promotedAt: '2026-06-20T04:18:02Z',
    archivedAt: '2026-09-02T15:07:54Z',
  }),
];

describe('prompt-templates.logic', () => {
  it('counts versions by state', () => {
    const c = templateCounts(rows);
    expect(c).toMatchObject({ versions: 3, drafts: 0, archived: 2 });
    expect(c.active?.id).toBe(5);
  });

  it('lists every dated change newest first', () => {
    const ev = versionEvents(rows);
    expect(ev[0]).toMatchObject({ id: 5, kind: 'promoted' });
    expect(ev.filter((e) => e.kind === 'forked')).toHaveLength(2);
    expect(ev[ev.length - 1]).toMatchObject({ id: 1, kind: 'created' });
  });

  it('default diff = active vs the version it was forked from', () => {
    expect(defaultDiffPair(rows)).toEqual({ left: 1, right: 5 });
    expect(defaultDiffPair([rows[0]])).toBeNull();
  });

  it('without an ancestor, skips stub versions for the newest real archived one', () => {
    const r = rows.map((x) => (x.id === 5 ? { ...x, forkedFromId: null } : x));
    expect(defaultDiffPair(r)).toEqual({ left: 1, right: 5 });
  });
});
