import { describe, expect, it } from 'vitest';

import { parseVisualSpec, toEchartsOption, type VisualSpec } from './visual-spec';
import { categoricalAt, signColor, vizPalette } from './viz-palette';

/**
 * The analyst's `chart` grammar, on the rendering side.
 *
 * <p>These assertions are about shape rather than pixels, and each one guards a way a chart can be
 * wrong while still looking fine: a gap bridged into a trend, a diverging series coloured by
 * identity instead of by sign, two incompatible scales sharing one y-axis, an annotation attached
 * to the wrong panel.</p>
 */

const spec = (over: Partial<VisualSpec>): VisualSpec =>
  ({ kind: 'chart', type: 'line', title: 't', ...over }) as VisualSpec;

const series = (o: unknown): any[] => (o as { series: any[] }).series;

const asArray = (v: unknown): any[] => (Array.isArray(v) ? v : [v]);

describe('parseVisualSpec', () => {
  it('accepts our own payload and rejects everything else', () => {
    expect(parseVisualSpec('{"kind":"chart","type":"bar","title":"t"}')?.type).toBe('bar');
    expect(parseVisualSpec('{"kind":"price_chart","symbol":"EURUSD"}')).toBeNull();
    expect(parseVisualSpec('{"error":"bad type"}')).toBeNull();
    expect(parseVisualSpec('not json')).toBeNull();
    expect(parseVisualSpec(null)).toBeNull();
  });
});

describe('line', () => {
  it('never bridges a gap — a connected null draws a trend through hours nobody measured', () => {
    const opt = toEchartsOption(
      spec({ x: ['a', 'b', 'c'], series: [{ name: 's', data: [1, null, 3] }] }),
      'light',
    )!;
    expect(series(opt)[0].connectNulls).toBe(false);
  });

  it('puts a different SCALE in its own stacked panel, never on a second y-axis', () => {
    // A dual y-axis makes the two lines cross wherever the scales happen to be zeroed, and the
    // reader takes the crossing for an event. Two panels on one x-axis show the same divergence
    // without inventing one.
    const opt = toEchartsOption(
      spec({
        x: ['t1', 't2'],
        series: [
          { name: 'score', data: [1, 1] },
          { name: 'liveShare', data: [83, 7], axis: 'right' },
        ],
      }),
      'light',
    )!;
    expect(asArray((opt as { grid: unknown }).grid)).toHaveLength(2);
    expect(asArray((opt as { xAxis: unknown }).xAxis)).toHaveLength(2);
    expect(series(opt)[0].yAxisIndex).toBe(0);
    expect(series(opt)[1].yAxisIndex).toBe(1);
    // …and one crosshair across both, which is the only reason to stack them.
    expect((opt as { axisPointer?: unknown }).axisPointer).toBeTruthy();
  });

  it('keeps a single panel when every series shares one scale', () => {
    const opt = toEchartsOption(
      spec({
        x: ['t1'],
        series: [
          { name: 'a', data: [1] },
          { name: 'b', data: [2] },
        ],
      }),
      'light',
    )!;
    expect(asArray((opt as { grid: unknown }).grid)).toHaveLength(1);
  });

  it('assigns categorical hues in fixed order and never cycles past the last slot', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ name: `s${i}`, data: [1] }));
    const opt = toEchartsOption(spec({ x: ['t'], series: many }), 'light')!;
    expect(series(opt)[0].lineStyle.color).toBe(categoricalAt('light', 0));
    expect(series(opt)[1].lineStyle.color).toBe(categoricalAt('light', 1));
    // A ninth distinguishable hue does not exist; repeating the last is honest, inventing is not.
    expect(series(opt)[9].lineStyle.color).toBe(categoricalAt('light', 7));
  });
});

