import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './markdown.pipe';

/** The pipe's internal placeholder; it must never survive into the output. */
const SENTINEL_CHAR = '\u0000';

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

describe('renderMarkdown — fenced code blocks', () => {
  // The ASCII flow diagram from conversation #24272. With no fence support every line
  // fell through to the paragraph branch and was joined with SPACES, and inline() then
  // matched the backticks across the fence — flattening the diagram into one line and
  // wrapping it in a stray <code> with literal `` left on both sides.
  const diagram = ['```', '[EA]', '  ↓', 'POST /tick/batch', '  ├─ filter stale', '```'].join('\n');

  it('preserves a diagram verbatim, with its newlines and indentation', () => {
    const html = renderMarkdown(diagram);
    expect(html).toContain('<pre class="md-code"><code>');
    expect(html).toContain('[EA]\n  ↓\nPOST /tick/batch\n  ├─ filter stale');
  });

  it('does not flatten the block into a paragraph or leave stray fences', () => {
    const html = renderMarkdown(diagram);
    expect(html).not.toContain('<p>');
    expect(html).not.toContain('`');
  });

  it('does not apply inline markdown inside a fence', () => {
    // Otherwise a diagram containing * or ** silently grows <em>/<strong> tags.
    const html = renderMarkdown(['```', 'a ** b ** c', '`not code`', '```'].join('\n'));
    expect(html).not.toContain('<strong>');
    expect(html).not.toContain('<code>`');
    expect(html).toContain('a ** b ** c');
  });

  it('echoes a language tag as a class', () => {
    expect(renderMarkdown(['```sql', 'SELECT 1', '```'].join('\n'))).toContain(
      '<code class="language-sql">',
    );
  });

  it('still escapes HTML inside a fence', () => {
    const html = renderMarkdown(['```', '<script>alert(1)</script>', '```'].join('\n'));
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('closes an unterminated fence at end of input', () => {
    const html = renderMarkdown(['```', 'dangling', ''].join('\n'));
    expect(html).toContain('<pre class="md-code">');
    expect(html).toContain('dangling');
  });
});

describe('renderMarkdown — links, images and safety', () => {
  it('renders [text](url) as a link that cannot re-enter this tab', () => {
    const html = renderMarkdown('See [Reuters](https://reuters.com/x) for detail.');
    expect(html).toContain(
      '<a href="https://reuters.com/x" target="_blank" rel="noopener noreferrer">Reuters</a>',
    );
  });

  it('autolinks a bare URL without swallowing the sentence punctuation', () => {
    const html = renderMarkdown('Source: https://example.com/a?b=1.');
    expect(html).toContain('href="https://example.com/a?b=1"');
    expect(html).toContain('</a>.');
  });

  it('refuses a javascript: or data: URL and leaves the text alone', () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,<script>', '//evil.test']) {
      const html = renderMarkdown(`[click](${bad})`);
      expect(html).not.toContain('<a ');
      expect(html).toContain('[click]');
    }
  });

  it('cannot be broken out of the href attribute', () => {
    // escapeHtml leaves quotes alone, so the attribute escape is the only thing standing here.
    const html = renderMarkdown('[x](https://a.test/")onmouseover="alert(1))');
    expect(html).not.toMatch(/href="[^"]*"\s*onmouseover/);
  });

  it('does not linkify a URL inside inline code', () => {
    const html = renderMarkdown('call `https://api.test/v1` directly');
    expect(html).toContain('<code>https://api.test/v1</code>');
    expect(html).not.toContain('<a ');
  });

  it('resolves a stashed fragment nested inside another', () => {
    // A link whose text is inline code nests one stash inside another. A single restore
    // pass leaves the inner marker in the output as a raw control character.
    const html = renderMarkdown('run [`GET /health`](https://api.test/health) first');
    expect(html).toContain('<code>GET /health</code></a>');
    expect(html).not.toContain(SENTINEL_CHAR);
  });

  it('renders an image, and rejects an unsafe one', () => {
    expect(renderMarkdown('![chart](https://x.test/c.png)')).toContain(
      '<img src="https://x.test/c.png" alt="chart" loading="lazy" class="md-img">',
    );
    expect(renderMarkdown('![x](javascript:alert(1))')).not.toContain('<img');
  });
});

