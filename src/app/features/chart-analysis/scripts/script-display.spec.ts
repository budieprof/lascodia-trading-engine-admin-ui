import { describe, expect, it } from 'vitest';
import { cssColor } from '@shared/pine-chart/core/color';
import { statusLineValues } from '@shared/pine-chart/render/legend';
import type { PlotLayer } from '@shared/pine-chart/render/render-model';
import { BOLLINGER_RUN } from './__fixtures__/bollinger-run';
import { toChartScriptResult } from './chart-script.model';
import {
  DEFAULT_DISPLAY,
  autoPrecision,
  displayOverrides,
  resolveDisplay,
  styleOutputsOf,
  styleRenderModel,
  timeframeOf,
  visibleOnTimeframe,
  type ScriptDisplaySettings,
} from './script-display';
import { scriptRenderModel } from './script-model-cache';

const run = (edit?: (raw: any) => void) => {
  const raw = structuredClone(BOLLINGER_RUN) as any;
  edit?.(raw);
  return toChartScriptResult(raw);
};
const display = (patch: Partial<ScriptDisplaySettings>) => resolveDisplay(patch);

/** A non-overlay oscillator over the fixture's bars (RSI-like, 0…100), declaring no format. */
const oscillator = (values?: (n: number) => number, edit?: (raw: any) => void) =>
  run((raw) => {
    raw.compile.declaration = { ...raw.compile.declaration, kind: 'indicator', overlay: false };
    raw.report = null;
    raw.outputs.fills = [];
    raw.outputs.plots = [
      {
        ...raw.outputs.plots[0],
        values: raw.bars.map((_: unknown, i: number) => (values ? values(i) : 30 + (i % 40))),
      },
    ];
    edit?.(raw);
  });

describe('styleRenderModel (PC-01, PC-I4)', () => {
  const r = run();
  const base = scriptRenderModel(r, 5)!;

  it('returns the run’s own model when nothing is styled', () => {
    expect(styleRenderModel(base, DEFAULT_DISPLAY, r.run?.outputs)).toBe(base);
  });

  it('overrides every value’s precision, the declared one included (MSqueeze declares 8)', () => {
    const m = styleRenderModel(base, display({ precision: 2 }), r.run?.outputs);
    for (const s of m.panes.main.series) expect(s.format.precision).toBe(2);
    expect(statusLineValues(m.panes.main, 30)[0].text).toMatch(/^\d+\.\d{2}$/);
    // Cached per settings: the same object for the same settings.
    expect(styleRenderModel(base, display({ precision: 2 }), r.run?.outputs)).toBe(m);
  });

  it('turns labels on the price scale and values in the status line off, script-wide', () => {
    const m = styleRenderModel(
      base,
      display({ labelsOnScale: false, valuesInStatusLine: false }),
      r.run?.outputs,
    );
    expect(m.panes.main.series.every((s) => !s.display.priceScale && !s.display.statusLine)).toBe(
      true,
    );
    expect(statusLineValues(m.panes.main, 30)).toEqual([]);
    // The pane drawing and the data window are untouched.
    expect(m.panes.main.series.every((s) => s.display.pane && s.display.dataWindow)).toBe(true);
  });

  it('hides one output, recolours it, changes its width and style — the fill follows its plots', () => {
    const upper = base.panes.main.series[1] as PlotLayer;
    const own = upper.colors.uniform!;
    const m = styleRenderModel(
      base,
      display({
        outputs: {
          'plot:0': { visible: false },
          [upper.key]: { colors: { [own]: 'rgb(255, 0, 0)' }, lineWidth: 3, plotStyle: 'stepline' },
        },
      }),
      r.run?.outputs,
    );
    const [basis, up] = m.panes.main.series as PlotLayer[];
    expect(basis.display.pane).toBe(false);
    expect(up.colors.uniform).toBe('rgb(255, 0, 0)');
    expect([up.lineWidth, up.style]).toEqual([3, 'stepline']);
    // The fill between Upper and Lower reads the styled plot objects.
    const fill = m.panes.main.fills[0];
    expect(fill.upper.kind === 'plot' && fill.upper.layer).toBe(up);
  });

  it('hides the tables, and barcolor() on request', () => {
    const withBars = run((raw) => {
      raw.outputs.barColors = [
        { id: 9, offset: 0, display: ['all'], forceOverlay: false, colors: raw.bars.map(() => '#FF0000FF') },
      ];
    });
    const m0 = scriptRenderModel(withBars, 5)!;
    const red = cssColor('#FF0000FF')!;
    const recoloured = styleRenderModel(
      m0,
      display({ outputs: { barcolor: { colors: { [red]: 'rgb(0, 0, 255)' } } } }),
      withBars.run?.outputs,
    );
    expect(recoloured.bars.colors![0]).toBe('rgb(0, 0, 255)');
    const hidden = styleRenderModel(
      m0,
      display({ showTables: false, outputs: { barcolor: { visible: false } } }),
      withBars.run?.outputs,
    );
    expect(hidden.bars.colors).toBeNull();
    expect(hidden.panes.main.tables).toEqual([]);
  });

  it('gives a pane of its own an automatic precision when the script declares none', () => {
    const osc = oscillator();
    const m0 = scriptRenderModel(osc, 5)!;
    // Undeclared: the symbol's 5 decimals.
    expect(m0.panes.script!.series[0].format.precision).toBe(5);
    const m = styleRenderModel(m0, DEFAULT_DISPLAY, osc.run?.outputs);
    // Values 30…69: two decimals, on the pane's own scale too.
    expect(m.panes.script!.series[0].format.precision).toBe(2);
    expect(m.format.precision).toBe(2);
    // The operator's precision wins over the automatic one.
    expect(
      styleRenderModel(m0, display({ precision: 4 }), osc.run?.outputs).panes.script!.series[0].format
        .precision,
    ).toBe(4);
  });

  it('keeps a declared precision in a pane of its own', () => {
    const osc = oscillator(undefined, (raw) => (raw.compile.declaration.precision = 8));
    const m0 = scriptRenderModel(osc, 5)!;
    expect(styleRenderModel(m0, DEFAULT_DISPLAY, osc.run?.outputs)).toBe(m0);
    expect(m0.panes.script!.series[0].format.precision).toBe(8);
  });
});

