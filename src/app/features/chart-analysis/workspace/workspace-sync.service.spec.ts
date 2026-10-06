import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Injector } from '@angular/core';
import { of, throwError } from 'rxjs';

import { ChartLayoutsService, type ChartLayoutDto } from '@core/services/chart-layouts.service';
import { ChartLayoutStore, LEGACY_LAST_KEY, LEGACY_LAYOUTS_KEY } from './layout-store.service';
import { ChartWorkspaceSync, WORKSPACE_CACHE_KEY } from './workspace-sync.service';
import type { ChartWorkspaceState } from './workspace-state';

const S = (symbol: string): ChartWorkspaceState => ({ v: 1, symbol });
const layout = (
  id: number,
  version: number,
  state: ChartWorkspaceState | null,
  name = 'Unnamed',
): ChartLayoutDto => ({
  id,
  name,
  isActive: true,
  version,
  state,
  createdAt: '',
  updatedAt: '',
});
const ok = <T>(data: T) => of({ status: true, data, message: 'ok', responseCode: '00' });

function make(remote: Partial<Record<keyof ChartLayoutsService, unknown>>) {
  const api = {
    list: () => ok([]),
    active: () => ok(null),
    sendOnUnload: vi.fn(() => true),
    ...remote,
  };
  const injector = Injector.create({
    providers: [
      { provide: ChartLayoutsService, useValue: api },
      {
        provide: ChartLayoutStore,
        useValue: {
          legacyLayouts: () => {
            const raw = localStorage.getItem(LEGACY_LAYOUTS_KEY);
            return {
              layouts: raw ? JSON.parse(raw).layouts : [],
              lastId: localStorage.getItem(LEGACY_LAST_KEY),
            };
          },
          clearLegacyLayouts: () => {
            localStorage.removeItem(LEGACY_LAYOUTS_KEY);
            localStorage.removeItem(LEGACY_LAST_KEY);
          },
        },
      },
      { provide: ChartWorkspaceSync, useClass: ChartWorkspaceSync },
    ],
  });
  return { sync: injector.get(ChartWorkspaceSync), api };
}

