import { DestroyRef, Injectable, inject } from '@angular/core';
import { ActivatedRoute, NavigationEnd, Router } from '@angular/router';
import { filter } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { AccountScopeService } from '@core/scope/account-scope.service';
import { buildBreadcrumbTrail } from '@core/routing/breadcrumb-trail';
import { findPage } from '@shared/navigation/page-catalog';
import type { PageContext, PageFacts } from './page-context.types';
import { UiCommandService } from './ui-command.service';

/**
 * How much page context may be sent.
 *
 * <p>Matches the engine's own `AssistantPageContextMaxChars` (8000). Staying under the
 * server cap is the point: the engine truncates as plain TEXT with a marker, which the model
 * can cope with, but a page that routinely overruns would be handing it half a sentence.</p>
 */
const MAX_CONTEXT_CHARS = 8000;

/**
 * Assembles what the assistant is told about the current page.
 *
 * <p>Route, params and account scope come for free. Anything beyond that — the record on
 * screen, the filters the operator set, the figures they are looking at — only the page
 * knows, so a page publishes it:</p>
 *
 * <pre>
 *   private readonly pageContext = inject(PageContextService);
 *   constructor() {
 *     this.pageContext.publish(() => ({
 *       headline: `Backtest #${this.id()} — ${this.symbol()} ${this.timeframe()}`,
 *       record: { kind: 'backtest', id: this.id() },
 *       figures: { totalReturn: this.primary().totalReturn },
 *     }));
 *   }
 * </pre>
 *
 * <p>The callback is invoked at send time, not at publish time, so it reads live signals
 * without any reactivity plumbing. Registrations drop themselves on component destroy and
 * are swept on navigation as a belt for a page that forgot.</p>
 */
@Injectable({ providedIn: 'root' })
export class PageContextService {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly scope = inject(AccountScopeService);
  private readonly uiCommands = inject(UiCommandService);

  /** The live publisher, with the URL it was registered under. */
  private current: { url: string; source: () => PageFacts } | null = null;

  constructor() {
    this.router.events
      .pipe(
        filter((e) => e instanceof NavigationEnd),
        takeUntilDestroyed(),
      )
      .subscribe(() => {
        // A publisher belongs to the page that registered it. Once the URL has moved on,
        // its facts describe a page the operator is no longer looking at, which is worse
        // than having none — so drop it even if that component's destroy has not run yet.
        if (this.current && !this.sameRoute(this.current.url, this.router.url)) {
          this.current = null;
        }
      });
  }

  /**
   * Publish this page's facts. Call from a component constructor so the registration can
   * drop itself on destroy; called from anywhere else it still works, and the
   * navigation sweep above is what cleans it up.
   */
  publish(source: () => PageFacts): void {
    const entry = { url: this.router.url, source };
    this.current = entry;
    try {
      inject(DestroyRef).onDestroy(() => {
        if (this.current === entry) this.current = null;
      });
    } catch {
      /* not in an injection context — the NavigationEnd sweep covers it */
    }
  }

  /** Everything the assistant should know about where the operator is right now. */
  capture(): PageContext {
    const url = this.router.url;
    const page = findPage(url);
    const snapshot = this.deepestSnapshot();
    const single = this.scope.singleAccount();

    let facts: PageFacts | null = null;
    if (this.current && this.sameRoute(this.current.url, url)) {
      try {
        facts = this.current.source();
      } catch {
        // A page that throws while describing itself must not break the operator's
        // question. Better to answer with route context alone.
        facts = null;
      }
    }

    return {
      url,
      routePath: this.routePattern(),
      params: snapshot?.params ?? {},
      query: snapshot?.queryParams ?? {},
      pageLabel: page?.label ?? null,
      pageGroup: page?.group ?? null,
      pageKeywords: page?.keywords,
      breadcrumbs: buildBreadcrumbTrail(this.route.root).map((c) => c.label),
      scope: {
        selected: this.scope.effectiveSelected(),
        // accountIdsKey, not accountIds: the array identity churns on every 30s refresh.
        accountIds: this.scope.accountIdsKey(),
        accountName: single?.accountName ?? null,
      },
      facts,
      // What the assistant may ask this page to DO. Without these it can only read and
      // describe — which is how it ended up guessing at chart controls it could not see.
      commands: this.uiCommands.specs(),
      capturedAtUtc: new Date().toISOString(),
    };
  }

  /**
   * Capture, serialise and fit inside the cap.
   *
   * <p><b>Never slices the JSON.</b> It used to, and the moment a page published enough to
   * overrun the cap the result was a truncated string that is not valid JSON — which the
   * caller then tried to parse, so the context was dropped entirely and the assistant
   * answered as if it had no idea what page it was on. Nothing warned; the reply simply said
   * the page was not being reported.</p>
   *
   * <p>Instead the payload is reduced in stages, each one a complete object that still
   * serialises. Command PARAMETER detail goes first (the model can ask), then the facts, then
   * the command list down to bare ids — route and scope are small and always useful, so they
   * are what survives.</p>
   */
  captureJson(): string | null {
    try {
      const full = this.capture();
      const commands = full.commands ?? [];

      const stages: PageContext[] = [
        full,
        // 1. Keep every command, lose the parameter documentation.
        {
          ...full,
          commands: commands.map((c) => ({
            ...c,
            params: c.params?.map((p) => ({ name: p.name, type: p.type, description: '' })),
          })),
        },
        // 2. Lose the parameters entirely.
        {
          ...full,
          commands: commands.map(({ id, description, confirm }) => ({
            id,
            description,
            ...(confirm ? { confirm } : {}),
          })),
        },
        // 3. Lose the page's own facts.
        {
          ...full,
          facts: null,
          commands: commands.map(({ id, description }) => ({ id, description })),
        },
        // 4. Bare command ids, so the assistant still knows what it could ask to run.
        { ...full, facts: null, commands: commands.map(({ id }) => ({ id, description: '' })) },
        // 5. Route and scope only.
        { ...full, facts: null, commands: [] },
      ];

      for (const stage of stages) {
        const json = JSON.stringify(stage);
        if (json.length <= MAX_CONTEXT_CHARS) return json;
      }

      // Everything still too big means the route/scope alone overran, which cannot happen
      // with any real URL — but returning invalid JSON is not the fallback.
      return null;
    } catch {
      return null;
    }
  }

  /** Route pattern (/backtests/:id) rather than the concrete URL, when derivable. */
  private routePattern(): string {
    const parts: string[] = [];
    let r: ActivatedRoute | null = this.route.root;
    while (r) {
      const seg = r.routeConfig?.path;
      if (seg) parts.push(seg);
      r = r.firstChild;
    }
    return '/' + parts.filter(Boolean).join('/');
  }

  private deepestSnapshot() {
    let r: ActivatedRoute | null = this.route.root;
    let deepest = r?.snapshot ?? null;
    while (r?.firstChild) {
      r = r.firstChild;
      deepest = r.snapshot;
    }
    return deepest;
  }

  /** Compares paths, ignoring the query string — a filter change is the same page. */
  private sameRoute(a: string, b: string): boolean {
    return (a || '').split('?')[0] === (b || '').split('?')[0];
  }
}
