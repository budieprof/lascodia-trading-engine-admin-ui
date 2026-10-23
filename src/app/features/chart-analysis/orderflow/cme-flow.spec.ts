import { describe, expect, it } from 'vitest';

import type { CmeOrderFlow, CmeOrderFlowRequest } from '@core/realtime/marketdata.types';
import {
  CmeFlowFeed,
  LIVE_REFRESH_MS,
  cmeBarsAsTickBars,
  cmeFootprintRows,
  cmeMarkerAt,
  cmeMarkerText,
  markerRadius,
  placeCmeMarkers,
} from './cme-flow';
import { DEFAULT_ORDER_FLOW, orderFlowCount, restoredOrderFlow } from './orderflow.types';

const T = (iso: string) => Date.parse(iso);
const flush = () => new Promise((r) => setTimeout(r, 0));

/**
 * An md/orderflow answer built from the values the ENGINE computed on the recorded 6E payrolls slice
 * (CmeRecordedSliceTests, 2026-06-05 12:28-12:33 UTC; futures prices) — real numbers, not invented.
 */
function answer(): CmeOrderFlow {
  const bar = (iso: string, o: number, h: number, l: number, c: number, volume: number, buy: number, sell: number, cvd: number, trades: number) => ({
    t: T(iso), o, h, l, c, volume, buy, sell, delta: buy - sell, cvd, trades,
    footprint: [[l, Math.round(buy / 2), Math.round(sell / 2)], [h, buy - Math.round(buy / 2), sell - Math.round(sell / 2)]] as [number, number, number][],
  });
  return {
    sourceId: 'cme-databento', symbol: 'EURUSD', from: T('2026-06-05T12:28:00Z'), to: T('2026-06-05T12:33:00Z'), barSeconds: 60,
    label: 'CME 6E (futures, raw futures prices)',
    spot: { mapped: false, inverted: false, basisAdjusted: false, basis: null, rowsWithoutBasis: 0, sizeUnit: 'contracts', contractSize: 125000, contractCurrency: 'EUR' },
    contracts: ['6EM6'],
    thresholds: { barSeconds: 60, bubbleMinContracts: 1, largeLotContracts: 25, sweepWindowMs: 50, sweepMinLevels: 3, icebergMinRatio: 2, icebergMinContracts: 20, absorptionMinContracts: 30, absorptionHoldMs: 5000, episodeIdleMs: 30000, maxItems: 20000 },
    cvdAnchor: 'window',
    bars: [
      bar('2026-06-05T12:28:00Z', 1.16415, 1.16415, 1.164, 1.164, 355, 77, 234, -157, 62),
      bar('2026-06-05T12:29:00Z', 1.16395, 1.1641, 1.1639, 1.1639, 352, 206, 134, -85, 66),
      bar('2026-06-05T12:30:00Z', 1.1641, 1.1641, 1.16205, 1.16215, 4383, 1670, 2495, -910, 1112),
      bar('2026-06-05T12:31:00Z', 1.16215, 1.16255, 1.1619, 1.16245, 1821, 920, 884, -874, 412),
      bar('2026-06-05T12:32:00Z', 1.1625, 1.1625, 1.16155, 1.16165, 1466, 720, 741, -895, 338),
    ],
    bubbles: [],
    largeLots: [
      { t: T('2026-06-05T12:30:01.144Z'), side: 'S', size: 189, price: 1.162763, low: 1.1624, high: 1.16365, prints: 31, levels: 22 },
      { t: T('2026-06-05T12:30:53.748Z'), side: 'S', size: 109, price: 1.16217, low: 1.16215, high: 1.16225, prints: 3, levels: 3 },
      { t: T('2026-06-05T12:29:30.005Z'), side: 'B', size: 75, price: 1.164, low: 1.164, high: 1.164, prints: 1, levels: 1 },
    ],
    sweeps: [{ t: T('2026-06-05T12:30:01.144Z'), endT: T('2026-06-05T12:30:01.144Z'), side: 'S', levels: 22, size: 189, fromPrice: 1.16365, toPrice: 1.1624, orders: 1 }],
    icebergs: [{ t: T('2026-06-05T12:30:13.979Z'), endT: T('2026-06-05T12:30:15.220Z'), side: 'bid', price: 1.1625, volume: 34, maxDisplayed: 22, refills: 3, heldMs: 0 }],
    absorptions: [{ t: T('2026-06-05T12:28:55.800Z'), endT: T('2026-06-05T12:29:05.301Z'), side: 'ask', price: 1.16405, volume: 29, maxDisplayed: 0, refills: 0, heldMs: 30000 }],
    bookAnalysed: true,
    notes: [],
  };
}

describe('CME order flow: bars on the chart', () => {
  it('sums CME minute bars into the chart bars and carries the real CVD', () => {
    const d = answer();
    const five = [T('2026-06-05T12:25:00Z'), T('2026-06-05T12:30:00Z')];
    const rows = cmeBarsAsTickBars(d, five, 300_000);
    expect(rows[0].delta).toBe(-157 + 72);
    expect(rows[0].cumDelta).toBe(-85);
    expect(rows[1].delta).toBe(-825 + 36 - 21);
    expect(rows[1].cumDelta).toBe(-895);
    expect(rows[1].ticks).toBe(4383 + 1821 + 1466);
    expect(rows.every((r) => r.source === 'ticks')).toBe(true);
    // A chart bar with no CME bar: no value (the line breaks), never a zero.
    const gap = cmeBarsAsTickBars(d, [T('2026-06-05T12:20:00Z')], 60_000);
    expect(gap[0].source).toBe('none');
    expect(gap[0].delta).toBeNull();
  });

  it('builds footprint rows (buy = up, sell = down) by price', () => {
    const d = answer();
    const rows = cmeFootprintRows(d.bars, T('2026-06-05T12:30:00Z'), T('2026-06-05T12:31:00Z'))!;
    expect(rows.map((r) => r.price)).toEqual([1.16205, 1.1641]);
    expect(rows.reduce((a, r) => a + r.up, 0)).toBe(1670);
    expect(rows.reduce((a, r) => a + r.down, 0)).toBe(2495);
    expect(cmeFootprintRows(d.bars, 0, 1)).toBeNull();
  });
});

