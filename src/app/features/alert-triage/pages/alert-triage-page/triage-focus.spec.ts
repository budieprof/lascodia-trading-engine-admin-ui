import { describe, expect, it } from 'vitest';

import { focusedAlertStatus, parseFocusParam } from './triage-focus';

describe('triage focus (SP-04)', () => {
  it('reads ?focus= as a positive alert id only', () => {
    expect(parseFocusParam('42')).toBe(42);
    expect(parseFocusParam(' 7 ')).toBe(7);
    for (const bad of [
      null,
      undefined,
      '',
      '0',
      '-3',
      '4.5',
      '12abc',
      'alert:12',
      '99999999999999999999',
    ]) {
      expect(parseFocusParam(bad)).toBeNull();
    }
  });

  it('says what the linked alert is now, the queue’s way', () => {
    const now = Date.parse('2026-10-09T08:00:00Z');
    const active = { isActive: true, autoResolvedAt: null };
    expect(focusedAlertStatus(active, null, now)).toEqual({ key: 'active', label: 'Active' });
    expect(focusedAlertStatus(active, now + 60_000, now).key).toBe('snoozed');
    expect(focusedAlertStatus(active, now - 1, now).key).toBe('active'); // an expired snooze
    expect(
      focusedAlertStatus({ isActive: true, autoResolvedAt: '2026-10-09T07:00:00Z' }, null, now).key,
    ).toBe('auto-resolved');
    expect(focusedAlertStatus({ isActive: false, autoResolvedAt: null }, null, now).key).toBe(
      'inactive',
    );
  });
});
