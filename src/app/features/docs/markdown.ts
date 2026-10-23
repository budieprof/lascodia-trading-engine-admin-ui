/**
 * A small, safe Markdown renderer for the documentation portal's own guides (`public/docs-content/*.md`).
 * Everything is HTML-escaped FIRST, then a fixed subset is turned into tags: headings (#–####, with
 * ids), paragraphs, bullet and numbered lists (one level), fenced code blocks, inline code, **bold**,
 * *italic*, links (http(s), site-relative `/…` or `#anchor` only — anything else stays text), pipe
 * tables, `>` notes and `---` rules. No raw HTML passes through.
 */

export interface DocHeading {
  level: number;
  text: string;
  id: string;
}

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

/** Inline formatting on ALREADY-ESCAPED text. Code spans are protected from the other rules. */
export function inline(escaped: string): string {
  const codes: string[] = [];
  let s = escaped.replace(/`([^`]+)`/g, (_, c: string) => {
    codes.push(`<code>${c}</code>`);
    return `\uE000${codes.length - 1}\uE000`;
  });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, text: string, href: string) => {
    const safe = safeHref(href.replace(/&amp;/g, '&'));
    if (!safe) return whole;
    const external = /^https?:/i.test(safe);
    return `<a href="${escapeHtml(safe)}"${external ? ' target="_blank" rel="noopener noreferrer"' : ''}>${text}</a>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  return s.replace(/\uE000(\d+)\uE000/g, (_, i: string) => codes[Number(i)]);
}

function tableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

export function renderMarkdown(source: string): { html: string; headings: DocHeading[] } {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  const headings: DocHeading[] = [];
  const used = new Map<string, number>();
  let i = 0;

  const paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) out.push(`<p>${inline(escapeHtml(paragraph.join(' ')))}</p>`);
    paragraph.length = 0;
  };

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed.startsWith('```')) {
      flush();
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) code.push(lines[i++]);
      i++;
      out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(trimmed);
    if (h) {
      flush();
      const level = h[1].length;
      const text = h[2].trim();
      let id = slugify(text) || 'section';
      const n = used.get(id) ?? 0;
      used.set(id, n + 1);
      if (n) id = `${id}-${n}`;
      headings.push({ level, text, id });
      out.push(`<h${level} id="${id}">${inline(escapeHtml(text))}</h${level}>`);
      i++;
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(trimmed)) {
      flush();
      out.push('<hr />');
      i++;
      continue;
    }
    if (trimmed.startsWith('|') && i + 1 < lines.length && /^\|?\s*:?-{3,}/.test(lines[i + 1].trim())) {
      flush();
      const head = tableRow(trimmed);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(tableRow(lines[i++]));
      out.push(
        `<div class="table-wrap"><table><thead><tr>${head.map((c) => `<th>${inline(escapeHtml(c))}</th>`).join('')}</tr></thead><tbody>${rows
          .map((r) => `<tr>${r.map((c) => `<td>${inline(escapeHtml(c))}</td>`).join('')}</tr>`)
          .join('')}</tbody></table></div>`,
      );
      continue;
    }
    if (/^[-*]\s+/.test(trimmed) || /^\d+[.)]\s+/.test(trimmed)) {
      flush();
      const ordered = /^\d/.test(trimmed);
      const items: string[] = [];
      while (i < lines.length) {
        const t = lines[i].trim();
        const m = ordered ? /^\d+[.)]\s+(.*)$/.exec(t) : /^[-*]\s+(.*)$/.exec(t);
        if (m) items.push(m[1]);
        else if (t && /^\s{2,}/.test(lines[i]) && items.length) items[items.length - 1] += ` ${t}`;
        else break;
        i++;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map((it) => `<li>${inline(escapeHtml(it))}</li>`).join('')}</${tag}>`);
      continue;
    }
    if (trimmed.startsWith('>')) {
      flush();
      const quote: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) quote.push(lines[i++].trim().replace(/^>\s?/, ''));
      out.push(`<blockquote>${inline(escapeHtml(quote.join(' ')))}</blockquote>`);
      continue;
    }
    if (!trimmed) {
      flush();
      i++;
      continue;
    }
    paragraph.push(trimmed);
    i++;
  }
  flush();
  return { html: out.join('\n'), headings };
}