describe('bar', () => {
  it('colours a diverging series by the sign of each point, not by the series', () => {
    const opt = toEchartsOption(
      spec({
        type: 'bar',
        diverging: true,
        categories: ['14:00', '15:00'],
        series: [{ name: 'Δ', data: [120, -205.8] }],
      }),
      'light',
    )!;
    const data = series(opt)[0].data;
    expect(data[0].itemStyle.color).toBe(signColor('light', 1));
    expect(data[1].itemStyle.color).toBe(signColor('light', -1));
  });

  it('draws a marker series as diamonds over the bars, not as a second bar group', () => {
    const opt = toEchartsOption(
      spec({
        type: 'bar',
        categories: ['NZDUSD'],
        series: [
          { name: 'rShort', data: [0.89] },
          { name: 'rDelta', data: [-0.01], render: 'marker' },
        ],
      }),
      'light',
    )!;
    expect(series(opt)[0].type).toBe('bar');
    expect(series(opt)[1].type).toBe('scatter');
    expect(series(opt)[1].symbol).toBe('diamond');
  });

  it('separates stacked segments with a surface-coloured gap rather than a bare colour change', () => {
    const opt = toEchartsOption(
      spec({
        type: 'stackedbar',
        categories: ['USD'],
        series: [
          { name: 'Muted', data: [93] },
          { name: 'Confirmed', data: [85] },
        ],
      }),
      'light',
    )!;
    expect(series(opt)[0].itemStyle.borderWidth).toBe(2);
    expect(series(opt)[0].itemStyle.borderColor).toBe(vizPalette('light').surface);
    expect(series(opt)[0].stack).toBe('total');
  });

  it('swaps the axes for a horizontal ranking', () => {
    const opt = toEchartsOption(
      spec({
        type: 'bar',
        horizontal: true,
        categories: ['USD'],
        series: [{ name: 's', data: [1] }],
      }),
      'light',
    )!;
    expect((opt as { yAxis: { type: string } }).yAxis.type).toBe('category');
    expect((opt as { xAxis: { type: string } }).xAxis.type).toBe('value');
  });
});

describe('heatmap', () => {
  it('ramps diverging around a midpoint, symmetrically, so the threshold reads', () => {
    // A profit-factor grid is about which cells cleared 1.0, not which cell was largest.
    const opt = toEchartsOption(
      spec({
        type: 'heatmap',
        xCategories: ['0.8', '1.0'],
        yCategories: ['1.0'],
        cells: [
          { x: 0, y: 0, value: 0.6 },
          { x: 1, y: 0, value: 1.8 },
        ],
        midpoint: 1,
      }),
      'light',
    )!;
    const vm = (opt as { visualMap: { min: number; max: number; inRange: { color: string[] } } })
      .visualMap;
    expect(vm.min).toBeCloseTo(0.2, 6);
    expect(vm.max).toBeCloseTo(1.8, 6);
    expect(vm.inRange.color).toHaveLength(3);
    expect(vm.inRange.color[1]).toBe(vizPalette('light').diverging.mid);
  });

  it('falls back to a single-hue ramp when there is no meaningful midpoint', () => {
    const opt = toEchartsOption(
      spec({
        type: 'heatmap',
        xCategories: ['a'],
        yCategories: ['b'],
        cells: [{ x: 0, y: 0, value: 5 }],
      }),
      'light',
    )!;
    expect(
      (opt as { visualMap: { inRange: { color: string[] } } }).visualMap.inRange.color,
    ).toHaveLength(2);
  });
});

describe('waterfall', () => {
  it('rises from the running total and codes each step by sign', () => {
    const opt = toEchartsOption(
      spec({
        type: 'waterfall',
        steps: [
          { label: 'Asian', value: 1344.6 },
          { label: 'London', value: -5553.7 },
        ],
      }),
      'light',
    )!;
    const risers = series(opt)[0].data;
    const blocks = series(opt)[1].data;
    expect(risers[0]).toBe(0);
    // The London step falls to -4209.1, so its transparent riser starts there.
    expect(risers[1]).toBeCloseTo(1344.6 - 5553.7, 4);
    expect(blocks[1].itemStyle.color).toBe(signColor('light', -1));
  });

  it('appends a total column only when asked', () => {
    const withTotal = toEchartsOption(
      spec({ type: 'waterfall', showTotal: true, steps: [{ label: 'a', value: 5 }] }),
      'light',
    )!;
    expect((withTotal as { xAxis: { data: string[] } }).xAxis.data).toEqual(['a', 'Total']);

    const without = toEchartsOption(
      spec({ type: 'waterfall', steps: [{ label: 'a', value: 5 }] }),
      'light',
    )!;
    expect((without as { xAxis: { data: string[] } }).xAxis.data).toEqual(['a']);
  });
});

