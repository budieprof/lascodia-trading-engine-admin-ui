import type { StrategyLineageDto, StrategyLineageNodeDto } from '@core/api/api.types';

/**
 * Lineage tree layout (moved verbatim from the strategy detail page, U13): depth → row, siblings spread evenly
 * along x; edges connect each node to its `parentInTree` via a vertical-then-horizontal elbow path. No external
 * library — for shallow lineages (≤10 levels × ≤8 siblings) a simple greedy layout is plenty. Pure.
 */
export interface LineageLayoutNode {
  id: number;
  x: number;
  y: number;
  width: number;
  name: string;
  symbol: string;
  timeframe: string;
  depthOffset: number;
  tooltip: string;
}

export interface LineageLayout {
  nodes: LineageLayoutNode[];
  edges: { id: string; path: string; color: string }[];
  width: number;
  height: number;
}

export function layoutLineage(lineage: StrategyLineageDto | null): LineageLayout | null {
  if (!lineage || lineage.nodes.length === 0) return null;

  // Defaults sized for shallow trees. We compress NODE_W when a row gets
  // wide so 12+ siblings still fit on a typical 1200px viewport. Compression
  // floors at 96px (just enough for "EURUSD/H1 #12345"); past that we let
  // the container scroll horizontally.
  const NODE_W_MAX = 180;
  const NODE_W_MIN = 96;
  const ROW_H = 56;
  const X_GAP = 16;
  const TOP_PAD = 24;
  const VIEWPORT = 1200;

  // Bucket by depthOffset row.
  const rows = new Map<number, StrategyLineageNodeDto[]>();
  for (const n of lineage.nodes) {
    const arr = rows.get(n.depthOffset) ?? [];
    arr.push(n);
    rows.set(n.depthOffset, arr);
  }
  const sortedDepths = [...rows.keys()].sort((a, b) => a - b);

  let maxRow = 0;
  for (const arr of rows.values()) {
    if (arr.length > maxRow) maxRow = arr.length;
  }

  // Anti-collision: compute the largest NODE_W that still fits the widest
  // row inside VIEWPORT. Floor at NODE_W_MIN — past that the container
  // gets a horizontal scroll bar instead of forcing tiny boxes.
  const fitNodeW = Math.floor((VIEWPORT - (maxRow - 1) * X_GAP) / Math.max(maxRow, 1));
  const NODE_W = Math.max(NODE_W_MIN, Math.min(NODE_W_MAX, fitNodeW));

  const width = Math.max(NODE_W + 40, maxRow * (NODE_W + X_GAP));
  const height = sortedDepths.length * ROW_H + TOP_PAD;

  // Position each node centred within its row.
  const positioned: {
    id: number;
    x: number;
    y: number;
    width: number;
    name: string;
    symbol: string;
    timeframe: string;
    depthOffset: number;
    parentInTree: number | null;
    tooltip: string;
  }[] = [];
  for (const depth of sortedDepths) {
    const arr = rows.get(depth)!;
    // Stable sort by createdAt so re-renders don't shuffle.
    arr.sort((a, b) =>
      a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id - b.id,
    );
    const rowWidth = arr.length * NODE_W + (arr.length - 1) * X_GAP;
    const xStart = (width - rowWidth) / 2 + NODE_W / 2;
    const y = TOP_PAD + sortedDepths.indexOf(depth) * ROW_H + 14;
    arr.forEach((n, i) => {
      positioned.push({
        id: n.id,
        x: xStart + i * (NODE_W + X_GAP),
        y,
        width: NODE_W,
        name: n.name ?? '(unnamed)',
        symbol: n.symbol ?? '?',
        timeframe: String(n.timeframe ?? ''),
        depthOffset: n.depthOffset,
        parentInTree: n.parentInTree ?? null,
        tooltip:
          `${n.strategyType} · ${n.status}` +
          (n.generationSource ? ` · via ${n.generationSource}` : ''),
      });
    });
  }

  // Build edges from parent → child via L-shape elbow at midpoint y.
  const byId = new Map(positioned.map((p) => [p.id, p]));
  const edges: { id: string; path: string; color: string }[] = [];
  for (const p of positioned) {
    if (p.parentInTree == null) continue;
    const parent = byId.get(p.parentInTree);
    if (!parent) continue;
    // Going from parent (which sits ABOVE if descendant, BELOW if ancestor) to p.
    // Top of p = p.y - 14, bottom of parent = parent.y + 14. Elbow at the
    // halfway point between them on y, vertical at parent.x then over to p.x.
    const px = parent.x;
    const py = parent.y + (p.depthOffset > parent.depthOffset ? 14 : -14);
    const cx = p.x;
    const cy = p.y + (p.depthOffset > parent.depthOffset ? -14 : 14);
    const my = (py + cy) / 2;
    const path = `M ${px} ${py} L ${px} ${my} L ${cx} ${my} L ${cx} ${cy}`;
    const color = p.depthOffset > 0 ? '#9ec5fe' : '#c5b3e6';
    edges.push({ id: `e${p.id}`, path, color });
  }

  return {
    nodes: positioned.map(({ id, x, y, width, name, symbol, timeframe, depthOffset, tooltip }) => ({
      id,
      x,
      y,
      width,
      name,
      symbol,
      timeframe,
      depthOffset,
      tooltip,
    })),
    edges,
    width,
    height,
  };
}

/** Ancestors (depth < 0) and descendants (depth > 0) around the focus. */
export function lineageCounts(lineage: StrategyLineageDto | null): {
  ancestors: number;
  descendants: number;
} {
  const nodes = lineage?.nodes ?? [];
  return {
    ancestors: nodes.filter((n) => n.depthOffset < 0).length,
    descendants: nodes.filter((n) => n.depthOffset > 0).length,
  };
}
