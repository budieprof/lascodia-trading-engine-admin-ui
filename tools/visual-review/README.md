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
JWT=$(cat jwt.txt) OUT=shots URLS=urls.txt TAG=desk node crawl.js   # writes shots/<slug>.desk.png + crawl.desk.json
JWT=$(cat jwt.txt) OUT=shots node modals.js                          # writes shots/modal.<name>.png
```

`urls.txt` is the full route list including detail routes with representative ids
(strategies/555, backtests/844, positions/6298, ea-instances/56 …); refresh the ids
when those records are gone.

`modals.js` only clicks exact, known-safe button labels. Do not switch it to regex
matching — an earlier version clicked "Launch instance" on an EA detail page.
