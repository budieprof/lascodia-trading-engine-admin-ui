import { ApplicationConfig, ErrorHandler, provideZoneChangeDetection } from '@angular/core';
import { provideRouter, withPreloading, withViewTransitions } from '@angular/router';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideAnimations } from '@angular/platform-browser/animations';
import { HoverPreloadingStrategy } from '@core/routing/hover-preloading.strategy';
import { provideEchartsCore } from 'ngx-echarts';
import * as echarts from 'echarts';
import { routes } from './app.routes';
import { authInterceptor } from '@core/auth/auth.interceptor';
import { errorInterceptor } from '@core/auth/error.interceptor';
import { retryInterceptor } from '@core/api/retry.interceptor';
import { RUNTIME_CONFIG, RuntimeConfig } from '@core/config/runtime-config';
import { GlobalErrorHandler } from '@core/errors/global-error-handler';
import { sentryProviders } from '@core/observability/sentry';
import { webVitalsProviders } from '@core/observability/web-vitals';
import { lascodiaTheme, lascodiaDarkTheme } from '../styles/echarts-theme';

// Register both themes at bootstrap so ChartCardComponent can swap between them
// as the user toggles light/dark. Echarts only consults the theme name at
// instance creation, so the chart-card re-renders when the theme signal flips.
echarts.registerTheme('lascodia-light', lascodiaTheme);
echarts.registerTheme('lascodia-dark', lascodiaDarkTheme);

export function buildAppConfig(runtimeConfig: RuntimeConfig): ApplicationConfig {
  return {
    providers: [
      { provide: RUNTIME_CONFIG, useValue: runtimeConfig },
      provideZoneChangeDetection({ eventCoalescing: true }),
      provideRouter(
        routes,
        withPreloading(HoverPreloadingStrategy),
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
      // Order matters: auth → retry (so retries carry the token) → error (final toast).
      provideHttpClient(withInterceptors([authInterceptor, retryInterceptor, errorInterceptor])),
      provideAnimations(),
      provideEchartsCore({ echarts }),
      { provide: ErrorHandler, useClass: GlobalErrorHandler },
      ...sentryProviders(),
      ...webVitalsProviders(),
    ],
  };
}
