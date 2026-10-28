import { describe, expect, it } from 'vitest';

import {
  escapeHtml,
  inline,
  isSafeDocHtml,
  plainText,
  readingMinutes,
  renderMarkdown,
  slugify,
} from './markdown';

const html = (md: string) => renderMarkdown(md).html;

describe('docs markdown', () => {
  it('never lets raw HTML through', () => {
    const out = html('Hello <script>alert(1)</script> <img src=x onerror=alert(1)>');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;script&gt;');
    expect(isSafeDocHtml(out)).toBe(true);
  });

  it('keeps only safe links', () => {
    expect(
      inline(
        escapeHtml('[ok](https://example.com) [site](/docs/admin) [bad](javascript:alert(1))'),
      ),
    ).toBe(
      '<a href="https://example.com" target="_blank" rel="noopener noreferrer">ok</a> <a href="/docs/admin">site</a> [bad](javascript:alert(1))',
    );
  });

  it('renders headings with unique ids, lists, code, tables and notes', () => {
    const { html: out, headings } = renderMarkdown(
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
    expect(out).toContain(
      '<ul><li><strong>bold</strong> and <code>code &lt;b&gt;</code></li><li>second</li></ul>',
    );
    expect(out).toContain('<ol class="steps"><li>first</li><li>second</li></ol>');
    expect(out).toContain('<pre><code>&lt;not html&gt;</code></pre>');
    expect(out).toContain('<td><code>Demo:Enabled</code></td>');
    expect(out).toContain('<blockquote><p>Note <em>this</em>.</p></blockquote>');
  });

  it('makes anchor ids from text', () => {
    expect(slugify('Allow-list & error 4060')).toBe('allow-list-error-4060');
  });

  it('nests content under a step: text, a picture and a sub-list', () => {
    const out = html(
      [
        '1. Open **Settings**.',
        '',
        '   ![The settings page](settings-page "/settings")',
        '',
        '   - first option',
        '   - second option',
        '2. Save.',
      ].join('\n'),
    );
    expect(out).toMatch(/^<ol class="steps"><li><p>Open <strong>Settings<\/strong>.<\/p>/);
    expect(out).toContain('<figure class="shot framed">');
    expect(out).toContain(
      '<ul><li>first option</li><li>second option</li></ul></li><li>Save.</li></ol>',
    );
  });

  it('continues a numbered list from its first number', () => {
    expect(html('3. three\n4. four')).toContain(
      '<ol class="steps" start="3" style="counter-reset: step 2">',
    );
  });

  it('draws checklists', () => {
    expect(html('- [x] done\n- [ ] to do')).toBe(
      '<ul class="checklist"><li class="done">done</li><li class="todo">to do</li></ul>',
    );
  });

  it('renders callouts with their own icon and an optional title', () => {
    const out = html('> [!WARNING] Real money\n> This places a **live** order.');
    expect(out).toContain('<aside class="callout warning"><svg class="callout-icon"');
    expect(out).toContain(
      '<p class="callout-title">Real money</p><p>This places a <strong>live</strong> order.</p>',
    );
    expect(html('> [!TIP]\n> Short.')).toContain('<p class="callout-title">Tip</p>');
    // An unknown kind is just a quote.
    expect(html('> [!WHATEVER] x')).toContain('<blockquote>');
  });

  it('renders screenshots for both themes, or one file, and refuses odd names', () => {
    const both = html('![The chart, with ((1)) the symbol](chart-overview "/chart-analysis")');
    expect(both).toContain('src="docs-content/img/chart-overview.light.webp"');
    expect(both).toContain('src="docs-content/img/chart-overview.dark.webp"');
    expect(both).toContain('<span class="addr">/chart-analysis</span>');
    expect(both).toContain('alt="The chart, with 1 the symbol"');
    expect(both).toContain(
      '<figcaption>The chart, with <span class="marker" aria-label="marker 1">1</span> the symbol</figcaption>',
    );
    expect(html('![Flow](how-it-works.svg)')).toContain('src="docs-content/img/how-it-works.svg"');
    expect(html('![x](../secret)')).toBe('<p>x</p>');
    expect(html('![x](https://evil.example/a.png)')).toBe('<p>x</p>');
    expect(html('![x"onerror="y](ok)')).toContain('alt="x&quot;onerror=&quot;y"');
  });

  it('renders flow, stack, decide and cards diagrams with escaped text', () => {
    const flow = html(
      [
        '```flow',
        'Sign up | Make an <b>account</b> | user',
        '-> then',
        'Trade',
        '@caption How it goes',
        '```',
      ].join('\n'),
    );
    expect(flow).toContain('<figure class="dg dg-flow">');
    expect(flow).toContain(
      '<strong>Sign up</strong><span>Make an &lt;b&gt;account&lt;/b&gt;</span>',
    );
    expect(flow).toContain('<span class="dg-arrow-label">then</span>');
    expect(flow).toContain('<span class="dg-badge num">2</span>');
    expect(flow).toContain('<figcaption class="dg-caption">How it goes</figcaption>');

    expect(html('```stack\nBrowser\nEngine\n```')).toContain('<figure class="dg dg-stack">');

    const decide = html('```decide\nIs it green?\nYes: carry on\nNo: see **Fixes**\n```');
    expect(decide).toContain('<strong>Is it green?</strong>');
    expect(decide).toContain('<div class="dg-branch yes">');
    expect(decide).toContain('<div class="dg-branch no">');
    expect(decide).toContain('see <strong>Fixes</strong>');

    const cards = html(
      '```cards\nplug | Connect | Add a terminal | /docs/ea-install\nx | Bad | link | javascript:alert(1)\n```',
    );
    expect(cards).toContain('<a class="dg-card" href="/docs/ea-install">');
    expect(cards).not.toContain('javascript:');
  });

  it('formats keys, on-screen labels, markers and chips', () => {
    expect(
      inline(escapeHtml('Press [[Shift]] then {{Save}} at ((2)) — :ok[Connected] :nope[x]')),
    ).toBe(
      'Press <kbd>Shift</kbd> then <span class="ui-label">Save</span> at <span class="marker" aria-label="marker 2">2</span> — <span class="chip ok">Connected</span> :nope[x]',
    );
  });

  it('renders FAQ drop-downs and keeps their headings out of the contents', () => {
    const { html: out, headings } = renderMarkdown(
      '## Problems\n?? Why is it red?\n   Because the **EA** is off.\n\n   - check one\n?? Another?\n   Yes.',
    );
    expect(out).toContain(
      '<details class="faq"><summary>Why is it red?</summary><div class="faq-body"><p>Because the <strong>EA</strong> is off.</p>',
    );
    expect(out).toContain('<summary>Another?</summary>');
    expect(headings.map((h) => h.id)).toEqual(['problems']);
  });

  it('only trusts its own tags and attributes', () => {
    expect(
      isSafeDocHtml('<p class="x">ok</p><svg viewBox="0 0 24 24"><path d="M0"></path></svg>'),
    ).toBe(true);
    expect(isSafeDocHtml('<script>1</script>')).toBe(false);
    expect(isSafeDocHtml('<p onclick="x">1</p>')).toBe(false);
    expect(isSafeDocHtml('<a href="javascript:x">1</a>')).toBe(false);
    expect(isSafeDocHtml('<p style="background:url(x)">1</p>')).toBe(false);
    expect(isSafeDocHtml('<iframe src="/x"></iframe>')).toBe(false);
  });

  it('counts plain words for search and reading time', () => {
    expect(plainText('## Hi\n**Bold** [link](/x) `code`\n```flow\nA | b\n```')).toBe(
      'Hi Bold link code',
    );
    expect(readingMinutes('word '.repeat(1000))).toBe(5);
    expect(readingMinutes('short')).toBe(1);
  });
});
