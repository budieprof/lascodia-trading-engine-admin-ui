import type { HitRegion } from '@shared/pine-chart/lwc/paint-drawings';

/**
 * What the pointer is over among the scripts' drawings (PC-10): the tooltip of a `label` with a
 * `tooltip` text, or of a strategy fill arrow. The primitives record those regions as they paint
 * (`hits`, pane-relative px); chart-host asks on every crosshair move. Pure.
 */

/** A drawing's region under the pointer, and whose it is. */
export interface ScriptHit {
  key: string;
  hit: HitRegion;
}

/** A tooltip as chart-host shows it: its text and where, in the host's px. */
export interface ScriptTooltip {
  text: string;
  left: number;
  top: number;
  /** Anchored by its right / bottom edge (opens toward the free side near the edges). */
  flipX: boolean;
  flipY: boolean;
}

/** The topmost script's region under the point: the last-added script draws on top. */
export function topHit(
  renderers: readonly { key: string; hitAt(pane: number, x: number, y: number): HitRegion | null }[],
  paneIndex: number,
  x: number,
  y: number,
): ScriptHit | null {
  for (let i = renderers.length - 1; i >= 0; i--) {
    const hit = renderers[i].hitAt(paneIndex, x, y);
    if (hit) return { key: renderers[i].key, hit };
  }
  return null;
}

/** Room a tooltip needs before it flips to the other side of the pointer, px. */
const ROOM_X = 340;
const ROOM_Y = 120;
/** Gap between the pointer and the tooltip, px. */
const GAP = 14;

/**
 * Where a tooltip goes for a pointer at (x, y) in a `width` × `height` host: beside it, toward the
 * free side, so one near the right or bottom edge is not clipped (as the Pine chart places its own).
 */
export function placeTooltip(
  text: string,
  x: number,
  y: number,
  width: number,
  height: number,
): ScriptTooltip {
  const flipX = x > width - ROOM_X;
  const flipY = y > height - ROOM_Y;
  return {
    text,
    left: x + (flipX ? -GAP : GAP),
    top: y + (flipY ? -GAP : GAP),
    flipX,
    flipY,
  };
}
