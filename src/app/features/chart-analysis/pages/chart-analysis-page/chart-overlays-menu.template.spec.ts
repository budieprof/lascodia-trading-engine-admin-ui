import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// U13: the overlays menu was moved out of the chart page's template; it reads the page through `page.…` (like the
// legend and side pane). The JIT component runner cannot load templateUrl components, so this guards the move as
// text: every `page.x` the template uses is a public member of the page, and the page no longer carries the menu.
const dir = resolve(process.cwd(), 'src/app/features/chart-analysis/pages/chart-analysis-page');
const menu = readFileSync(resolve(dir, 'chart-overlays-menu.component.html'), 'utf8');
const pageTs = readFileSync(resolve(dir, 'chart-analysis-page.component.ts'), 'utf8');
const pageHtml = readFileSync(resolve(dir, 'chart-analysis-page.component.html'), 'utf8');

describe('chart overlays menu split (U13)', () => {
  it('only uses public members of the page', () => {
    const used = [...new Set([...menu.matchAll(/\bpage\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]))];
    expect(used.length).toBeGreaterThan(30);
    for (const name of used) {
      const declared = new RegExp(
        `^\\s{2}(?:(?:readonly|protected|public|async|get)\\s+)*${name}\\b`,
        'm',
      );
      expect(declared.test(pageTs), `page.${name} is declared`).toBe(true);
      const hidden = new RegExp(`^\\s{2}private\\s+(?:readonly\\s+)?${name}\\b`, 'm');
      expect(hidden.test(pageTs), `page.${name} is not private`).toBe(false);
    }
  });

  it('is rendered once by the page in place of the inline markup', () => {
    expect(pageHtml.match(/<app-chart-overlays-menu \/>/g)).toHaveLength(1);
    expect(pageHtml).not.toContain('data-testid="overlays-button"');
    expect(menu).toContain('data-testid="overlays-button"');
  });
});
