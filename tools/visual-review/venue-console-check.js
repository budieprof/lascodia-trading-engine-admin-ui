// Write-blocked check of the multi-asset console pages (WS7 7.5–7.10) on a LOCAL production build with STUBBED engine
// answers: nothing reaches any engine — every /api, /health, /bff and hub request is answered in the browser by the
// stubs below, and every non-GET except the two read-POSTs (currency-pair/list, execution-console/ticket/preview,
// both answered locally) is ABORTED and recorded. Prints a JSON summary; screenshots go to OUT.
//
// Usage (repo root, after `npx ng build --configuration production`):
//   OUT=/tmp/shots node tools/visual-review/venue-console-check.js
const path = require('path');
const fs = require('fs');
const express = require('express');
const { chromium } = require('@playwright/test');

const ROOT = path.resolve(__dirname, '../../dist/lascodia-admin/browser');
const OUT = process.env.OUT || path.resolve(__dirname, 'shots-venue');
const PORT = Number(process.env.PORT || 4317);
fs.mkdirSync(OUT, { recursive: true });

// Every permission key of the catalogue (the session is a stubbed super admin).
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
const fx = (symbol, digits, asset = 'Fx') => ({
  symbol, assetClass: asset, exchange: 'OTC', description: symbol, quoteCurrency: symbol.slice(3) || 'USD', tickSize: 10 ** -digits,
  tickValue: 1, multiplier: 100000, quantityUnit: 'Lots', quantityStep: 0.01, minQuantity: 0.01, maxQuantity: 100, priceDecimals: digits,
  displayDistance: 'Pips', tradingCalendarCode: 'fx-24x5', status: 'Active', future: null, crypto: null, equity: null,
});
const INSTRUMENTS = [
  fx('EURUSD', 5), fx('USDJPY', 3),
  { symbol: 'ESZ6', assetClass: 'Future', exchange: 'CME', description: 'E-mini S&P 500 Dec 2026', quoteCurrency: 'USD', tickSize: 0.25, tickValue: 12.5,
    multiplier: 50, quantityUnit: 'Contracts', quantityStep: 1, minQuantity: 1, maxQuantity: 0, priceDecimals: 2, displayDistance: 'Ticks',
    tradingCalendarCode: 'cme-globex', status: 'Active',
    future: { root: 'ES', contractCode: 'ESZ6', expiry: '2026-12-18T00:00:00Z', lastTradeDate: '2026-12-18T00:00:00Z', isFront: true, continuousSymbol: 'ES1!' } },
  { symbol: 'BTC-USDT-PERP', assetClass: 'Crypto', exchange: 'Binance', description: 'BTC perpetual', quoteCurrency: 'USDT', tickSize: 0.1, tickValue: 0.1,
    multiplier: 1, quantityUnit: 'Coins', quantityStep: 0.001, minQuantity: 0.001, maxQuantity: 0, priceDecimals: 1, displayDistance: 'Ticks',
    tradingCalendarCode: 'crypto-24x7', status: 'Active', crypto: { kind: 'Perpetual', settleAsset: 'USDT', fundingIntervalHours: 8 } },
];