describe('CME order flow: markers', () => {
  const x0 = T('2026-06-05T12:28:00Z');
  const xAt = (t: number) => (t - x0) / 1000;      // 1 px per second
  const yAt = (p: number) => (1.165 - p) * 100_000; // 1 px per point

  it('places large lots, sweeps, icebergs and absorption on screen, largest drawn last', () => {
    const placed = placeCmeMarkers(answer(), { large: true, sweeps: true, levels: true }, xAt, yAt, 400, 400, null);
    const kinds = placed.map((p) => p.kind);
    expect(kinds.filter((k) => k === 'large')).toHaveLength(3);
    expect(kinds).toContain('sweep');
    expect(kinds).toContain('iceberg');
    expect(kinds).toContain('absorption');
    const large = placed.filter((p) => p.kind === 'large');
    expect(large.at(-1)!.size).toBe(189);
    expect(large.at(-1)!.r).toBe(14);
    expect(large.at(-1)!.side).toBe(-1);
    const sweep = placed.find((p) => p.kind === 'sweep')!;
    expect(sweep.y2).toBeGreaterThan(sweep.y); // took the bids down
    expect(markerRadius(0, 10)).toBe(4);
  });

  it('honours the replay clip and the screen', () => {
    const clip = T('2026-06-05T12:30:00Z');
    const placed = placeCmeMarkers(answer(), { large: true, sweeps: true, levels: true }, xAt, yAt, 400, 400, clip);
    expect(placed.every((p) => (p.item as { t: number }).t < clip)).toBe(true);
    expect(placeCmeMarkers(answer(), { large: true, sweeps: false, levels: false }, xAt, yAt, 50, 400, null)).toHaveLength(0);
  });

  it('hover finds the marker and says what it is, honestly about MBP-10', () => {
    const placed = placeCmeMarkers(answer(), { large: false, sweeps: false, levels: true }, xAt, yAt, 400, 400, null);
    const ice = placed.find((p) => p.kind === 'iceberg')!;
    expect(cmeMarkerAt(placed, ice.x, ice.y)).toBe(ice);
    const text = cmeMarkerText(ice, 'CME 6E', 5).join(' ');
    expect(text).toContain('iceberg-like bid 1.16250');
    expect(text).toContain('traded 34 vs at most 22 shown');
    expect(text).toContain('MBP-10');
  });
});

describe('CmeFlowFeed', () => {
  function harness(fail?: unknown) {
    let now = T('2026-06-05T12:33:00Z');
    const calls: CmeOrderFlowRequest[] = [];
    let changed = 0;
    const feed = new CmeFlowFeed({
      orderFlow: (r) => {
        calls.push(r);
        return fail ? Promise.reject(fail) : Promise.resolve(answer());
      },
      now: () => now,
      changed: () => changed++,
    });
    return { feed, calls, advance: (ms: number) => (now += ms), changed: () => changed };
  }
  const win = { symbol: 'eurusd', sourceId: 'cme-databento', fromUtc: T('2026-06-05T12:28:00Z'), toUtc: T('2026-06-05T12:33:00Z'), barSeconds: 60, head: null };

  it('reads once per window, asks for the book only up to 2 h, re-reads at the live edge every 10 s', async () => {
    const h = harness();
    h.feed.update({ ...win, live: false });
    await flush();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ symbol: 'EURUSD', includeBook: true, spot: true, barSeconds: 60 });
    expect(h.feed.state.kind).toBe('ready');
    h.feed.update({ ...win, live: false });
    expect(h.calls).toHaveLength(1);
    h.feed.update({ ...win, live: true });
    await flush();
    const n = h.calls.length;
    h.feed.update({ ...win, live: true });
    expect(h.calls).toHaveLength(n);
    h.advance(LIVE_REFRESH_MS);
    h.feed.update({ ...win, live: true });
    expect(h.calls).toHaveLength(n + 1);
    h.feed.update({ ...win, fromUtc: T('2026-06-05T08:00:00Z'), live: false });
    expect(h.calls.at(-1)!.includeBook).toBe(false);
    h.feed.update({ ...win, fromUtc: T('2026-06-03T12:00:00Z'), live: false });
    expect(h.feed.state).toMatchObject({ kind: 'idle' });
  });

  it('says "not entitled" when the engine refuses the feed', async () => {
    const refusal = { responseCode: '-403-entitlement', message: "Your organisation is not entitled to 'cme-trades'.", status: false };
    const h = harness({ status: 403, error: refusal });
    h.feed.update({ ...win, live: false });
    await flush();
    expect(h.feed.state.kind).toBe('error');
    expect((h.feed.state as { message: string }).message.toLowerCase()).toContain('entitled');
  });
});

describe('CME order-flow setting', () => {
  it('is off by default, restored and counted', () => {
    expect(DEFAULT_ORDER_FLOW.cmeFlow).toBe(false);
    expect(restoredOrderFlow({ cmeFlow: true }).cmeFlow).toBe(true);
    expect(restoredOrderFlow({}).cmeFlow).toBe(false);
    expect(orderFlowCount({ ...DEFAULT_ORDER_FLOW, cmeFlow: true })).toBe(1);
  });
});
