// Flat ESLint config for the Angular 19 admin UI.
//
// The ruleset is deliberately light: stop typos and obvious bugs without
// fighting the team's existing style. Prettier handles formatting; ESLint
// handles correctness. Two project-wide signals matter most:
//   - `@angular-eslint/no-output-on-prefix` — outputs should not start with `on`.
//   - `@typescript-eslint/no-unused-vars` — surface dead code early.
// Component selector naming follows the codebase's mixed `app-`/`ui-` convention,
// so we don't enforce a single prefix here.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import angular from 'angular-eslint';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
      '.angular/**',
      'public/**',
      '*.config.{js,cjs,mjs,ts,mts}',
      // Build output and scratch scripts, not source. Linting them was the
      // sole reason `npm run lint` exited non-zero: 21 "errors" that are all
      // bundled vendor code (`storybook-static/sb-manager/globals-runtime.js`
      // alone accounted for 12) or one-off workflow scripts.
      'storybook-static/**',
      '.tmp-workflows/**',
    ],
  },
  {
    files: ['**/*.ts'],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommended,
      ...angular.configs.tsRecommended,
    ],
    processor: angular.processInlineTemplates,
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@angular-eslint/component-class-suffix': 'warn',
      '@angular-eslint/directive-class-suffix': 'warn',
      // angular-eslint 22 recommends this as an error. It flags every
      // `ChangeDetectionStrategy.Eager`, including the components Angular's v22
      // `ng update` migration pinned to Eager so they keep their pre-v22
      // behaviour. Moving them to OnPush is a per-component behaviour change,
      // so keep them visible as warnings until each one is reviewed.
      '@angular-eslint/prefer-on-push-component-change-detection': 'warn',
      // Selector style is mixed (`app-` for shared, `ui-` for primitives) — don't enforce.
      '@angular-eslint/component-selector': 'off',
      '@angular-eslint/directive-selector': 'off',
    },
  },
  {
    files: ['**/*.html'],
    extends: [
      ...angular.configs.templateRecommended,
    ],
    rules: {
      '@angular-eslint/template/click-events-have-key-events': 'warn',
      '@angular-eslint/template/interactive-supports-focus': 'warn',
    },
  },
);
