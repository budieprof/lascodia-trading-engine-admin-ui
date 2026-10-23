import { describe, expect, it } from 'vitest';

import { escapeHtml, inline, renderMarkdown, slugify } from './markdown';

describe('docs markdown', () => {
  it('never lets raw HTML through', () => {
    const { html } = renderMarkdown('Hello <script>alert(1)</script> <img src=x onerror=alert(1)>');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;');
  });

  it('keeps only safe links', () => {
    expect(inline(escapeHtml('[ok](https://example.com) [site](/docs/admin) [bad](javascript:alert(1))'))).toBe(
      '<a href="https://example.com" target="_blank" rel="noopener noreferrer">ok</a> <a href="/docs/admin">site</a> [bad](javascript:alert(1))',
    );
  });

  it('renders headings with unique ids, lists, code, tables and notes', () => {
    const { html, headings } = renderMarkdown(
      [
        '# Title',
        '## Step one',
        '## Step one',
        '- **bold** and `code <b>`',
        '- second',
        '',
        '1. first',
        '2. second',
        '',
        '```',
        '<not html>',
        '```',
        '| Key | Default |',
        '|---|---|',
        '| `Demo:Enabled` | false |',
        '> Note *this*.',
      ].join('\n'),
    );
    expect(headings.map((h) => h.id)).toEqual(['title', 'step-one', 'step-one-1']);
    expect(html).toContain('<ul><li><strong>bold</strong> and <code>code &lt;b&gt;</code></li><li>second</li></ul>');
    expect(html).toContain('<ol><li>first</li><li>second</li></ol>');
    expect(html).toContain('<pre><code>&lt;not html&gt;</code></pre>');
    expect(html).toContain('<td><code>Demo:Enabled</code></td>');
    expect(html).toContain('<blockquote>Note <em>this</em>.</blockquote>');
  });

  it('makes anchor ids from text', () => {
    expect(slugify('Allow-list & error 4060')).toBe('allow-list-error-4060');
  });
});