/** Stub answer for a GET (or an allowed read-POST) by path. */
function stub(method, p) {
  if (p.endsWith('/admin/auth/me')) return ok({ id: 1, username: 'stub', displayName: 'Stub', email: 'stub@local', isSuperAdmin: true, mustChangePassword: false, roles: ['SuperAdmin'], permissions: PERMS });
  if (p.endsWith('/instruments')) return ok(INSTRUMENTS);
  if (p.endsWith('/execution/adapters')) return ok([
    { kind: 'mt5-ea', requiresCredential: false, capabilities: { entryModel: 'signal-pull', orderTypes: [0, 1, 2], timeInForce: [0], positionStops: true, positionModel: 'both', quantityUnit: 0 } },
    { kind: 'binance-usdm', requiresCredential: true, capabilities: { entryModel: 'direct', orderTypes: [0, 1, 2, 3], timeInForce: [0, 1, 2], positionStops: true, positionModel: 'netting', quantityUnit: 3 } },
  ]);
  if (p.endsWith('/execution/accounts')) return ok([
    { id: 7, name: 'Binance testnet', adapterKind: 'binance-usdm', venue: 'binance', externalAccountId: null, tradingAccountId: null, mode: 'Paper', status: 'Disabled', currency: 'USDT',
      lastConnectResult: null, lastConnectedAtUtc: null, createdAtUtc: '2026-10-27T05:00:00Z',
      credential: { executionAccountId: 7, status: 'RefusedWithdrawalRights', keyFingerprint: 'AbCd…9xYz', observedPermissions: 'trade,withdraw', verifiedAtUtc: null, lastUsedAtUtc: null,
        reason: 'The key has withdrawal or transfer rights. Create a trade-only key (no withdrawals, no transfers) and save it again.' } },
  ]);
  if (p.endsWith('/execution-console/health')) return ok({
    switches: { 'Execution:Router:Enabled': 'false', 'Execution:Entries:Enabled': 'false', 'Execution:Reconciliation:Mode': 'report' },
    accounts: [{ executionAccountId: 7, name: 'Binance testnet', adapterKind: 'binance-usdm', venue: 'binance', mode: 'Paper', status: 'Disabled', tradingAccountId: null,
      credentialStatus: 'RefusedWithdrawalRights', credentialFingerprint: 'AbCd…9xYz', credentialVerifiedAtUtc: null, credentialLastUsedAtUtc: null, lastConnectResult: null,
      lastConnectedAtUtc: null, instructions24h: {}, oldestUnsentAgeSeconds: null, lastFailure: null, lastFailureAtUtc: null, lastFillAtUtc: null, fills24h: 0, fillsCursorUtc: null,
      protectiveLegsWorking: 0, protectiveLegsFailed: 0, health: 'off', problems: [] }],
    workers: [{ workerName: 'ExecutionInstructionDispatcherWorker', isRunning: true, lastSuccessAt: '2026-10-27T06:00:00Z', lastErrorAt: null, lastErrorMessage: null, consecutiveFailures: 0 }],
  });
  if (p.endsWith('/execution/reconciliation')) return ok([
    { adapterKind: 'binance-usdm', executionAccountId: 7, tradingAccountId: null, atUtc: '2026-10-27T06:00:00Z', enginePositions: 1, venuePositions: 0, engineOrders: 0, venueOrders: 1,
      drift: [{ kind: 0, symbol: 'BTC-USDT-PERP', venueId: null, engineId: 55, engineQuantity: 0.01, venueQuantity: null }, { kind: 4, symbol: 'BTC-USDT-PERP', venueId: '991', engineId: null, engineQuantity: null, venueQuantity: 0.02 }], skipped: null },
  ]);
  if (p.endsWith('/reference/fee-schedules')) return ok([
    { id: 1, code: 'cme:es', assetClass: 'Future', venue: 'cme', scope: 'ES', currency: 'USD', commissionPerContract: 0.85, exchangeFeePerContract: 1.38, clearingFeePerContract: null,
      regulatoryFeePerContract: 0.02, makerFeeBps: null, takerFeeBps: null, tierMinVolume30d: null, commissionPerShare: null, commissionBps: null, minCommissionPerOrder: null,
      maxCommissionPctOfNotional: null, secFeePerMillion: null, finraTafPerShare: null, finraTafMaxPerTrade: null, borrowFeeAnnualPct: null, slippageTicks: 1,
      effectiveFromUtc: '2026-01-01T00:00:00Z', effectiveToUtc: null, source: 'NOT a quote — verify', notes: null, createdAtUtc: '2026-10-27T00:00:00Z', updatedAtUtc: '2026-10-27T00:00:00Z', isDeleted: false, inForce: true },
  ]);
  if (p.endsWith('/reference/margin-requirements')) return ok([]);
  if (p.endsWith('/instrument-candles/state')) return ok({ builderEnabled: false, continuousAdjustment: 'Panama',
    cursors: [{ id: 1, symbol: 'ESZ6', kind: 'Instrument', sourceId: 'cme-databento', root: null, builtFromUtc: '2026-10-20T00:00:00Z', builtToUtc: '2026-10-27T05:00:00Z', status: 'Live', note: null, barsWritten: 1200, tradesRead: 50000, tradesExcluded: 10, updatedAtUtc: '2026-10-27T05:00:00Z', lagMinutes: 60 }],
    rolls: [], statusCounts: { Live: 1 } });
  if (p.endsWith('/execution-console/ticket/preview')) return ok({ symbol: 'ESZ6', assetClass: 'Future', instrumentKind: 'Future', quantityUnit: 'Contracts', tickSize: 0.25, tickValue: 12.5,
    multiplier: 50, quantityStep: 1, minQuantity: 1, maxQuantity: 0, priceDecimals: 2, quoteCurrency: 'USD', accountCurrency: 'USD', accountEquity: null, quoteToAccountRate: 1,
    referencePrice: 6000, referencePriceSource: 'limit', bid: null, ask: null, notionalQuote: 300000, notionalAccount: 300000,
    margin: { model: 'futures', initialMargin: 0, maintenanceMargin: 0, liquidationPrice: null, leverage: null, basis: '', refusal: 'no margin requirement for ESZ6 — load its MarginRequirement rows' },
    stopLossPrice: null, takeProfitPrice: null, riskMoney: null, rewardMoney: null, riskPctOfEquity: null, feeEstimate: 2.25, feeBasis: 'cme:es: 2.25 USD per contract per side',
    accountLeverage: null, accountMarginMode: null, multiAssetRiskEnabled: false, sessionOpen: true, sessionKind: 'Regular', valid: false,
    checks: [{ name: 'margin', ok: false, blocking: true, message: 'The margin model refuses: no margin requirement for ESZ6.' }], notes: ['Risk:MultiAsset:Enabled is off: the engine refuses exchange-traded orders until it is on.'] });
  if (p.includes('/instrument-fundamentals/futures/')) return ok({ root: 'ES', exchange: 'CME', description: 'E-mini S&P 500', currency: 'USD', multiplier: 50, continuousSymbol: 'ES1!',
    contractSource: 'master', curve: [{ contract: 'ESZ6', expiryUtc: null, lastTradeUtc: '2026-12-18T00:00:00Z', firstNoticeUtc: null, rollUtc: null, isFront: true, daysToLastTrade: 52, tradeDate: '2026-10-26', sourceId: 'cme-databento', settlement: 6000, settlementFinal: true, openInterest: 2010000, openInterestChange: 10000, volume: 1200000 }],
    slopeAnnualPct: null, totalOpenInterest: 2010000, entitledSources: ['cme-databento'], notes: [] });
  if (p.endsWith('/currency-pair/list')) return ok({ data: [], total: 0 });
  if (/\/prop\/(status|module)/.test(p)) return ok({ available: true, plan: 'stub', message: null });
  return ok([]);
}

