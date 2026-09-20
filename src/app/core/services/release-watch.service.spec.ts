import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { Injector, runInInjectionContext, DestroyRef } from '@angular/core';
import { ReleaseWatchService } from './release-watch.service';
import { RUNTIME_CONFIG } from '@core/config/runtime-config';

/**
 * The failure this prevents: a publish swaps the files on disk, but an open tab keeps
 * running the JavaScript it loaded. The operator sits in front of a fixed bug and reports
 * that the fix does not work — which is exactly what happened during the screen-capture
 * work, on a tab three releases behind.
 */
function make(releaseId: string | undefined): ReleaseWatchService {
  const injector = Injector.create({
    providers: [
      { provide: RUNTIME_CONFIG, useValue: { apiBaseUrl: '', releaseId } },
      { provide: DestroyRef, useValue: { onDestroy: () => () => void 0 } },
      { provide: ReleaseWatchService, useClass: ReleaseWatchService },
    ],
  });
  return runInInjectionContext(injector, () => injector.get(ReleaseWatchService));
}

const respond = (body: unknown, ok = true) =>
  vi.fn().mockResolvedValue({ ok, json: () => Promise.resolve(body) });

describe('ReleaseWatchService', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('stays quiet while the served release matches', async () => {
    vi.stubGlobal('fetch', respond({ releaseId: 'r1' }));
    const svc = make('r1');
    svc.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(svc.pending()).toBeNull();
  });

  it('reports a different served release', async () => {
    vi.stubGlobal('fetch', respond({ releaseId: 'r2' }));
    const svc = make('r1');
    svc.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(svc.pending()).toBe('r2');
  });

  it('clears again if the deploy is rolled back under the tab', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ releaseId: 'r2' }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ releaseId: 'r1' }) });
    vi.stubGlobal('fetch', fetchMock);
    const svc = make('r1');
    svc.start(1000);
    await vi.advanceTimersByTimeAsync(1);
    expect(svc.pending()).toBe('r2');
    await vi.advanceTimersByTimeAsync(1000);
    // A rollback puts this tab back in step; a banner still nagging would be wrong.
    expect(svc.pending()).toBeNull();
  });

  it('does nothing at all when the build carries no releaseId', async () => {
    const fetchMock = respond({ releaseId: 'r9' });
    vi.stubGlobal('fetch', fetchMock);
    const svc = make(undefined);
    svc.start();
    await vi.advanceTimersByTimeAsync(1);
    // A dev server has no releaseId; a watcher firing constantly there would train the
    // operator to ignore the banner that matters in production.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(svc.pending()).toBeNull();
  });

  it('stays quiet when the request fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const svc = make('r1');
    svc.start();
    await vi.advanceTimersByTimeAsync(1);
    // Offline, or the console is mid-redeploy. A banner raised by a network blink is worse
    // than one that arrives a poll late.
    expect(svc.pending()).toBeNull();
  });

  it('stays quiet on a non-200', async () => {
    vi.stubGlobal('fetch', respond({ releaseId: 'r2' }, false));
    const svc = make('r1');
    svc.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(svc.pending()).toBeNull();
  });

  it('polls on the interval, and only starts one timer', async () => {
    const fetchMock = respond({ releaseId: 'r1' });
    vi.stubGlobal('fetch', fetchMock);
    const svc = make('r1');
    svc.start(1000);
    svc.start(1000);
    await vi.advanceTimersByTimeAsync(2500);
    // 1 immediate + 2 interval ticks. A second start() must not double the polling.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    svc.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('cache-busts the request', async () => {
    const fetchMock = respond({ releaseId: 'r1' });
    vi.stubGlobal('fetch', fetchMock);
    make('r1').start();
    await vi.advanceTimersByTimeAsync(1);
    const [url, opts] = fetchMock.mock.calls[0];
    // A proxy that ignores no-cache would make the whole watcher quietly useless — which is
    // the same class of failure it exists to catch.
    expect(String(url)).toMatch(/config\.json\?_=\d+/);
    expect(opts).toMatchObject({ cache: 'no-store' });
  });
});
