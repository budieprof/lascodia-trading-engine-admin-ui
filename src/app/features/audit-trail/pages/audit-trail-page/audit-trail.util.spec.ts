import { describe, expect, it } from 'vitest';

import { escapeHtml, outcomeTone } from './audit-trail.util';

describe('audit-trail util', () => {
  it('separates refusals from failures', () => {
    expect(outcomeTone('Approved')).toBe('ok');
    expect(outcomeTone('Promoted')).toBe('ok');
    expect(outcomeTone('Rejected')).toBe('warn');
    expect(outcomeTone('Blocked')).toBe('warn');
    expect(outcomeTone('Failed')).toBe('bad');
    expect(outcomeTone('Critical')).toBe('bad');
    expect(outcomeTone('Skipped')).toBe('grey');
    expect(outcomeTone(null)).toBe('grey');
    expect(outcomeTone('Queued')).toBe('info');
  });

  it('escapes html', () => {
    expect(escapeHtml('<b>"x" & y</b>')).toBe('&lt;b&gt;&quot;x&quot; &amp; y&lt;/b&gt;');
    expect(escapeHtml(null)).toBe('');
  });
});
