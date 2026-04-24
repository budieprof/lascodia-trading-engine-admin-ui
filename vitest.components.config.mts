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

// Relies on Angular's JIT compiler (`@angular/compiler` loaded in
// `test-setup.components.ts`). No Analog Vite plugin: the 3.x alphas under
// Angular 20 have unstable peer-dep resolution (`@angular/build/private` /
// devkit imports), and the 2.x series is incompatible with 19.2. Revisit
// when Analog 3.x stabilises.
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
