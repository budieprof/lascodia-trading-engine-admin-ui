import { describe, expect, it } from 'vitest';

import { reportPalette } from '../report/report-charts';
import { cellStability, heatmapGrid, mostStableCell } from './heatmap.model';
import type { HeatmapCell, OptimizationHeatmapDto } from './research.types';

const c = (m: number): HeatmapCell => ({ meanExpectancyR: m, count: 3, bestExpectancyR: m });

/** 3×3 grid, rows by y: a lone spike at (2,2), a solid region bottom-left. */
const cells: (HeatmapCell | null)[][] = [
  [c(0.2), c(0.3), null],
  [c(0.25), c(0.2), c(-0.4)],
  [null, c(-0.1), c(0.9)],
];

function dto(): OptimizationHeatmapDto {
  return {
    optimizationRunId: 1,
    strategyId: 1,
    candidates: 20,
    parameters: [],
    heatmap: {
      x: { id: 'len', numeric: true, labels: ['10', '20', '30'], edges: null },
      y: { id: 'mult', numeric: true, labels: ['1', '2', '3'], edges: null },
      cells,
      peakX: 2,
      peakY: 2,
      peakMeanExpectancyR: 0.9,
      plateauScore: null,
      neighbourhoodPositiveShare: null,
      candidates: 20,
    },
    plateau: null,
    peakParametersJson: null,
    whyNot: null,
  };
}

describe('neighbourhood stability (U10)', () => {
  it('takes the worst mean R and the positive share over the populated 3×3 block', () => {
    const s = cellStability(cells, 0, 0)!;
    expect(s.populated).toBe(4);
    expect(s.worstMeanR).toBe(0.2);
    expect(s.positiveShare).toBe(1);
    const spike = cellStability(cells, 2, 2)!;
    expect(spike.worstMeanR).toBe(-0.4);
    expect(cellStability(cells, 2, 0)).toBeNull();
  });

  it('finds the most stable region, which is not the lone peak', () => {
    const best = mostStableCell(dto())!;
    expect([best.x, best.y]).toEqual([0, 0]);
    expect(best.stability.worstMeanR).toBe(0.2);
  });

  it('colours by the neighbourhood when asked, from the engine cells only', () => {
    const g = heatmapGrid(dto(), reportPalette('light'), 'neighbourhood')!;
    // rows are top (highest y) first; the peak cell now shows its neighbourhood's worst.
    const peak = g.rows[0].cells[2];
    expect(peak.peak).toBe(true);
    expect(peak.text).toBe('-0.40'.replace('-', '−'));
    expect(peak.title).toContain('neighbourhood worst');
    expect(g.rows[0].cells[0].text).toBe('');
  });
});
