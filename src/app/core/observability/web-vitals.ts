import { APP_INITIALIZER, Provider } from '@angular/core';
import { onCLS, onINP, onLCP, onFCP, onTTFB, type Metric } from 'web-vitals';
import * as Sentry from '@sentry/angular';

/**
 * Reports Core Web Vitals (LCP, INP, CLS) plus FCP / TTFB as Sentry
 * measurements. Lets the Performance tab in Sentry chart page-load quality
 * over time without a separate analytics pipeline. When Sentry isn't
 * initialised, the captures are silent noops.
 */
function report(metric: Metric): void {
  // Log in dev so you see the numbers in the console without leaving the page.
  if (typeof window !== 'undefined' && window.location.hostname === 'localhost') {
     
    console.info(`[web-vitals] ${metric.name}: ${metric.value.toFixed(1)}`);
  }

  // Ship to Sentry as a measurement. Breadcrumb trail is informational; the
  // measurement lands on the active transaction if one exists.
  Sentry.setMeasurement(metric.name, metric.value, metric.name === 'CLS' ? 'none' : 'millisecond');
}

export function webVitalsProviders(): Provider[] {
  return [
    {
      provide: APP_INITIALIZER,
      multi: true,
      useFactory: () => () => {
        if (typeof window === 'undefined') return Promise.resolve();
        onCLS(report);
        onINP(report);
        onLCP(report);
        onFCP(report);
        onTTFB(report);
        return Promise.resolve();
      },
    },
  ];
}
