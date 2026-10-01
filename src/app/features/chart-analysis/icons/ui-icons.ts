/**
 * Chrome icons for the chart workspace (toolbar, rail, panels, menus).
 *
 * Inner markup for a 28×28, 1px-stroke, currentColor SVG (see
 * `chart-icon.component.ts`). Straight horizontal/vertical strokes sit on .5
 * coordinates so a 1px line lands on one device pixel instead of blurring
 * across two. Solid accents use `fill="currentColor" stroke="none"`.
 */
const DOT = (x: number, y: number, r = 1.5) =>
  `<circle cx="${x}" cy="${y}" r="${r}" fill="currentColor" stroke="none"/>`;

export const UI_ICONS: Record<string, string> = {
  fallback: '<rect x="7.5" y="7.5" width="13" height="13" rx="2"/>',

  // ── toolbar ──
  caret: '<path d="M10 12.5l4 4 4-4"/>',
  'chevron-right': '<path d="M12 9l5 5-5 5"/>',
  indicators:
    '<path d="M6.5 21.5c3-1 4.5-4 6-8.5s3-7 7-7.5"/><path d="M15.5 16l6 6M21.5 16l-6 6"/>',
  strategy:
    '<path d="M5.5 21.5h17"/><path d="M6.5 18l4.5-5 3.5 3 6-7.5"/><path d="M17 8.5h3.5V12"/>',
  pine: '<path d="M10.5 9l-5 5 5 5M17.5 9l5 5-5 5M15.5 7.5l-3 13"/>',
  calendar:
    '<rect x="5.5" y="7.5" width="17" height="15" rx="1.5"/><path d="M5.5 11.5h17M10.5 5v4M17.5 5v4"/>' +
    DOT(10.5, 15.5, 1) +
    DOT(14, 15.5, 1) +
    DOT(17.5, 15.5, 1) +
    DOT(10.5, 19, 1),
  'volume-profile':
    '<path d="M6.5 5v18"/><path d="M6.5 7.5h6M6.5 10.5h10M6.5 13.5h14M6.5 16.5h9M6.5 19.5h5"/>',
  'sr-levels':
    '<path d="M4.5 9.5h19M4.5 18.5h19" stroke-dasharray="2 2"/><path d="M6 15l4-3 3 2 4-5 4 3"/>',
  structure:
    '<path d="M4.5 19l4-6 3 3 4.5-8 3 5 4.5-4"/>' +
    DOT(8.5, 13, 1.2) +
    DOT(16, 8, 1.2) +
    DOT(19, 13, 1.2),
  delta: '<path d="M14 6.5l8 14.5H6z"/><path d="M14 11.5v5.5"/>',
  magnet:
    '<path d="M8.5 6.5v8a5.5 5.5 0 0 0 11 0v-8"/><path d="M8.5 10.5h3M16.5 10.5h3"/><path d="M11.5 6.5v8a2.5 2.5 0 0 0 5 0v-8"/>',
  info: '<circle cx="14" cy="14" r="8.5"/><path d="M14 12.5v6"/>' + DOT(14, 9.5, 1),
  news:
    '<path d="M6.5 7.5h13v13a1.5 1.5 0 0 0 1.5 1.5H8a1.5 1.5 0 0 1-1.5-1.5z"/><path d="M19.5 11.5h2v9a1.5 1.5 0 0 1-1.5 1.5"/>' +
    '<path d="M9.5 11.5h7M9.5 14.5h7M9.5 17.5h4"/>',
  watchlist:
    '<path d="M11.5 8.5h11M11.5 14.5h11M11.5 20.5h11"/>' +
    DOT(7, 8.5, 1.2) +
    DOT(7, 14.5, 1.2) +
    DOT(7, 20.5, 1.2),
  eye: '<path d="M4.5 14s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z"/><circle cx="14" cy="14" r="3"/>',
  'eye-off':
    '<path d="M4.5 14s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z"/><circle cx="14" cy="14" r="3"/><path d="M6 22L22 6"/>',
  undo: '<path d="M9 9.5L5.5 13 9 16.5"/><path d="M5.5 13h11a5 5 0 0 1 0 10H13"/>',
  redo: '<path d="M19 9.5l3.5 3.5-3.5 3.5"/><path d="M22.5 13h-11a5 5 0 0 0 0 10H15"/>',
  layouts:
    '<rect x="5.5" y="5.5" width="17" height="17" rx="1.5"/><path d="M14.5 5.5v17M5.5 14.5h9"/>',
  save: '<path d="M6.5 6.5h12l3 3v12h-15z"/><path d="M9.5 6.5v5h8v-5"/><rect x="9.5" y="15.5" width="9" height="6"/>',
  star: '<path d="M14 5.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L14 18.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.8z"/>',
  'star-filled':
    '<path d="M14 5.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L14 18.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.8z" fill="currentColor"/>',
  close: '<path d="M8.5 8.5l11 11M19.5 8.5l-11 11"/>',
  camera:
    '<path d="M5.5 10.5a1.5 1.5 0 0 1 1.5-1.5h3l1.5-2.5h5L18 9h3a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 21 21H7a1.5 1.5 0 0 1-1.5-1.5z"/><circle cx="14" cy="15" r="3.5"/>',
  fullscreen: '<path d="M5.5 10.5v-5h5M17.5 5.5h5v5M22.5 17.5v5h-5M10.5 22.5h-5v-5"/>',
  replay: '<path d="M6.5 6.5v15"/><path d="M11.5 8.5l10 5.5-10 5.5z"/>',
  sync: '<path d="M20.5 10a7 7 0 0 0-12.5-1M7.5 18a7 7 0 0 0 12.5 1"/><path d="M8 5v4h4M20 23v-4h-4"/>',
  warning: '<path d="M14 5.5l9 16H5z"/><path d="M14 11.5v5"/>' + DOT(14, 19, 1),
  cursor: '<path d="M14 5v6M14 17v6M5 14h6M17 14h6"/>' + DOT(14, 14, 1),
  arrow: '<path d="M9.5 6.5v14l4-4 3 6 2.5-1.2-3-6h5.5z"/>',
  trash:
    '<path d="M6.5 8.5h15M11.5 8.5v-2h5v2"/><path d="M8.5 8.5l1 14h9l1-14"/><path d="M12.5 12v7M15.5 12v7"/>',
  fill: '<rect x="6.5" y="6.5" width="15" height="15" rx="1.5"/><path d="M6.5 15.5l9-9M10.5 21.5l11-11M16.5 21.5l5-5" opacity=".6"/>',
  lock: '<rect x="7.5" y="12.5" width="13" height="10" rx="1.5"/><path d="M10 12.5V10a4 4 0 0 1 8 0v2.5"/>',
  unlock:
    '<rect x="7.5" y="12.5" width="13" height="10" rx="1.5"/><path d="M10 12.5V10a4 4 0 0 1 7.7-1.5"/>',
  clone:
    '<rect x="9.5" y="9.5" width="12" height="12" rx="1.5"/><path d="M6.5 17.5v-10a1 1 0 0 1 1-1h10"/>',
  swap: '<path d="M6 10.5h15M17.5 7l3.5 3.5-3.5 3.5M22 17.5H7M10.5 14L7 17.5l3.5 3.5"/>',
  'step-back': '<path d="M8.5 7.5v13"/><path d="M20.5 8l-9 6 9 6z"/>',
  'step-forward': '<path d="M19.5 7.5v13"/><path d="M7.5 8l9 6-9 6z"/>',
  play: '<path d="M9.5 7l12 7-12 7z"/>',
  pause: '<path d="M10.5 7.5v13M17.5 7.5v13"/>',
  tester: '<path d="M5.5 22.5h17"/><path d="M8.5 22.5v-6M12.5 22.5V10M16.5 22.5v-9M20.5 22.5V7"/>',
  settings:
    '<circle cx="14" cy="14" r="3"/><path d="M14 4.5v3M14 20.5v3M4.5 14h3M20.5 14h3M7.3 7.3l2.1 2.1M18.6 18.6l2.1 2.1M7.3 20.7l2.1-2.1M18.6 9.4l2.1-2.1"/>',
  live: DOT(14, 14, 3),
  closed: '<circle cx="14" cy="14" r="3"/>',

  plus: '<path d="M14 7v14M7 14h14"/>',
  more: DOT(8, 14, 1.3) + DOT(14, 14, 1.3) + DOT(20, 14, 1.3),
  pencil: '<path d="M17.5 6.5l4 4L11 21H7v-4z"/><path d="M15 9l4 4"/>',
  flag: '<path d="M8.5 23V5.5"/><path d="M8.5 6.5h11l-2.5 4 2.5 4h-11" fill="currentColor"/>',

  search: '<circle cx="12.5" cy="12.5" r="6"/><path d="M17 17l5.5 5.5"/>',
  templates:
    '<rect x="5.5" y="5.5" width="7" height="7" rx="1"/><rect x="15.5" y="5.5" width="7" height="7" rx="1"/><rect x="5.5" y="15.5" width="7" height="7" rx="1"/><rect x="15.5" y="15.5" width="7" height="7" rx="1"/>',
  layers:
    '<path d="M14 5.5l8.5 4.5-8.5 4.5L5.5 10z"/><path d="M5.5 14l8.5 4.5 8.5-4.5"/><path d="M5.5 18l8.5 4.5 8.5-4.5"/>',
  volume:
    '<path d="M5.5 22.5h17"/><path d="M8.5 22.5v-5M11.5 22.5v-9M14.5 22.5v-6M17.5 22.5v-11M20.5 22.5v-7"/>',
  trades: '<path d="M5.5 20l5-6 4 3 7-8.5"/><path d="M8 8.5h4M10 6.5v4"/>' + DOT(21.5, 8.5, 1.4),
  alert:
    '<path d="M14 5.5a5.5 5.5 0 0 0-5.5 5.5v4.5L6.5 19h15l-2-3.5V11A5.5 5.5 0 0 0 14 5.5z"/><path d="M12 21.5a2 2 0 0 0 4 0"/>',
  'goto-date':
    '<rect x="5.5" y="7.5" width="17" height="15" rx="1.5"/><path d="M5.5 11.5h17M10.5 5v4M17.5 5v4"/><path d="M12 17h6M16 15l2 2-2 2"/>',
  'object-tree':
    '<path d="M7.5 6.5h6M7.5 6.5v15M7.5 13.5h6M7.5 21.5h6"/><rect x="15.5" y="4.5" width="7" height="4" rx="1"/><rect x="15.5" y="11.5" width="7" height="4" rx="1"/><rect x="15.5" y="19.5" width="7" height="4" rx="1"/>',

  // ── split-layout picker ──
  'layout-1': '<rect x="5.5" y="6.5" width="17" height="15" rx="1.5"/>',
  'layout-2h': '<rect x="5.5" y="6.5" width="17" height="15" rx="1.5"/><path d="M14.5 6.5v15"/>',
  'layout-2v': '<rect x="5.5" y="6.5" width="17" height="15" rx="1.5"/><path d="M5.5 14.5h17"/>',
  'layout-4':
    '<rect x="5.5" y="6.5" width="17" height="15" rx="1.5"/><path d="M14.5 6.5v15M5.5 14.5h17"/>',
  'layout-6':
    '<rect x="4.5" y="6.5" width="19" height="15" rx="1.5"/><path d="M10.5 6.5v15M17.5 6.5v15M4.5 14.5h19"/>',
  'layout-8':
    '<rect x="3.5" y="6.5" width="21" height="15" rx="1.5"/><path d="M8.5 6.5v15M14.5 6.5v15M19.5 6.5v15M3.5 14.5h21"/>',
};
