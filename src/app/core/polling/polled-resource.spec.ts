import { DestroyRef, Injector, runInInjectionContext } from '@angular/core';
import { Subject, of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createPolledResource } from './polled-resource';
import { RealtimeService, type RealtimeEventName } from '@core/realtime/realtime.service';

/** Stand-in hub: `emit` pushes an event to whatever `on()` handed out. */
class FakeRealtime {
  private readonly subjects = new Map<string, Subject<unknown>>();
  on(name: RealtimeEventName) {
    let s = this.subjects.get(name);
    if (!s) {
      s = new Subject<unknown>();
      this.subjects.set(name, s);
    }
    return s.asObservable();
  }
  emit(name: string) {
    this.subjects.get(name)?.next({});
  }
}

describe('createPolledResource', () => {
  let injector: Injector;
  let realtime: FakeRealtime;
  let teardowns: Array<() => void>;

  beforeEach(() => {
    realtime = new FakeRealtime();
    teardowns = [];
    // Plain injector — this spec runs under the pure-TS vitest config, which
    // deliberately has no Angular TestBed harness wired.
    injector = Injector.create({
      providers: [
        { provide: RealtimeService, useValue: realtime },
        {
          provide: DestroyRef,
          useValue: {
            onDestroy: (cb: () => void) => {
              teardowns.push(cb);
              return () => undefined;
            },
          },
        },
      ],
    });
    vi.useFakeTimers();
  });

  const make = <T>(fetchFn: () => ReturnType<typeof of<T>>, opts = {}) =>
    runInInjectionContext(injector, () =>
      createPolledResource<T>(fetchFn, { intervalMs: 1000, ...opts }),
    );

  it('drops `loading` after the first fetch and never raises it again', () => {
    const r = make(() => of([1, 2, 3]));
    expect(r.loading()).toBe(false);
    expect(r.value()).toEqual([1, 2, 3]);

    // A background poll must not re-raise loading — that swap is the flicker.
    vi.advanceTimersByTime(1000);
    expect(r.loading()).toBe(false);
  });

  it('ends `loading` when the FIRST fetch fails, so the error branch can render', () => {
    const r = make(() => throwError(() => new Error('boom')));
    expect(r.loading()).toBe(false);
    expect(r.error()).toBeTruthy();
    expect(r.value()).toBeNull();
  });

  it('keeps the last good value when a refresh fails', () => {
    let fail = false;
    const r = make(() => (fail ? throwError(() => new Error('x')) : of([1])));
    expect(r.value()).toEqual([1]);

    fail = true;
    r.refresh();
    expect(r.value()).toEqual([1]); // never blanks
    expect(r.error()).toBeTruthy();
  });

  it('does not notify when a refetch returns structurally identical data', () => {
    // New array identity each call, same contents.
    const r = make(() => of([{ id: 1, n: 5 }]));
    const first = r.value();

    r.refresh();
    // Same reference back out => no downstream recompute, no DOM rebuild.
    expect(r.value()).toBe(first);
  });

  it('emits a new value when the data actually changes', () => {
    let n = 5;
    const r = make(() => of([{ id: 1, n }]));
    const first = r.value();
    n = 6;
    r.refresh();
    expect(r.value()).not.toBe(first);
    expect(r.value()).toEqual([{ id: 1, n: 6 }]);
  });

  it('refetches when a subscribed realtime event fires', () => {
    let calls = 0;
    const r = make(
      () => {
        calls++;
        return of([calls]);
      },
      { intervalMs: 0, refreshOn: ['positionOpened'] as RealtimeEventName[] },
    );
    expect(calls).toBe(1);

    realtime.emit('positionOpened');
    vi.advanceTimersByTime(500); // past the coalescing window
    expect(calls).toBe(2);
    expect(r.value()).toEqual([2]);
  });

  it('coalesces an event burst into one refetch', () => {
    let calls = 0;
    make(
      () => {
        calls++;
        return of([calls]);
      },
      { intervalMs: 0, refreshOn: ['orderFilled'] as RealtimeEventName[] },
    );
    expect(calls).toBe(1);

    for (let i = 0; i < 10; i++) realtime.emit('orderFilled');
    vi.advanceTimersByTime(500);
    expect(calls).toBe(2); // ten fills, one request
  });

  it('does not run an interval when intervalMs is 0 (fully push-driven)', () => {
    let calls = 0;
    make(
      () => {
        calls++;
        return of([calls]);
      },
      { intervalMs: 0 },
    );
    expect(calls).toBe(1);
    vi.advanceTimersByTime(60_000);
    expect(calls).toBe(1);
  });

  // ── Review A12 (2026-11-16) ──

  it('drops the previous scope’s value when the key changes and the new fetch fails', () => {
    let scope = 1;
    let fail = false;
    const r = make(() => (fail ? throwError(() => new Error('x')) : of([`acct-${scope}`])), {
      key: () => scope,
    });
    expect(r.value()).toEqual(['acct-1']);

    scope = 2;
    fail = true;
    r.refresh();
    // Never another scope's numbers as if they were this one's.
    expect(r.value()).toBeNull();
    expect(r.error()).toBeTruthy();
    expect(r.loading()).toBe(false);
  });

  it('keeps the value across a failed refresh while the key is unchanged', () => {
    let fail = false;
    const r = make(() => (fail ? throwError(() => new Error('x')) : of([1])), { key: () => ({ a: [1] }) });
    fail = true;
    r.refresh();
    expect(r.value()).toEqual([1]);
  });

  it('shows the new scope’s value once it arrives', () => {
    let scope = 1;
    const r = make(() => of([scope]), { key: () => scope });
    scope = 2;
    r.refresh();
    expect(r.value()).toEqual([2]);
  });

  it('stays stopped when the tab becomes visible again, and on realtime events', () => {
    let calls = 0;
    const r = make(
      () => {
        calls++;
        return of([calls]);
      },
      { refreshOn: ['positionOpened'] as RealtimeEventName[] },
    );
    expect(calls).toBe(1);
    r.stop();
    document.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(5_000);
    realtime.emit('positionOpened');
    vi.advanceTimersByTime(5_000);
    expect(calls).toBe(1);

    // An explicit refresh still fetches once, and restarts nothing.
    r.refresh();
    expect(calls).toBe(2);
    vi.advanceTimersByTime(5_000);
    expect(calls).toBe(2);
  });
});