describe('autoPrecision', () => {
  it('three significant digits of the span, between 2 and 8', () => {
    expect(autoPrecision([20, 80])).toBe(2);
    expect(autoPrecision([-0.0002, 0.0003])).toBe(6);
    expect(autoPrecision([-3, 3])).toBe(2);
    expect(autoPrecision([1e-12, 2e-12])).toBe(8);
    // Flat: by magnitude; empty or zero: 2.
    expect(autoPrecision([0.004, 0.004])).toBe(5);
    expect(autoPrecision([])).toBe(2);
    expect(autoPrecision([0, 0, NaN])).toBe(2);
  });
});

describe('Visibility tab', () => {
  it('reads chart resolutions as TradingView counts them', () => {
    expect(timeframeOf('5')).toEqual({ unit: 'minutes', n: 5 });
    expect(timeframeOf('60')).toEqual({ unit: 'hours', n: 1 });
    expect(timeframeOf('240')).toEqual({ unit: 'hours', n: 4 });
    expect(timeframeOf('90')).toEqual({ unit: 'minutes', n: 90 });
    expect(timeframeOf('1D')).toEqual({ unit: 'days', n: 1 });
    expect(timeframeOf('2W')).toEqual({ unit: 'weeks', n: 2 });
    expect(timeframeOf('M')).toEqual({ unit: 'months', n: 1 });
    expect(timeframeOf('tick')).toBeNull();
  });

  it('shows the script only on the intervals its rows allow', () => {
    const v = { minutes: { on: false, from: 1, to: 59 }, hours: { on: true, from: 1, to: 4 } };
    expect(visibleOnTimeframe(v, '15')).toBe(false);
    expect(visibleOnTimeframe(v, '60')).toBe(true);
    expect(visibleOnTimeframe(v, '240')).toBe(true);
    expect(visibleOnTimeframe(v, '480')).toBe(false);
    // Rows it does not set show everything.
    expect(visibleOnTimeframe(v, '1D')).toBe(true);
    expect(visibleOnTimeframe(null, '15')).toBe(true);
  });
});

describe('saving and listing', () => {
  it('a layout saves only what differs from the defaults, and reads it back whole', () => {
    const d = display({ visible: false, precision: 3, outputs: { 'plot:0': { lineWidth: 2 } } });
    const saved = displayOverrides(d);
    expect(saved).toEqual({ visible: false, precision: 3, outputs: { 'plot:0': { lineWidth: 2 } } });
    expect(resolveDisplay(saved)).toEqual(d);
    expect(displayOverrides(DEFAULT_DISPLAY)).toEqual({});
  });

  it('lists each output with the colours it draws in, for the Style tab', () => {
    const outs = styleOutputsOf(scriptRenderModel(run(), 5)!);
    expect(outs.map((o) => [o.key, o.kind])).toEqual([
      ['plot:0', 'plot'],
      ['plot:1', 'plot'],
      ['plot:2', 'plot'],
      ['fill:0', 'fill'],
    ]);
    expect(outs[0]).toMatchObject({ lineWidth: 1, plotStyle: 'line' });
    expect(outs[0].colors).toHaveLength(1);
  });
});
