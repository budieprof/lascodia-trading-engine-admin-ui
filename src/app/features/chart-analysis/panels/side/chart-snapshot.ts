/**
 * A picture of the chart for a note (SP-I9), composed from Lightweight Charts' own canvases — the same thing the
 * library's `takeScreenshot()` does, without needing a handle on the chart instance. Overlays drawn in HTML (legend,
 * Pine tables) are not in the picture; the price, studies, drawings and axes are.
 */

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Where each canvas lands on the output, in output pixels: its offset in the chart box × the scale. Pure. */
export function placeCanvases(container: Box, canvases: readonly Box[], scale: number): {
  width: number;
  height: number;
  items: Box[];
} {
  const r = (v: number) => Math.round(v * scale);
  return {
    width: r(container.width),
    height: r(container.height),
    items: canvases
      .filter((c) => c.width > 0 && c.height > 0)
      .map((c) => ({
        left: r(c.left - container.left),
        top: r(c.top - container.top),
        width: r(c.width),
        height: r(c.height),
      })),
  };
}

/** The scale that keeps the picture at most `maxWidth` pixels wide (never upscaled). Pure. */
export function scaleFor(containerWidth: number, devicePixelRatio: number, maxWidth = 1600): number {
  const native = Math.max(1, devicePixelRatio || 1);
  return containerWidth * native > maxWidth ? maxWidth / containerWidth : native;
}

/** A note's picture must fit the engine's cap (2,000,000 characters of data URL). */
export const MAX_SNAPSHOT_CHARS = 1_900_000;

/**
 * A PNG (or, when that is too large, a JPEG) data URL of the chart in `area` — the first Lightweight Charts container
 * inside it — or null when there is no chart or the picture cannot fit {@link MAX_SNAPSHOT_CHARS}.
 */
export function captureChart(area: HTMLElement | null): string | null {
  const chart = area?.querySelector<HTMLElement>('.tv-lightweight-charts');
  if (!chart) return null;
  const box = chart.getBoundingClientRect();
  if (box.width < 10 || box.height < 10) return null;
  const canvases = [...chart.querySelectorAll('canvas')];
  const background = getComputedStyle(area!).backgroundColor || '#ffffff';

  for (const shrink of [1, 0.6]) {
    const scale = scaleFor(box.width, window.devicePixelRatio) * shrink;
    const plan = placeCanvases(box, canvases.map((c) => c.getBoundingClientRect()), scale);
    const out = document.createElement('canvas');
    out.width = plan.width;
    out.height = plan.height;
    const ctx = out.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = background === 'rgba(0, 0, 0, 0)' ? '#ffffff' : background;
    ctx.fillRect(0, 0, out.width, out.height);
    // Same order as the DOM: the price/study panes, then the crosshair layer above each.
    canvases.forEach((c, i) => {
      const at = plan.items[i];
      if (at && c.width > 0 && c.height > 0) ctx.drawImage(c, at.left, at.top, at.width, at.height);
    });
    const png = out.toDataURL('image/png');
    if (png.length <= MAX_SNAPSHOT_CHARS) return png;
    const jpeg = out.toDataURL('image/jpeg', 0.85);
    if (jpeg.length <= MAX_SNAPSHOT_CHARS) return jpeg;
  }
  return null;
}
