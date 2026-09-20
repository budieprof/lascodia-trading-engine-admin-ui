import { describe, expect, it } from 'vitest';
import { MAX_ATTACHMENTS, formatBytes, readAttachments, resolveMediaType } from './attachments';

const file = (name: string, type: string, size = 10): File =>
  new File([new Uint8Array(size)], name, { type });

describe('resolveMediaType', () => {
  it('accepts the image and text types the assistant can use', () => {
    expect(resolveMediaType(file('a.png', 'image/png'))).toBe('image/png');
    expect(resolveMediaType(file('a.csv', 'text/csv'))).toBe('text/csv');
  });

  it('falls back to the extension when the browser reports no type', () => {
    // Most platforms report '' for .md and .log; refusing those for having no label would
    // reject perfectly readable files.
    expect(resolveMediaType(file('notes.md', ''))).toBe('text/markdown');
    expect(resolveMediaType(file('run.log', ''))).toBe('text/plain');
    expect(resolveMediaType(file('rows.tsv', ''))).toBe('text/tab-separated-values');
  });

  it('falls back when the browser reports the WRONG type', () => {
    // A plain .csv often arrives as application/octet-stream.
    expect(resolveMediaType(file('rows.csv', 'application/octet-stream'))).toBe('text/csv');
  });

  it('refuses what the assistant cannot read', () => {
    expect(resolveMediaType(file('doc.pdf', 'application/pdf'))).toBeNull();
    expect(resolveMediaType(file('sheet.xlsx', 'application/vnd.ms-excel'))).toBeNull();
    expect(resolveMediaType(file('app.exe', 'application/octet-stream'))).toBeNull();
  });
});

describe('readAttachments', () => {
  it('reads an accepted file to bare base64', async () => {
    const r = await readAttachments([file('a.csv', 'text/csv', 4)]);
    expect(r.refused).toEqual([]);
    expect(r.attachments).toHaveLength(1);
    // Bare base64 — no data: prefix, which is what the engine expects.
    expect(r.attachments[0].base64).not.toMatch(/^data:/);
    expect(r.attachments[0].mediaType).toBe('text/csv');
  });

  it('refuses an unusable type WITH a reason', async () => {
    // Accepting it and letting the engine drop it would look like the model chose not to
    // mention it.
    const r = await readAttachments([file('doc.pdf', 'application/pdf')]);
    expect(r.attachments).toEqual([]);
    expect(r.refused[0]).toMatch(/cannot read this kind of file/);
  });

  it('refuses a file over the size cap', async () => {
    const r = await readAttachments([file('big.png', 'image/png', 6_000_000)]);
    expect(r.attachments).toEqual([]);
    expect(r.refused[0]).toMatch(/over 5MB/);
  });

  it('enforces the per-message cap ACROSS drops, not per drop', async () => {
    const one = Array.from({ length: 4 }, (_, i) => file(`a${i}.csv`, 'text/csv'));
    const r = await readAttachments(one, MAX_ATTACHMENTS - 2);
    expect(r.attachments).toHaveLength(2);
    expect(r.refused).toHaveLength(2);
    expect(r.refused[0]).toMatch(/limit is 6/);
  });

  it('keeps the good files when one in a batch is refused', async () => {
    const r = await readAttachments([
      file('ok.png', 'image/png'),
      file('no.pdf', 'application/pdf'),
      file('ok.csv', 'text/csv'),
    ]);
    expect(r.attachments.map((a) => a.name)).toEqual(['ok.png', 'ok.csv']);
    expect(r.refused).toHaveLength(1);
  });
});

describe('formatBytes', () => {
  it('reads naturally at each scale', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(12_700)).toBe('12.4 KB');
    expect(formatBytes(3_500_000)).toBe('3.3 MB');
  });
});
