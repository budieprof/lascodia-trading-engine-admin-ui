import { Pipe, PipeTransform, inject } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';

/**
 * Minimal, dependency-free markdown → sanitized HTML for the LLM narrative
 * blocks (spot analysis, rationales, etc.). Deliberately supports only the
 * subset the models emit — ATX and setext headings, bold, italics, bold-italic,
 * strikethrough, inline code, fenced and indented code blocks, unordered/ordered/
 * nested/task lists, blockquotes, horizontal rules, links, bare-URL autolinks,
 * images, footnotes, hard line breaks, GFM pipe tables and blank-line paragraphs.
 *
 * Security: the raw text is HTML-escaped FIRST, so any `<script>` etc. in the
 * model output is neutralised before we insert our own controlled tags. Only
 * then is the result trusted for [innerHTML]. No third-party markdown lib.
 *
 * There is no raw HTML pass-through. The one exception is a fixed allowlist of
 * BARE formatting tags (<br>, <b>, <em>, …) with no attributes, re-enabled after
 * escaping — see the rule at the end of inline(). This matters because these
 * pages render text the models derive from third-party sources (news articles,
 * broker copy), so the input is not fully trusted even though it arrives via our
 * own engine. Anything carrying an attribute stays escaped.
 */
@Pipe({ name: 'markdown', standalone: true })
export class MarkdownPipe implements PipeTransform {
  private readonly sanitizer = inject(DomSanitizer);

  transform(value: string | null | undefined): SafeHtml {
    if (!value) return '';
    return this.sanitizer.bypassSecurityTrustHtml(renderMarkdown(value));
  }
}

/**
 * Markdown → sanitized HTML string. Exported separately from the pipe so the
 * rendering rules can be tested directly, without a TestBed or a DomSanitizer.
 * Escaping happens here, so every caller gets the same guarantee the pipe does.
 */
