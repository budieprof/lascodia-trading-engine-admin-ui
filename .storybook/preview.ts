import type { Preview } from '@storybook/angular';
// Global SCSS deferred — Storybook 10 Angular builder doesn't chain
// css-loader after sass-loader, and the app's styles.scss contains
// `@import url(...)` (fonts, tailwindcss, ag-grid) that needs that
// post-sass pass. Stories render with browser defaults until we wire
// `webpackFinal` to inject the missing loader. Tracked as Phase 8 work.

/**
 * Global Storybook preview wiring. Loads the app's design tokens + animations
 * so stories render against the same glass/motion system the real app uses.
 *
 * Toolbar exposes a `theme` global so stories can be previewed in light /
 * dark without editing the component — flipping the toolbar sets
 * `[data-theme="dark"]` on the preview iframe's `<html>`.
 */
const preview: Preview = {
  parameters: {
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/,
      },
    },
  },
  globalTypes: {
    theme: {
      description: 'Lascodia design theme',
      defaultValue: 'light',
      toolbar: {
        title: 'Theme',
        icon: 'paintbrush',
        items: [
          { value: 'light', title: 'Light' },
          { value: 'dark', title: 'Dark' },
        ],
        dynamicTitle: true,
      },
    },
  },
  decorators: [
    (storyFn, context) => {
      const theme = context.globals['theme'] as string;
      document.documentElement.setAttribute('data-theme', theme);
      return storyFn();
    },
  ],
};

export default preview;
