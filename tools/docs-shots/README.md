# Help-portal screenshots

`capture.js` takes the screenshots the guides in `public/docs-content/*.md` show, from the running console,
and writes `public/docs-content/img/<name>.light.webp` and `<name>.dark.webp` (the guide page shows the one
matching the reader's theme). Re-run it after a UI change so the pictures match the screens.

```bash
# from the repo root; console on :8080 (or BASE=http://localhost:4300 for an unpublished build)
python3 path/to/mint_jwt.py /tmp/docs.tok          # a read-only screenshot token (see "Signing in")
JWT_FILE=/tmp/docs.tok NODE_PATH="$PWD/node_modules" node tools/docs-shots/capture.js            # every shot
JWT_FILE=/tmp/docs.tok NODE_PATH="$PWD/node_modules" node tools/docs-shots/capture.js --guide user-guide
JWT_FILE=/tmp/docs.tok NODE_PATH="$PWD/node_modules" node tools/docs-shots/capture.js --only chart-overview --theme light
```

On this laptop run it through the heavy-job lock (`buildlock.sh heavy -- …`): it is a Chromium.

## Describing a shot

One JSON file per guide in `shots/<guide slug>.json`, an array of:

| Field | Meaning |
| --- | --- |
| `name` | File name stem; the guide shows it as `![Caption](name "/address")`. Lowercase, dashes. |
| `route` | The console address to open, e.g. `/chart-analysis/EURUSD`. |
| `viewport` | `[width, height]`, default `[1440, 900]`. Use `[390, 844]` for a phone. |
| `settle` | Milliseconds to wait after the page loads (default 2500; charts need ~6000). |
| `steps` | Things to do first, in order: `{ "click": "css" }`, `{ "clickText": "Buy", "exact": true }`, `{ "clickRole": ["button", "Buy"] }`, `{ "hover": "css" }`, `{ "fill": ["css", "text"] }`, `{ "select": ["css", 1] }` (option by position; or a label string), `{ "press": "Escape" }`, `{ "scroll": "css" }`, `{ "scrollY": 400 }`, `{ "wait": 500 }`, `{ "waitFor": "css" }`. |
| `marks` | Numbered outlines: `{ "sel": "css", "text": "starts with", "nth": 0, "n": 1, "label": "optional words", "pad": 4 }`. `text` picks the innermost visible element under `sel` whose text starts with it. Number them in the order the guide's steps use them, and refer to them in the text as `((1))`. |
| `spotlight` | `true` dims everything except the FIRST mark. |
| `crop` | `{ "sel": "css", "pad": 24 }`: capture only that element (a dialog, a panel, a card) — sharper and easier to read than a whole page. |
| `clip` | `[x, y, width, height]` in CSS pixels, when no element fits. |
| `hide` | CSS selectors to hide (`visibility: hidden`). |
| `mask` | CSS selectors to blur (anything private the scrub misses). |
| `replace` | `[["regex", "replacement"], …]` extra text replacements. |
| `keepMoney` | `true` keeps money amounts as they are (default: digits shuffled). |
| `noAuth` | `true` for signed-out pages (sign-in, sign-up, the public demo). |

Prefer **crops** of the part of the screen a step is about, plus **one** whole-page shot per page so readers
know where they are. 1–3 marks per shot; more than four is a sign the shot should be split.

## Signing in

Shots run signed in the way customers are (the console's session mode), as a stand-in session: a made-up
person, *Alex Morgan* of *Example Trading*, holding every permission, so every page and button can be shown.
The engine itself only ever sees the read-only screenshot token (a superadmin JWT minted from the engine's
`JWT_SECRET_KEY`, five identity claims + `adminUserId`; see the engine-admin-jwt notes).

## Safety and privacy

- **Engine writes are blocked** at the network layer — only GETs, read-style POSTs (`tools/visual-review/read-posts.js`),
  SignalR, and closing the chart's own script sessions get through. A step that clicks {{Save}} or {{Buy}} cannot
  change anything; it can still open the dialog, which is usually what the picture needs.
- **Every page is scrubbed** before the picture is taken: e-mail addresses, long numbers (account logins, ids),
  the operator's name and money amounts are replaced. Guides are read by every organisation — look at every
  image before publishing, and add `mask` / `replace` for anything else.
- Toasts, the assistant button and the update pill are hidden.