describe('scatter', () => {
  it('draws the quadrant rules and the 1:1 diagonal — the claim is where the dots fall', () => {
    const opt = toEchartsOption(
      spec({
        type: 'scatter',
        points: [
          { x: 12, y: 28 },
          { x: 30, y: 9 },
        ],
        quadrantX: 14,
        quadrantY: 29,
        diagonal: true,
      }),
      'light',
    )!;
    const guides = series(opt).find((s) => s.markLine);
    expect(guides.markLine.data).toHaveLength(2);
    expect(series(opt).some((s) => s.name === '1:1')).toBe(true);
  });

  it('uses one colour for an ungrouped cloud and the categorical order once grouped', () => {
    const plain = toEchartsOption(spec({ type: 'scatter', points: [{ x: 1, y: 1 }] }), 'light')!;
    expect(series(plain)).toHaveLength(1);

    const grouped = toEchartsOption(
      spec({
        type: 'scatter',
        points: [
          { x: 1, y: 1, group: 'win' },
          { x: 2, y: 2, group: 'loss' },
        ],
      }),
      'light',
    )!;
    expect(series(grouped).map((s) => s.name)).toEqual(['win', 'loss']);
  });
});

describe('annotations', () => {
  it('attaches a right-scale band to the lower panel, where its series is', () => {
    const opt = toEchartsOption(
      spec({
        x: ['t1', 't2'],
        series: [
          { name: 'score', data: [1, 1] },
          { name: 'liveShare', data: [83, 7], axis: 'right' },
        ],
        markLines: [
          { y: 0, label: 'neutral' },
          { y: 50, label: 'half live', axis: 'right' },
        ],
      }),
      'light',
    )!;
    const carriers = series(opt).filter((s) => s.markLine);
    expect(carriers).toHaveLength(2);
    expect(carriers[0].yAxisIndex).toBe(0);
    expect(carriers[1].yAxisIndex).toBe(1);
    expect(carriers[1].markLine.data[0].yAxis).toBe(50);
  });

  it('adds no carrier series when there is nothing to annotate', () => {
    const opt = toEchartsOption(spec({ x: ['t'], series: [{ name: 's', data: [1] }] }), 'light')!;
    expect(series(opt)).toHaveLength(1);
  });

  it('orders a band regardless of which way round the analyst wrote it', () => {
    const opt = toEchartsOption(
      spec({
        type: 'bar',
        categories: ['a'],
        series: [{ name: 's', data: [1] }],
        bands: [{ from: 9, to: 2, label: 'value area' }],
      }),
      'light',
    )!;
    const area = series(opt).find((s) => s.markArea).markArea.data[0];
    expect(area[0].yAxis).toBe(2);
    expect(area[1].yAxis).toBe(9);
  });
});

describe('legend', () => {
  it('is present for two or more series and absent for one — identity is never colour-alone', () => {
    const one = toEchartsOption(spec({ x: ['t'], series: [{ name: 'a', data: [1] }] }), 'light')!;
    expect((one as { legend: { show?: boolean } }).legend.show).toBe(false);

    const two = toEchartsOption(
      spec({
        x: ['t'],
        series: [
          { name: 'a', data: [1] },
          { name: 'b', data: [2] },
        ],
      }),
      'light',
    )!;
    expect((two as { legend: { show?: boolean } }).legend.show).toBeUndefined();
  });
});

describe('theme', () => {
  it('has its own steps for the dark surface rather than flipping the light ones', () => {
    expect(categoricalAt('dark', 0)).not.toBe(categoricalAt('light', 0));
    expect(vizPalette('dark').surface).not.toBe(vizPalette('light').surface);
  });
});

describe('unsupported types', () => {
  it('returns null for the timeline, which the component lays out as an HTML strip', () => {
    expect(toEchartsOption(spec({ type: 'timeline', events: [] }), 'light')).toBeNull();
  });
});
