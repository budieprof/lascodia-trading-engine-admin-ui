/**
 * File downloads the console's way: bytes in hand (fetched with the operator's credentials, never
 * a bare link that would travel without them) → object URL → a transient `<a download>` click.
 */

/** Hands `blob` to the browser as a download named `fileName`. */
export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // The download has the bytes once click() returns; keep the URL briefly for slow handlers.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export type CsvCell = string | number | boolean | null | undefined;

/**
 * A spreadsheet opens a text cell that starts with one of these as a formula. Script output
 * (plot titles, alert messages, error text) is not trusted input, so such cells get a leading
 * apostrophe. Numbers are written as numbers and never altered.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

function csvCell(v: CsvCell): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  let text = v;
  if (FORMULA_LEAD.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** RFC 4180 CSV (CRLF line ends) with a UTF-8 BOM so Excel reads non-ASCII text correctly. */
export function toCsv(headers: readonly string[], rows: readonly (readonly CsvCell[])[]): string {
  const lines = [headers.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))];
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

/**
 * The file name a `Content-Disposition` header carries (`filename*=UTF-8''…` preferred over
 * `filename="…"`), or null. Path separators are stripped — the name is server-supplied.
 */
export function fileNameFromContentDisposition(header: string | null | undefined): string | null {
  if (!header) return null;
  const star = /filename\*\s*=\s*([^']*)''([^;]+)/i.exec(header);
  let name: string | null = null;
  if (star) {
    try {
      name = decodeURIComponent(star[2].trim().replace(/^"|"$/g, ''));
    } catch {
      name = star[2].trim();
    }
  } else {
    const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/i.exec(header);
    if (plain) name = (plain[2] ?? plain[1]).trim();
  }
  if (!name) return null;
  const safe = name.replace(/[\\/]/g, '_').trim();
  return safe.length > 0 ? safe : null;
}

/** "EURUSD_60_2026-09-24" — a file-name-safe stamp. */
export function fileStamp(...parts: (string | number | null | undefined)[]): string {
  return parts
    .filter((p) => p !== null && p !== undefined && String(p).trim() !== '')
    .map((p) =>
      String(p)
        .trim()
        .replace(/[^A-Za-z0-9._-]+/g, '-'),
    )
    .join('_');
}
