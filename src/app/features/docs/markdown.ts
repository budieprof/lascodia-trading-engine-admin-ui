/**
 * A small, safe Markdown renderer for the documentation portal's own guides (`public/docs-content/*.md`).
 * Everything is HTML-escaped FIRST, then a fixed subset is turned into tags. No raw HTML passes through:
 * every tag below is built here from escaped text, and every attribute value is escaped or fixed.
 *
 * Blocks: headings (#–####, with ids), paragraphs, bullet / numbered lists (nested by indenting two
 * spaces; numbered lists draw as steps; `[ ]` / `[x]` items as a checklist), fenced code, pipe tables,
 * `---` rules, `>` quotes, callouts (`> [!TIP] Optional title` — NOTE, TIP, WARNING, DANGER, SUCCESS,
 * SUMMARY), FAQ drop-downs (`?? Question` + an indented answer), screenshots
 * (`![Caption](name "/page-address")`) and diagrams (fenced `flow`, `stack`, `decide`, `cards`).
 *
 * Inline: `code`, **bold**, *italic*, links (http(s), site-relative `/…` or `#anchor` only — anything
 * else stays text), `[[Shift]]` keys, `{{Save}}` on-screen buttons and labels, `((2))` numbered markers
 * that match the numbers drawn on a screenshot, and status chips `:ok[Connected]` (ok / warn / bad /
 * info / muted).
 */
import { DOC_ICONS, type DocIconName } from './docs-icons';

export interface DocHeading {
  level: number;
  text: string;
  id: string;
}

/** Where screenshots live inside a release (`public/docs-content/img/`). */
export const DOCS_IMG_BASE = 'docs-content/img';

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** A heading's anchor id: lowercase words joined by dashes. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/&[a-z#0-9]+;/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function safeHref(raw: string): string | null {
  const href = raw.trim();
  if (/^https?:\/\//i.test(href) || href.startsWith('/') || href.startsWith('#')) return href;
  return null;
}

/** An icon from the fixed docs set as inline SVG (unknown names draw nothing). */
export function iconSvg(name: string, cls = 'dg-ico'): string {
  const icon = DOC_ICONS[name as DocIconName];
  if (!icon) return '';
  const children = icon.node
    .map(([tag, attrs]) => {
      const a = Object.entries(attrs)
        .filter(([k]) => k !== 'key')
        .map(([k, v]) => `${escapeHtml(k)}="${escapeHtml(String(v))}"`)
        .join(' ');
      return `<${escapeHtml(tag)} ${a}></${escapeHtml(tag)}>`;
    })
    .join('');
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${children}</svg>`;
}

const CHIP_TONES = new Set(['ok', 'warn', 'bad', 'info', 'muted']);

/** Inline formatting on ALREADY-ESCAPED text. Code spans are protected from the other rules. */
export function inline(escaped: string): string {
  const codes: string[] = [];
  let s = escaped.replace(/`([^`]+)`/g, (_, c: string) => {
    codes.push(`<code>${c}</code>`);
    return `${codes.length - 1}`;
  });
  s = s.replace(/\[\[([^\]\n]{1,24})\]\]/g, '<kbd>$1</kbd>');
  s = s.replace(/\{\{([^}\n]{1,60})\}\}/g, '<span class="ui-label">$1</span>');
  s = s.replace(/\(\((\d{1,2})\)\)/g, '<span class="marker" aria-label="marker $1">$1</span>');
  s = s.replace(/:([a-z]+)\[([^\]\n]{1,40})\]/g, (whole, tone: string, text: string) =>
    CHIP_TONES.has(tone) ? `<span class="chip ${tone}">${text}</span>` : whole,
  );
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, text: string, href: string) => {
    const safe = safeHref(href.replace(/&amp;/g, '&'));
    if (!safe) return whole;
    const external = /^https?:/i.test(safe);
    return `<a href="${escapeHtml(safe)}"${external ? ' target="_blank" rel="noopener noreferrer"' : ''}>${text}</a>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  return s.replace(/(\d+)/g, (_, i: string) => codes[Number(i)]);
}

const fmt = (raw: string) => inline(escapeHtml(raw));

function tableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

// ---------------------------------------------------------------------------------------------
// Screenshots

/** A screenshot name: `chart-overview` (both themes) or `diagram.svg` (one file). */
const IMG_NAME = /^[a-z0-9][a-z0-9._-]{0,80}$/;
const IMG_EXT = /\.(png|jpe?g|webp|svg)$/;

export function figure(caption: string, name: string, address: string | undefined): string {
  if (!IMG_NAME.test(name) || name.includes('..')) return `<p>${fmt(caption)}</p>`;
  const alt = escapeHtml(caption.replace(/[*`[\]{}()]/g, ''));
  const one = (file: string, cls: string) =>
    `<img class="${cls}" src="${DOCS_IMG_BASE}/${escapeHtml(file)}" alt="${alt}" loading="lazy" decoding="async" />`;
  const imgs = IMG_EXT.test(name)
    ? one(name, 'shot-img')
    : one(`${name}.light.webp`, 'shot-img theme-light') +
      one(`${name}.dark.webp`, 'shot-img theme-dark');
  const chrome = address
    ? `<span class="shot-chrome" aria-hidden="true"><span class="dots"><i></i><i></i><i></i></span><span class="addr">${escapeHtml(address)}</span></span>`
    : '';
  return `<figure class="shot${address ? ' framed' : ''}"><button type="button" class="shot-zoom" title="Click to enlarge">${chrome}${imgs}</button><figcaption>${fmt(caption)}</figcaption></figure>`;
}

