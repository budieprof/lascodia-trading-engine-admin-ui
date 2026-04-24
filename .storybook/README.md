# Storybook

Storybook 10 is installed against Angular 20. The config lives in this folder
(`main.ts`, `preview.ts`) and stories live next to the components they cover
under `src/app/shared/components/**/*.stories.ts`.

## Run locally

```bash
npm run storybook         # dev server on :6006
npm run storybook:build   # static bundle → storybook-static/
```

## Writing stories

Reference: [`status-badge.stories.ts`](../src/app/shared/components/status-badge/status-badge.stories.ts).
Every shared primitive (`StatusBadge`, `DataTable`, `ChartCard`, `MetricCard`,
`ConfirmDialog`, `FormField`, `TimeRangePicker`, `PresenceBadge`) should
eventually have a `.stories.ts` file.

## Theming in the preview

`preview.ts` exposes a `theme` toolbar toggle. Flipping it sets
`[data-theme="dark"]` on the preview iframe's `<html>`, so stories render
against the real design tokens from `styles.scss`.

## CI

Storybook isn't wired into `.github/workflows/ci.yml` yet. Add a
`storybook-build` job running `npm run storybook:build` when the component
count justifies the per-run cost (~20 primitives with stories is the rough
threshold at which visual regression testing pays off).
