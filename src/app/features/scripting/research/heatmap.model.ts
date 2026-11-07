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

/** What the cells are coloured by: the engine's mean R, or the worst mean R of the cell's 3×3 neighbourhood (U10). */
export type HeatmapColourBy = 'mean' | 'neighbourhood';

/**
 * U10 — neighbourhood stability of one cell, from the engine's cells only: over the populated cells of its 3×3 block
 * (itself included) the WORST mean R (a pessimistic contour — an edge that survives a step in any direction) and the
 * share of them above 0R. Null for an empty cell.
 */
export interface CellStability {
  worstMeanR: number;
  positiveShare: number;
  populated: number;
}

export function cellStability(
  cells: readonly (readonly (HeatmapCell | null)[])[],
  x: number,
  y: number,
): CellStability | null {
  if (!cells[y]?.[x]) return null;
  let worst = Infinity;
  let positive = 0;
  let populated = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const c = cells[y + dy]?.[x + dx];
      if (!c) continue;
      populated++;
      worst = Math.min(worst, c.meanExpectancyR);
      if (c.meanExpectancyR > 0) positive++;
    }
  }
  return { worstMeanR: worst, positiveShare: positive / populated, populated };
}

/**
 * The most stable cell: the highest worst-of-neighbourhood mean R among cells with at least `minPopulated` populated
 * cells in their block (a lone cell has no neighbourhood to vouch for it). Null when none qualifies.
 */
export function mostStableCell(
  dto: OptimizationHeatmapDto,
  minPopulated = 4,
): { x: number; y: number; stability: CellStability } | null {
  const h = dto.heatmap;
  if (!h) return null;
  let best: { x: number; y: number; stability: CellStability } | null = null;
  for (let y = 0; y < h.cells.length; y++) {
    for (let x = 0; x < h.cells[y].length; x++) {
      const s = cellStability(h.cells, x, y);
      if (!s || s.populated < minPopulated) continue;
      if (!best || s.worstMeanR > best.stability.worstMeanR) best = { x, y, stability: s };
    }
  }
  return best;
}

/** The grid of an engine heatmap, or null when the engine drew none (`whyNot`). */
export function heatmapGrid(
  dto: OptimizationHeatmapDto,
  palette: ReportPalette,
  colourBy: HeatmapColourBy = 'mean',
): HeatmapGrid | null {
  const h = dto.heatmap;
  if (!h) return null;
  const valueOf = (cell: HeatmapCell | null, x: number, y: number): number | null => {
    if (!cell) return null;
    if (colourBy === 'mean') return cell.meanExpectancyR;
    return cellStability(h.cells, x, y)?.worstMeanR ?? null;
  };
  let scale = 0;
  for (let y = 0; y < h.cells.length; y++)
    for (let x = 0; x < h.cells[y].length; x++) {
      const v = valueOf(h.cells[y][x], x, y);
      if (v !== null) scale = Math.max(scale, Math.abs(v));
    }
  const rows: HeatmapGrid['rows'] = [];
  for (let y = h.cells.length - 1; y >= 0; y--) {
    const cells: GridCell[] = h.cells[y].map((cell, x) => {
      const peak = x === h.peakX && y === h.peakY;
      const neighbour = !peak && Math.abs(x - h.peakX) <= 1 && Math.abs(y - h.peakY) <= 1;
      const value = valueOf(cell, x, y);
      const colours = value !== null ? heatCellColors(value, scale, palette) : null;
      const stability = cell ? cellStability(h.cells, x, y) : null;
      const where = `${h.x.id} ${h.x.labels[x] ?? x}, ${h.y.id} ${h.y.labels[y] ?? y}`;
      return {
        x,
        y,
        cell,
        peak,
        neighbour,
        background: colours?.background ?? 'transparent',
        color: colours?.color ?? 'inherit',
        text: value !== null ? formatNumber(value, 2) : '',
        title: cell
          ? `${where}: mean ${formatNumber(cell.meanExpectancyR, 3)} R over ${cell.count} candidate${cell.count === 1 ? '' : 's'}` +
            ` (best ${formatNumber(cell.bestExpectancyR, 3)} R)` +
            (stability
              ? `; neighbourhood worst ${formatNumber(stability.worstMeanR, 3)} R, ${formatPercent(stability.positiveShare * 100, { decimals: 0 })} of ${stability.populated} cells above 0R`
              : '') +
            (peak ? ' — the peak' : '')
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