// ---------------------------------------------------------------------------------------------
// Diagrams

interface DiagramNode {
  title: string;
  text: string;
  icon: string;
  link: string;
  arrow: string;
}

/** `Title | text | icon` lines (cards: `icon | Title | text | /link`); `-> label` labels the next arrow. */
function diagramNodes(lines: string[], cards: boolean): { nodes: DiagramNode[]; caption: string } {
  const nodes: DiagramNode[] = [];
  let caption = '';
  let arrow = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('@caption ')) {
      caption = line.slice(9).trim();
      continue;
    }
    if (line.startsWith('->')) {
      arrow = line.slice(2).trim();
      continue;
    }
    const parts = line.split('|').map((p) => p.trim());
    nodes.push(
      cards
        ? {
            icon: parts[0],
            title: parts[1] ?? '',
            text: parts[2] ?? '',
            link: parts[3] ?? '',
            arrow,
          }
        : { title: parts[0], text: parts[1] ?? '', icon: parts[2] ?? '', link: '', arrow },
    );
    arrow = '';
  }
  return { nodes, caption };
}

const capt = (caption: string) =>
  caption ? `<figcaption class="dg-caption">${fmt(caption)}</figcaption>` : '';

function diagramFlow(kind: 'flow' | 'stack', lines: string[]): string {
  const { nodes, caption } = diagramNodes(lines, false);
  const numbered = kind === 'flow';
  const body = nodes
    .map((n, i) => {
      const arrow =
        i === 0
          ? ''
          : `<div class="dg-arrow" aria-hidden="true"><span class="dg-arrow-line"></span>${n.arrow ? `<span class="dg-arrow-label">${fmt(n.arrow)}</span>` : ''}</div>`;
      const badge = n.icon
        ? `<span class="dg-badge">${iconSvg(n.icon)}</span>`
        : numbered
          ? `<span class="dg-badge num">${i + 1}</span>`
          : '';
      return `${arrow}<div class="dg-node" role="listitem">${badge}<div class="dg-body"><strong>${fmt(n.title)}</strong>${n.text ? `<span>${fmt(n.text)}</span>` : ''}</div></div>`;
    })
    .join('');
  return `<figure class="dg dg-${kind}"><div class="dg-track" role="list">${body}</div>${capt(caption)}</figure>`;
}

