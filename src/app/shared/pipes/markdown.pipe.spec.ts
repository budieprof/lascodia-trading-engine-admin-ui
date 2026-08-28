import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './markdown.pipe';

describe('renderMarkdown — GFM tables', () => {
  // The exact table from conversation #23909, which rendered as pipe soup:
  // with no table support every row fell through to the paragraph branch and
  // was joined with spaces into a single unreadable <p>.
  const realTable = [
    '| Leg | Score | Articles | Dominant theme | Live share |',
    '|-----|-------|----------|----------------|------------|',
    '| EUR | +0.75 | 68 | Monetary Policy | 2.5% |',
    '| USD | +0.45 | 156 | Central Bank Speak | 10.2% |',
  ].join('\n');

  it('renders a real model table as a table, not a paragraph', () => {
    const html = renderMarkdown(realTable);

    expect(html).toContain('<table>');
    expect(html).toContain('<th>Leg</th>');
    expect(html).toContain('<th>Live share</th>');
    expect(html).toContain('<td>EUR</td>');
    expect(html).toContain('<td>Central Bank Speak</td>');
    // The regression: no stray pipes, and no paragraph swallowing the rows.
    expect(html).not.toContain('|');
    expect(html).not.toContain('<p>');
  });

  it('emits one header row and one body row per data line', () => {
    const html = renderMarkdown(realTable);
    expect(html.match(/<tr>/g)).toHaveLength(3); // 1 header + 2 body
    // `[ >]` so the count does not also match the opening <thead> tag.
    expect(html.match(/<th[ >]/g)).toHaveLength(5);
    expect(html.match(/<td/g)).toHaveLength(10);
  });

  it('wraps the table so a wide one scrolls inside its own container', () => {
    expect(renderMarkdown(realTable)).toContain('<div class="md-table-wrap">');
  });

  it('honours per-column alignment', () => {
    const html = renderMarkdown(['| a | b | c |', '|:--|:-:|--:|', '| 1 | 2 | 3 |'].join('\n'));
    expect(html).toContain('style="text-align:left"');
    expect(html).toContain('style="text-align:center"');
    expect(html).toContain('style="text-align:right"');
  });

  it('applies inline formatting inside cells', () => {
    const html = renderMarkdown(['| k | v |', '|---|---|', '| **bold** | `code` |'].join('\n'));
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<code>code</code>');
  });

  it('pads a ragged row to the header width', () => {
    const html = renderMarkdown(['| a | b | c |', '|---|---|---|', '| 1 |'].join('\n'));
    expect(html.match(/<td/g)).toHaveLength(3);
  });

  it('escapes HTML inside cells', () => {
    const html = renderMarkdown(['| x |', '|---|', '| <script>alert(1)</script> |'].join('\n'));
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('does not treat a lone pipe line as a table', () => {
    const html = renderMarkdown('| not a table\njust text');
    expect(html).not.toContain('<table>');
  });

  it('still renders surrounding markdown around a table', () => {
    const html = renderMarkdown(
      ['## Heading', '', 'Intro text.', '', '| a |', '|---|', '| 1 |', '', 'Outro.'].join('\n'),
    );
    expect(html).toContain('<h4>Heading</h4>');
    expect(html).toContain('<p>Intro text.</p>');
    expect(html).toContain('<table>');
    expect(html).toContain('<p>Outro.</p>');
  });

  it('leaves non-table markdown untouched', () => {
    const html = renderMarkdown(['# Title', '- one', '- two'].join('\n'));
    expect(html).toContain('<h3>Title</h3>');
    expect(html).toContain('<li>one</li>');
    expect(html).not.toContain('<table>');
  });
});
