import { describe, expect, it } from 'vitest';

import { reportPalette } from '../report/report-charts';
import { GATE_DEFAULT_MIN_PLATEAU, heatmapGrid, plateauReadout } from './heatmap.model';
import {
  isOosScatterOptions,
  leastSquares,
  logitHistogramOptions,
  stitchedEquityOptions,
} from './research-charts';
import type { OptimizationHeatmapDto, WalkForwardEquityPoint } from './research.types';

const palette = reportPalette('light');

function heatmapDto(over: Partial<OptimizationHeatmapDto> = {}): OptimizationHeatmapDto {
  return {
    optimizationRunId: 88,
    strategyId: 7,
    candidates: 6,
    parameters: [],
    heatmap: {
      x: { id: 'Length', numeric: true, labels: ['10', '20', '30'], edges: null },
      y: { id: 'Mode', numeric: false, labels: ['"Fast"', '"Slow"'], edges: null },
      cells: [
        [
          { meanExpectancyR: 0.1, count: 1, bestExpectancyR: 0.1 },
          { meanExpectancyR: 0.3, count: 2, bestExpectancyR: 0.4 },
          null,
        ],
        [
          { meanExpectancyR: -0.2, count: 1, bestExpectancyR: -0.2 },
          { meanExpectancyR: 0.2, count: 1, bestExpectancyR: 0.2 },
          null,
        ],
      ],
      peakX: 1,
      peakY: 0,
      peakMeanExpectancyR: 0.3,
      plateauScore: 0.4,
      neighbourhoodPositiveShare: 0.67,
      candidates: 6,
    },
    plateau: {
      score: 0.8,
      peakExpectancyR: 0.4,
      neighboursMeanExpectancyR: 0.32,
      neighbours: 5,
      positiveShare: 0.8,
    },
    peakParametersJson: '{"Length":20,"Mode":"Fast"}',
    whyNot: null,
    ...over,
  };
}

describe('research charts and heatmap (BT-I5, BT-I7, PE-I4)', () => {
  it('lays the heatmap out with the highest y bin on top and marks the peak and its neighbours', () => {
    const grid = heatmapGrid(heatmapDto(), palette)!;

    expect(grid.rows.map((r) => r.label)).toEqual(['"Slow"', '"Fast"']);
    expect(grid.scale).toBeCloseTo(0.3);
    const fastRow = grid.rows[1].cells;
    expect(fastRow[1]).toMatchObject({ peak: true, text: '0.30' });
    expect(fastRow[1].title).toContain('the peak');
    expect(fastRow[0].neighbour).toBe(true);
    expect(grid.rows[0].cells[2]).toMatchObject({
      cell: null,
      text: '',
      background: 'transparent',
    });
    expect(grid.rows[0].cells[0].background).not.toBe(fastRow[1].background); // loss vs gain pole
  });

  it('draws no grid when the engine drew no heatmap', () => {
    expect(
      heatmapGrid(
        heatmapDto({ heatmap: null, whyNot: 'one candidate is not a landscape' }),
        palette,
      ),
    ).toBeNull();
  });

  it('reads the plateau scores in words', () => {
    const plateau = plateauReadout(heatmapDto());
    expect(plateau.level).toBe('plateau');
    expect(plateau.lines[0]).toContain('5 nearest neighbours keep 80%');
    expect(plateau.lines[1]).toContain('Length × Mode slice');

    const spike = plateauReadout(
      heatmapDto({
        plateau: {
          score: 0.2,
          peakExpectancyR: 0.5,
          neighboursMeanExpectancyR: 0.1,
          neighbours: 8,
          positiveShare: 0.5,
        },
      }),
    );
    expect(spike.level).toBe('spike');
    expect(spike.lines.at(-1)).toContain(String(GATE_DEFAULT_MIN_PLATEAU));

    const losing = plateauReadout(
      heatmapDto({
        plateau: {
          score: 0,
          peakExpectancyR: -0.1,
          neighboursMeanExpectancyR: -0.2,
          neighbours: 8,
          positiveShare: 0,
        },
      }),
    );
    expect(losing.level).toBe('losing');
  });

  it('fits a least-squares line and refuses one without spread', () => {
    expect(
      leastSquares([
        { x: 1, y: 3 },
        { x: 2, y: 2 },
        { x: 3, y: 1 },
      ]),
    ).toEqual({ slope: -1, intercept: 4 });
    expect(
      leastSquares([
        { x: 1, y: 1 },
        { x: 1, y: 2 },
        { x: 1, y: 3 },
      ]),
    ).toBeNull();
    expect(leastSquares([{ x: 1, y: 1 }])).toBeNull();
  });

  it('plots IS against OOS with the diagonal and a falling fit line in the loss colour', () => {
    const options = isOosScatterOptions(
      [
        { inSample: 1, outOfSample: 0.5, label: 'a' },
        { inSample: 2, outOfSample: 0.2, label: 'b' },
        { inSample: 3, outOfSample: -0.4, label: 'c' },
      ],
      palette,
      { x: 'In-sample Sharpe', y: 'Out-of-sample Sharpe' },
    )!;
    const series = options.series as {
      type: string;
      lineStyle?: { color: string };
      data: unknown[];
    }[];
    expect(series.map((s) => s.type)).toEqual(['scatter', 'line']);
    expect(series[1].lineStyle!.color).toBe(palette.lossPole);
    expect(isOosScatterOptions([], palette, { x: 'x', y: 'y' })).toBeNull();
  });

  it('bins the CSCV logits with the median-or-worse side in the loss colour', () => {
    const options = logitHistogramOptions([-1.2, -0.3, 0.4, 0.9], palette)!;
    const data = (
      options.series as { data: { value: number; itemStyle: { color: string } }[] }[]
    )[0].data;
    expect(data.reduce((s, d) => s + d.value, 0)).toBe(4);
    expect(data[0].itemStyle.color).toBe(palette.lossPole);
    expect(data.at(-1)!.itemStyle.color).toBe(palette.gainPole);
    expect(logitHistogramOptions([], palette)).toBeNull();
  });

  it('draws the stitched equity with fold markers, in money or in R', () => {
    const points: WalkForwardEquityPoint[] = [
      { time: '2026-01-01T00:00:00Z', equity: 10000, drawdownPct: 0, fold: 0, cumulativeR: 0 },
      { time: '2026-01-05T00:00:00Z', equity: 10100, drawdownPct: 0, fold: 0, cumulativeR: 1 },
      { time: '2026-02-01T00:00:00Z', equity: 10050, drawdownPct: 0.5, fold: 1, cumulativeR: 0.5 },
      { time: '2026-02-03T00:00:00Z', equity: 10200, drawdownPct: 0, fold: 1, cumulativeR: null },
    ];
    const money = stitchedEquityOptions(points, palette, 'money')!;
    const series = money.series as {
      name: string;
      data: [number, number | null][];
      markLine?: { data: { name: string }[] };
    }[];
    expect(series[0].data.map((d) => d[1])).toEqual([10000, 10100, 10050, 10200]);
    expect(series[0].markLine!.data.map((d) => d.name)).toEqual(['Fold 1', 'Fold 2']);
    expect(series[1].data[2][1]).toBe(-0.5);

    const r = stitchedEquityOptions(points, palette, 'r')!;
    expect((r.series as { data: unknown[] }[])[0].data).toHaveLength(3); // points without R are left out
    expect(stitchedEquityOptions(points.slice(0, 1), palette, 'money')).toBeNull();
  });
});
