import { Pipe, PipeTransform, inject } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';

/**
 * Minimal, dependency-free markdown → sanitized HTML for the LLM narrative
 * blocks (spot analysis, rationales, etc.). Deliberately supports only the
 * subset the models emit — headings (#/##/###), bold (**…**), italics (*…*),
 * inline code (`…`), unordered lists (-, *) and blank-line paragraphs.
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
    return this.sanitizer.bypassSecurityTrustHtml(render(escapeHtml(value)));
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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

  for (const raw of lines) {
    const line = raw.trimEnd();
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