describe('renderMarkdown — emphasis', () => {
  it('pairs each bold marker with its own partner', () => {
    // The regression: a lazy body backtracked through the closing ** and welded two spans.
    const html = renderMarkdown('**8**, `liveShare` = **0.059**');
    expect(html).toContain('<strong>8</strong>');
    expect(html).toContain('<strong>0.059</strong>');
    expect(html).not.toContain('<strong>8*');
  });

  it('allows a lone asterisk inside bold', () => {
    expect(renderMarkdown('**a *b* c**')).toContain('<strong>a <em>b</em> c</strong>');
  });

  it('never emphasises inside snake_case identifiers', () => {
    // 11% of real documents carry these; a naive _x_ rule mangles every one.
    for (const id of ['EA_VERSION_NUMERIC', '_ownershipGuard', 'a_b_c_d']) {
      const html = renderMarkdown(`the ${id} constant`);
      expect(html).toContain(id);
      expect(html).not.toContain('<em>');
    }
  });

  it('supports __bold__, _italic_ and ***bold italic***', () => {
    expect(renderMarkdown('__hard__ stop')).toContain('<strong>hard</strong>');
    expect(renderMarkdown('a _soft_ stop')).toContain('<em>soft</em>');
    expect(renderMarkdown('***both***')).toContain('<strong><em>both</em></strong>');
  });

  it('renders strikethrough', () => {
    expect(renderMarkdown('~~retired~~ now')).toContain('<del>retired</del>');
  });
});

describe('renderMarkdown — inline HTML allowlist', () => {
  it('re-enables bare formatting tags', () => {
    expect(renderMarkdown('one<br>two')).toContain('one<br>two');
    expect(renderMarkdown('a <b>bold</b> word')).toContain('<b>bold</b>');
  });

  it('keeps everything else escaped', () => {
    for (const bad of [
      '<script>alert(1)</script>',
      '<img src=x onerror=alert(1)>',
      '<br onload="alert(1)">',
      '<iframe></iframe>',
      '<div style="position:fixed">x</div>',
    ]) {
      const html = renderMarkdown(bad);
      // The tag itself must never be reconstituted. A handler NAME may survive as inert
      // text inside an escaped tag — that is harmless, and asserting on the tag rather
      // than the substring is what makes this test meaningful.
      expect(html).not.toMatch(/<(script|img|iframe|div|br\s)/);
      expect(html).toContain('&lt;');
    }
  });

  it('leaves a raw anchor escaped, even though its URL still autolinks', () => {
    // Worth pinning down: the <a> tag stays inert text, but the autolink rule then sees a
    // bare URL in that text and links it — the same thing it does for a URL in prose. The
    // anchor that results is ours, so it carries the scheme check and the rel guard.
    const html = renderMarkdown('<a href="https://evil.test">x</a>');
    expect(html).toContain('&lt;a href=');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).not.toContain('<a href="https://evil.test">x</a>');
  });
});

describe('renderMarkdown — blockquotes, tasks, footnotes, breaks', () => {
  it('renders a blockquote, with its inner markdown', () => {
    const html = renderMarkdown('> **note**: careful');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('<strong>note</strong>');
    expect(html).not.toContain('&gt; ');
  });

  it('renders task list checkboxes, checked and unchecked', () => {
    const html = renderMarkdown(['- [x] done', '- [ ] pending'].join('\n'));
    expect(html).toContain('<input type="checkbox" disabled checked>');
    expect(html).toContain('<input type="checkbox" disabled>');
    expect(html).not.toContain('[x]');
  });

  it('links a footnote reference to a definition collected at the end', () => {
    const html = renderMarkdown(['Claim.[^1]', '', '[^1]: The evidence.'].join('\n'));
    expect(html).toContain('<sup class="md-fnref" id="fnref-1"><a href="#fn-1">1</a></sup>');
    expect(html).toContain('<li id="fn-1">The evidence.');
  });

  it('slugifies a hostile footnote label before it reaches an id', () => {
    const html = renderMarkdown('x[^a"onmouseover=b]');
    expect(html).not.toContain('onmouseover=b"');
    expect(html).toContain('id="fnref-a-onmouseover-b"');
  });

  it('honours a hard line break from two trailing spaces', () => {
    expect(renderMarkdown('line one  \nline two')).toContain('line one<br>line two');
  });

  it('joins ordinary wrapped lines with a space, not a break', () => {
    expect(renderMarkdown('line one\nline two')).toBe('<p>line one line two</p>');
  });
});

