# Generated API Schema

`schema.ts` in this folder is produced by `npm run codegen:api` from the
running engine's Swagger document. It mirrors every endpoint's request +
response shape as TypeScript types, giving us compile-time drift detection
between the UI and the engine.

## Regenerate

```bash
# Against a locally-running engine (default swagger location):
npm run codegen:api

# Against a staging/preview engine:
SWAGGER_URL=https://engine-staging.example/swagger/v1/swagger.json npm run codegen:api
```

Commit the regenerated `schema.ts`. The file is tracked so PRs reveal
API-surface changes alongside the code that consumes them.

## Migrating existing types

`src/app/core/api/api.types.ts` is hand-rolled today. Moving it over is
incremental:

1. Import from `@core/api/_generated/schema` where the shape you want exists.
2. Keep the hand-rolled interface as the public name (`export type OrderDto =
components['schemas']['OrderDto']`) so downstream code doesn't churn.
3. Delete the original declaration once the generated equivalent covers it.

Avoid editing `schema.ts` by hand — the next `codegen:api` run will overwrite it.
