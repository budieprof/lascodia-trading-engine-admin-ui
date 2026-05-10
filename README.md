# Lascodia Trading Engine — Admin UI

Single-page admin for the Lascodia Automated Forex Trading Engine. Angular 19, standalone components + signals, custom Apple-inspired design system, Tailwind v4 + SCSS tokens, ag-grid + echarts.

For the end-to-end feature roadmap see [UPGRADE_PLAN.md](UPGRADE_PLAN.md). For the detailed product spec see [PRD.md](PRD.md).

## Quick start

```bash
npm install
npm start              # dev server on http://localhost:4200
```

The dev server proxies to the API at `http://localhost:5081` by default (see [public/config.json](public/config.json)).

## Scripts

| Script                  | Purpose                                                         |
| ----------------------- | --------------------------------------------------------------- |
| `npm start`             | `ng serve` on port 4200                                         |
| `npm run build`         | Production build (output: `dist/lascodia-admin/browser/`)       |
| `npm run watch`         | Development build with watch mode                               |
| `npm test`              | Vitest unit tests (one-shot)                                    |
| `npm run test:watch`    | Vitest in watch mode                                            |
| `npm run test:coverage` | Vitest + v8 coverage report                                     |
| `npm run e2e:install`   | Download Playwright browsers (one-time)                         |
| `npm run e2e`           | Playwright smoke tests (starts a dev server if none is running) |
| `npm run e2e:ui`        | Playwright interactive runner                                   |

## Runtime configuration

The Angular bundle is environment-agnostic. At boot the app fetches [public/config.json](public/config.json) before bootstrapping, and the API base URL is provided via the `RUNTIME_CONFIG` injection token ([src/app/core/config/runtime-config.ts](src/app/core/config/runtime-config.ts)).

To retarget the API without rebuilding:

- **Local dev**: edit `public/config.json`.
- **Docker**: set `API_BASE_URL` when running the container — the entrypoint rewrites `/usr/share/nginx/html/config.json` on start.

## Docker

```bash
docker build -t lascodia-admin .
docker run --rm -p 8080:80 -e API_BASE_URL=https://engine.example.com lascodia-admin
# http://localhost:8080
```

Nginx config lives in [docker/nginx.conf](docker/nginx.conf) — SPA fallback, long-cache for hashed bundles, `no-store` for `config.json` and `index.html`, plus CSP / X-Frame-Options / Permissions-Policy headers.

## Project layout

```
src/app/
  core/                 # services, interceptors, config, polling, envelope
  shared/               # DataTable, ChartCard, StatusBadge, feedback/*, command-palette/*
  features/             # one folder per feature module
  layout/               # sidebar, header, breadcrumbs, layout shell
```

Path aliases (configured in [tsconfig.json](tsconfig.json) and mirrored in [vitest.config.mts](vitest.config.mts)):

| Alias         | Resolves to          |
| ------------- | -------------------- |
| `@core/*`     | `src/app/core/*`     |
| `@shared/*`   | `src/app/shared/*`   |
| `@features/*` | `src/app/features/*` |
| `@env/*`      | `src/environments/*` |

## Testing

**Unit (Vitest)** — current coverage targets the core primitives: envelope unwrapping ([api.envelope.spec.ts](src/app/core/api/api.envelope.spec.ts)), optimistic updates ([optimistic-update.spec.ts](src/app/core/api/optimistic-update.spec.ts)), and app validators ([app-validators.spec.ts](src/app/shared/validators/app-validators.spec.ts)). 22 tests today.

**E2E (Playwright)** — scaffolded at [playwright.config.ts](playwright.config.ts) with backend-independent smoke specs in [e2e/](e2e/): bundle mounts, sidebar navigation, ⌘K opens the palette, `?` opens the keyboard-help overlay. The `webServer` block starts `npm start` automatically if `E2E_BASE_URL` isn't set.

**Angular component tests (TestBed)** — deferred. `@analogjs/vite-plugin-angular@2.4.10` mis-resolves `@angular/core/testing` on Angular 19.2, so component-level `TestBed` specs need to wait for either an Angular 20 upgrade or a plugin fix.

## Keyboard shortcuts

Beyond ⌘K / Ctrl+K (command palette) the app exposes `g`-prefix two-key navigation and a help overlay. Press `?` anywhere to see the current list — it's driven by [KeyboardShortcutsService](src/app/core/keyboard/keyboard-shortcuts.service.ts) and rendered by [keyboard-help.component.ts](src/app/shared/components/keyboard-help/keyboard-help.component.ts).

