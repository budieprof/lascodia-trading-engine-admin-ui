/// <reference types="vitest" />
//
// Separate Vitest config for Angular component/TestBed tests. The pure-TS unit
// tests in `vitest.config.mts` stay on the zero-plugin path; this config adds
// the Analog Vite plugin + testing-library preset so component specs under
// `*.component.spec.ts` can render templates and drive them via TestBed.
//
// Kept separate because the Analog plugin has historically been brittle across
// Angular minor versions — isolating component tests means a future plugin bug
// doesn't take the whole test suite offline.

import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Component-test config — no Analog Vite plugin.
//
// History of the blocker (keep for future-me):
//   1. On Angular 19.2 we used `@analogjs/vite-plugin-angular@2.4.10`. It
//      rewrote some @angular/core/testing imports to a non-existent
//      `@angular/core/fesm2022/null` path at transform time, then to
//      `/undefined`. A regex alias to a stub module got past resolution but
//      broke getTestBed() via the stubbed import graph.
//   2. After upgrading to Angular 20, tried `@analogjs/vite-plugin-angular@3.0.0-alpha.46`.
//      It requires `@angular/build/private` and bare `vite` imports that aren't
//      exposed as package peer deps, so resolution fails with ERR_MODULE_NOT_FOUND.
//   3. Current state: run component tests without the Analog plugin, relying on
//      Angular's JIT compiler (pulled in via `test-setup.components.ts`).
//      That works for default-render specs but not for cases that vary signal
//      inputs — `setInput` + host-template bindings both fail NG0950 under JIT
//      because signal-input writes don't land before the first detectChanges.
//
// Unblock path: bump Analog to a stable 3.x (not an alpha) once released, or
// switch to `@analogjs/vitest-angular`'s AOT preset when its peer-deps clear.
// Tracking: https://github.com/analogjs/analog/issues (filter by
// "vite-plugin-angular angular 20").
export default defineConfig(({ mode }) => ({
  resolve: {
    alias: [
      { find: '@core', replacement: path.resolve(__dirname, 'src/app/core') },
      { find: '@shared', replacement: path.resolve(__dirname, 'src/app/shared') },
      { find: '@features', replacement: path.resolve(__dirname, 'src/app/features') },
      { find: '@env', replacement: path.resolve(__dirname, 'src/environments') },
    ],
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['src/test-setup.components.ts'],
    include: ['src/**/*.component.spec.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      reportsDirectory: 'coverage-components',
      include: ['src/app/**/*.component.ts'],
    },
  },
  define: {
    'import.meta.vitest': mode !== 'production',
  },
}));