export function renderMarkdown(value: string): string {
  return render(escapeHtml(value));
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * A GFM table separator: the `|---|:---:|---:|` line that must sit directly
 * under the header row. Requires at least one dash per cell, so a stray line
 * of pipes is not mistaken for one.
 */
const TABLE_SEPARATOR = /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/;

/** Opening or closing fence of a code block: ``` or ~~~, with an optional language tag. */
const FENCE = /^(?:```|~~~)\s*([A-Za-z0-9_+-]*)\s*$/;

/**
 * A thematic break on its own line. Kept separate from the table separator above,
 * which is only ever consumed as part of a table and so never reaches this test.
 */
const HORIZONTAL_RULE = /^(?:-{3,}|_{3,}|\*{3,})$/;

/** `1.` / `2)` — an ordered-list marker, capturing the item text. */
const ORDERED_ITEM = /^\d+[.)]\s+(.*)$/;

/** `[ ]` / `[x]` at the head of a list item — a GFM task-list checkbox. */
const TASK_ITEM = /^\[([ xX])\]\s+(.*)$/;

/**
 * Marks an explicit line break (two trailing spaces, or a trailing backslash) while lines
 * are still being accumulated into a paragraph. A control character rather than a literal
 * `<br>` so the inline rules cannot mistake it for text, and it is stripped from anything
 * that does not become a paragraph.
 */
const HARD_BREAK = '\u0001';

/** Leading whitespace as a column count, tabs counted as four. Drives list nesting. */
function indentOf(line: string): number {
  return (/^[ \t]*/.exec(line)?.[0] ?? '').replace(/\t/g, '    ').length;
}

/** Split one `| a | b |` row into trimmed cells, tolerating optional outer pipes. */
function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

/** Per-column alignment from the separator row: `:--` left, `:-:` centre, `--:` right. */
function columnAlignments(separator: string): (string | null)[] {
  return splitRow(separator).map((cell) => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return null;
  });
}

/** Only ever emits one of three fixed values — no model text reaches the style attribute. */
function alignAttr(align: string | null): string {
  return align ? ` style="text-align:${align}"` : '';
}

/**
 * Links are the only rule that puts model text into an ATTRIBUTE rather than between
 * tags, so it is the only one that can escape the "escape everything first" guarantee.
 * Two independent limits: the scheme must be http/https (blocks `javascript:`, `data:`,
 * and protocol-relative `//host`), and the value is attribute-escaped on the way out —
 * escapeHtml deliberately leaves quotes alone, which would otherwise close the attribute.
 */
const SAFE_URL = /^https?:\/\/[^\s]+$/i;

function attrEscape(url: string): string {
  return url.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function anchor(href: string, text: string): string {
  return `<a href="${attrEscape(href)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
}

/**
 * Parks generated HTML out of reach of the later inline rules. NUL cannot occur in the
 * input: escapeHtml cannot produce it and Postgres rejects it in text columns.
 */
const SENTINEL = '\u0000';

/** Trailing sentence punctuation that a bare URL should not swallow. */
const URL_TAIL = /[.,;:!?)\]]+$/;

/**
 * A footnote label reaches an `id`/`href`, so it is reduced to a conservative slug rather
 * than trusted. Anything outside [A-Za-z0-9_-] becomes a dash.
 */
function footnoteId(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_-]/g, '-');
}

/**
 * A fenced or indented code block, wrapped with a copy affordance. Code blocks are the most
 * common construct the models emit (61% of documents), and an ASCII diagram or a SQL snippet
 * is usually something the reader wants OUT of the page — selecting it by hand out of a
 * scrolling box is the fiddliest thing in the transcript.
 *
 * The button carries no data: MarkdownCopyDirective reads the sibling <pre>'s textContent,
 * so the code never has to survive a second round of attribute escaping.
 */
function codeBlock(body: string, lang: string): string {
  return (
    `<div class="md-code-wrap">` +
    `<button type="button" class="md-copy" aria-label="Copy code">Copy</button>` +
    `<pre class="md-code"><code${lang}>${body}</code></pre>` +
    `</div>`
  );
}

/**
 * Inline transforms applied within a text run (already HTML-escaped).
 *
 * Emitted HTML is parked in `slots` behind a NUL sentinel as soon as it is produced, so
 * later rules cannot match inside it — without that, the autolink rule linkifies a URL
 * that the code rule had already placed inside a <code> span, and the emphasis rules
 * chew on the markup of both. NUL cannot occur in the input: it is not producible by
 * escapeHtml and Postgres rejects it in text columns.
 */
function inline(s: string): string {
  const slots: string[] = [];
  const stash = (html: string): string => `${SENTINEL}${slots.push(html) - 1}${SENTINEL}`;

  const out = s
    // Code first: its contents are literal, so nothing inside may be linkified or emphasised.
    .replace(/`([^`]+)`/g, (_m, code: string) => stash(`<code>${code}</code>`))
    // Footnote reference. Before the link rules, which would otherwise see the brackets.
    .replace(/\[\^([^\]\s]+)\]/g, (_m, id: string) => {
      const slug = footnoteId(id);
      return stash(
        `<sup class="md-fnref" id="fnref-${slug}"><a href="#fn-${slug}">${id}</a></sup>`,
      );
    })
    // Images before links: they share the bracket syntax and differ only by the leading !.
    .replace(/!\[([^\]]*)\]\(([^()\s]+)\)/g, (whole, alt: string, url: string) =>
      SAFE_URL.test(url)
        ? stash(
            `<img src="${attrEscape(url)}" alt="${attrEscape(alt)}" loading="lazy" class="md-img">`,
          )
        : whole,
    )
    // [text](url) — an unsafe or malformed URL is left as the literal text it was.
    .replace(/\[([^\]\n]+)\]\(([^()\s]+)\)/g, (whole, text: string, url: string) =>
      SAFE_URL.test(url) ? stash(anchor(url, text)) : whole,
    )
    // Bare URLs. Quotes and angle brackets are excluded from the match so a URL can never
    // reach attrEscape carrying an attribute terminator.
    .replace(/https?:\/\/[^\s<>"']+/gi, (url: string) => {
      const tail = URL_TAIL.exec(url)?.[0] ?? '';
      const link = tail ? url.slice(0, -tail.length) : url;
      return SAFE_URL.test(link) ? stash(anchor(link, link)) + tail : url;
    })
    .replace(/~~(?=\S)((?:[^~]|~(?!~))+?)~~/g, '<del>$1</del>')
    // Triple markers first, else the bold rule below claims two of the three asterisks.
    .replace(/\*\*\*(?=\S)([^*]+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/___(?=\S)([^_]+?)___/g, '<strong><em>$1</em></strong>')
    // Bold. The body admits a LONE asterisk but never a `**`, so `**a *b* c**` matches whole
    // while `**8**, x = **0.059**` still pairs each marker with its own partner. A plain lazy
    // `.*?` is not enough: its optional tail backtracks straight through the closing `**` and
    // welds two separate bold spans into one.
    .replace(/\*\*(?=\S)((?:[^*]|\*(?!\*))+?)\*\*/g, '<strong>$1</strong>')
    // italics: single * not adjacent to another * (avoid eating bold markers)
    .replace(/(^|[^*])\*(?!\s)([^*]+?)\*(?!\*)/g, '$1<em>$2</em>')
    // Underscore emphasis is INTRAWORD-SAFE by construction. 11% of real documents contain
    // snake_case identifiers (EA_VERSION_NUMERIC, _ownershipGuard) against ONE genuine use
    // of _italics_, so the boundary guards matter far more than the feature: a marker may
    // not touch a word character on either side.
    .replace(/(^|[^\w\\])__(?=\S)((?:[^_]|_(?!_))+?)__(?!\w)/g, '$1<strong>$2</strong>')
    .replace(/(^|[^\w\\_])_(?!_)([^_\n]*[^_\s])_(?!\w)/g, '$1<em>$2</em>')
    // A deliberately tiny inline-HTML allowlist: bare formatting tags, no attributes, fixed
    // set. Everything else — anything carrying an attribute, and every unlisted tag — stays
    // escaped, so this cannot become the raw-HTML pass-through this file forbids.
    .replace(
      /&lt;(\/?)(br|b|i|u|s|em|strong|code|sub|sup|mark|small)\s*\/?&gt;/gi,
      (_m, slash: string, tag: string) => `<${slash}${tag.toLowerCase()}>`,
    );

  // Split rather than a regex: a control character in a pattern is both an eslint error
  // (no-control-regex) and needlessly clever. Sentinels are always emitted in balanced
  // pairs, so every odd-indexed part is a slot number.
  //
  // Looped because a stashed fragment can itself hold an earlier sentinel — a link whose
  // text was inline code nests one stash inside another, and a single pass would leave the
  // inner marker sitting in the output as a raw control character.
  let resolved = out;
  for (let pass = 0; pass < 5 && resolved.includes(SENTINEL); pass++) {
    resolved = resolved
      .split(SENTINEL)
      .map((part, i) => (i % 2 === 1 ? slots[Number(part)] : part))
      .join('');
  }
  return resolved;
}

function render(escaped: string): string {
  const lines = escaped.split('\n');
  const html: string[] = [];
  // Open lists, outermost first. A stack rather than a single tag because sub-bullets are
  // indented under their parent: with one flat list they collapsed to the same level, and
  // the tag is per-frame so an ordered child inside a bulleted parent closes correctly.
  // `liOpen` is what lets a nested <ul> be emitted INSIDE its parent's <li>, which is
  // where valid HTML requires it.
  const stack: { tag: 'ul' | 'ol'; indent: number; liOpen: boolean }[] = [];
  let paragraph: string[] = [];
  // Definitions are gathered as they are met and emitted once at the end, so a reference
  // near the top still resolves to a note the reader can find in one place.
  const footnotes: { id: string; text: string }[] = [];
  let quote: string[] = [];

  const flushQuote = () => {
    if (quote.length === 0) return;
    html.push(`<blockquote>${render(quote.join('\n'))}</blockquote>`);
    quote = [];
  };
  const flushParagraph = () => {
    flushQuote();
    if (paragraph.length === 0) return;
    // Lines are joined with a space; where one asked for a hard break, that space belongs to
    // the <br> instead — otherwise every explicit break starts the next line with a stray gap.
    const text = inline(paragraph.join(' '))
      .split(HARD_BREAK)
      .map((part, i) => (i === 0 ? part : part.replace(/^ /, '')))
      .join('<br>');
    html.push(`<p>${text}</p>`);
    paragraph = [];
  };
  const closeLi = (frame: { liOpen: boolean }) => {
    if (frame.liOpen) {
      html.push('</li>');
      frame.liOpen = false;
    }
  };
  const closeList = () => {
    while (stack.length) {
      const frame = stack.pop()!;
      closeLi(frame);
      html.push(`</${frame.tag}>`);
    }
  };
  const listItem = (indent: number, tag: 'ul' | 'ol', text: string) => {
    // Unwind any frames deeper than this item. The outermost frame is never popped here:
    // a dedent past it is still the same list, just inconsistently indented by the model.
    while (stack.length > 1 && indent < stack[stack.length - 1].indent) {
      const frame = stack.pop()!;
      closeLi(frame);
      html.push(`</${frame.tag}>`);
    }

    const top = stack[stack.length - 1];
    if (!top || indent > top.indent) {
      // Deeper (or the first list): open a child list. When there is a parent its <li> is
      // deliberately left open, so this nests inside it.
      html.push(`<${tag}>`);
      stack.push({ tag, indent, liOpen: false });
    } else {
      closeLi(top);
      if (top.tag !== tag) {
        stack.pop();
        html.push(`</${top.tag}>`);
        html.push(`<${tag}>`);
        stack.push({ tag, indent, liOpen: false });
      }
    }

    // A task item keeps its checkbox but loses the `[ ]` from the text. Rendered disabled:
    // it reflects the model's state, it is not a control the operator can toggle.
    const task = TASK_ITEM.exec(text);
    const body = task
      ? `<input type="checkbox" disabled${task[1] === ' ' ? '' : ' checked'}> ${inline(task[2])}`
      : inline(text);
    html.push(`<li${task ? ' class="md-task"' : ''}>${body}`);
    stack[stack.length - 1].liOpen = true;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd();
    const trimmed = line.trim();

    // Fenced code block. FIRST, before every other branch: its body must reach the
    // output verbatim. Left to the paragraph branch below, an ASCII diagram was joined
    // with spaces into one unreadable line and inline() then matched its backticks
    // across the fence, wrapping the flattened diagram in a stray <code> span.
    const fence = FENCE.exec(trimmed);
    if (fence) {
      flushParagraph();
      closeList();

      const body: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i].trim())) {
        body.push(lines[i]);
        i++;
      }
      // An unterminated fence runs to the end of the text; i is then lines.length and the
      // loop ends naturally. A closing fence is consumed by leaving i on it.

      // The language tag is echoed as a class, so it must be a bare identifier — FENCE's
      // character class already guarantees that, and the body is pre-escaped upstream.
      const lang = fence[1] ? ` class="language-${fence[1]}"` : '';
      html.push(codeBlock(body.join('\n'), lang));
      continue;
    }

    if (trimmed.length === 0) {
      flushParagraph();
      closeList();
      continue;
    }

    // Blockquote. `>` is already `&gt;` by this point — matching the raw character here
    // would silently never fire. Lines are gathered and the body rendered recursively, so
    // a quote can hold its own lists, emphasis and code.
    const quoted = /^&gt;\s?(.*)$/.exec(trimmed);
    if (quoted) {
      if (paragraph.length) flushParagraph();
      closeList();
      quote.push(quoted[1]);
      continue;
    }
    flushQuote();

    // Indented code block: four spaces, but ONLY when nothing else is open. Inside a list
    // that same indent is a continuation line, and after a paragraph it is a wrapped line —
    // treating either as code would be a regression in the common case to serve a rare one.
    if (paragraph.length === 0 && stack.length === 0 && /^(?: {4}|\t)\S/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && (/^(?: {4}|\t)/.test(lines[i]) || lines[i].trim() === '')) {
        if (lines[i].trim() === '' && !/^(?: {4}|\t)/.test(lines[i + 1] ?? '')) break;
        body.push(lines[i].replace(/^(?: {4}|\t)/, ''));
        i++;
      }
      i--;
      html.push(codeBlock(body.join('\n'), ''));
      continue;
    }

    // Setext heading: === or --- directly under a text line. Checked BEFORE the rule branch
    // because `---` means both, and the paragraph above decides which. Measured safe: across
    // 992 real documents there was not one `---` sitting directly under text, so this cannot
    // silently convert an existing separator into a heading.
    const setext = /^(=+|-+)$/.exec(trimmed);
    if (setext && paragraph.length > 0) {
      const text = paragraph.pop()!;
      flushParagraph();
      const level = setext[1][0] === '=' ? 3 : 4;
      html.push(`<h${level}>${inline(text)}</h${level}>`);
      continue;
    }

    // A rule closes whatever came before it and stands alone. Checked before the bullet
    // branch: `---` is not a bullet (that needs trailing whitespace) but is close enough
    // to warrant the explicit ordering.
    if (HORIZONTAL_RULE.test(trimmed)) {
      flushParagraph();
      closeList();
      html.push('<hr>');
      continue;
    }

    // Footnote definition: `[^1]: text`. Collected rather than emitted inline so every
    // definition lands together at the end, which is where a reader expects them.
    const footnote = /^\[\^([^\]]+)\]:\s*(.*)$/.exec(trimmed);
    if (footnote) {
      flushParagraph();
      closeList();
      footnotes.push({ id: footnote[1], text: footnote[2] });
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flushParagraph();
      closeList();
      // Map #→h3, ##→h4, ###+→h5 so headings sit sensibly inside a modal.
      const level = Math.min(heading[1].length + 2, 5);
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }

    // GFM pipe table. Without this the rows fell through to the paragraph
    // branch below and were joined with spaces into one unreadable line —
    // every table the models emit rendered as pipe soup.
    if (
      trimmed.startsWith('|') &&
      i + 1 < lines.length &&
      TABLE_SEPARATOR.test(lines[i + 1].trim())
    ) {
      flushParagraph();
      closeList();

      const header = splitRow(trimmed);
      const aligns = columnAlignments(lines[i + 1].trim());
      i += 2;

      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        rows.push(splitRow(lines[i].trim()));
        i++;
      }
      i--; // the for-loop's ++ consumes the first non-row line

      const head = header
        .map((cell, c) => `<th${alignAttr(aligns[c] ?? null)}>${inline(cell)}</th>`)
        .join('');

      // Pad or truncate every body row to the header width, so a ragged table
      // from the model still produces well-formed HTML.
      const body = rows
        .map((row) => {
          const cells: string[] = [];
          for (let c = 0; c < header.length; c++) {
            cells.push(`<td${alignAttr(aligns[c] ?? null)}>${inline(row[c] ?? '')}</td>`);
          }
          return `<tr>${cells.join('')}</tr>`;
        })
        .join('');

      // Wrapped so a wide table scrolls inside the bubble instead of forcing
      // the whole chat panel to scroll sideways.
      html.push(
        `<div class="md-table-wrap"><table><thead><tr>${head}</tr></thead>` +
          `<tbody>${body}</tbody></table></div>`,
      );
      continue;
    }

    const bullet = /^[-*+]\s+(.*)$/.exec(trimmed);
    if (bullet) {
      flushParagraph();
      listItem(indentOf(line), 'ul', bullet[1]);
      continue;
    }

    // Ordered list. Without this the numbered steps the models love ("1. … 2. …") fell
    // through to the paragraph branch and were joined with spaces into run-on prose.
    const ordered = ORDERED_ITEM.exec(trimmed);
    if (ordered) {
      flushParagraph();
      listItem(indentOf(line), 'ol', ordered[1]);
      continue;
    }

    // Plain text line — accumulate into the current paragraph. Two trailing spaces or a
    // trailing backslash request an explicit break; `line` has been trimEnd()'d, so the
    // raw line is the only thing still carrying that signal.
    closeList();
    paragraph.push(
      /(?: {2}|\\)$/.test(lines[i]) ? trimmed.replace(/\\$/, '') + HARD_BREAK : trimmed,
    );
  }

  flushParagraph();
  closeList();

  if (footnotes.length) {
    html.push('<hr class="md-fn-rule"><ol class="md-footnotes">');
    for (const f of footnotes) {
      const id = footnoteId(f.id);
      html.push(
        `<li id="fn-${id}">${inline(f.text)} <a href="#fnref-${id}" aria-label="Back to reference">↩</a></li>`,
      );
    }
    html.push('</ol>');
  }
  return html.join('');
}
