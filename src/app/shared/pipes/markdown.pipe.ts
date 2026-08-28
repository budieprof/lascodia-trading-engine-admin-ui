import { Pipe, PipeTransform, inject } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';

/**
 * Minimal, dependency-free markdown → sanitized HTML for the LLM narrative
 * blocks (spot analysis, rationales, etc.). Deliberately supports only the
 * subset the models emit — headings (#/##/###), bold (**…**), italics (*…*),
 * inline code (`…`), unordered lists (-, *), GFM pipe tables and blank-line
 * paragraphs.
 *
 * Security: the raw text is HTML-escaped FIRST, so any `<script>` etc. in the
 * model output is neutralised before we insert our own controlled tags. Only
 * then is the result trusted for [innerHTML]. No third-party markdown lib and
 * no raw HTML pass-through.
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

/** Inline transforms applied within a text run (already HTML-escaped). */
function inline(s: string): string {
  return (
    s
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      // italics: single * not adjacent to another * (avoid eating bold markers)
      .replace(/(^|[^*])\*(?!\s)([^*]+?)\*(?!\*)/g, '$1<em>$2</em>')
  );
}

function render(escaped: string): string {
  const lines = escaped.split('\n');
  const html: string[] = [];
  let inList = false;
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    html.push(`<p>${inline(paragraph.join(' '))}</p>`);
    paragraph = [];
  };
  const closeList = () => {
    if (inList) {
      html.push('</ul>');
      inList = false;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd();
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      flushParagraph();
      closeList();
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

    const bullet = /^[-*]\s+(.*)$/.exec(trimmed);
    if (bullet) {
      flushParagraph();
      if (!inList) {
        html.push('<ul>');
        inList = true;
      }
      html.push(`<li>${inline(bullet[1])}</li>`);
      continue;
    }

    // Plain text line — accumulate into the current paragraph.
    closeList();
    paragraph.push(trimmed);
  }

  flushParagraph();
  closeList();
  return html.join('');
}
