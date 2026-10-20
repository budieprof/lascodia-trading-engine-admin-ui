import { getTestBed } from '@angular/core/testing';
import { BrowserTestingModule, platformBrowserTesting } from '@angular/platform-browser/testing';

/**
 * A zoneless TestBed for specs under the pure-TS vitest runner (`vitest.config.mts`), which does
 * not set one up. Each spec FILE runs in its own module graph, so this initialises at most once per
 * file. Use it for services that need Angular's DI with effects, HttpClient testing, or a small host
 * template; flush effects with `TestBed.tick()`.
 */
export function ensureTestBed(): void {
  const tb = getTestBed();
  if (tb.platform) return;
  tb.initTestEnvironment(BrowserTestingModule, platformBrowserTesting(), {
    teardown: { destroyAfterEach: true },
  });
}
