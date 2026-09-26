import { signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import type { AnalysisMonitorDto } from '@core/api/api.types';
import type { AnalysisMonitorDetail } from '../../analysis-monitors.types';
import {
  monitorsPageCommands,
  monitorsPageFacts,
  type MonitorsPageHandles,
} from './monitors-page-assistant';

const monitor = {
  id: 42,
  symbol: 'EURUSD',
  timeframe: 'H1',
  intentText: 'tell me when 1.15 breaks',
  evaluationMode: 'Deterministic',
  triggerSpecJson: '{"v":2,"metric":"price","op":"crossesUp","value":1.15}',
  actionSpecJson: '{"steps":[{"type":"notify"}]}',
  status: 'Active',
  recurring: false,
  triggerCount: 0,
  maxTriggers: 1,
  cooldownSeconds: 0,
  createdAtUtc: '2026-09-26T08:00:00Z',
  expiresAtUtc: '2026-09-27T08:00:00Z',
} as unknown as AnalysisMonitorDto;

const detail = {
  monitor,
  timeline: [
    { id: 1, monitorId: 42, kind: 'Created', occurredAtUtc: '2026-09-26T08:00:00Z', fired: false },
  ],
} as unknown as AnalysisMonitorDetail;

describe('monitorsPageFacts', () => {
  it('names the open monitor, its spec and timeline, and the filters', () => {
    const f = monitorsPageFacts({
      statusFilter: 'Live',
      search: 'EUR',
      origin: '',
      mode: '',
      page: 1,
      monitors: [monitor],
      counters: { active: 1 },
      detail,
    });
    expect(f.record).toEqual({ kind: 'analysisMonitor', id: 42, label: 'EURUSD H1' });
    expect(f.filters).toMatchObject({ status: 'Live', search: 'EUR' });
    expect(f.figures?.['open.trigger']).toContain('crossesUp');
    expect(f.figures?.['open.timeline[0]']).toContain('Created');
    expect(f.ids).toEqual({ monitorsOnPage: [42] });
  });

  it('describes the board when nothing is open', () => {
    const f = monitorsPageFacts({
      statusFilter: '',
      search: '',
      origin: '',
      mode: '',
      page: 2,
      monitors: [],
      counters: null,
      detail: null,
    });
    expect(f.headline).toBe('Monitor board — 0 monitor(s) on page 2');
    expect(f.filters?.['status']).toBe('All');
    expect(f.record).toBeUndefined();
  });
});

describe('monitorsPageCommands', () => {
  const handles = (): MonitorsPageHandles => ({
    statusFilter: signal('Live'),
    search: signal(''),
    origin: signal(''),
    mode: signal(''),
    page: signal(3),
    statusKeys: ['Live', 'Active', ''],
    openMonitor: vi.fn(),
    closeMonitor: vi.fn(),
    openBuilder: vi.fn(() => true),
    openTemplates: vi.fn(),
  });
  const run = (h: MonitorsPageHandles, id: string, args: Record<string, unknown> = {}) =>
    monitorsPageCommands(h)
      .find((c) => c.id === id)!
      .run(args);

  it('filters the board and goes back to page 1', async () => {
    const h = handles();
    await run(h, 'monitors.setStatusFilter', { status: 'All' });
    expect(h.statusFilter()).toBe('');
    expect(h.page()).toBe(1);
  });

  it('opens a monitor by id and refuses a bad one', async () => {
    const h = handles();
    expect((await run(h, 'monitors.open', { monitorId: 42 })).ok).toBe(true);
    expect(h.openMonitor).toHaveBeenCalledWith(42);
    expect((await run(h, 'monitors.open', { monitorId: -1 })).ok).toBe(false);
  });

  it('none of the page commands needs a click — they only change the view', () => {
    expect(monitorsPageCommands(handles()).every((c) => !c.confirm)).toBe(true);
  });
});