(async () => {
  const app = express();
  app.get('/config.json', (_q, r) => {
    const f = path.join(ROOT, 'config.json');
    const base = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
    r.json({ ...base, apiBaseUrl: '', releaseId: 'venue-check', environmentLabel: 'verify', featureFlags: { ...(base.featureFlags ?? {}), bffAuth: false } });
  });
  app.use(express.static(ROOT, { index: false, dotfiles: 'allow' }));
  app.use((_q, r) => r.sendFile(path.join(ROOT, 'index.html'), { dotfiles: 'allow' }));
  const server = app.listen(PORT);
  const BASE = `http://localhost:${PORT}`;

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const blocked = [];
  const answered = [];
  const READ_POSTS = [/\/currency-pair\/list$/, /\/execution-console\/ticket\/preview$/];
  await ctx.route('**/*', (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const engine = url.pathname.startsWith('/api/') || url.pathname.startsWith('/health') || url.pathname.startsWith('/bff') || url.port === '5081' || url.port === '5083';
    if (!engine) return url.hostname === 'localhost' ? route.continue() : route.abort('blockedbyclient');
    const m = req.method();
    if (m !== 'GET' && !(m === 'POST' && READ_POSTS.some((r) => r.test(url.pathname)))) {
      blocked.push(`${m} ${url.pathname}`);
      return route.abort('blockedbyclient');
    }
    if (url.pathname.includes('/hubs/')) return route.abort('blockedbyclient'); // no realtime in a stubbed check
    answered.push(`${m} ${url.pathname}`);
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(stub(m, url.pathname)) });
  });
  await ctx.addInitScript(({ token, perms }) => {
    if (location.pathname === '/login') return;
    sessionStorage.setItem('lascodia.auth.token', token);
    sessionStorage.setItem('lascodia.auth.user', JSON.stringify({ passportId: '1', firstName: 'Stub', lastName: 'Admin', email: 'stub@local' }));
    sessionStorage.setItem('lascodia.auth.perms', JSON.stringify(perms));
  }, { token: JWT, perms: PERMS });

  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text().slice(0, 200)));
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 200)}`));

  const results = {};
  const visit = async (route, name, checks) => {
    await page.goto(BASE + route, { waitUntil: 'networkidle' }).catch(() => {});
    await page.waitForTimeout(800);
    const r = { url: page.url().replace(BASE, '') };
    for (const [k, fn] of Object.entries(checks)) r[k] = await fn().catch((e) => `error: ${String(e).slice(0, 120)}`);
    await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
    results[name] = r;
  };
  const text = (sel) => () => page.locator(sel).first().innerText({ timeout: 4000 });
  const count = (sel) => () => page.locator(sel).count();

  await visit('/connections', 'connections', {
    title: text('h1'),
    refusal: text('text=withdrawal or transfer rights'),
    adapters: count('table >> text=binance-usdm'),
  });
  // Opening the credential form sends nothing (no Save click).
  await page.locator('button', { hasText: 'Replace key' }).first().click().catch(() => {});
  await page.waitForTimeout(300);
  results.connections.credentialForm = await count('input[type="password"]')();
  await page.screenshot({ path: path.join(OUT, 'connections-credential.png'), fullPage: true });

  await visit('/connections/drift', 'drift', { summary: text('text=with drift'), rows: count('tbody tr') });
  await visit('/reference/fee-schedules', 'fee-schedules', { row: text('text=cme:es') });
  await page.locator('button', { hasText: 'Add a row' }).first().click().catch(() => {});
  await page.waitForTimeout(300);
  results['fee-schedules'].formOpen = await count('form >> text=New fee schedule row')();
  await visit('/reference/margin-requirements', 'margin-requirements', { empty: text('text=No margin requirement loaded') });
  await visit('/market-data/instrument-candles', 'instrument-candles', { builder: text('text=builder off'), row: text('text=cme-databento') });
  await visit('/prop/programs', 'prop-programs', { title: text('h1') });

  // Chart: FX symbol has no fundamentals button; the futures contract has it and its ticket is the venue ticket.
  await visit('/chart-analysis/EURUSD', 'chart-eurusd', { fundamentalsButton: count('[data-testid="fundamentals-button"]') });
  await visit('/chart-analysis/ESZ6', 'chart-esz6', { fundamentalsButton: count('[data-testid="fundamentals-button"]') });
  await page.locator('[data-testid="fundamentals-button"]').first().click().catch(() => {});
  await page.waitForTimeout(600);
  results['chart-esz6'].fundamentalsPanel = await count('[data-testid="fundamentals-panel"]')();
  results['chart-esz6'].termStructure = await text('text=Term structure')().catch(() => 'missing');
  await page.screenshot({ path: path.join(OUT, 'chart-esz6-fundamentals.png'), fullPage: false });

  console.log(JSON.stringify({ blockedWrites: blocked, answeredCount: answered.length, results, consoleErrors: [...new Set(consoleErrors)].slice(0, 30) }, null, 2));
  await browser.close();
  server.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
