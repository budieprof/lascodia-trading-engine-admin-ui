/**
 * Search across the guides, by section: every `##` / `###` heading starts a section, so a result links
 * straight to the place it was found (`/docs/<slug>#<heading id>`). Pure functions — the page feeds it
 * the Markdown it already downloaded.
 */
import type { DocGuide } from './docs-catalog';
import { plainText, renderMarkdown } from './markdown';

export interface DocSection {
  guide: DocGuide;
  heading: string;
  /** Heading anchor; empty for the text before the first heading. */
  id: string;
  text: string;
}

export interface DocHit extends DocSection {
  score: number;
  snippet: string;
}

export function sectionsOf(guide: DocGuide, markdown: string): DocSection[] {
  const { headings } = renderMarkdown(markdown);
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const sections: DocSection[] = [];
  let heading = guide.title;
  let id = '';
  let buf: string[] = [];
  let h = 0;
  let inFence = false;
  const push = () => {
    const text = plainText(buf.join('\n'));
    if (text || id) sections.push({ guide, heading, id, text });
    buf = [];
  };
  for (const line of lines) {
    if (line.trim().startsWith('```')) inFence = !inFence;
    const m = !inFence && /^(#{1,4})\s+(.*)$/.exec(line.trim());
    if (m) {
      const hd = headings[h++];
      if (m[1].length <= 3 && hd) {
        push();
        heading = hd.text.replace(/[*`]/g, '');
        id = hd.level === 1 ? '' : hd.id;
        continue;
      }
    }
    // Diagram lines are words too ("Connect a terminal | …"), so keep them, minus the syntax.
    buf.push(inFence ? line.replace(/\|/g, ' ') : line);
  }
  push();
  return sections;
}

function snippetOf(text: string, word: string): string {
  const at = text.toLowerCase().indexOf(word);
  if (at < 0) return text.slice(0, 160) + (text.length > 160 ? '…' : '');
  const start = Math.max(0, at - 60);
  const end = Math.min(text.length, at + 120);
  return (start ? '…' : '') + text.slice(start, end).trim() + (end < text.length ? '…' : '');
}

/** Sections holding every word of the query, best first: heading matches count most. */
export function searchDocs(sections: readonly DocSection[], query: string, limit = 12): DocHit[] {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^a-z0-9.-]/g, ''))
    .filter((w) => w.length > 1);
  if (!words.length) return [];
  const hits: DocHit[] = [];
  for (const s of sections) {
    const head = `${s.guide.title} ${s.heading}`.toLowerCase();
    const body = s.text.toLowerCase();
    let score = 0;
    let all = true;
    for (const w of words) {
      const inHead = head.includes(w);
      const count = body.split(w).length - 1;
      if (!inHead && !count) {
        all = false;
        break;
      }
      score += (inHead ? 10 : 0) + Math.min(count, 5);
    }
    if (all) hits.push({ ...s, score, snippet: snippetOf(s.text, words[0]) });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}
