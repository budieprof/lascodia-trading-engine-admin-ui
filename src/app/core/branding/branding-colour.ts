/** Colour helpers for an organisation's primary colour (engine multi-tenancy Phase 7, LC.4). */

/** `#rrggbb` (any case), or empty for "the platform's colour". */
export function isValidColour(value: string | null | undefined): boolean {
  const v = (value ?? '').trim();
  return v === '' || /^#[0-9a-fA-F]{6}$/.test(v);
}

/** Black or white text, whichever reads better on `hex` (WCAG relative luminance). */
export function readableTextOn(hex: string): '#000000' | '#ffffff' {
  const rgb = parseHex(hex);
  if (!rgb) return '#ffffff';
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.179 ? '#000000' : '#ffffff';
}

/** A slightly lighter shade for hover states (`amount` 0–1 towards white). */
export function lighten(hex: string, amount = 0.12): string {
  const rgb = parseHex(hex);
  if (!rgb) return hex;
  return (
    '#' +
    rgb
      .map((c) =>
        Math.round(c + (255 - c) * amount)
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  );
}

function parseHex(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
}
