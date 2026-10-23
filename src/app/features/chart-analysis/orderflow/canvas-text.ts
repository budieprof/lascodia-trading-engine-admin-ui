/**
 * Small canvas helpers the order-flow primitives share: a hover card and a caption line, in media px (the caller has
 * scaled the context to the device pixel ratio).
 */

export const OF_FONT =
  '11px -apple-system, BlinkMacSystemFont, "Trebuchet MS", Roboto, Ubuntu, sans-serif';

/** A hover card with `lines` next to (x, y), kept inside the pane. */
export function drawHoverCard(
  ctx: CanvasRenderingContext2D,
  lines: readonly string[],
  x: number,
  y: number,
  pane: { width: number; height: number },
  dark: boolean,
): void {
  if (lines.length === 0) return;
  ctx.save();
  ctx.font = OF_FONT;
  const pad = 6;
  const lh = 15;
  const w = Math.ceil(Math.max(...lines.map((l) => ctx.measureText(l).width))) + pad * 2;
  const h = lines.length * lh + pad * 2 - 3;
  let left = x + 14;
  let top = y + 14;
  if (left + w > pane.width - 4) left = x - w - 14;
  if (top + h > pane.height - 4) top = y - h - 14;
  left = Math.max(4, left);
  top = Math.max(4, top);
  ctx.fillStyle = dark ? 'rgba(30,34,45,0.94)' : 'rgba(255,255,255,0.96)';
  ctx.strokeStyle = dark ? 'rgba(120,123,134,0.6)' : 'rgba(120,123,134,0.45)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.rect(left + 0.5, top + 0.5, w, h);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = dark ? '#d1d4dc' : '#131722';
  ctx.textBaseline = 'top';
  lines.forEach((l, i) => ctx.fillText(l, left + pad, top + pad + i * lh));
  ctx.restore();
}

/** Caption lines stacked upwards from `bottom` at the pane's left edge, each on a faint plate so it reads over bars. */
export function drawCaptions(
  ctx: CanvasRenderingContext2D,
  lines: readonly string[],
  bottom: number,
  dark: boolean,
  left = 8,
): void {
  if (lines.length === 0) return;
  ctx.save();
  ctx.font = OF_FONT;
  ctx.textBaseline = 'middle';
  const lh = 16;
  lines.forEach((text, i) => {
    const cy = bottom - (lines.length - 1 - i) * lh - lh / 2;
    const w = ctx.measureText(text).width + 8;
    ctx.fillStyle = dark ? 'rgba(19,23,34,0.72)' : 'rgba(255,255,255,0.78)';
    ctx.fillRect(left - 4, cy - lh / 2 + 1, w, lh - 2);
    ctx.fillStyle = dark ? '#b2b5be' : '#50535e';
    ctx.fillText(text, left, cy);
  });
  ctx.restore();
}

/** "16 Oct 08:00 UTC" — order-flow notes say their clock. */
export function formatUtcShort(ms: number): string {
  const d = new Date(ms);
  const mon = d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' });
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${d.getUTCDate()} ${mon} ${hh}:${mm} UTC`;
}

/** An instance id short enough for a caption: `LASC-MULTI…849480`. */
export function shortInstance(id: string): string {
  return id.length > 18 ? `${id.slice(0, 10)}…${id.slice(-6)}` : id;
}

/** "08:00:12.345 UTC" — an event-level instant (the market-data stream is millisecond-stamped). */
export function formatUtcMs(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)} UTC`;
}
