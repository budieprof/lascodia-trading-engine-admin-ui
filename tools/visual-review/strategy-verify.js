// Strategy-program UI verification (pages, clicks, selects, element shots) against the LIVE console (via ssh tunnel :8080). Staff stand-in session, EVERY engine write
// aborted except read-style POSTs (feedback: crawlers must block writes). Usage:
//   STAFF_JWT=… OUT=dir STEP=name node tools/visual-review/strategy-verify.js
const fs = require('fs');
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://localhost:8080';
const OUT = process.env.OUT; const JWT = process.env.STAFF_JWT; const STEP = process.env.STEP || 'all';
const { PERMISSIONS } = require('./bff-session.js');
fs.mkdirSync(OUT, { recursive: true });
const log = { blocked: [], errors: [], console: [], shots: [] };
const isApi = (u) => u.startsWith(BASE + '/api/') || u.startsWith(BASE + '/health');
const readPost = (p) => /\/(list|paged|query|summary|equity-curve|recent|latest)$/.test(p) || /\/hubs\/.*negotiate/.test(p);
const session = () => { const n = new Date(); return {
  user: { id: 1, username: 'superadmin', displayName: 'Super Admin', email: 'admin@local' },
  activeTenant: { id: 1, slug: 'house', name: 'House', kind: 'House' },
  memberships: [{ tenantId: 1, slug: 'house', name: 'House', status: 'Active' }],
  permissions: PERMISSIONS, isPlatformStaff: true, impersonation: null, csrfToken: 'verify',
  mfa: { satisfied: true, authTimeUtc: n.toISOString() }, sessionId: 'verify',
  expiresAtUtc: new Date(n.getTime() + 4 * 3600e3).toISOString(), idleTimeoutSeconds: 14400 }; };
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, colorScheme: 'dark' });
  await ctx.route('**/*', async (route) => {
    const req = route.request(); const p = req.url().split('?')[0];
    if (p.startsWith(BASE + '/bff/')) {
      if (p.endsWith('/bff/session')) return route.fulfill({ json: session() });
      if (p.endsWith('/bff/ws-ticket')) return route.fulfill({ json: { ticket: JWT, expiresInSeconds: 30 } });
      return route.fulfill({ status: 204, body: '' });
    }
    if (!isApi(p)) return route.continue();
    const short = p.replace(BASE, '');
    if (!['GET', 'OPTIONS', 'HEAD'].includes(req.method()) && !(req.method() === 'POST' && readPost(short))) {
      log.blocked.push(`${req.method()} ${short}`); return route.abort('blockedbyclient');
    }
    return route.continue({ headers: { ...req.headers(), authorization: `Bearer ${JWT}` } });
  });
  await ctx.addInitScript(() => {
    const N = window.WebSocket; const P = function (u, pr) { return new N(String(u).replace(/([?&])ticket=/, '$1access_token='), pr); };
    P.prototype = N.prototype; Object.assign(P, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 }); window.WebSocket = P;
    try { localStorage.setItem('lascodia.theme', 'dark'); } catch {}
  });
  const page = await ctx.newPage();
  page.on('response', (r) => { if (isApi(r.url()) && r.status() >= 400) log.errors.push(`${r.status()} ${r.request().method()} ${r.url().replace(BASE, '')}`); });
  page.on('console', (m) => { if (m.type() === 'error') log.console.push(m.text().slice(0, 300)); });
  const shot = async (name) => { const f = `${OUT}/${name}.png`; await page.screenshot({ path: f, fullPage: !!process.env.FULL }); log.shots.push(f); };
  const go = async (path) => { await page.goto(BASE + path, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(6000); };
  const steps = {
    performance: async () => { await go('/performance'); await shot('performance'); },
    positions: async () => { await go('/positions'); await shot('positions'); },
    walkforward: async () => { await go('/walk-forward'); await shot('walk-forward'); },
    strategies: async () => { await go('/strategies'); await shot('strategies'); },
    clicks: async () => { await go(process.env.PATHX); await shot((process.env.NAME||'c')+'-0');
      let i = 0; for (const t of (process.env.CLICKS||'').split('|').filter(Boolean)) { i++;
        if (t.startsWith('sel:')) { const sel = page.locator('select').last();
          const v = await sel.evaluate((el, txt) => [...el.options].find(o => o.text.includes(txt))?.value, t.slice(4));
          if (v == null) log.errors.push(`no option ${t}: ` + JSON.stringify(await page.locator("select").evaluateAll(els => els.map(e => [...e.options].map(o => o.text).slice(0,8))))); else await sel.selectOption(v);
          await page.waitForTimeout(6000); await shot(`${process.env.NAME||'c'}-${i}`); continue; }
        const loc = t.startsWith('css:') ? page.locator(t.slice(4)).first() : page.getByText(t, { exact: false }).first();
        try { await loc.click({ timeout: 8000 }); } catch (e) { log.errors.push(`click ${t}: ${e.message.slice(0,120)}`); }
        await page.waitForTimeout(5000);
        if (process.env.SHOTSEL) { const el = page.locator(process.env.SHOTSEL).first(); if (await el.count()) { await el.scrollIntoViewIfNeeded(); await el.screenshot({ path: `${OUT}/${process.env.NAME||'c'}-${i}-el.png` }); } }
        await shot(`${process.env.NAME||'c'}-${i}`); } },
    custom: async () => { await go(process.env.PATHX); await shot(process.env.NAME || 'custom'); },
  };
  for (const [k, fn] of Object.entries(steps)) if (STEP === 'all' ? k !== 'custom' : STEP.split(',').includes(k)) {
    try { await fn(); } catch (e) { log.errors.push(`step ${k}: ${e.message.slice(0, 200)}`); }
  }
  fs.writeFileSync(`${OUT}/log-${STEP.replace(/,/g, '_')}.json`, JSON.stringify(log, null, 2));
  console.log(JSON.stringify({ blocked: log.blocked.length, errors: log.errors, console: log.console.slice(0, 8) }, null, 1));
  await browser.close();
})();
