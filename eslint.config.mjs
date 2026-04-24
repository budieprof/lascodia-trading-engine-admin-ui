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
