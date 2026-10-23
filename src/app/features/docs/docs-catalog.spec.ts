import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { DOC_GUIDES } from './docs-catalog';
import { renderMarkdown } from './markdown';

const content = join(process.cwd(), 'public/docs-content');

describe('documentation portal content', () => {
  it.each(DOC_GUIDES.map((g) => g.slug))('ships %s.md with a title', (slug) => {
    const file = join(content, `${slug}.md`);
    expect(existsSync(file)).toBe(true);
    const { headings } = renderMarkdown(readFileSync(file, 'utf8'));
    expect(headings[0]?.level).toBe(1);
  });

  it('links only to guides and console pages that exist in the catalog', () => {
    const slugs = new Set([...DOC_GUIDES.map((g) => g.slug), 'api']);
    for (const g of DOC_GUIDES) {
      const md = readFileSync(join(content, `${g.slug}.md`), 'utf8');
      for (const m of md.matchAll(/\]\(\/docs\/([a-z0-9-]+)\)/g)) expect(slugs.has(m[1]), `${g.slug} → ${m[1]}`).toBe(true);
    }
  });

  it('ships the API reference generated from the engine', () => {
    const ref = JSON.parse(readFileSync(join(content, 'api-reference.json'), 'utf8'));
    expect(ref.endpointCount).toBeGreaterThan(300);
    expect(ref.groups.length).toBeGreaterThan(20);
  });
});
