// Serve a production build (dist/) with the same routing as the live Caddy site, so a fix can be
// screenshot-checked before it is published — without `ng serve` (watch servers are too heavy for
// this laptop) and without touching the live console on :8080.
//
// Usage (from the repo root, after `npx ng build --configuration production`):
//   NODE_PATH="$PWD/node_modules" PORT=4300 node tools/visual-review/serve-dist.js
// then point the crawl scripts at it with BASE=http://localhost:4300.
//
// Mirrors Caddyfile: scripting API + hub -> research (:5083); every other /api/* -> api (:5081,
// WebSocket upgrade for SignalR); /health*, /bff/*, /scim/* -> api; everything else static with SPA fallback.
const path = require('path');
const fs = require('fs');
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

const PORT = Number(process.env.PORT || 4300);
const ROOT = path.resolve(__dirname, '../../dist/lascodia-admin/browser');
if (!fs.existsSync(path.join(ROOT, 'index.html'))) {
  console.error(`No build at ${ROOT} — run: npx ng build --configuration production`);
  process.exit(1);
}

const app = express();
const scripting = createProxyMiddleware({
  target: 'http://localhost:5083',
  changeOrigin: true,
  ws: true,
  pathFilter: ['/api/v1/lascodia-trading-engine/scripting', '/api/hubs/scripting'],
});
const api = createProxyMiddleware({
  target: 'http://localhost:5081',
  changeOrigin: true,
  ws: true,
  // /bff and /scim sit at the engine root, like Caddy's @engine_root route; without /bff the sign-in
  // page reports "The engine could not be reached".
  pathFilter: ['/api', '/health', '/bff', '/scim'],
});
app.use(scripting);
app.use(api);

// A plain build ships public/config.json, which points the API at :5081 directly (the dev-server
// setup). Serve it same-origin instead, like the release does, so requests go through the proxy.
app.get('/config.json', (_req, res) => {
  const f = path.join(ROOT, 'config.json');
  const base = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
  res.set('Cache-Control', 'no-store');
  res.json({
    ...base,
    apiBaseUrl: '',
    buildSha: 'local',
    releaseId: 'local-verify',
    environmentLabel: 'verify',
  });
});
app.use(express.static(ROOT, { index: false }));
app.use((_req, res) => res.sendFile(path.join(ROOT, 'index.html')));

const server = app.listen(PORT, () => console.log(`serving ${ROOT} on http://localhost:${PORT}`));
server.on('upgrade', (req, socket, head) => {
  (req.url.startsWith('/api/hubs/scripting') ? scripting : api).upgrade(req, socket, head);
});
