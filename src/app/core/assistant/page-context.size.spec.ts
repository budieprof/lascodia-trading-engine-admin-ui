import { describe, expect, it } from 'vitest';
import { Injector, runInInjectionContext, DestroyRef } from '@angular/core';
import { PageContextService } from './page-context.service';
import { UiCommandService } from './ui-command.service';
import { AccountScopeService } from '@core/scope/account-scope.service';
import { Router, ActivatedRoute } from '@angular/router';
import { of } from 'rxjs';
import type { UiCommand } from './ui-command.types';

/**
 * The bug this pins: `captureJson` used to fit the payload by SLICING the JSON string.
 *
 * The moment a page published enough to overrun the cap, the result was a truncated string
 * that is not valid JSON. The caller parsed it, the parse threw, the context was dropped —
 * and the assistant answered as if it had no idea what page it was on. Nothing warned. The
 * only symptom was a reply saying the page was not being reported.
 *
 * So the invariant is not "small enough", it is "always parseable".
 */
function makeService(commands: UiCommand[]): PageContextService {
  const destroyRef = { onDestroy: () => () => void 0 } as unknown as DestroyRef;
  const injector = Injector.create({
    providers: [
      { provide: Router, useValue: { url: '/chart-analysis/EURUSD', events: of() } },
      {
        // Minimal but COMPLETE: capture() walks `firstChild` for params and `children`
        // for breadcrumbs, and an incomplete stub throws into the catch — which would
        // make every assertion below pass or fail for the wrong reason.
        provide: ActivatedRoute,
        useValue: {
          root: {
            routeConfig: null,
            firstChild: null,
            children: [],
            snapshot: { params: {}, queryParams: {}, url: [] },
          },
        },
      },
      {
        provide: AccountScopeService,
        useValue: {
          effectiveSelected: () => 'all-real',
          accountIdsKey: () => '17,22',
          singleAccount: () => null,
        },
      },
      { provide: UiCommandService, useClass: UiCommandService },
      { provide: PageContextService, useClass: PageContextService },
    ],
  });
  const ui = injector.get(UiCommandService);
  if (commands.length) ui.register(commands, destroyRef);
  return runInInjectionContext(injector, () => injector.get(PageContextService));
}

/** A command whose declared text is deliberately large. */
function fatCommand(i: number): UiCommand {
  return {
    id: `page.command${i}`,
    description: 'x'.repeat(400),
    params: [
      {
        name: 'value',
        type: 'enum',
        description: 'y'.repeat(300),
        values: Array.from({ length: 20 }, (_, k) => `option-${k}-${'z'.repeat(10)}`),
      },
    ],
    run: () => ({ ok: true, message: 'ok' }),
  };
}

describe('page context payload', () => {
  it('is valid JSON when nothing is published', () => {
    const json = makeService([]).captureJson();
    expect(json).not.toBeNull();
    expect(() => JSON.parse(json!)).not.toThrow();
  });

  it('carries the registered command specs', () => {
    const json = makeService([fatCommand(0)]).captureJson();
    const parsed = JSON.parse(json!);
    expect(parsed.commands).toHaveLength(1);
    expect(parsed.commands[0].id).toBe('page.command0');
  });

  it('stays valid JSON when the commands alone blow the cap', () => {
    // 40 fat commands is far past any real page, and exactly the shape that used to
    // produce a half-serialised string.
    const svc = makeService(Array.from({ length: 40 }, (_, i) => fatCommand(i)));
    const json = svc.captureJson();
    expect(json).not.toBeNull();
    expect(() => JSON.parse(json!), 'payload must parse at any size').not.toThrow();
    expect(json!.length).toBeLessThanOrEqual(8000);
  });

  it('keeps the command ids when it has to shed detail', () => {
    const svc = makeService(Array.from({ length: 40 }, (_, i) => fatCommand(i)));
    const parsed = JSON.parse(svc.captureJson()!);
    // Losing the parameter docs is survivable — the assistant can ask. Losing the fact that
    // a command EXISTS is what sends it back to guessing.
    expect(Array.isArray(parsed.commands)).toBe(true);
    expect(parsed.commands.length).toBeGreaterThan(0);
    expect(parsed.commands[0].id).toMatch(/^page\.command/);
  });

  it('always keeps the route, whatever it sheds', () => {
    const svc = makeService(Array.from({ length: 40 }, (_, i) => fatCommand(i)));
    const parsed = JSON.parse(svc.captureJson()!);
    expect(parsed.url).toBe('/chart-analysis/EURUSD');
  });
});
