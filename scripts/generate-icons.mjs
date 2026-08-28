/**
 * Generates every brand raster from one SVG source of truth.
 *
 *   node scripts/generate-icons.mjs
 *
 * Outputs into public/: favicon.svg, favicon.ico, apple-touch-icon.png,
 * icon-192.png, icon-512.png, icon-maskable-512.png, logo-mark.svg.
 *
 * The mark is a pair of chart axes forming an "L" with two candlesticks rising
 * inside it — the monogram and the instrument in one figure. Geometry lives
 * here and in src/app/shared/components/logo/logo.component.ts (which inlines
 * the same shapes for in-app use); change one and change the other.
 *
 * Rasterising goes through the Playwright Chromium already vendored for e2e,
 * so there is no new toolchain dependency. The .ico is assembled here too —
 * an ICO is just a small header wrapped around PNG payloads.
 */
import { chromium } from 'playwright';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

// ── Geometry ────────────────────────────────────────────────────────────────
// Drawn on a 512 grid, but SIZED FOR 16px. A favicon spends most of its life
// in a browser tab, and the earlier draft — a pretty drawing at 512 — arrived
// there as a blue smudge: its axis measured 36 units, which is 1.1 device
// pixels at tab size, so anti-aliasing dissolved it into grey.
//
// So the mark is fitted to the pixel budget instead. At 16px one device pixel
// is 32 grid units, and every edge here lands on a multiple of 32 — not just
// the right thickness but the right position, so nothing straddles a pixel
// boundary and gets split into two grey halves:
//
//   axis 64u = 2px · candle body 96u = 3px · wick 32u = 1px
//
// The content box runs 64..448 on both axes — 75% of the plate against the
// 56% the draft used — and is centred with no optical nudge needed.
//
// Two candles, not three: three bodies plus their wicks put more edges into a
// ~13px box than there are pixels to draw them. Two at this weight stay
// separate, and one rising above the other still reads as a trend. The axis is
// full-opacity white for the same reason — a tinted axis is the first thing to
// vanish at small sizes.
//
// Verify changes with a true 16px raster magnified, never by eyeballing the
// 512 artwork.
const GRID = 512;
const TILE_RADIUS = 114; // 22.3% — the iOS app-icon corner
const AXIS_STROKE = 64;
const WICK_STROKE = 32;

// Outer bounds of the drawn glyph, caps included. The maskable check derives
// from these, so widening the mark re-runs that constraint automatically.
const CONTENT_MIN = 64;
const CONTENT_MAX = GRID - CONTENT_MIN;

// Columns 2-3 carry the axis, 5-7 the near candle, 9-11 the far one; rows
// 12-13 carry the baseline. Round caps add half a stroke beyond each endpoint,
// which is why the path stops 32u short of the box on every side.
const GLYPH = `
  <path d="M96 96 V416 H416" fill="none" stroke="#fff" stroke-width="${AXIS_STROKE}" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M208 224 V400" stroke="#fff" stroke-width="${WICK_STROKE}" stroke-linecap="round"/>
  <rect x="160" y="288" width="96" height="96" rx="22" fill="#fff"/>
  <path d="M336 128 V320" stroke="#fff" stroke-width="${WICK_STROKE}" stroke-linecap="round"/>
  <rect x="288" y="160" width="96" height="128" rx="22" fill="#fff"/>`;

const BLUE_LIGHT = '#3B9DFF';
const BLUE_DEEP = '#0057D8';
// Kept light: the sheen sits exactly where the axis rises, and at 0.18 it was
// lifting the plate toward the glyph's own white and costing contrast.
const SHEEN = 0.1;

// Android's maskable safe zone is a circle 80% of the icon's width (radius
// 204.8u). The corner of the L sits 272u out from centre, so it needs a real
// shrink — 0.75 brings it to ~204u, just inside what a circular mask keeps.
// The generator asserts this rather than trusting the arithmetic.
const MASKABLE_INSET = 0.75;

{
  const safeRadius = GRID * 0.4;
  const cornerReach = Math.SQRT2 * (CONTENT_MAX - GRID / 2);
  const masked = MASKABLE_INSET * cornerReach;
  if (masked > safeRadius) {
    throw new Error(
      `Maskable icon would be clipped: the glyph corner reaches ${masked.toFixed(1)}u ` +
        `at inset ${MASKABLE_INSET}, past the ${safeRadius}u safe radius. ` +
        `Lower MASKABLE_INSET to ${(safeRadius / cornerReach).toFixed(3)} or less.`,
    );
  }
}

/**
 * @param {object} opts
 * @param {number} opts.radius   corner radius; 0 for the full-bleed square cut
 *                               that iOS and Android re-mask themselves
 * @param {number} opts.inset    glyph scale about the centre (maskable safe zone)
 * @param {string} opts.id       gradient id prefix, unique per document
 */
