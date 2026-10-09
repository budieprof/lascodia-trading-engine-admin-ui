/**
 * A picture for the Image drawing (DR-I12), made small enough to travel inside the drawing's options — the engine
 * keeps a drawing's options in a 20,000-character column, so the picture (a data URL) gets ~18,000 of them. The
 * largest size that fits wins: PNG first (keeps transparency), then JPEG at falling qualities, at falling sizes.
 */

/** Characters a picture may take in a drawing's options. */
export const MAX_IMAGE_CHARS = 18_000;

const SIDES = [480, 360, 256, 192, 128, 96, 64] as const;
const QUALITIES = [0.85, 0.7, 0.55, 0.4] as const;

/** Encodes the picture with its longer side at most `maxSide` px; null when it cannot. */
export type ImageEncoder = (
  maxSide: number,
  type: 'image/png' | 'image/jpeg',
  quality?: number,
) => string | null;

/** The first encoding, largest first, that fits in `maxChars`; null when even the smallest does not. */
export function fitDataUrl(encode: ImageEncoder, maxChars = MAX_IMAGE_CHARS): string | null {
  for (const side of SIDES) {
    const png = encode(side, 'image/png');
    if (png && png.length <= maxChars) return png;
    for (const q of QUALITIES) {
      const jpg = encode(side, 'image/jpeg', q);
      if (jpg && jpg.length <= maxChars) return jpg;
    }
  }
  return null;
}

/** Decode a chosen file and fit it ({@link fitDataUrl}); null when it is not a picture or will not fit. */
export async function fitImageFile(file: File, maxChars = MAX_IMAGE_CHARS): Promise<string | null> {
  if (!file.type.startsWith('image/')) return null;
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('not a picture'));
      el.src = url;
    });
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (!w || !h) return null;
    const canvas = document.createElement('canvas');
    const encode: ImageEncoder = (maxSide, type, quality) => {
      const k = Math.min(1, maxSide / Math.max(w, h));
      canvas.width = Math.max(1, Math.round(w * k));
      canvas.height = Math.max(1, Math.round(h * k));
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (type === 'image/jpeg') {
        // JPEG has no transparency: what was transparent turns white, not black.
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL(type, quality);
    };
    return fitDataUrl(encode, maxChars);
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}