## Accessible forms

Wrap Reactive Forms controls in `<app-form-field>` ([form-field.component.ts](src/app/shared/components/form-field/form-field.component.ts)) and apply the `appFormFieldControl` directive to the input. The wrapper handles implicit label association, required/invalid semantics, `aria-describedby` for inline errors, and error display from a `AbstractControl`.

```html
<app-form-field label="Lot Size" [required]="true" [control]="form.controls.lotSize">
  <input appFormFieldControl formControlName="lotSize" type="number" step="0.01" />
</app-form-field>
```

Reference migration: [risk-profiles-page.component.ts](src/app/features/risk-profiles/pages/risk-profiles-page/risk-profiles-page.component.ts). Other feature forms still use the sibling `<label>`/`<input>` pattern and can be migrated opportunistically.

## CI

GitHub Actions workflow at [.github/workflows/ci.yml](.github/workflows/ci.yml):

- `build-test` — Vitest + production build on every push and PR.
- `e2e` — Playwright smoke tests on top of the built bundle.
- `docker` — Buildx image on `main` pushes with GHA cache.

## State management

One rule, codified after v2 Phase 0:

- **Hot data → signal store.** Anything that ticks frequently (positions P&L, prices, pending signals, kill-switch state, system logs) lives in an `@ngrx/signals` store under [src/app/core/stores/](src/app/core/stores/). Mutations dispatched from anywhere in the app; reads via the store's exposed signals. This is where push channels (Phase 7) land.
- **Cold reads → service + `createPolledResource`.** Anything fetched on-demand or refreshed every 30s+ (config, audit trail, backtests, walk-forward, alerts) stays as a stateless service that returns observables/promises, consumed via [`createPolledResource`](src/app/core/polling/polled-resource.ts) for component-scoped polling.

If you're tempted to mix the two — e.g. add a service for hot data, or put cold reads in a store — push back. The reason for the split is testability and refresh semantics: stores are tested with deterministic dispatch sequences; services are tested with mock HTTP. Mixing them muddies both.

## Storybook

Stories live next to each shared primitive under [src/app/shared/components/](src/app/shared/components/) as `*.stories.ts`. Run `npm run storybook` for the dev server, `npm run storybook:build` for the static bundle.

The Storybook config in [.storybook/](.storybook/) uses the Angular builder (`@storybook/angular:start-storybook`); legacy CLI invocation is no longer supported in Storybook 10. The preview iframe currently renders stories without the app's global SCSS — the Storybook webpack chain doesn't include css-loader after sass-loader, which breaks the `@import url(...)` lines in [styles.scss](src/styles.scss). Stories use browser defaults plus component-scoped styles. Wiring the full token stack is tracked as Phase 8 follow-up work.

## Shared primitives worth knowing

- **`createPolledResource`** — [polled-resource.ts](src/app/core/polling/polled-resource.ts). Component-scoped polling with automatic pause on `visibilitychange`.
- **`runOptimistic`** — [optimistic-update.ts](src/app/core/api/optimistic-update.ts). Signal-backed optimistic mutation with automatic rollback.
- **`ApiService.getEnvelope` / `postEnvelope` / `putEnvelope` / `deleteEnvelope`** — unwrap `ResponseData<T>` or throw `ApiError`.
- **Feedback components** — [offline-banner](src/app/shared/components/feedback/offline-banner.component.ts), [paper-mode-banner](src/app/shared/components/feedback/paper-mode-banner.component.ts), [kill-switch-banner](src/app/shared/components/feedback/kill-switch-banner.component.ts), [rate-limit-strip](src/app/shared/components/feedback/rate-limit-strip.component.ts), [empty-state](src/app/shared/components/feedback/empty-state.component.ts), [error-state](src/app/shared/components/feedback/error-state.component.ts), [table-skeleton](src/app/shared/components/feedback/table-skeleton.component.ts), [card-skeleton](src/app/shared/components/feedback/card-skeleton.component.ts).
- **Command palette** — [command-palette.component.ts](src/app/shared/components/command-palette/command-palette.component.ts). Global ⌘K / Ctrl+K, fuzzy filter across every route.

## Engine prerequisites

The admin UI talks to:

- **`api/v1/lascodia-trading-engine/*`** — the .NET 10 engine (port 5081 by default).

Start the engine separately; the admin UI has no embedded mock server.

## License

Private / proprietary. Not for redistribution.
