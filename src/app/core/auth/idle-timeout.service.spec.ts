import { Injector, runInInjectionContext } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NotificationService } from '@core/notifications/notification.service';
import { appStorage } from '@core/storage/app-storage';
import { IDLE_ACTIVITY_KEY, IDLE_CHECK_MS, IdleTimeoutService } from './idle-timeout.service';
import { permissionsForLegacyRoles } from './legacy-role-permissions';

function make() {
  const notify = { warning: vi.fn() };
  const injector = Injector.create({ providers: [{ provide: NotificationService, useValue: notify }] });
  const idle = runInInjectionContext(injector, () => new IdleTimeoutService());
  return { idle, notify };
}

describe('IdleTimeoutService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-20T10:00:00Z'));
    localStorage.clear();
  });
  afterEach(() => vi.useRealTimers());

  it('signs out after the timeout without activity, warning a minute before', () => {
    const { idle, notify } = make();
    const onIdle = vi.fn();
    idle.start(5 * 60, onIdle);

    vi.advanceTimersByTime(4 * 60_000);
    expect(notify.warning).toHaveBeenCalledTimes(1);
    expect(onIdle).not.toHaveBeenCalled();

    vi.advanceTimersByTime(60_000);
    expect(onIdle).toHaveBeenCalledTimes(1);
    expect(idle.running).toBe(false);
  });

  it('counts pointer and keyboard activity', () => {
    const { idle } = make();
    const onIdle = vi.fn();
    idle.start(5 * 60, onIdle);
    vi.advanceTimersByTime(4 * 60_000);
    window.dispatchEvent(new Event('keydown'));
    vi.advanceTimersByTime(4 * 60_000);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000 + IDLE_CHECK_MS);
    expect(onIdle).toHaveBeenCalledTimes(1);
    idle.stop();
  });

  it('counts activity in another tab (one cookie, one idle clock)', () => {
    const { idle } = make();
    const onIdle = vi.fn();
    idle.start(5 * 60, onIdle);
    vi.advanceTimersByTime(4 * 60_000);
    // Another tab of this browser saw activity just now.
    appStorage.setItem(IDLE_ACTIVITY_KEY, String(Date.now()));
    vi.advanceTimersByTime(4 * 60_000);
    expect(onIdle).not.toHaveBeenCalled();
    idle.stop();
  });

  it('does nothing once stopped, or without a timeout', () => {
    const { idle } = make();
    const onIdle = vi.fn();
    idle.start(60, onIdle);
    idle.stop();
    vi.advanceTimersByTime(10 * 60_000);
    expect(onIdle).not.toHaveBeenCalled();
    idle.start(0, onIdle);
    expect(idle.running).toBe(false);
  });
});

describe('permissionsForLegacyRoles', () => {
  it('mirrors the engine ladder: Operator ⊇ Trader ∪ Analyst, Admin adds administration', () => {
    const trader = permissionsForLegacyRoles(['Trader']);
    const analyst = permissionsForLegacyRoles(['Analyst']);
    const operator = new Set(permissionsForLegacyRoles(['Operator']));
    for (const k of [...trader, ...analyst]) expect(operator.has(k), k).toBe(true);
    expect(operator.has('users.manage')).toBe(false);
    expect(permissionsForLegacyRoles(['Admin'])).toContain('users.manage');
    expect(trader).toContain('orders.create');
    expect(trader).not.toContain('ml.train');
  });

  it('grants nothing for no roles or unknown roles', () => {
    expect(permissionsForLegacyRoles([])).toEqual([]);
    expect(permissionsForLegacyRoles(['SuperAdmin', 'Nope'])).toEqual([]);
  });

  it('gives the EA role only its ingest and read keys', () => {
    expect(permissionsForLegacyRoles(['EA'])).toEqual(
      ['access.eaingest', 'access.viewer', 'marketdata.ingest', 'marketdata.read', 'orders.ingest', 'orders.read'],
    );
  });
});
