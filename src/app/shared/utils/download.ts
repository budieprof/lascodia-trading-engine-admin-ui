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
