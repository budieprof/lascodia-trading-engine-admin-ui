# Visual review crawl

Playwright scripts used for the 2026-09-06 full-UI review. They screenshot every
route (full page, with tab clicks) and open the known-safe dialogs, recording API
failures, console errors and clipped elements per page.

```bash
# from the repo root, dev server running on :4200, engine on :5081
export NODE_PATH="$PWD/node_modules"
cd tools/visual-review

# JWT must carry the five identity claims (passportId, firstName, lastName,
# email, mobileNo), is_superadmin, and role ["Admin","Operator"] for the
# role-gated routes. Mint one with the engine's JwtSettings__SecretKey.
JWT=$(cat jwt.txt) OUT=shots URLS=urls.txt PERMS_FILE=perms.json TAG=desk node crawl.js
JWT=$(cat jwt.txt) OUT=shots PERMS_FILE=perms.json node modals.js
```

`PERMS_FILE` is the `data.permissions` array from `GET /admin/auth/me` (40 entries
for the superadmin). Both scripts need it: permission-gated routes redirect to the
dashboard before that call answers, which shows up as an empty page in the crawl
and as a selector timeout in `modals.js`.

The JWT also needs an `adminUserId` claim (the `AdminUser.Id`, `1` for `superadmin`)
on top of the claims below — without it `/admin/auth/me` answers
`"Not an admin-user session."` and no permissions come back at all.

`urls.txt` is the full route list including detail routes with representative ids
(strategies/602, backtests/891, positions/6349, ea-instances/68 …); refresh the ids
when those records are gone. `/brokers/:id` takes a **slug**, not a number —
`/brokers/exness`, not `/brokers/1`, which renders "Broker not found".

Keep it one route per line and diff it against the router before trusting a run:
the 2026-09-06 pass silently skipped `/worker-health` for a whole review because
its line had been joined to the next one. To regenerate the route list, compose
each `path:` in `app.routes.ts` with the `path:` values of the feature
`*.routes.ts` it lazily loads, then re-add the ids for the `:id` routes.

`modals.js` only clicks exact, known-safe button labels. Do not switch it to regex
matching — an earlier version clicked "Launch instance" on an EA detail page.
