import { behaviorFor } from '../tools/registry';
import { styleFor, toolFor, type Drawing } from '../model';

/** TradingView's colour picker grid: a grey ramp, the base hues, then tints/shades. */
export const TV_PALETTE: readonly (readonly string[])[] = [
  ['#FFFFFF', '#EBEBEB', '#D6D6D6', '#BFBFBF', '#A8A8A8', '#8F8F8F', '#757575', '#5C5C5C', '#434343', '#000000'],
  ['#F23645', '#FF9800', '#FFEB3B', '#4CAF50', '#089981', '#00BCD4', '#2962FF', '#673AB7', '#9C27B0', '#E91E63'],
  ['#FCCBCD', '#FFE0B2', '#FFF9C4', '#C8E6C9', '#ACE5DC', '#B2EBF2', '#BBD9FB', '#D1C4E9', '#E1BEE7', '#F8BBD0'],
  ['#FAA1A4', '#FFCC80', '#FFF59D', '#A5D6A7', '#70CCBD', '#80DEEA', '#90BFF9', '#B39DDB', '#CE93D8', '#F48FB1'],
  ['#F7787B', '#FFB74D', '#FFF176', '#81C784', '#42BDA8', '#4DD0E1', '#5B9CF6', '#9575CD', '#BA68C8', '#F06292'],
  ['#F7525F', '#FFA726', '#FFEE58', '#66BB6A', '#22AB94', '#26C6DA', '#3179F5', '#7E57C2', '#AB47BC', '#EC407A'],
  ['#B22833', '#F57C00', '#FBC02D', '#388E3C', '#056656', '#0097A7', '#1848CC', '#512DA8', '#7B1FA2', '#C2185B'],
  ['#801922', '#E65100', '#F57F17', '#1B5E20', '#00332A', '#006064', '#0C3299', '#311B92', '#4A148C', '#880E4F'],
];

/** Split any `#rgb`, `#rrggbb`, `#rrggbbaa` or `rgb(a)()` colour into hex + alpha. */
export function parseColor(c: string | null | undefined): { hex: string; alpha: number } {
  if (!c) return { hex: '#2962FF', alpha: 1 };
  const s = c.trim();
  let m = /^#([a-f\d])([a-f\d])([a-f\d])$/i.exec(s);
  if (m) return { hex: `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}`.toUpperCase(), alpha: 1 };
  m = /^#([a-f\d]{6})([a-f\d]{2})?$/i.exec(s);
  if (m) return { hex: `#${m[1]}`.toUpperCase(), alpha: m[2] ? round2(parseInt(m[2], 16) / 255) : 1 };
  m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i.exec(s);
  if (m) {
    const hex = '#' + [m[1], m[2], m[3]].map((v) => Number(v).toString(16).padStart(2, '0')).join('');
    const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return { hex: hex.toUpperCase(), alpha: round2(a) };
  }
  return { hex: '#2962FF', alpha: 1 };
}

/** Hex + alpha → the string stored on the drawing (plain hex when opaque). */
export function formatColor(hex: string, alpha: number): string {
  const { hex: h } = parseColor(hex);
  if (alpha >= 1) return h;
  const r = parseInt(h.slice(1, 3), 16);
  const g = parseInt(h.slice(3, 5), 16);
  const b = parseInt(h.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${round2(Math.max(0, alpha))})`;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

const FILL_GROUPS = new Set(['shapes', 'fib', 'gann', 'channels', 'measure', 'volume', 'pitchfork']);

/** Whether the floating toolbar offers a Background (fill) button for this drawing. */
export function hasFill(d: Drawing): boolean {
  return d.style.fill !== null || styleFor(d.kind).fill !== null || FILL_GROUPS.has(toolFor(d.kind)?.group ?? '');
}

/** Whether the drawing carries text (Text tab, text colour button). */
export function hasText(d: Drawing): boolean {
  if (d.style.text) return true;
  if (toolFor(d.kind)?.group === 'annotation') return true;
  return (behaviorFor(d.kind)?.options ?? []).some((o) => o.tab === 'text');
}