/** First line the question; each `Answer: what to do` line a branch. */
function diagramDecide(lines: string[]): string {
  let caption = '';
  const content = lines
    .map((l) => l.trim())
    .filter((l) => {
      if (l.startsWith('@caption ')) caption = l.slice(9).trim();
      return l && !l.startsWith('@caption ');
    });
  const [question, ...branches] = content;
  const items = branches
    .map((b) => {
      const at = b.indexOf(':');
      const answer = at > 0 ? b.slice(0, at).trim() : b;
      const outcome = at > 0 ? b.slice(at + 1).trim() : '';
      const tone = /^(yes|ok|green|done|it works)/i.test(answer)
        ? 'yes'
        : /^(no|red|fails?|error|not)/i.test(answer)
          ? 'no'
          : 'other';
      return `<div class="dg-branch ${tone}"><span class="dg-branch-line" aria-hidden="true"></span><span class="dg-answer">${fmt(answer)}</span><div class="dg-outcome">${fmt(outcome)}</div></div>`;
    })
    .join('');
  return `<figure class="dg dg-decide"><div class="dg-question">${iconSvg('circle-help')}<strong>${fmt(question ?? '')}</strong></div><div class="dg-branches">${items}</div>${capt(caption)}</figure>`;
}

function diagramCards(lines: string[]): string {
  const { nodes, caption } = diagramNodes(lines, true);
  const cards = nodes
    .map((n) => {
      const href = n.link ? safeHref(n.link) : null;
      const inner = `<span class="dg-card-icon">${iconSvg(n.icon)}</span><strong>${fmt(n.title)}</strong>${n.text ? `<span>${fmt(n.text)}</span>` : ''}`;
      return href
        ? `<a class="dg-card" href="${escapeHtml(href)}">${inner}<span class="dg-card-go" aria-hidden="true">→</span></a>`
        : `<div class="dg-card">${inner}</div>`;
    })
    .join('');
  return `<figure class="dg dg-cards"><div class="dg-card-grid">${cards}</div>${capt(caption)}</figure>`;
}

const DIAGRAMS: Record<string, (lines: string[]) => string> = {
  flow: (l) => diagramFlow('flow', l),
  stack: (l) => diagramFlow('stack', l),
  decide: diagramDecide,
  cards: diagramCards,
};

// ---------------------------------------------------------------------------------------------
// Callouts

const CALLOUTS: Record<string, { title: string; icon: string }> = {
  NOTE: { title: 'Good to know', icon: 'info' },
  TIP: { title: 'Tip', icon: 'lightbulb' },
  WARNING: { title: 'Be careful', icon: 'triangle-alert' },
  DANGER: { title: 'Stop and check', icon: 'octagon-alert' },
  SUCCESS: { title: 'What you should see', icon: 'circle-check-big' },
  SUMMARY: { title: 'In short', icon: 'sparkles' },
};

// ---------------------------------------------------------------------------------------------
// Blocks

interface Ctx {
  headings: DocHeading[];
  used: Map<string, number>;
  /** Inside a list item, callout or drop-down: headings are not listed in the table of contents. */
  nested: boolean;
}

const indentOf = (line: string) => line.length - line.trimStart().length;
const LIST_MARK = /^([-*]|\d+[.)])\s+(.*)$/;

function dedent(lines: string[]): string[] {
  const widths = lines.filter((l) => l.trim()).map(indentOf);
  const min = widths.length ? Math.min(...widths) : 0;
  return lines.map((l) => l.slice(Math.min(min, indentOf(l))));
}

/** A block that ends a paragraph when it starts on the next line. */
function startsBlock(lines: string[], i: number): boolean {
  const t = lines[i].trim();
  return (
    t.startsWith('```') ||
    /^#{1,4}\s/.test(t) ||
    t.startsWith('>') ||
    t.startsWith('?? ') ||
    /^!\[/.test(t) ||
    LIST_MARK.test(t) ||
    /^(-{3,}|\*{3,})$/.test(t) ||
    (t.startsWith('|') && i + 1 < lines.length && /^\|?\s*:?-{3,}/.test(lines[i + 1].trim()))
  );
}

/** One list item's own lines: its first line, then indented or blank-then-indented lines. */
function takeItem(lines: string[], start: number, base: number): { body: string[]; next: number } {
  const body = [lines[start].trim().replace(LIST_MARK, '$2')];
  let i = start + 1;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) {
      let j = i;
      while (j < lines.length && !lines[j].trim()) j++;
      if (j < lines.length && indentOf(lines[j]) > base) {
        while (i < j) body.push(lines[i++]);
        continue;
      }
      break;
    }
    if (indentOf(l) <= base) break;
    body.push(l);
    i++;
  }
  return { body: [body[0], ...dedent(body.slice(1))], next: i };
}

