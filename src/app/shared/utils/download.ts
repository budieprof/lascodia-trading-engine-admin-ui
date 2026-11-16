/**
 * Saves text as a file in the browser — the console's download mechanism (a Blob behind an
 * object URL, clicked through a transient `<a download>`, as the chart and equity-overlay PNG
 * exports do), for text content such as `.pine` sources and JSON bundles.
 */
export function downloadTextFile(
  fileName: string,
  content: string,
  mimeType = 'text/plain;charset=utf-8',
): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = sanitiseFileName(fileName);
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // The click has handed the bytes to the browser; release the blob shortly after.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Strips characters no filesystem accepts; never returns an empty name. */
export function sanitiseFileName(name: string): string {
  const printable = [...(name ?? '')].filter((ch) => ch.charCodeAt(0) >= 32).join('');
  const cleaned = printable.replace(/[\\/:*?"<>|]+/g, '_').trim();
  return cleaned || 'download.txt';
}

/** Reads a user-picked file as text (UTF-8). */
export function readTextFile(file: File): Promise<string> {
  if (typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('The file could not be read.'));
    reader.readAsText(file);
  });
}

/**
 * Raster image types a same-origin blob URL may be OPENED as (review A11, 2026-11-16). Anything
 * else — SVG (scriptable), HTML, XML, PDF, unknown — opened from a blob: URL runs as a document of
 * the console's own origin, with its session. Those are downloaded instead.
 */
const INLINE_SAFE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** The bare media type when a blob of `type` is safe to open inline, else null. */
export function inlineSafeType(type: string | null | undefined): string | null {
  const bare = (type ?? '').split(';')[0].trim().toLowerCase();
  return INLINE_SAFE_IMAGE_TYPES.has(bare) ? bare : null;
}

/** Saves a blob through a transient `<a download>`, as opaque bytes. */
export function downloadBlob(blob: Blob, fileName: string): void {
  const opaque = new Blob([blob], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(opaque);
  const a = document.createElement('a');
  a.href = url;
  a.download = sanitiseFileName(fileName);
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Opens a server-supplied blob in a new tab only when it is a raster image (re-wrapped with
 * exactly that type, so no parameter rides along); everything else is downloaded as
 * `application/octet-stream`. Never trust the server's content type to decide what runs.
 */
export function openOrDownloadBlob(blob: Blob, fileName: string): 'opened' | 'downloaded' {
  const type = inlineSafeType(blob.type);
  if (!type) {
    downloadBlob(blob, fileName);
    return 'downloaded';
  }
  const url = URL.createObjectURL(new Blob([blob], { type }));
  window.open(url, '_blank', 'noopener');
  // The tab has the bytes by now; holding the object URL would pin the blob.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return 'opened';
}
