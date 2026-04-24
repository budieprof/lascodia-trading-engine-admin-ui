import type { StorybookConfig } from '@storybook/angular';

/**
 * Storybook config targeting Angular 20 standalone components.
 *
 * Addon set is intentionally minimal — `addon-docs` ships inline API docs +
 * Controls + Actions together in Storybook 10, so we don't need the separate
 * `addon-essentials` package that older versions required. Additional addons
 * (a11y, interactions, visual-regression) can be layered on when demand is real.
 *
 * Stories live next to the component they cover under
 * `src/app/shared/components/**\/*.stories.ts` so changes to a component and
 * its stories land in the same diff.
 */
const config: StorybookConfig = {
  stories: ['../src/app/shared/components/**/*.stories.@(ts|mdx)'],
  addons: ['@storybook/addon-docs'],
  framework: {
    name: '@storybook/angular',
    options: {},
  },
};

export default config;
