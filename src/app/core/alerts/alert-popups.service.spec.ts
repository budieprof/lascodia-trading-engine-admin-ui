import { Injector } from '@angular/core';
import { Observable, Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiService } from '@core/api/api.service';
import type { AlertFiredPayload } from '@core/api/alerts.types';
import { RealtimeService, type RealtimeEventName } from '@core/realtime/realtime.service';

import { AlertPopupsService, MAX_POPUPS, POPUP_MS } from './alert-popups.service';

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
  emit(name: RealtimeEventName, payload: unknown): void {
    this.subjects.get(name)?.next(payload);
  }
}

/** Stand-in API: records each GET and lets the test answer it. */
class FakeApi {
  readonly calls: { path: string; opts: unknown; reply: Subject<unknown> }[] = [];
  get(path: string, opts?: unknown): Observable<unknown> {
    const reply = new Subject<unknown>();
    this.calls.push({ path, opts, reply });
    return reply.asObservable();
  }
  answer(index: number, body: unknown): void {
    this.calls[index].reply.next(body);
    this.calls[index].reply.complete();
  }
}

function fired(over: Partial<AlertFiredPayload> = {}): AlertFiredPayload {
  return {
    source: 'price',
    alertId: 12,
    subscriptionId: null,
    symbol: 'EURUSD',
    timeframe: '60',
    title: 'EURUSD crossed above 1.08500',
    message: 'Bid 1.08503 crossed above 1.08500',
    price: 1.08503,
    firedAtUtc: '2026-10-09T08:00:00Z',
    severity: 'High',
    fireId: 40,
    ...over,
  };
}

