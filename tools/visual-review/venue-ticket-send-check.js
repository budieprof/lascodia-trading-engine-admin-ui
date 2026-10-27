// Write-blocked check of the venue ticket's SEND (multi-asset ticket-send) on a LOCAL production build with STUBBED
// engine answers: nothing reaches any engine. Every /api, /health, /bff and hub request is answered in the browser by
// the stubs below; every non-GET except the two read-POSTs (currency-pair/list, execution-console/ticket/preview — both
// answered locally) is ABORTED and recorded. The Send click is asserted through the intercepted (aborted) request: its
// method, path and body. Prints a JSON summary with `pass`; screenshots go to OUT.
//
// Usage (repo root, after `npx ng build --configuration production`):
//   OUT=/tmp/shots node tools/visual-review/venue-ticket-send-check.js
const path = require('path');
const fs = require('fs');
const express = require('express');
const { chromium } = require('@playwright/test');

const ROOT = path.resolve(__dirname, '../../dist/lascodia-admin/browser');
const OUT = process.env.OUT || path.resolve(__dirname, 'shots-ticket-send');
const PORT = Number(process.env.PORT || 4318);
fs.mkdirSync(OUT, { recursive: true });

const PERMS = [
  ...fs
    .readFileSync(path.resolve(__dirname, '../../src/app/core/auth/permissions.generated.ts'), 'utf8')
    .matchAll(/^\s+[A-Z][A-Za-z0-9]+: '([a-z0-9_.-]+)',$/gm),
].map((m) => m[1]);

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const JWT = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({
  passportId: '1', firstName: 'Stub', lastName: 'Admin', email: 'stub@local', mobileNo: '0',
  adminUserId: '1', is_superadmin: 'true', exp: Math.floor(Date.now() / 1000) + 3600,
  'http://schemas.microsoft.com/ws/2008/06/identity/claims/role': ['SuperAdmin', 'Admin', 'Operator'],
})}.stub`;

const ok = (data) => ({ status: true, message: 'Successful', responseCode: '00', data });
const fx = (symbol, digits) => ({
  symbol, assetClass: 'Fx', exchange: 'OTC', description: symbol, quoteCurrency: symbol.slice(3), tickSize: 10 ** -digits,
  tickValue: 1, multiplier: 100000, quantityUnit: 'Lots', quantityStep: 0.01, minQuantity: 0.01, maxQuantity: 100, priceDecimals: digits,
  displayDistance: 'Pips', tradingCalendarCode: 'fx-24x5', status: 'Active', future: null, crypto: null, equity: null,
});
const INSTRUMENTS = [
  fx('EURUSD', 5),
  { symbol: 'ESZ6', assetClass: 'Future', exchange: 'CME', description: 'E-mini S&P 500 Dec 2026', quoteCurrency: 'USD', tickSize: 0.25, tickValue: 12.5,
    multiplier: 50, quantityUnit: 'Contracts', quantityStep: 1, minQuantity: 1, maxQuantity: 0, priceDecimals: 2, displayDistance: 'Ticks',
    tradingCalendarCode: 'cme-globex', status: 'Active',
    future: { root: 'ES', contractCode: 'ESZ6', expiry: '2026-12-18T00:00:00Z', lastTradeDate: '2026-12-18T00:00:00Z', isFront: true, continuousSymbol: 'ES1!' } },
];
const ACCOUNTS = [
  { id: 3, name: 'CQG demo', adapterKind: 'cqg', venue: 'CME', externalAccountId: null, tradingAccountId: 7, mode: 'Paper', status: 'Active', currency: 'USD',
    lastConnectResult: 'ok', lastConnectedAtUtc: '2026-10-27T05:00:00Z', createdAtUtc: '2026-10-27T05:00:00Z', credential: null },
  { id: 4, name: 'MT5 route', adapterKind: 'mt5-ea', venue: 'mt5', externalAccountId: null, tradingAccountId: 7, mode: 'Live', status: 'Active', currency: 'USD',
    lastConnectResult: null, lastConnectedAtUtc: null, createdAtUtc: '2026-10-27T05:00:00Z', credential: null },
];
const PREVIEW = { symbol: 'ESZ6', assetClass: 'Future', instrumentKind: 'Future', quantityUnit: 'Contracts', tickSize: 0.25, tickValue: 12.5,
  multiplier: 50, quantityStep: 1, minQuantity: 1, maxQuantity: 0, priceDecimals: 2, quoteCurrency: 'USD', accountCurrency: 'USD', accountEquity: 100000,
  quoteToAccountRate: 1, referencePrice: 6000, referencePriceSource: 'limit', bid: null, ask: null, notionalQuote: 300000, notionalAccount: 300000,
  margin: { model: 'futures', initialMargin: 15000, maintenanceMargin: 13600, liquidationPrice: null, leverage: null, basis: 'CME', refusal: null },
  stopLossPrice: 5995, takeProfitPrice: 6010, riskMoney: 250, rewardMoney: 500, riskPctOfEquity: 0.25, feeEstimate: 2.25, feeBasis: 'cme:es',
  accountLeverage: null, accountMarginMode: null, multiAssetRiskEnabled: true, sessionOpen: true, sessionKind: 'Regular', valid: true,
  checks: [{ name: 'margin', ok: true, blocking: true, message: 'Margin 15,000 USD.' }], notes: [] };

function stub(p, switchesOn) {
  if (p.endsWith('/admin/auth/me')) return ok({ id: 1, username: 'stub', displayName: 'Stub', email: 'stub@local', isSuperAdmin: true, mustChangePassword: false, roles: ['SuperAdmin'], permissions: PERMS });
  if (p.endsWith('/instruments')) return ok(INSTRUMENTS);
  if (p.endsWith('/execution/accounts')) return ok(ACCOUNTS);
  if (p.endsWith('/execution-console/health')) return ok({
    switches: { 'Execution:Router:Enabled': String(switchesOn), 'Execution:Entries:Enabled': String(switchesOn), 'Execution:Reconciliation:Mode': 'report' },
    accounts: [], workers: [] });
  if (p.endsWith('/execution-console/ticket/preview')) return ok({ ...PREVIEW, multiAssetRiskEnabled: switchesOn });
  if (p.endsWith('/currency-pair/list')) return ok({ data: [], total: 0 });
  return ok([]);
}

(async () => {
  const app = express();
  app.get('/config.json', (_q, r) => {
    const f = path.join(ROOT, 'config.json');
    const base = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
    r.json({ ...base, apiBaseUrl: '', releaseId: 'ticket-send-check', environmentLabel: 'verify', featureFlags: { ...(base.featureFlags ?? {}), bffAuth: false } });
  });
  app.use(express.static(ROOT, { index: false, dotfiles: 'allow' }));
  app.use((_q, r) => r.sendFile(path.join(ROOT, 'index.html'), { dotfiles: 'allow' }));
  const server = app.listen(PORT);
  const BASE = `http://localhost:${PORT}`;
  const browser = await chromium.launch();
  const blocked = [];
  // Non-engine, non-localhost requests (web fonts): aborted, recorded — nothing leaves the browser.
  const externalAborted = [];
  const READ_POSTS = [/\/currency-pair\/list$/, /\/execution-console\/ticket\/preview$/];

  async function context(switchesOn) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await ctx.route('**/*', (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const engine = url.pathname.startsWith('/api/') || url.pathname.startsWith('/health') || url.pathname.startsWith('/bff') || url.port === '5081' || url.port === '5083';
      if (!engine) {
        if (url.hostname === 'localhost') return route.continue();
        externalAborted.push(url.hostname);
        return route.abort('blockedbyclient');
      }
      const m = req.method();
      if (m !== 'GET' && !(m === 'POST' && READ_POSTS.some((r) => r.test(url.pathname)))) {
        let body = null;
        try { body = req.postDataJSON(); } catch { body = req.postData(); }
        blocked.push({ switchesOn, method: m, path: url.pathname, body });
        return route.abort('blockedbyclient');
      }
      if (url.pathname.includes('/hubs/')) return route.abort('blockedbyclient');
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(stub(url.pathname, switchesOn)) });
    });
    await ctx.addInitScript(({ token, perms }) => {
      if (location.pathname === '/login') return;
      sessionStorage.setItem('lascodia.auth.token', token);
      sessionStorage.setItem('lascodia.auth.user', JSON.stringify({ passportId: '1', firstName: 'Stub', lastName: 'Admin', email: 'stub@local' }));
      sessionStorage.setItem('lascodia.auth.perms', JSON.stringify(perms));
    }, { token: JWT, perms: PERMS });
    return ctx;
  }

  const consoleErrors = [];
  async function openTicket(ctx, symbol) {
    const page = await ctx.newPage();
    page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text().slice(0, 160)));
    page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 160)}`));
    await page.goto(`${BASE}/chart-analysis/${symbol}`, { waitUntil: 'networkidle' }).catch(() => {});
    await page.waitForTimeout(800);
    await page.locator('[data-testid="open-ticket"]').first().click();
    await page.waitForTimeout(600);
    return page;
  }
  const venueTicketPosts = (on) => blocked.filter((b) => b.switchesOn === on && b.path.endsWith('/trade-signal/venue-ticket'));
  const results = {};

  // A. Switches on: Send → confirm step (nothing sent) → Confirm → ONE intercepted POST with the exact body.
  {
    const ctx = await context(true);
    const page = await openTicket(ctx, 'ESZ6');
    const ticket = page.locator('[data-testid="venue-order-ticket"]');
    await ticket.locator('input[aria-label="Limit price"]').fill('6000');
    await ticket.locator('input[aria-label="Limit price"]').dispatchEvent('change');
    await ticket.locator('input[aria-label="Stop loss in ticks"]').fill('20');
    await ticket.locator('input[aria-label="Stop loss in ticks"]').dispatchEvent('change');
    await page.waitForTimeout(1000);
    const submit = ticket.locator('[data-testid="venue-ticket-submit"]');
    const r = {
      venueAccountOptions: await ticket.locator('[data-testid="venue-ticket-account"] option').allInnerTexts(),
      submitEnabled: await submit.isEnabled(),
      typeShown: await ticket.locator('select[aria-label="Order type"]').inputValue(),
      tifShown: await ticket.locator('select[aria-label="Time in force"]').inputValue(),
    };
    await submit.click();
    await page.waitForTimeout(300);
    r.confirmStep = await ticket.locator('[data-testid="venue-ticket-confirm-step"]').innerText().catch(() => null);
    r.postsAfterFirstClick = venueTicketPosts(true).length;
    await page.screenshot({ path: path.join(OUT, 'esz6-confirm.png') });
    await ticket.locator('[data-testid="venue-ticket-confirm"]').click();
    await page.waitForTimeout(800);
    r.posts = venueTicketPosts(true);
    r.result = await ticket.locator('[data-testid="venue-ticket-result"]').innerText().catch(() => null);
    await page.screenshot({ path: path.join(OUT, 'esz6-after-send.png') });
    results.switchesOn = r;
    await ctx.close();
  }

  // B. Switches off: disabled with the engine's reason; a click sends nothing.
  {
    const ctx = await context(false);
    const page = await openTicket(ctx, 'ESZ6');
    const ticket = page.locator('[data-testid="venue-order-ticket"]');
    await ticket.locator('input[aria-label="Limit price"]').fill('6000');
    await ticket.locator('input[aria-label="Limit price"]').dispatchEvent('change');
    await page.waitForTimeout(1000);
    const submit = ticket.locator('[data-testid="venue-ticket-submit"]');
    results.switchesOff = {
      submitEnabled: await submit.isEnabled(),
      why: await ticket.locator('[data-testid="venue-ticket-why"]').innerText().catch(() => null),
    };
    await submit.click({ force: true }).catch(() => {});
    await page.waitForTimeout(300);
    results.switchesOff.posts = venueTicketPosts(false).length;
    await page.screenshot({ path: path.join(OUT, 'esz6-switches-off.png') });

    // C. FX: EURUSD keeps today's ticket, no venue ticket.
    const fxPage = await openTicket(ctx, 'EURUSD');
    results.fx = {
      fxTicket: await fxPage.locator('[data-testid="order-ticket"]').count(),
      venueTicket: await fxPage.locator('[data-testid="venue-order-ticket"]').count(),
    };
    await fxPage.screenshot({ path: path.join(OUT, 'eurusd-ticket.png') });
    await ctx.close();
  }

  const a = results.switchesOn;
  const post = a.posts[0];
  const pass =
    a.submitEnabled === true && a.typeShown === 'Limit' && a.tifShown === 'Gtc' &&
    a.venueAccountOptions.length === 2 && // "none" + the CQG account (the MT5 route is not offered)
    !!a.confirmStep && /second authorised person/.test(a.confirmStep) &&
    a.postsAfterFirstClick === 0 &&
    a.posts.length === 1 && post.method === 'POST' &&
    post.body && post.body.executionAccountId === 3 && post.body.symbol === 'ESZ6' && post.body.price === 6000 &&
    post.body.quantity === 1 && post.body.stopLossTicks === 20 && post.body.timeInForce === 'Gtc' &&
    results.switchesOff.submitEnabled === false && /Venue tickets are switched off/.test(results.switchesOff.why || '') &&
    results.switchesOff.posts === 0 &&
    results.fx.fxTicket === 1 && results.fx.venueTicket === 0;

  console.log(JSON.stringify({ pass, results, blockedWrites: blocked.map((b) => `${b.method} ${b.path}`), externalAborted: [...new Set(externalAborted)], consoleErrors: [...new Set(consoleErrors)].slice(0, 20) }, null, 2));
  await browser.close();
  server.close();
  process.exit(pass ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