function markSvg({ radius = TILE_RADIUS, inset = 1, id = 'l' } = {}) {
  const scaled =
    inset === 1
      ? GLYPH
      : `<g transform="translate(256 256) scale(${inset}) translate(-256 -256)">${GLYPH}</g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${GRID} ${GRID}" width="${GRID}" height="${GRID}" role="img" aria-label="Lascodia">
  <defs>
    <linearGradient id="${id}-fill" x1="0" y1="0" x2="0.4" y2="1">
      <stop offset="0" stop-color="${BLUE_LIGHT}"/>
      <stop offset="1" stop-color="${BLUE_DEEP}"/>
    </linearGradient>
    <linearGradient id="${id}-sheen" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity="${SHEEN}"/>
      <stop offset="0.55" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect width="${GRID}" height="${GRID}" rx="${radius}" fill="url(#${id}-fill)"/>
  <rect width="${GRID}" height="${GRID}" rx="${radius}" fill="url(#${id}-sheen)"/>
  ${scaled}
</svg>`;
}

// ── ICO container ───────────────────────────────────────────────────────────
/**
 * Wrap PNG buffers in an ICONDIR. Modern browsers and Windows Vista+ read
 * PNG-compressed ICO entries directly, so no BMP re-encoding is needed.
 * @param {{size: number, png: Buffer}[]} entries
 */
function buildIco(entries) {
  const HEADER = 6;
  const ENTRY = 16;
  const header = Buffer.alloc(HEADER);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);

  let offset = HEADER + ENTRY * entries.length;
  const dir = [];
  for (const { size, png } of entries) {
    const e = Buffer.alloc(ENTRY);
    e.writeUInt8(size >= 256 ? 0 : size, 0); // 0 encodes 256
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2); // palette count
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // colour planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    dir.push(e);
    offset += png.length;
  }
  return Buffer.concat([header, ...dir, ...entries.map((e) => e.png)]);
}

// ── Render ──────────────────────────────────────────────────────────────────
async function main() {
  await mkdir(OUT, { recursive: true });

  const browser = await chromium.launch();
  const page = await browser.newPage();

  // Chromium refuses viewports below ~50px, so sizing the viewport to the icon
  // silently yields a 48px raster for the 16 and 32 cases. Hold the viewport
  // comfortably large and clip to the exact box instead.
  const VIEWPORT = 640;
  await page.setViewportSize({ width: VIEWPORT, height: VIEWPORT });

  /** Rasterise an SVG string at an exact pixel size, preserving alpha. */
  async function raster(svg, size) {
    if (size > VIEWPORT) throw new Error(`size ${size} exceeds viewport ${VIEWPORT}`);
    await page.setContent(
      `<!doctype html><style>html,body{margin:0;background:transparent}
       svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
    );
    return page.screenshot({
      omitBackground: true,
      clip: { x: 0, y: 0, width: size, height: size },
    });
  }

  const rounded = markSvg({ id: 'r' });
  const square = markSvg({ radius: 0, id: 's' });
  const maskable = markSvg({ radius: 0, inset: MASKABLE_INSET, id: 'm' });

  // Vector first — modern browsers prefer the SVG favicon and it stays sharp
  // on any display.
  await writeFile(join(OUT, 'favicon.svg'), rounded + '\n');
  await writeFile(join(OUT, 'logo-mark.svg'), rounded + '\n');

  const written = ['favicon.svg', 'logo-mark.svg'];

  const pngs = [
    ['apple-touch-icon.png', square, 180], // iOS applies its own mask
    ['icon-192.png', rounded, 192],
    ['icon-512.png', rounded, 512],
    ['icon-maskable-512.png', maskable, 512], // Android safe-zone crop
  ];
  for (const [name, svg, size] of pngs) {
    await writeFile(join(OUT, name), await raster(svg, size));
    written.push(`${name} (${size}px)`);
  }

  // Legacy .ico for browsers and pinned shortcuts that ignore favicon.svg.
  //
  // Rasterise these one at a time. `raster` drives a SHARED page — setContent
  // then screenshot — so running the sizes concurrently lets one call replace
  // the page content before another has taken its shot. That produced an .ico
  // whose entries were the right dimensions but the wrong picture: the 16px
  // entry was a top-left crop of the 48px render, which is exactly what a
  // browser tab then displayed.
  const icoSizes = [16, 32, 48];
  const icoEntries = [];
  for (const size of icoSizes) {
    icoEntries.push({ size, png: await raster(rounded, size) });
  }
  const ico = buildIco(icoEntries);
  await writeFile(join(OUT, 'favicon.ico'), ico);
  written.push(`favicon.ico (${icoSizes.join('/')})`);

  await browser.close();
  console.log(written.map((w) => `  ✓ ${w}`).join('\n'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