function renderList(lines: string[], i: number, ctx: Ctx): { html: string; next: number } {
  const base = indentOf(lines[i]);
  const ordered = /^\d/.test(lines[i].trim());
  const start = ordered ? Number(/^(\d+)/.exec(lines[i].trim())?.[1] ?? 1) : 1;
  const items: string[] = [];
  let checklist = false;
  while (i < lines.length && lines[i].trim() && indentOf(lines[i]) === base) {
    const m = LIST_MARK.exec(lines[i].trim());
    if (!m || /^\d/.test(m[1]) !== ordered) break;
    const { body, next } = takeItem(lines, i, base);
    i = next;
    let cls = '';
    const box = /^\[( |x|X)\]\s+/.exec(body[0]);
    if (box) {
      checklist = true;
      cls = box[1] === ' ' ? ' class="todo"' : ' class="done"';
      body[0] = body[0].slice(box[0].length);
    }
    let html = blocks(body, { ...ctx, nested: true });
    const only = /^<p>([\s\S]*)<\/p>$/.exec(html);
    if (only && !only[1].includes('<p>')) html = only[1];
    items.push(`<li${cls}>${html}</li>`);
    // A blank line between items keeps the list going.
    let j = i;
    while (j < lines.length && !lines[j].trim()) j++;
    if (j > i && j < lines.length && indentOf(lines[j]) === base) {
      const n = LIST_MARK.exec(lines[j].trim());
      if (n && /^\d/.test(n[1]) === ordered) i = j;
    }
  }
  const tag = ordered ? 'ol' : 'ul';
  const cls = ordered ? ' class="steps"' : checklist ? ' class="checklist"' : '';
  const startAttr =
    ordered && start !== 1 ? ` start="${start}" style="counter-reset: step ${start - 1}"` : '';
  return { html: `<${tag}${cls}${startAttr}>${items.join('')}</${tag}>`, next: i };
}

function blocks(lines: string[], ctx: Ctx): string {
  const out: string[] = [];
  const paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) out.push(`<p>${fmt(paragraph.join(' '))}</p>`);
    paragraph.length = 0;
  };
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      flush();
      i++;
      continue;
    }
    if (paragraph.length && !startsBlock(lines, i)) {
      paragraph.push(trimmed);
      i++;
      continue;
    }
    flush();

    if (trimmed.startsWith('```')) {
      const lang = trimmed.slice(3).trim().toLowerCase();
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) code.push(lines[i++]);
      i++;
      const diagram = DIAGRAMS[lang];
      out.push(
        diagram
          ? diagram(code)
          : `<pre${lang ? ` data-lang="${escapeHtml(lang)}"` : ''}><code>${escapeHtml(dedent(code).join('\n'))}</code></pre>`,
      );
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(trimmed);
    if (h) {
      const level = h[1].length;
      const text = h[2].trim();
      let id = slugify(text) || 'section';
      const n = ctx.used.get(id) ?? 0;
      ctx.used.set(id, n + 1);
      if (n) id = `${id}-${n}`;
      if (!ctx.nested) ctx.headings.push({ level, text, id });
      out.push(`<h${level} id="${id}">${fmt(text)}</h${level}>`);
      i++;
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(trimmed)) {
      out.push('<hr />');
      i++;
      continue;
    }
    const img = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)$/.exec(trimmed);
    if (img) {
      out.push(figure(img[1], img[2], img[3]));
      i++;
      continue;
    }
    if (
      trimmed.startsWith('|') &&
      i + 1 < lines.length &&
      /^\|?\s*:?-{3,}/.test(lines[i + 1].trim())
    ) {
      const head = tableRow(trimmed);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(tableRow(lines[i++]));
      out.push(
        `<div class="table-wrap"><table><thead><tr>${head.map((c) => `<th>${fmt(c)}</th>`).join('')}</tr></thead><tbody>${rows
          .map((r) => `<tr>${r.map((c) => `<td>${fmt(c)}</td>`).join('')}</tr>`)
          .join('')}</tbody></table></div>`,
      );
      continue;
    }
    if (LIST_MARK.test(trimmed)) {
      const r = renderList(lines, i, ctx);
      out.push(r.html);
      i = r.next;
      continue;
    }
    if (trimmed.startsWith('?? ')) {
      const question = trimmed.slice(3).trim();
      const { body, next } = takeItem(lines, i, indentOf(line));
      i = next;
      out.push(
        `<details class="faq"><summary>${fmt(question)}</summary><div class="faq-body">${blocks(body.slice(1), { ...ctx, nested: true })}</div></details>`,
      );
      continue;
    }
    if (trimmed.startsWith('>')) {
      const quote: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('>'))
        quote.push(lines[i++].trim().replace(/^>\s?/, ''));
      const call = /^\[!([A-Z]+)\]\s*(.*)$/.exec(quote[0] ?? '');
      const kind = call ? CALLOUTS[call[1]] : undefined;
      if (call && kind) {
        const title = call[2] || kind.title;
        out.push(
          `<aside class="callout ${call[1].toLowerCase()}">${iconSvg(kind.icon, 'callout-icon')}<div class="callout-body"><p class="callout-title">${fmt(title)}</p>${blocks(quote.slice(1), { ...ctx, nested: true })}</div></aside>`,
        );
      } else {
        out.push(`<blockquote>${blocks(quote, { ...ctx, nested: true })}</blockquote>`);
      }
      continue;
    }
    paragraph.push(trimmed);
    i++;
  }
  flush();
  return out.join('\n');
}

