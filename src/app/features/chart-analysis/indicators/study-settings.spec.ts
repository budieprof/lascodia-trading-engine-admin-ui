import { describe, expect, it } from 'vitest';
import { FillPrimitive } from './fill-primitive';
import { INDICATORS, indicatorById, indicatorLabel } from './registry';
import {
  effectivePlot,
  joinClosed,
  mtfCapable,
  parseStudyInput,
  remapStudySources,
  sourceGroups,
  timeframeChoices,
  padResults,
  parseStudySource,
  plotColors,
  sourceBars,
  studyOrder,
  studySource,
} from './study-settings';

const H = 3_600_000;

describe('study settings (DR-I4 / DR-I5)', () => {
  it('a plot is the catalogue spec with the study overrides', () => {
    const spec = { key: 'ma', title: 'SMA', kind: 'line' as const, color: '#2962FF' };
    expect(effectivePlot(spec)).toMatchObject({ color: '#2962FF', kind: 'line', visible: true });
    expect(
      effectivePlot(spec, {
        plots: { ma: { color: '#FF0000', width: 3, visible: false, kind: 'points' } },
      }),
    ).toMatchObject({
      color: '#FF0000',
      lineWidth: 3,
      kind: 'points',
      visible: false,
    });
  });

  it('a study source names another study and its plot', () => {
    expect(parseStudySource(studySource('rsi-1', 'rsi'))).toEqual({ uid: 'rsi-1', plot: 'rsi' });
    expect(parseStudySource('close')).toBeNull();
  });

  it('computes sources first, and breaks loops and dangling references', () => {
    const a = { uid: 'a', params: { source: studySource('b', 'x') } };
    const b = { uid: 'b', params: { source: 'close' } };
    const c = { uid: 'c', params: { source: studySource('gone', 'x') } };
    const d = { uid: 'd', params: { source: studySource('e', 'x') } };
    const e = { uid: 'e', params: { source: studySource('d', 'x') } };
    const { order, broken } = studyOrder([a, b, c, d, e]);
    expect(order.map((s) => s.uid).indexOf('b')).toBeLessThan(order.map((s) => s.uid).indexOf('a'));
    expect(broken.has('c')).toBe(true);
    expect(broken.has('d') || broken.has('e')).toBe(true);
    expect(broken.has('a')).toBe(false);
  });

  it('builds bars from a source series: from its first value, gaps held, then pads the results back', () => {
    const bars = [1, 2, 3, 4].map((i) => ({
      time: i,
      open: 9,
      high: 9,
      low: 9,
      close: 9,
      volume: 10 * i,
    }));
    const s = sourceBars(bars, [null, 5, null, 7]);
    expect(s.offset).toBe(1);
    expect(s.bars.map((b) => b.close)).toEqual([5, 5, 7]);
    expect(s.bars[0].volume).toBe(20);
    expect(padResults({ ma: [1, 2, 3], 'ma:ahead': [4] }, 1)).toEqual({
      ma: [null, 1, 2, 3],
      'ma:ahead': [4],
    });
  });

  it('joins a higher timeframe on CLOSED bars only — no repaint', () => {
    // H1 bars 08:00..12:00 close at 09:00..13:00; H4 bars [04,08) and [08,12) close at 08:00 and 12:00.
    const chartClose = [9, 10, 11, 12, 13].map((h) => h * H);
    const htfClose = [8 * H, 12 * H, 16 * H];
    expect(joinClosed(chartClose, htfClose, [100, 200, 300])).toEqual([100, 100, 100, 200, 200]);
    expect(joinClosed([7 * H], htfClose, [100, 200, 300])).toEqual([null]);
  });

  it("colours bars TradingView's way", () => {
    expect(plotColors('rising', [1, 2, 2, 1], [])).toEqual([
      '#26A69A',
      '#26A69A',
      '#EF5350',
      '#EF5350',
    ]);
    expect(plotColors('macd', [1, 2, 1.5, -1, -0.5], [])).toEqual([
      '#B2DFDB',
      '#26A69A',
      '#B2DFDB',
      '#FF5252',
      '#FFCDD2',
    ]);
    expect(plotColors('sign', [-1, 0, null], [])).toEqual(['#EF5350', '#26A69A', undefined]);
    expect(
      plotColors(
        'candle',
        [5, 5],
        [
          { open: 1, close: 2 },
          { open: 2, close: 1 },
        ],
      ),
    ).toEqual(['#26A69A', '#EF5350']);
  });

  it('every band / cloud fill and per-bar colouring names plots of its study', () => {
    for (const def of INDICATORS) {
      const keys = new Set(def.plots.map((p) => p.key));
      for (const f of def.fills ?? []) {
        expect(keys.has(f.a), `${def.id} fill ${f.a}`).toBe(true);
        expect(keys.has(f.b), `${def.id} fill ${f.b}`).toBe(true);
      }
      for (const p of def.plots)
        if (p.colorBy) expect(p.kind, `${def.id}.${p.key}`).not.toBe('markers');
    }
    expect(INDICATORS.find((d) => d.id === 'ichimoku')?.fills?.length).toBe(1);
    expect(
      INDICATORS.find((d) => d.id === 'macd')?.plots.find((p) => p.key === 'histogram')?.colorBy,
    ).toBe('macd');
  });

  it("fills one polygon per run on one side, in that side's colour, split at gaps", () => {
    const fills: string[] = [];
    const ctx = {
      fillStyle: '',
      beginPath() {},
      moveTo() {},
      lineTo() {},
      closePath() {},
      fill() {
        fills.push(this.fillStyle);
      },
    };
    const series = { priceToCoordinate: (p: number) => 100 - p };
    const fill = new FillPrimitive(
      () => series as never,
      (t) => t * 10,
    );
    // a over b, then under (the cross at t=3), then a gap, then over again.
    fill.setFills([
      {
        times: [1, 2, 3, 4, 5, 6, 7],
        a: [5, 5, 1, 1, null, 5, 5],
        b: [2, 2, 2, 2, 2, 2, 2],
        color: 'up',
        colorBelow: 'down',
      },
    ]);
    const target = {
      useMediaCoordinateSpace: (cb: (s: { context: typeof ctx }) => void) => cb({ context: ctx }),
    };
    const view = fill.paneViews()[0];
    view.renderer().draw(target as never);
    expect(fills).toEqual(['up', 'down', 'up']);
    expect(view.zOrder()).toBe('bottom');
  });

  it("offers price sources and other studies' plots — never one that reads this study (no loops)", () => {
    const rsi = { uid: 'r', defId: 'rsi', params: { length: 14, source: 'close' } };
    const sma = { uid: 's', defId: 'sma', params: { length: 9, source: studySource('r', 'rsi') } };
    const ema = { uid: 'e', defId: 'ema', params: { length: 5, source: 'close' } };
    const describe = (s: { defId: string; params: Record<string, number | string> }) => {
      const def = indicatorById(s.defId);
      return def ? { label: indicatorLabel(def, s.params), plots: def.plots } : null;
    };
    const forRsi = sourceGroups(rsi, [rsi, sma, ema], describe);
    expect(forRsi[0].choices.map((c) => c.value)).toContain('hlcc4');
    // The SMA reads the RSI: offering it to the RSI would close a loop; the RSI itself is not offered either.
    expect(forRsi.flatMap((g) => g.choices).some((c) => c.value.startsWith('study:s:'))).toBe(
      false,
    );
    expect(forRsi.flatMap((g) => g.choices).some((c) => c.value.startsWith('study:r:'))).toBe(
      false,
    );
    expect(forRsi.flatMap((g) => g.choices).some((c) => c.value === studySource('e', 'ma'))).toBe(
      true,
    );
    const forSma = sourceGroups(sma, [rsi, sma, ema], describe);
    expect(forSma.flatMap((g) => g.choices).some((c) => c.value === studySource('r', 'rsi'))).toBe(
      true,
    );
  });

  it('parses inputs by type: sources and sessions as text, times as ms, numbers within range (DR-16, DR-22)', () => {
    const src = { key: 'source', label: 'Source', type: 'source' as const, default: 'close' };
    expect(parseStudyInput(src, 'hl2')).toBe('hl2');
    expect(parseStudyInput(src, studySource('a', 'b'))).toBe('study:a:b');
    expect(parseStudyInput(src, 'nonsense')).toBeNull();
    const ses = { key: 's', label: 'S', type: 'session' as const, default: '0800-1700' };
    expect(parseStudyInput(ses, '08:30-16:00')).toBe('0830-1600');
    expect(parseStudyInput(ses, '8-16')).toBeNull();
    const time = { key: 't', label: 'T', type: 'time' as const, default: 0 };
    expect(parseStudyInput(time, '')).toBe(0);
    expect(parseStudyInput(time, '1760000000000')).toBe(1760000000000);
    const len = {
      key: 'length',
      label: 'Length',
      type: 'number' as const,
      default: 14,
      min: 1,
      max: 500,
    };
    expect(parseStudyInput(len, '0')).toBe(1);
    expect(parseStudyInput(len, 'x')).toBeNull();
    const sel = {
      key: 'm',
      label: 'M',
      type: 'select' as const,
      default: 'SMA',
      options: ['SMA', 'EMA'],
    };
    expect(parseStudyInput(sel, 'EMA')).toBe('EMA');
    expect(parseStudyInput(sel, 'WMA')).toBeNull();
  });

  it("offers timeframes above the chart's, and only for studies a higher timeframe suits", () => {
    expect(timeframeChoices(['1', '60', '240', '1D'], '60')).toEqual(['240', '1D']);
    expect(timeframeChoices(['1', '60', '240', '1D'], '1D', '240')).toEqual(['240']);
    expect(mtfCapable(indicatorById('rsi')!)).toBe(true);
    expect(mtfCapable(indicatorById('ichimoku')!)).toBe(false);
    expect(mtfCapable(indicatorById('sessions')!)).toBe(false);
    expect(mtfCapable(indicatorById('anchored-vwap')!)).toBe(false);
    expect(mtfCapable(indicatorById('correlation')!)).toBe(false);
  });

  it('keeps a copied study reading its copied source', () => {
    const copies = [
      { uid: 'n1', params: { source: 'close' } },
      { uid: 'n2', params: { source: studySource('o1', 'rsi') } },
      { uid: 'n3', params: { source: studySource('gone', 'x') } },
    ];
    const out = remapStudySources(copies, new Map([['o1', 'n1']]));
    expect(out.map((s) => s.params.source)).toEqual(['close', 'study:n1:rsi', 'close']);
  });
});
