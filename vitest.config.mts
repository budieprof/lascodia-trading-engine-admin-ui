/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import path from 'node:path';

/**
 * Vitest config for pure-TS unit tests (services, helpers, validators).
 * Angular component tests (TestBed) are not wired here — the `@analogjs/vite-plugin-angular`
 * integration is unstable on Angular 19.2 (it mis-resolves `@angular/core/testing` imports).
 * Migrate component tests once we upgrade to Angular 20+ or the plugin stabilizes.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@core': path.resolve(__dirname, 'src/app/core'),
      '@shared': path.resolve(__dirname, 'src/app/shared'),
      '@features': path.resolve(__dirname, 'src/app/features'),
      '@env': path.resolve(__dirname, 'src/environments'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['src/test-setup.ts'],
    include: ['src/**/*.spec.ts'],
    // Component specs run under the separate vitest.components.config.mts
    // which wires the Angular test harness; exclude them here so the
    // pure-TS runner doesn't pick them up.
    exclude: ['**/node_modules/**', '**/dist/**', 'src/**/*.component.spec.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      reportsDirectory: 'coverage',
      include: ['src/app/**/*.ts'],
      exclude: ['src/**/*.spec.ts', 'src/test-setup.ts'],
    },
  },
});
