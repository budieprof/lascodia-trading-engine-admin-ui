import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { appStorage } from '@core/storage/app-storage';
import { ensureTestBed } from '@core/testing/zoneless-test-bed';
import {
  ARM_IDLE_STORAGE_KEY,
  DEFAULT_ARM_IDLE_MINUTES,
  LadderArmingService,
  armingStaleReason,
  restoredIdleMinutes,
  type LadderArming,
} from './ladder-arming.service';

ensureTestBed();

const T = Date.parse('2026-11-07T12:00:00Z');

describe('LadderArmingService (UF05)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T);
    appStorage.removeItem(ARM_IDLE_STORAGE_KEY);
    TestBed.configureTestingModule({});
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    vi.useRealTimers();
  });

  it('expires after the idle timeout (default 5 min) and says why; activity restarts it', () => {
    const s = TestBed.inject(LadderArmingService);
    expect(s.idleMinutes()).toBe(DEFAULT_ARM_IDLE_MINUTES);
    s.arm(17, 'eurusd');
    expect(s.isArmedFor(17, 'EURUSD')).toBe(true);
    vi.advanceTimersByTime(4 * 60_000);
    s.touch();
    vi.advanceTimersByTime(4 * 60_000);
    expect(s.armed()).toBe(true);
    vi.advanceTimersByTime(60_000 + 100);
    expect(s.armed()).toBe(false);
    expect(s.lastDisarm()?.reason).toBe('no ladder activity for 5 min');
    // Arming again clears the reason.
    s.arm(17, 'EURUSD');
    expect(s.lastDisarm()).toBeNull();
  });

  it('the idle setting is validated, stored per person, and applies at once', () => {
    const s = TestBed.inject(LadderArmingService);
    s.arm(17, 'EURUSD');
    vi.advanceTimersByTime(90_000);
    s.setIdleMinutes(1);
    expect(appStorage.getItem(ARM_IDLE_STORAGE_KEY)).toBe('1');
    expect(s.armed()).toBe(false);
    s.setIdleMinutes(7);
    expect(s.idleMinutes()).toBe(DEFAULT_ARM_IDLE_MINUTES);
    expect(restoredIdleMinutes('10')).toBe(10);
    expect(restoredIdleMinutes(null)).toBe(DEFAULT_ARM_IDLE_MINUTES);
    expect(restoredIdleMinutes('0')).toBe(DEFAULT_ARM_IDLE_MINUTES);
  });

  it('a hidden tab disarms; a visible one does not; the operator disarm leaves no reason', () => {
    const s = TestBed.inject(LadderArmingService);
    s.arm(17, 'EURUSD');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(s.armed()).toBe(true);
    const vis = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    vis.mockRestore();
    expect(s.armed()).toBe(false);
    expect(s.lastDisarm()?.reason).toBe('the tab was hidden');
    s.arm(17, 'EURUSD');
    s.disarm();
    expect(s.lastDisarm()).toBeNull();
  });

  it('stale account / book reasons', () => {
    const a: LadderArming = { accountId: 17, symbol: 'EURUSD', armedAt: T, lastActivityAt: T };
    const ok = { accountLive: true, accountActive: true, lastStripOkAt: T, bookLostSince: null };
    expect(armingStaleReason(a, ok, T + 10_000)).toBeNull();
    expect(armingStaleReason(a, { ...ok, accountActive: false }, T)).toBe('the account was deactivated');
    expect(armingStaleReason(a, { ...ok, accountLive: false }, T)).toBe('the account has no active EA any more');
    expect(armingStaleReason(a, ok, T + 31_000)).toContain("orders and positions could not be read for 31 s");
    expect(armingStaleReason(a, { ...ok, lastStripOkAt: null }, T + 29_000)).toBeNull();
    expect(armingStaleReason(a, { ...ok, lastStripOkAt: T + 20_000, bookLostSince: T + 5_000 }, T + 21_000)).toContain(
      'no live book for 16 s',
    );
  });
});
