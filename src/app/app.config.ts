import {
  ApplicationConfig,
  ErrorHandler,
  inject,
  provideAppInitializer,
  provideZoneChangeDetection,
} from '@angular/core';
import {
  provideRouter,
  withPreloading,
  withRouterConfig,
  withViewTransitions,
} from '@angular/router';
import { provideHttpClient, withInterceptors, withXhr } from '@angular/common/http';
import { provideAnimations } from '@angular/platform-browser/animations';
import { HoverPreloadingStrategy } from '@core/routing/hover-preloading.strategy';
import { provideEchartsCore } from 'ngx-echarts';
import { routes } from './app.routes';
import { authInterceptor } from '@core/auth/auth.interceptor';
import { csrfInterceptor } from '@core/auth/csrf.interceptor';
import { approvalInterceptor } from '@core/auth/approval.interceptor';
import { AuthService } from '@core/auth/auth.service';
import { serverClockInterceptor } from '@core/time/server-clock';
import { pageApiActivityInterceptor } from '@core/assistant/page-api-activity';
import { assistantWriteGuardInterceptor } from '@core/assistant/assistant-write-guard';
import { errorInterceptor } from '@core/auth/error.interceptor';
import { retryInterceptor } from '@core/api/retry.interceptor';
import { RUNTIME_CONFIG, RuntimeConfig } from '@core/config/runtime-config';
import { GlobalErrorHandler } from '@core/errors/global-error-handler';
import { sentryProviders } from '@core/observability/sentry';
import { webVitalsProviders } from '@core/observability/web-vitals';
import { provideChartTouchCancel } from '@shared/utils/lwc-touch-cancel';
import { lascodiaTheme, lascodiaDarkTheme } from '../styles/echarts-theme';

// ECharts (~1.4 MB with zrender) is loaded on demand: the first chart directive that renders
// calls this loader, so the shell (sign-in, sidebar, assistant dock, command palette) never pays
// for it. `import()` is evaluated once and the promise memoised, so the themes are registered
// exactly once, before any chart is created.
//
// Both themes are registered so ChartCardComponent can swap between them as the user toggles
// light/dark. Echarts only consults the theme name at instance creation, so the chart-card
// re-renders when the theme signal flips.
//
// Charts rendered through ChartCardComponent pass the theme name explicitly. Sixteen pages use
// the `echarts` directive directly and passed none, so they got ECharts' stock look — and none
// of the theme-level defaults (axis label overlap hiding, compact number formatting). Hand
// ngx-echarts a module facade whose `init` defaults the theme from the same `data-theme`
// attribute ThemeService writes, so every chart in the app is governed by one theme regardless
// of how it was mounted. An explicit theme argument still wins.
//
// A facade, NOT `echarts.init = …`: an ES module namespace is read-only at runtime, and that
// assignment threw "Cannot assign to import" during bootstrap and took the whole app down.
let themedEcharts: Promise<typeof import('echarts')> | null = null;
export function loadThemedEcharts(): Promise<typeof import('echarts')> {
  themedEcharts ??= import('echarts').then((echarts) => {
    echarts.registerTheme('lascodia-light', lascodiaTheme);
    echarts.registerTheme('lascodia-dark', lascodiaDarkTheme);
    const themedInit: typeof echarts.init = (dom, theme, opts) =>
      echarts.init(
        dom,
        theme ??
          (document.documentElement.getAttribute('data-theme') === 'dark'
            ? 'lascodia-dark'
            : 'lascodia-light'),
        opts,
      );
    return { ...echarts, init: themedInit };
  });
  return themedEcharts;
}

export function buildAppConfig(runtimeConfig: RuntimeConfig): ApplicationConfig {
  return {
    providers: [
      { provide: RUNTIME_CONFIG, useValue: runtimeConfig },
      provideZoneChangeDetection({ eventCoalescing: true }),
      provideRouter(
        routes,
        withPreloading(HoverPreloadingStrategy),
        // Angular 22 changed the default to 'always' (child routes inherit
        // every parent param). Keep the pre-v22 behaviour explicitly.
        withRouterConfig({ paramsInheritanceStrategy: 'emptyOnly' }),
        // Native View Transitions API on each navigation. The browser
        // snapshots the outgoing page and crossfades into the incoming
        // one; we customise the animation in global styles via the
        // `::view-transition-*` pseudo-elements. Falls back to no
        // animation on browsers without API support (currently Firefox).
        //
        // onViewTransitionCreated lets us override the default fade
        // for specific gestures by reading a one-shot intent flag the
        // origin component stashed in sessionStorage. The watchlist
        // tile uses this to request a horizontal slide when the
        // operator opens a tile into the full chart — feels like the
        // mini-chart is sliding away to make room for the big one.
        withViewTransitions({
          onViewTransitionCreated: ({ transition }) => {
            const kind = sessionStorage.getItem('lascodia.viewTransition.next');
            if (!kind) return;
            sessionStorage.removeItem('lascodia.viewTransition.next');
            document.documentElement.dataset['viewTransition'] = kind;
            // Clean the attribute back off once the transition resolves
            // so subsequent navigations fall back to the default
            // fade-in-up. `.finished` rejects on a skipped transition
            // (e.g. user clicked something else mid-flight) — handle
            // both branches via .finally().
            transition.finished.finally(() => {
              delete document.documentElement.dataset['viewTransition'];
            });
          },
        }),
      ),
      // Order matters: assistant write guard (first, so a write it refuses never retries, toasts or
      // leaves the browser) → auth → CSRF (BFF sign-in) → retry (so retries carry both) → error
      // (final toast, step-up, CSRF refresh) → approval (two-person 202 notice).
      provideHttpClient(
        withXhr(),
        withInterceptors([
          assistantWriteGuardInterceptor,
          authInterceptor,
          csrfInterceptor,
          retryInterceptor,
          errorInterceptor,
          approvalInterceptor,
          serverClockInterceptor,
          // Which engine calls the current page made — the assistant's map of where its data comes from.
          pageApiActivityInterceptor,
        ]),
      ),
      // Who is signed in is settled before the first route renders: guards, the sidebar and every
      // service that reads per-person storage at construction see the final identity and
      // permissions (BFF: GET /bff/session; legacy: a restored admin token's permissions).
      provideAppInitializer(() => inject(AuthService).initialize()),
      provideAnimations(),
      provideEchartsCore({ echarts: loadThemedEcharts }),
      // Once for the app: a touch the browser cancels on any Lightweight Charts chart must not
      // swallow the next tap, on whatever page the chart is.
      provideChartTouchCancel(),
      { provide: ErrorHandler, useClass: GlobalErrorHandler },
      ...sentryProviders(),
      ...webVitalsProviders(),
    ],
  };
}
