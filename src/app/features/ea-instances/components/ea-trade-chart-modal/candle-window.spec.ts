import { describe, expect, it } from 'vitest';

import { candleWindow } from './ea-trade-chart-modal.component';

describe('candleWindow', () => {
  // Position #6592: EURUSD short opened Fri 2026-10-30 12:50 UTC, still open on Sunday.
  const opened = '2026-10-30T12:50:19Z';
  const sunday = Date.parse('2026-11-01T13:20:00Z');

  it('keeps an open trade’s entry in the window over a weekend', () => {
    const { from, to } = candleWindow({ referenceTime: opened, exitTime: null }, 5, sunday);
    // 75 M5 bars before entry — not "480 bars before now", which started after Friday's close.
    expect(from.toISOString()).toBe('2026-10-30T06:35:19.000Z');
    expect(to.getTime()).toBe(sunday);
    // Friday's last M5 bar (20:55 UTC) is inside the window.
    expect(Date.parse('2026-10-30T20:55:00Z')).toBeGreaterThan(from.getTime());
  });

  it('frames a closed trade from 75 bars before entry to 25 after exit', () => {
    const { from, to } = candleWindow(
      { referenceTime: '2026-10-30T12:00:00Z', exitTime: '2026-10-30T14:00:00Z' },
      15,
      sunday,
    );
    expect(from.toISOString()).toBe('2026-10-29T17:15:00.000Z');
    expect(to.toISOString()).toBe('2026-10-30T20:15:00.000Z');
  });
});
