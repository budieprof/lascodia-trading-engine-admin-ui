/**
 * Turning files the operator picked into something the assistant can be given.
 *
 * <p>Pure, so the rules about what is accepted and what is refused can be tested without a
 * browser — those rules are the whole of this module, and they are what decides whether a
 * dropped file reaches the model or is silently ignored.</p>
 */

export interface Attachment {
  name: string;
  mediaType: string;
  /** Bare base64, no data: prefix — the wire format the engine expects. */
  base64: string;
  bytes: number;
}

/** Most files per message. Matches the engine's own cap. */
export const MAX_ATTACHMENTS = 6;

/** Largest single file. Matches the engine's cap, so nothing is accepted here and refused there. */
export const MAX_ATTACHMENT_BYTES = 5_000_000;

/**
 * Types the assistant can actually use.
 *
 * <p>Images become inline blocks; the text types are decoded into the prompt. A PDF or a
 * spreadsheet binary would reach the model as neither, so it is refused at the composer —
 * accepting it and having the engine drop it would look to the operator like the model chose
 * not to mention it.</p>
 */
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const TEXT_TYPES = [
  'text/plain',
  'text/csv',
  'text/markdown',
  'text/tab-separated-values',
  'application/json',
  'application/xml',
  'text/xml',
  'text/yaml',
  'application/x-yaml',
];

/** Extensions the OS often reports with no type or the wrong one. */
const TEXT_EXTENSIONS = [
  '.md',
  '.markdown',
  '.csv',
  '.tsv',
  '.json',
  '.log',
  '.txt',
  '.yaml',
  '.yml',
  '.xml',
  // Pine scripts: no OS knows the type, and the assistant loads them into a buffer to
  // compile, import or edit a strategy.
  '.pine',
  '.pinescript',
];

export const ACCEPT_ATTR = [...IMAGE_TYPES, ...TEXT_TYPES, ...TEXT_EXTENSIONS].join(',');

/**
 * The media type to send for a file.
 *
 * <p>The browser reports `''` for `.md` and `.log` on most platforms, and sometimes
 * `application/octet-stream` for a plain `.csv`. Falling back to the extension is what stops
 * a perfectly readable file being refused for having no label.</p>
 */
export function resolveMediaType(file: File): string | null {
  const type = (file.type || '').toLowerCase();
  if (IMAGE_TYPES.includes(type) || TEXT_TYPES.includes(type)) return type;

  const name = file.name.toLowerCase();
  const ext = TEXT_EXTENSIONS.find((e) => name.endsWith(e));
  if (!ext) return null;
  switch (ext) {
    case '.csv':
      return 'text/csv';
    case '.tsv':
      return 'text/tab-separated-values';
    case '.json':
      return 'application/json';
    case '.md':
    case '.markdown':
      return 'text/markdown';
    case '.yaml':
    case '.yml':
      return 'text/yaml';
    case '.xml':
      return 'text/xml';
    default:
      return 'text/plain';
  }
}

export interface ReadResult {
  attachments: Attachment[];
  /** Human-readable reasons, one per refused file. Empty when everything was accepted. */
  refused: string[];
}

/**
 * Read picked files into attachments, refusing what cannot be used.
 *
 * <p>`existing` is the count already attached, so the per-message cap is enforced across
 * several drops rather than per drop.</p>
 */
export async function readAttachments(files: readonly File[], existing = 0): Promise<ReadResult> {
  const attachments: Attachment[] = [];
  const refused: string[] = [];
  let slots = MAX_ATTACHMENTS - existing;

  for (const file of files) {
    if (slots <= 0) {
      refused.push(`${file.name} — limit is ${MAX_ATTACHMENTS} files per message`);
      continue;
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      refused.push(`${file.name} — over ${Math.round(MAX_ATTACHMENT_BYTES / 1_000_000)}MB`);
      continue;
    }
    const mediaType = resolveMediaType(file);
    if (!mediaType) {
      refused.push(`${file.name} — the assistant cannot read this kind of file`);
      continue;
    }
    try {
      attachments.push({
        name: file.name,
        mediaType,
        base64: await toBase64(file),
        bytes: file.size,
      });
      slots -= 1;
    } catch {
      refused.push(`${file.name} — could not be read`);
    }
  }

  return { attachments, refused };
}

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('read failed'));
    reader.onload = () => {
      const result = String(reader.result ?? '');
      // readAsDataURL gives "data:<type>;base64,<payload>" — the engine wants the payload.
      const comma = result.indexOf(',');
      if (comma < 0) return reject(new Error('unexpected reader output'));
      resolve(result.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}

/** `12.4 KB`, for the attachment chip. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
