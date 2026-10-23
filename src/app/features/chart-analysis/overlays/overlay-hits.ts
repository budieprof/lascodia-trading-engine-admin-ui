import type { ProvenanceFacts, ProvenanceKey } from './provenance';

/**
 * Where the derived layers were drawn on the last frame (pane media px), so the host can ask what is
 * under the pointer (PR-4 provenance hover) and which level a right-click landed on (PR-7 alert from a
 * level). Rebuilt on every draw; nothing here survives a pan.
 */

/** A level an alert can be set at: its name and exact price. */
export interface AlertableLevel {
  label: string;
  price: number;
}

interface Base {
  key: ProvenanceKey;
  facts: ProvenanceFacts;
  /** Set on POC / VAH / VAL, nPOC and range edges: a right-click there offers "Add alert at …". */
  level?: AlertableLevel;
}

/** A label box: hit when the pointer is inside it. Labels win over lines and areas. */
interface TagRegion extends Base {
  type: 'tag';
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** A line segment: hit within {@link LINE_TOLERANCE} px of it. */
interface LineRegion extends Base {
  type: 'line';
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** A filled area (a profile's histogram, a stop pool): hit inside it, after tags and lines. */
interface AreaRegion extends Base {
  type: 'area';
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export type HitRegion = TagRegion | LineRegion | AreaRegion;

export interface HitResult {
  key: ProvenanceKey;
  facts: ProvenanceFacts;
}

export const LINE_TOLERANCE = 4;
/** How far a right-click may be from a level's line and still mean it. */
export const LEVEL_TOLERANCE = 6;

function inside(r: { x0: number; y0: number; x1: number; y1: number }, x: number, y: number): boolean {
  return (
    x >= Math.min(r.x0, r.x1) &&
    x <= Math.max(r.x0, r.x1) &&
    y >= Math.min(r.y0, r.y1) &&
    y <= Math.max(r.y0, r.y1)
  );
}

/** Distance from (x, y) to the segment; Infinity beyond its ends (a line is only where it is drawn). */
function segmentDistance(r: LineRegion, x: number, y: number): number {
  const dx = r.x1 - r.x0;
  const dy = r.y1 - r.y0;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(x - r.x0, y - r.y0);
  const t = ((x - r.x0) * dx + (y - r.y0) * dy) / len2;
  if (t < 0 || t > 1) return Infinity;
  return Math.hypot(x - (r.x0 + t * dx), y - (r.y0 + t * dy));
}

export class HitRegistry {
  private regions: HitRegion[] = [];

  clear(): void {
    this.regions = [];
  }

  get size(): number {
    return this.regions.length;
  }

  add(region: HitRegion): void {
    if (
      [region.x0, region.y0, region.x1, region.y1].every((v) => Number.isFinite(v))
    )
      this.regions.push(region);
  }

  /**
   * What is under (x, y): the topmost label, else the nearest line within {@link LINE_TOLERANCE} px,
   * else the topmost area. Later-drawn regions are on top.
   */
  hit(x: number, y: number): HitResult | null {
    for (let i = this.regions.length - 1; i >= 0; i--) {
      const r = this.regions[i];
      if (r.type === 'tag' && inside(r, x, y)) return { key: r.key, facts: r.facts };
    }
    let best: LineRegion | null = null;
    let bestD = LINE_TOLERANCE;
    for (const r of this.regions) {
      if (r.type !== 'line') continue;
      const d = segmentDistance(r, x, y);
      if (d <= bestD) {
        best = r;
        bestD = d;
      }
    }
    if (best) return { key: best.key, facts: best.facts };
    for (let i = this.regions.length - 1; i >= 0; i--) {
      const r = this.regions[i];
      if (r.type === 'area' && inside(r, x, y)) return { key: r.key, facts: r.facts };
    }
    return null;
  }

  /**
   * The alertable level nearest (x, y): a level line within {@link LEVEL_TOLERANCE} px vertically and
   * inside its drawn span, or a level's label box. Null when the click was not on one.
   */
  levelAt(x: number, y: number): AlertableLevel | null {
    let best: AlertableLevel | null = null;
    let bestD = Infinity;
    for (const r of this.regions) {
      if (!r.level) continue;
      let d = Infinity;
      if (r.type === 'tag' && inside(r, x, y)) d = 0;
      else if (r.type === 'line') d = segmentDistance(r, x, y);
      if (d <= LEVEL_TOLERANCE && d < bestD) {
        best = r.level;
        bestD = d;
      }
    }
    return best;
  }
}
