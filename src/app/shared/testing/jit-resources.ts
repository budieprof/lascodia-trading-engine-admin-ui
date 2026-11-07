import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';

/**
 * Component specs run under Angular's JIT compiler without the CLI (see `vitest.components.config.mts`), which leaves a
 * component with `styleUrl` / `templateUrl` "not resolved". Call this (awaited) before the first
 * `TestBed.createComponent` of such a component: stylesheets resolve to nothing (specs never assert CSS) and templates
 * resolve from `templates` (file name → template text, e.g. read with `readFileSync`). An unknown template throws, so
 * a spec never renders an empty component by accident.
 */
export async function resolveJitResources(
  templates: Readonly<Record<string, string>> = {},
): Promise<void> {
  await resolveComponentResources(async (url: string) => {
    if (/\.(s?css|sass|less)$/.test(url)) return '';
    const name = url.split('/').pop() ?? url;
    const t = templates[name] ?? templates[url];
    if (t !== undefined) return t;
    throw new Error(`resolveJitResources: no template given for ${url}`);
  });
}