describe('renderMarkdown — nested lists and setext headings', () => {
  it('nests an indented sub-list inside its parent item', () => {
    const html = renderMarkdown(['- parent', '  - child', '- sibling'].join('\n'));
    expect(html).toBe('<ul><li>parent<ul><li>child</li></ul></li><li>sibling</li></ul>');
  });

  it('nests an ordered list under a bulleted parent', () => {
    const html = renderMarkdown(['- parent', '  1. first'].join('\n'));
    expect(html).toContain('<li>parent<ol><li>first</li></ol></li>');
  });

  it('renders setext headings', () => {
    expect(renderMarkdown(['Title', '===='].join('\n'))).toBe('<h3>Title</h3>');
    expect(renderMarkdown(['Sub', '----'].join('\n'))).toBe('<h4>Sub</h4>');
  });

  it('still treats --- after a blank line as a rule, not a heading', () => {
    const html = renderMarkdown(['text', '', '---', '', 'more'].join('\n'));
    expect(html).toContain('<hr>');
    expect(html).not.toContain('<h4>');
  });

  it('renders an indented code block only outside lists and paragraphs', () => {
    expect(renderMarkdown(['    SELECT 1', '    FROM t'].join('\n'))).toContain(
      '<pre class="md-code"><code>SELECT 1\nFROM t</code></pre>',
    );
    // Inside a list the same indent is a continuation, not code.
    expect(renderMarkdown(['- item', '    continued'].join('\n'))).not.toContain('md-code');
  });
});

describe('renderMarkdown — code block affordances', () => {
  it('wraps a code block with a copy button', () => {
    const html = renderMarkdown(['```', 'SELECT 1', '```'].join('\n'));
    expect(html).toContain('<div class="md-code-wrap">');
    expect(html).toContain('<button type="button" class="md-copy" aria-label="Copy code">');
  });

  it('carries no code in the button, so nothing needs escaping twice', () => {
    const html = renderMarkdown(['```', 'a "quoted" <tag>', '```'].join('\n'));
    expect(html).not.toMatch(/<button[^>]*data-/);
  });
});

describe('renderMarkdown — ordered lists and rules', () => {
  it('renders numbered steps as an <ol>, not run-on prose', () => {
    // The regression from #24272: ten numbered steps joined with spaces into one <p>.
    const html = renderMarkdown(['1. Ownership check', '2. Heartbeat', '3. Filtering'].join('\n'));
    expect(html).toContain('<ol>');
    expect(html).toContain('<li>Ownership check</li>');
    expect(html).toContain('<li>Filtering</li>');
    expect(html).toContain('</ol>');
    expect(html).not.toContain('<p>');
  });

  it('accepts the 1) form as well as 1.', () => {
    expect(renderMarkdown('1) first')).toContain('<li>first</li>');
  });

  it('closes one list kind before opening the other', () => {
    const html = renderMarkdown(['- bullet', '1. numbered'].join('\n'));
    expect(html).toContain('</ul><ol>');
  });

  it('renders --- as a rule rather than literal text', () => {
    const html = renderMarkdown(['a', '', '---', '', 'b'].join('\n'));
    expect(html).toContain('<hr>');
    expect(html).not.toContain('<p>---</p>');
  });

  it('does not mistake a table separator for a rule', () => {
    const html = renderMarkdown(['| a |', '|---|', '| 1 |'].join('\n'));
    expect(html).toContain('<table>');
    expect(html).not.toContain('<hr>');
  });
});
