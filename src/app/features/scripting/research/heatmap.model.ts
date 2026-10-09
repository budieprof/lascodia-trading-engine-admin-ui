import { formatNumber, formatPercent } from '../report/report-format';
import { heatCellColors, type ReportPalette } from '../report/report-charts';
import type { HeatmapCell, OptimizationHeatmapDto } from './research.types';

/**
 * The ExpectancyR heatmap (BT-I7, scripting API §8e) laid out for an HTML grid: the engine's bins and cells, coloured on
 * the report's diverging scale (loss pole ↔ gain pole, saturating at the largest |mean R|), the peak cell and its
 * 8-neighbourhood marked — the neighbourhood the engine's plateau score is measured over.
 */

export interface GridCell {
  x: number;
  y: number;
  cell: HeatmapCell | null;
  peak: boolean;
  neighbour: boolean;
  background: string;
  color: string;
  /** The cell's text: mean R, or empty for an empty bin. */
  text: string;
  /** Tooltip / accessible label. */
  title: string;
}

export interface HeatmapGrid {
  xId: string;
  yId: string;
  xLabels: string[];
  /** Rows top to bottom (the highest y bin first, as an axis reads upward). */
  rows: { label: string; cells: GridCell[] }[];
  /** |mean R| the colours saturate at. */
  scale: number;
}

/** The grid of an engine heatmap, or null when the engine drew none (`whyNot`). */
export function heatmapGrid(
  dto: OptimizationHeatmapDto,
  palette: ReportPalette,
): HeatmapGrid | null {
  const h = dto.heatmap;
  if (!h) return null;
  let scale = 0;
  for (const row of h.cells)
    for (const c of row) if (c) scale = Math.max(scale, Math.abs(c.meanExpectancyR));
  const rows: HeatmapGrid['rows'] = [];
  for (let y = h.cells.length - 1; y >= 0; y--) {
    const cells: GridCell[] = h.cells[y].map((cell, x) => {
      const peak = x === h.peakX && y === h.peakY;
      const neighbour = !peak && Math.abs(x - h.peakX) <= 1 && Math.abs(y - h.peakY) <= 1;
      const colours = cell ? heatCellColors(cell.meanExpectancyR, scale, palette) : null;
      const where = `${h.x.id} ${h.x.labels[x] ?? x}, ${h.y.id} ${h.y.labels[y] ?? y}`;
      return {
        x,
        y,
        cell,
        peak,
        neighbour,
        background: colours?.background ?? 'transparent',
        color: colours?.color ?? 'inherit',
        text: cell ? formatNumber(cell.meanExpectancyR, 2) : '',
        title: cell
          ? `${where}: mean ${formatNumber(cell.meanExpectancyR, 3)} R over ${cell.count} candidate${cell.count === 1 ? '' : 's'}` +
            ` (best ${formatNumber(cell.bestExpectancyR, 3)} R)${peak ? ' — the peak' : ''}`
          : `${where}: no candidate`,
      };
    });
    rows.push({ label: h.y.labels[y] ?? String(y), cells });
  }
  return { xId: h.x.id, yId: h.y.id, xLabels: h.x.labels, rows, scale };
}

export type PlateauLevel = 'plateau' | 'mixed' | 'spike' | 'losing' | 'unknown';

/** The promotion gate's default minimum plateau score (`Promotion:Plateau:MinScore`; the gate is off by default). */
export const GATE_DEFAULT_MIN_PLATEAU = 0.5;

/** The promotion gate's plateau check as the engine reports it configured (candidates `selection`). */
export interface PlateauGate {
  enabled: boolean;
  minScore: number;
}

/**
 * The neighbourhood-stability readout, in words, from the engine's two plateau scores: the slice's (the peak cell's
 * 8 neighbours on these two axes) and the full space's (the best candidate's 8 nearest neighbours over every parameter).
 * With the engine's gate settings (`gate`) the spike line quotes the configured minimum and whether the gate runs;
 * without them (an older engine) it names the gate's default.
 */
export function plateauReadout(
  dto: OptimizationHeatmapDto,
  gate: PlateauGate | null = null,
): {
  level: PlateauLevel;
  lines: string[];
} {
  const lines: string[] = [];
  const full = dto.plateau;
  const slice = dto.heatmap;
  const minScore = gate?.minScore ?? GATE_DEFAULT_MIN_PLATEAU;
  let level: PlateauLevel = 'unknown';
  if (full) {
    if (full.peakExpectancyR <= 0) level = 'losing';
    else if (full.score >= Math.max(0.7, minScore)) level = 'plateau';
    else if (full.score >= minScore) level = 'mixed';
    else level = 'spike';
    lines.push(
      `Across every parameter, the best candidate's ${full.neighbours} nearest neighbours keep ${formatPercent(full.score * 100, { decimals: 0 })} ` +
        `of its expectancy (${formatNumber(full.neighboursMeanExpectancyR, 3)} R against ${formatNumber(full.peakExpectancyR, 3)} R); ` +
        `${formatPercent(full.positiveShare * 100, { decimals: 0 })} of them are profitable.`,
    );
  }
  if (slice?.plateauScore !== null && slice?.plateauScore !== undefined) {
    lines.push(
      `On this ${slice.x.id} × ${slice.y.id} slice, the peak cell's neighbours keep ` +
        `${formatPercent(slice.plateauScore * 100, { decimals: 0 })} of its mean` +
        (slice.neighbourhoodPositiveShare !== null
          ? `; ${formatPercent(slice.neighbourhoodPositiveShare * 100, { decimals: 0 })} of them are positive.`
          : '.'),
    );
  }
  switch (level) {
    case 'plateau':
      lines.push(
        'A broad plateau: settings near the best keep most of its edge, so the result does not hinge on one exact value.',
      );
      break;
    case 'mixed':
      lines.push(
        'Part of the edge survives near the best settings; check the heatmap for a ridge or an isolated cell.',
      );
      break;
    case 'spike':
      lines.push(
        `A spike: small changes to the best settings lose most of the edge (below ${gateText(gate)}). ` +
          'Treat the best result as fragile.',
      );
      break;
    case 'losing':
      lines.push('The best candidate loses money in R, so there is no edge to keep.');
      break;
  }
  return { level, lines };
}

function gateText(gate: PlateauGate | null): string {
  if (!gate) return `the promotion gate's default minimum of ${GATE_DEFAULT_MIN_PLATEAU}`;
  return gate.enabled
    ? `the promotion gate's minimum of ${gate.minScore}, so approval would be refused`
    : `the promotion gate's minimum of ${gate.minScore}; that gate is off (Promotion:Plateau:Enabled)`;
}
