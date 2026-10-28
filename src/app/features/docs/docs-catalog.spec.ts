import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { DOC_GROUPS, DOC_GUIDES, neighbours } from './docs-catalog';
import { DOC_ICONS } from './docs-icons';
import { searchDocs, sectionsOf } from './docs-search';
import { isSafeDocHtml, renderMarkdown } from './markdown';

const content = join(process.cwd(), 'public/docs-content');
const read = (slug: string) => readFileSync(join(content, `${slug}.md`), 'utf8');

describe('documentation portal content', () => {
  it.each(DOC_GUIDES.map((g) => g.slug))('ships %s.md with a title', (slug) => {
    const file = join(content, `${slug}.md`);
    expect(existsSync(file)).toBe(true);
    const { headings, html } = renderMarkdown(read(slug));
    expect(headings[0]?.level).toBe(1);
    expect(isSafeDocHtml(html)).toBe(true);
  });

  it('links only to guides that exist in the catalog', () => {
    const slugs = new Set([...DOC_GUIDES.map((g) => g.slug), 'api']);
    for (const g of DOC_GUIDES) {
      for (const m of read(g.slug).matchAll(/\]\(\/docs\/([a-z0-9-]+)[)#]/g))
        expect(slugs.has(m[1]), `${g.slug} → ${m[1]}`).toBe(true);
      for (const m of read(g.slug).matchAll(/\|\s*\/docs\/([a-z0-9-]+)/g))
        expect(slugs.has(m[1]), `${g.slug} card → ${m[1]}`).toBe(true);
    }
  });

  it('ships every screenshot a guide shows, in both themes', () => {
    const missing: string[] = [];
    for (const g of DOC_GUIDES) {
      for (const m of read(g.slug).matchAll(/^\s*!\[[^\]]*\]\(([^)\s]+)/gm)) {
        const name = m[1];
        const files = /\.(png|jpe?g|webp|svg)$/.test(name)
          ? [name]
          : [`${name}.light.webp`, `${name}.dark.webp`];
        for (const f of files)
          if (!existsSync(join(content, 'img', f))) missing.push(`${g.slug}: ${f}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('uses only icons the docs set can draw', () => {
    const icons = new Set(Object.keys(DOC_ICONS));
    for (const g of DOC_GUIDES) expect(icons.has(g.icon), g.slug).toBe(true);
    for (const g of DOC_GROUPS) expect(icons.has(g.icon), g.title).toBe(true);
    for (const g of DOC_GUIDES) {
      const md = read(g.slug);
      for (const block of md.matchAll(/```(flow|stack|cards)\n([\s\S]*?)```/g)) {
        for (const line of block[2].split('\n')) {
          const parts = line.split('|').map((p) => p.trim());
          if (!line.trim() || line.trim().startsWith('@') || line.trim().startsWith('->')) continue;
          const icon = block[1] === 'cards' ? parts[0] : parts[2];
          if (icon) expect(icons.has(icon), `${g.slug}: ${icon}`).toBe(true);
        }
      }
    }
  });

  it('every audience has a group, and guides chain previous / next', () => {
    for (const g of DOC_GUIDES)
      expect(DOC_GROUPS.some((grp) => grp.audience === g.audience)).toBe(true);
    expect(neighbours(DOC_GUIDES[0].slug).prev).toBeNull();
    expect(neighbours(DOC_GUIDES[0].slug).next?.slug).toBe(DOC_GUIDES[1].slug);
  });

  it('finds a section by its words and links to its heading', () => {
    const g = DOC_GUIDES.find((x) => x.slug === 'ea-install')!;
    const hits = searchDocs(sectionsOf(g, read('ea-install')), 'allow list');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].guide.slug).toBe('ea-install');
    expect(searchDocs(sectionsOf(g, read('ea-install')), 'zzqx')).toEqual([]);
  });

  it('ships the API reference generated from the engine', () => {
    const ref = JSON.parse(readFileSync(join(content, 'api-reference.json'), 'utf8'));
    expect(ref.endpointCount).toBeGreaterThan(300);
    expect(ref.groups.length).toBeGreaterThan(20);
  });
});
