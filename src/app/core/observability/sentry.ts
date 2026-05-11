import { APP_INITIALIZER, Provider, inject } from '@angular/core';
import { Router } from '@angular/router';
import * as Sentry from '@sentry/angular';

import { RUNTIME_CONFIG, type RuntimeConfig } from '@core/config/runtime-config';

/**
 * Sentry wiring for the admin UI. Activated only when `runtime-config.json`
 * supplies a `sentryDsn` — local dev omits it and gets a noop. This keeps the
 * provider graph static (no conditional imports) while making the activation
 * operator-controlled at deploy time.
 *
 * `GlobalErrorHandler` stays as Angular's ErrorHandler — it shows the toast,
 * preserves the console stack, AND calls `captureException` here so the
 * remote report lands alongside the UX feedback. Nothing is replaced.
 */
export interface SentryRuntimeConfig {
  sentryDsn?: string;
  sentryEnvironment?: string;
  sentryRelease?: string;
  sentryTracesSampleRate?: number;
  // Session Replay sample rates. Defaults are conservative: 0% of normal
  // sessions, 100% of error sessions. Operators can bump the session rate
  // (e.g. 0.05) per environment via runtime config without a rebuild.
  sentryReplaysSessionSampleRate?: number;
  sentryReplaysOnErrorSampleRate?: number;
}

export function initSentry(config: RuntimeConfig & SentryRuntimeConfig): void {
  const dsn = config.sentryDsn;
  if (!dsn) return;

  Sentry.init({
    dsn,
    environment: config.sentryEnvironment ?? 'production',
    release: config.sentryRelease,
    tracesSampleRate: config.sentryTracesSampleRate ?? 0.05,
    replaysSessionSampleRate: config.sentryReplaysSessionSampleRate ?? 0,
    replaysOnErrorSampleRate: config.sentryReplaysOnErrorSampleRate ?? 1.0,
    integrations: [
      Sentry.browserTracingIntegration(),
      // Session Replay: mask all text + block all media by default so we
      // never ship trader PnL numbers or strategy parameters to Sentry.
      // The error-sample path is what makes this useful for an operator
      // console — when something breaks, the replay shows what they were
      // looking at without us paying for full-session recording.
      Sentry.replayIntegration({
        maskAllText: true,
        maskAllInputs: true,
        blockAllMedia: true,
      }),
    ],
    // Scrub Authorization headers from network breadcrumbs so engine JWTs
    // don't land in reports.
    beforeBreadcrumb(breadcrumb) {
      if (
        (breadcrumb.category === 'xhr' || breadcrumb.category === 'fetch') &&
        breadcrumb.data &&
        typeof breadcrumb.data === 'object'
      ) {
        delete (breadcrumb.data as Record<string, unknown>)['Authorization'];
      }
      return breadcrumb;
    },
  });
}

/**
 * Thin wrapper so `GlobalErrorHandler` doesn't reach for the SDK directly
 * (keeps the error-handler module free of the `@sentry/angular` import if the
 * DSN is absent — the init function is a noop in that case and `captureException`
 * is a safe noop too, because Sentry degrades gracefully).
 */
export function reportError(error: unknown): void {
  try {
    Sentry.captureException(error);
  } catch {
    /* Sentry never throws, but belt-and-braces. */
  }
}

/**
 * Angular provider bundle: runs `initSentry` once the runtime config is
 * available and wires router tracing so route transitions appear as
 * transactions.
 */
export function sentryProviders(): Provider[] {
  return [
    {
      provide: Sentry.TraceService,
      deps: [Router],
    },
    {
      provide: APP_INITIALIZER,
      multi: true,
      useFactory: () => {
        const cfg = inject(RUNTIME_CONFIG) as RuntimeConfig & SentryRuntimeConfig;
        initSentry(cfg);
        // Touch the trace service so its ctor runs and the router is hooked.
        inject(Sentry.TraceService);
        return () => Promise.resolve();
      },
    },
  ];
}
