import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// U13: the overlays menu was moved out of the chart page's template. US02b: it no longer reads the page; its saved
// settings are the page's ChartOverlaySettings (`overlays.…`). The JIT component runner cannot load every child, so
// this also guards the move as text: every `overlays.x` the template uses is a public member of the store, no `page.`
// is left, and the page renders the menu once in place of the inline markup. (`ngc` checks the bindings' types.)
const dir = resolve(process.cwd(), 'src/app/features/chart-analysis/pages/chart-analysis-page');
const menu = readFileSync(resolve(dir, 'chart-overlays-menu.component.html'), 'utf8');
const storeTs = readFileSync(resolve(dir, 'chart-overlay-settings.ts'), 'utf8');
const pageHtml = readFileSync(resolve(dir, 'chart-analysis-page.component.html'), 'utf8');

describe('chart overlays menu split (U13, US02b)', () => {
  it('reads the overlay settings store, not the page', () => {
    expect(menu).not.toMatch(/\bpage\./);
    const used = [
      ...new Set([...menu.matchAll(/\boverlays\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1])),
    ];
    expect(used.length).toBeGreaterThan(20);
    for (const name of used) {
      const declared = new RegExp(`^\\s{2}(?:readonly\\s+)?${name}\\b`, 'm');
      expect(declared.test(storeTs), `overlays.${name} is declared`).toBe(true);
      const hidden = new RegExp(`^\\s{2}private\\s+(?:readonly\\s+)?${name}\\b`, 'm');
      expect(hidden.test(storeTs), `overlays.${name} is not private`).toBe(false);
    }
  });

  it('is rendered once by the page in place of the inline markup', () => {
    expect(pageHtml.match(/<app-chart-overlays-menu\b/g)).toHaveLength(1);
    expect(pageHtml).not.toContain('data-testid="overlays-button"');
    expect(menu).toContain('data-testid="overlays-button"');
  });
});