export function renderMarkdown(source: string): { html: string; headings: DocHeading[] } {
  const ctx: Ctx = { headings: [], used: new Map(), nested: false };
  const html = blocks(source.replace(/\r\n?/g, '\n').split('\n'), ctx);
  return { html, headings: ctx.headings };
}

const SAFE_TAGS = new Set(
  (
    'a aside blockquote br button code details div em figcaption figure h1 h2 h3 h4 hr i img kbd li ol p ' +
    'pre span strong summary table tbody td th thead tr ul ' +
    'svg path circle rect line polyline polygon ellipse g'
  ).split(' '),
);
const SAFE_ATTRS = new Set(
  (
    'class id href target rel src alt loading decoding title type role start style aria-hidden aria-label ' +
    'data-lang viewbox fill stroke stroke-width stroke-linecap stroke-linejoin d cx cy r rx ry x y x1 x2 y1 y2 ' +
    'width height points'
  ).split(' '),
);

/**
 * Second line of defence before the page trusts the renderer's output (it bypasses Angular's sanitizer,
 * which strips the SVG icons and the screenshot zoom buttons): every tag and attribute must be one this
 * file emits, no `on…` handler, no script URL, and `style` only the step counter.
 */
export function isSafeDocHtml(html: string): boolean {
  for (const m of html.matchAll(/<\/?([a-zA-Z0-9-]+)([^>]*)>/g)) {
    if (!SAFE_TAGS.has(m[1].toLowerCase())) return false;
    for (const a of m[2].matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*"([^"]*)"/g)) {
      const name = a[1].toLowerCase();
      if (!SAFE_ATTRS.has(name)) return false;
      if ((name === 'href' || name === 'src') && /^\s*(javascript|data|vbscript):/i.test(a[2]))
        return false;
      if (name === 'style' && !/^counter-reset: step \d+$/.test(a[2])) return false;
    }
  }
  return true;
}

/** Plain words of a guide (for search and reading time): no markup, no diagram syntax. */
export function plainText(source: string): string {
  return source
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/:(ok|warn|bad|info|muted)\[/g, ' ')
    .replace(/\?\? |[#>*`|{}[\]()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Minutes to read at a relaxed 200 words a minute (at least one). */
export function readingMinutes(source: string): number {
  return Math.max(1, Math.round(plainText(source).split(' ').length / 200));
}
