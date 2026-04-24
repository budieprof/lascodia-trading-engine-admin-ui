import { ApplicationConfig, ErrorHandler, provideZoneChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideAnimations } from '@angular/platform-browser/animations';
import { provideEchartsCore } from 'ngx-echarts';
import * as echarts from 'echarts';
import { routes } from './app.routes';
import { authInterceptor } from '@core/auth/auth.interceptor';
import { errorInterceptor } from '@core/auth/error.interceptor';
import { retryInterceptor } from '@core/api/retry.interceptor';
import { RUNTIME_CONFIG, RuntimeConfig } from '@core/config/runtime-config';
import { GlobalErrorHandler } from '@core/errors/global-error-handler';
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
      provideRouter(routes),
      // Order matters: auth → retry (so retries carry the token) → error (final toast).
      provideHttpClient(withInterceptors([authInterceptor, retryInterceptor, errorInterceptor])),
      provideAnimations(),
      provideEchartsCore({ echarts }),
      { provide: ErrorHandler, useClass: GlobalErrorHandler },
    ],
  };
}