describe('ChartWorkspaceSync', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('opens with the engine’s active layout and caches it', async () => {
    const { sync } = make({ active: () => ok(layout(7, 3, S('GBPUSD'), 'Scalping')) });
    await sync.load();
    expect(sync.initialState).toEqual(S('GBPUSD'));
    expect(sync.active()).toEqual({ id: 7, name: 'Scalping', version: 3 });
    expect(sync.status()).toBe('saved');
    expect(JSON.parse(localStorage.getItem(WORKSPACE_CACHE_KEY)!).state).toEqual(S('GBPUSD'));
  });

  it('first load uploads this browser’s legacy layouts once and clears them', async () => {
    localStorage.setItem(
      LEGACY_LAYOUTS_KEY,
      JSON.stringify({
        layouts: [
          { id: 'a', name: 'Daily', symbol: 'USDJPY', resolution: 'D', indicators: [] },
          { id: 'b', name: 'Scalp', symbol: 'EURUSD', resolution: '1', indicators: [] },
        ],
        templates: [],
      }),
    );
    localStorage.setItem(LEGACY_LAST_KEY, 'b');
    let id = 10;
    const create = vi.fn((b: { name: string; state: ChartWorkspaceState; activate?: boolean }) =>
      ok(layout(id++, 1, b.state, b.name)),
    );
    const { sync } = make({ create });
    await sync.load();
    expect(create.mock.calls.map((c) => [c[0].name, c[0].activate])).toEqual([
      ['Scalp', true],
      ['Daily', false],
    ]);
    expect(sync.initialState?.symbol).toBe('EURUSD');
    expect(sync.active().name).toBe('Scalp');
    expect(localStorage.getItem(LEGACY_LAYOUTS_KEY)).toBeNull();
  });

  it('offline: opens with the cached copy and says so', async () => {
    localStorage.setItem(
      WORKSPACE_CACHE_KEY,
      JSON.stringify({ layoutId: 7, name: 'X', version: 2, state: S('AUDUSD'), dirty: false }),
    );
    const { sync } = make({ active: () => throwError(() => new Error('down')) });
    await sync.load();
    expect(sync.initialState).toEqual(S('AUDUSD'));
    expect(sync.status()).toBe('offline');
  });

  it('uploads an edit a closed tab never got confirmed, if nobody saved since', async () => {
    localStorage.setItem(
      WORKSPACE_CACHE_KEY,
      JSON.stringify({ layoutId: 7, name: 'X', version: 3, state: S('NZDUSD'), dirty: true }),
    );
    const update = vi.fn(() => ok(layout(7, 4, null)));
    const { sync } = make({ active: () => ok(layout(7, 3, S('EURUSD'))), update });
    await sync.load();
    expect(sync.initialState).toEqual(S('NZDUSD'));
    await vi.advanceTimersByTimeAsync(10);
    expect(update).toHaveBeenCalledWith(7, { state: S('NZDUSD'), expectedVersion: 3 });
  });

  it('a newer save elsewhere beats a stale unconfirmed cache', async () => {
    localStorage.setItem(
      WORKSPACE_CACHE_KEY,
      JSON.stringify({ layoutId: 7, name: 'X', version: 2, state: S('NZDUSD'), dirty: true }),
    );
    const update = vi.fn();
    const { sync } = make({ active: () => ok(layout(7, 5, S('EURUSD'))), update });
    await sync.load();
    expect(sync.initialState).toEqual(S('EURUSD'));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(update).not.toHaveBeenCalled();
  });

  it('debounces edits into one save, skips unchanged and rebased state', async () => {
    const update = vi.fn(
      (_id: number, b: { state: ChartWorkspaceState; expectedVersion: number }) =>
        ok(layout(7, b.expectedVersion + 1, null)),
    );
    const { sync } = make({ active: () => ok(layout(7, 1, S('EURUSD'))), update });
    await sync.load();
    sync.rebase(S('EURUSD'));
    sync.markDirty(S('EURUSD'));
    expect(sync.status()).toBe('saved');
    sync.markDirty(S('GBPUSD'));
    sync.markDirty(S('USDJPY'));
    expect(sync.status()).toBe('pending');
    await vi.advanceTimersByTimeAsync(1_600);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(7, { state: S('USDJPY'), expectedVersion: 1 });
    expect(sync.status()).toBe('saved');
    expect(sync.active().version).toBe(2);
    sync.markDirty(S('USDJPY'));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('a -409 re-sends a fresh edit on top of the newer version (last writer wins)', async () => {
    const update = vi
      .fn()
      .mockReturnValueOnce(
        of({ status: false, responseCode: '-409', message: 'x', data: layout(7, 4, S('OTHER')) }),
      )
      .mockReturnValueOnce(ok(layout(7, 5, null)));
    const { sync } = make({ active: () => ok(layout(7, 1, S('EURUSD'))), update });
    await sync.load();
    sync.markDirty(S('MINE'));
    await vi.advanceTimersByTimeAsync(1_600);
    expect(update.mock.calls.map((c) => c[1].expectedVersion)).toEqual([1, 4]);
    expect(sync.active().version).toBe(5);
    expect(sync.status()).toBe('saved');
  });

  it('a network failure goes offline and retries', async () => {
    const update = vi
      .fn()
      .mockReturnValueOnce(throwError(() => new Error('net')))
      .mockReturnValueOnce(ok(layout(7, 2, null)));
    const { sync } = make({ active: () => ok(layout(7, 1, S('EURUSD'))), update });
    await sync.load();
    sync.markDirty(S('X'));
    await vi.advanceTimersByTimeAsync(1_600);
    expect(sync.status()).toBe('offline');
    await vi.advanceTimersByTimeAsync(5_100);
    expect(update).toHaveBeenCalledTimes(2);
    expect(sync.status()).toBe('saved');
  });

  it('on focus adopts a newer server version, but never while an edit is unsaved', async () => {
    let server = layout(7, 1, S('EURUSD'));
    const { sync } = make({
      active: () => ok(server),
      update: vi.fn(() => ok(layout(7, 2, null))),
    });
    await sync.load();
    server = layout(7, 3, S('CADJPY'));
    await sync.refreshIfNewer();
    expect(sync.incoming()?.state).toEqual(S('CADJPY'));
    expect(sync.active().version).toBe(3);

    const seq = sync.incoming()!.seq;
    sync.markDirty(S('LOCAL'));
    server = layout(7, 9, S('OTHER'));
    await sync.refreshIfNewer();
    expect(sync.incoming()!.seq).toBe(seq);
  });

  it('flushes an unsaved edit with a keepalive request when the page hides', async () => {
    const { sync, api } = make({ active: () => ok(layout(7, 1, S('EURUSD'))) });
    await sync.load();
    sync.markDirty(S('GONE'));
    window.dispatchEvent(new Event('pagehide'));
    expect(api.sendOnUnload).toHaveBeenCalledWith('/chart/layouts/7', 'PUT', { state: S('GONE') });
  });

  it('switching flushes the current layout, then applies the other', async () => {
    const update = vi.fn(() => ok(layout(7, 2, null)));
    const activate = vi.fn(() => ok(layout(8, 4, S('XAUUSD'), 'Gold')));
    const { sync } = make({ active: () => ok(layout(7, 1, S('EURUSD'))), update, activate });
    await sync.load();
    sync.markDirty(S('EDIT'));
    await sync.switchTo(8);
    expect(update).toHaveBeenCalledTimes(1);
    expect(activate).toHaveBeenCalledWith(8);
    expect(sync.active()).toEqual({ id: 8, name: 'Gold', version: 4 });
    expect(sync.incoming()?.state).toEqual(S('XAUUSD'));
  });
});

import { normaliseView } from '../pages/chart-analysis-page/chart-analysis-page.component';

describe('normaliseView', () => {
  it('rounds away sub-pixel and fractional-scroll jitter so it never reads as an edit', () => {
    const a = normaliseView({
      barSpacing: 6.000001,
      rightOffset: 4.6,
      paneHeights: [151.7, 211.2],
    });
    const b = normaliseView({
      barSpacing: 6.000004,
      rightOffset: 5.2,
      paneHeights: [152.2, 210.9],
    });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a).toEqual({ barSpacing: 6, rightOffset: 5, paneHeights: [152, 211] });
  });
});