// Pure-TS runner (no TestBed): the service is built by a plain injector, as polled-resource.spec does.
describe('AlertPopupsService', () => {
  let service: AlertPopupsService;
  let realtime: FakeRealtime;
  let api: FakeApi;

  beforeEach(() => {
    vi.useFakeTimers();
    try {
      localStorage.clear();
    } catch {
      /* no storage in this environment */
    }
    realtime = new FakeRealtime();
    api = new FakeApi();
    const injector = Injector.create({
      providers: [
        { provide: AlertPopupsService },
        { provide: RealtimeService, useValue: realtime },
        { provide: ApiService, useValue: api },
      ],
    });
    service = injector.get(AlertPopupsService);
    service.setSound(false);
    service.start();
    service.start(); // idempotent: one subscription
  });

  afterEach(() => vi.useRealTimers());

  it('shows a chart alert only once the engine confirms it is this operator’s', () => {
    realtime.emit('alertFired', fired());
    expect(service.popups()).toEqual([]);
    expect(api.calls.map((c) => [c.path, c.opts])).toEqual([['/chart-alert/12', { silent: true }]]);
    api.answer(0, { data: { id: 12 }, status: true, message: 'ok', responseCode: '00' });
    expect(service.popups().map((p) => p.payload.title)).toEqual(['EURUSD crossed above 1.08500']);
    expect(service.popups()[0].link).toEqual({
      route: ['/chart-analysis', 'EURUSD'],
      params: { alert: '12', tf: '60' },
    });
  });

  it('shows nothing for another operator’s chart alert (the owner-scoped read finds none)', () => {
    realtime.emit('alertFired', fired({ source: 'drawing' }));
    api.answer(0, { data: null, status: false, message: 'Not found', responseCode: '-14' });
    realtime.emit('alertFired', fired({ alertId: 13 }));
    api.calls[1].reply.error(new Error('404'));
    expect(service.popups()).toEqual([]);
  });

  it('shows script alerts and channel tests straight away', () => {
    realtime.emit(
      'alertFired',
      fired({ source: 'script', alertId: 5, strategyId: 77, title: 'Long breakout: Breakout' }),
    );
    realtime.emit('alertFired', fired({ source: 'test', alertId: 0, title: 'Test alert' }));
    expect(api.calls).toEqual([]);
    expect(service.popups().map((p) => [p.payload.source, p.link])).toEqual([
      ['test', null],
      ['script', { route: ['/strategies', 77], params: {} }],
    ]);
  });

  it('shows a saved screen’s alert only once the engine confirms the screen is this operator’s (SS-I6)', () => {
    realtime.emit(
      'alertFired',
      fired({
        source: 'screen',
        alertId: 5,
        fireId: 901,
        price: null,
        title: 'EURUSD entered RSI hot',
        message: 'EURUSD now matches RSI hot on 60',
      }),
    );
    expect(service.popups()).toEqual([]);
    expect(api.calls.map((c) => [c.path, c.opts])).toEqual([
      ['/scripting/screens/5', { silent: true }],
    ]);
    api.answer(0, { data: { id: 5 }, status: true, message: 'ok', responseCode: '00' });
    expect(service.popups()[0].payload.title).toBe('EURUSD entered RSI hot');
    expect(service.popups()[0].link).toEqual({
      route: ['/pine-screener'],
      params: { screen: '5' },
    });

    // Another operator's screen: the owner-scoped read answers -14 and nothing pops up.
    realtime.emit('alertFired', fired({ source: 'screen', alertId: 6, title: 'Not mine' }));
    api.answer(1, {
      data: null,
      status: false,
      message: 'Screen 6 not found.',
      responseCode: '-14',
    });
    expect(service.popups().map((p) => p.payload.title)).toEqual(['EURUSD entered RSI hot']);
  });

  it('shows an alert on a chart script only once the engine confirms it is this operator’s (SS-I1)', () => {
    realtime.emit(
      'alertFired',
      fired({
        source: 'chart-script',
        alertId: 41,
        subscriptionId: 41,
        timeframe: '240',
        price: null,
        title: 'Cross up: EMA pair · EURUSD 240',
        message: 'Fast crossed above slow',
      }),
    );
    expect(service.popups()).toEqual([]);
    expect(api.calls.map((c) => [c.path, c.opts])).toEqual([['/scripting/alerts/41', { silent: true }]]);
    api.answer(0, { data: { id: 41 }, status: true, message: 'ok', responseCode: '00' });
    expect(service.popups()[0].link).toEqual({
      route: ['/chart-analysis', 'EURUSD'],
      params: { scriptAlert: '41', tf: '240' },
    });

    // Another operator's: -14, nothing pops up.
    realtime.emit('alertFired', fired({ source: 'chart-script', alertId: 42, title: 'Not mine' }));
    api.answer(1, { data: null, status: false, message: 'Script alert 42 not found.', responseCode: '-14' });
    expect(service.popups().map((p) => p.payload.alertId)).toEqual([41]);
  });

  it('ignores malformed pushes', () => {
    realtime.emit('alertFired', null);
    realtime.emit('alertFired', { source: 'script' });
    expect(service.popups()).toEqual([]);
  });

  it('keeps at most a handful on screen, newest first, each for a while', () => {
    for (let i = 0; i < MAX_POPUPS + 2; i++)
      realtime.emit('alertFired', fired({ source: 'script', alertId: i, title: `#${i}` }));
    expect(service.popups().map((p) => p.payload.title)).toEqual(['#6', '#5', '#4', '#3', '#2']);
    service.dismiss(service.popups()[0].key);
    expect(service.popups()).toHaveLength(MAX_POPUPS - 1);
    vi.advanceTimersByTime(POPUP_MS + 1);
    expect(service.popups()).toEqual([]);
  });

  it('remembers the sound choice', () => {
    expect(service.soundOn()).toBe(false);
    try {
      expect(localStorage.getItem('lascodia.alerts.sound')).toBe('false');
    } catch {
      /* no storage in this environment */
    }
  });

  it('says why browser notifications cannot be switched on where the browser has none', async () => {
    const original = (globalThis as { Notification?: unknown }).Notification;
    delete (globalThis as { Notification?: unknown }).Notification;
    try {
      await service.setBrowser(true);
      expect(service.browserOn()).toBe(false);
      expect(service.browserProblem()).toMatch(/does not support/);
    } finally {
      if (original !== undefined)
        (globalThis as { Notification?: unknown }).Notification = original;
    }
  });

  it('links each kind of alert to where it lives', () => {
    expect(AlertPopupsService.linkFor(fired({ timeframe: null }))).toEqual({
      route: ['/chart-analysis', 'EURUSD'],
      params: { alert: '12' },
    });
    expect(AlertPopupsService.linkFor(fired({ source: 'script', strategyId: null }))).toBeNull();
    expect(AlertPopupsService.linkFor(fired({ source: 'test' }))).toBeNull();
  });
});
