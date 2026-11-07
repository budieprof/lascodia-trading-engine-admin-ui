// Write-blocked check of the News Intel cockpit tabs (news-intel program, 2026-11-07) on a LOCAL production build
// with STUBBED engine answers: nothing reaches any engine — every /api, /health, /bff and hub request is answered in
// the browser by the stubs below, and every non-GET except the read-POST currency-pair/list is ABORTED and recorded.
// No click in this script presses a write button. Prints a JSON summary; screenshots go to OUT.
//
// Usage (repo root, after `npx ng build --configuration production`):
//   OUT=/tmp/shots node tools/visual-review/news-intel-check.js        (NI_STUDY_404=1: event study answers 404;
//   NI_GAPS_404=1: the gaps endpoints — coverage, exposures, risk-observations, story members, vendor verify — answer 404,
//   i.e. an engine before ni/gaps, so the fallbacks render)
const path = require('path');
const fs = require('fs');
const express = require('express');
const { chromium } = require('@playwright/test');

const ROOT = path.resolve(__dirname, '../../dist/lascodia-admin/browser');
const OUT = process.env.OUT || path.resolve(__dirname, 'shots-news-intel');
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
const now = Date.now();
const iso = (minAgo) => new Date(now - minAgo * 60_000).toISOString();

const CONFIG = [
  ['NewsIntel:Enabled', 'true', 'Bool'], ['NewsIntel:Prompt:Enabled', 'true', 'Bool'],
  ['NewsIntel:Currencies', 'USD,EUR,GBP,JPY,AUD,NZD,CAD,CHF,XAU', 'String'], ['NewsIntel:Exposures', '', 'String'],
  ['NewsIntel:Exposures:Recommended', 'USD,EUR,GBP,JPY,XAU,WTI,BRENT,IDX:US500,IDX:NAS100,EQ:AAPL,EQ:MSFT,CR:BTC,CR:MARKET,F:RISK,F:USRATES', 'String'],
  ['NewsIntel:Ingest:SearchQueriesJson', '{"USD":"(Federal Reserve OR \\"US economy\\") when:1d"}', 'Json'],
  ['NewsIntel:Ingest:SecUserAgent', '', 'String'],
  ['NewsIntel:Vendor:Polygon:Enabled', 'true', 'Bool'], ['NewsIntel:Vendor:Polygon:ApiKey', '***UNSET', 'String'],
  ['NewsIntel:Vendor:Finnhub:ApiKey', '***SET', 'String'], ['NewsIntel:Story:Mode', 'Observe', 'String'],
  ['NewsIntel:Weight:CategorySeverityJson', '{"MonetaryPolicy":0.9,"Inflation":0.8,"Growth":0.6,"Earnings":0.5,"Other":0.25}', 'Json'],
  ['NewsIntel:BreakingGate:Mode', 'Observe', 'String'], ['NewsIntel:Prompt:DirectionMode', 'Full', 'String'],
].map(([key, value, dataType]) => ({ key, value, dataType, description: `stub ${key}`, isHotReloadable: true }));

const legs = (s) => {
  if (s === 'AAPL') return { ex: [['EQ:AAPL', 1, 'own'], ['IDX:US500', 0.25, 'constituent'], ['USD', 0.3, 'factor:static']], cal: ['EQ:AAPL', 'USD'] };
  if (s === 'USOIL') return { ex: [['WTI', 1, 'own'], ['USD', 0, 'quote'], ['F:RISK', 0.2, 'factor:static']], cal: ['WTI', 'USD'] };
  if (s === 'BTCUSD') return { ex: [['CR:BTC', 1, 'own'], ['CR:MARKET', 0.5, 'factor:fitted'], ['USD', -1, 'quote']], cal: ['USD'] };
  return { ex: [[s.slice(0, 3), 1, 'base'], [s.slice(3), -1, 'quote']], cal: [s.slice(0, 3), s.slice(3)] };
};
const TRACKED = new Set(['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'NZD', 'CAD', 'CHF', 'XAU']);
const focus = (s) => {
  const { ex, cal } = legs(s);
  const ctxLegs = ex.map(([key, weight, basis]) => {
    const covered = TRACKED.has(key);
    return { key, weight, basis, covered, score: covered ? 0.12 : null, contribution: covered ? 0.12 * weight : null, absolutePressure: covered ? 0.3 : null, storyCount: covered ? 3 : null };
  });
  const multi = !['EURUSD', 'GBPUSD', 'USDJPY'].includes(s);
  return {
    context: { baseLeg: null, quoteLeg: null, pairBias: multi ? null : 0.05, asOfNote: 'stub', paramsFingerprint: 'fp1', legs: ctxLegs,
      symbolBias: multi ? null : 0.05, coverage: multi ? 0.3 : 1, multiLeg: multi },
    includedInPrompt: !multi, omissionReason: multi ? 'own leg untracked' : null, baseCurrency: ex[0][0], quoteCurrency: null,
    exposure: { symbol: s, legs: ex.map(([key, weight, basis]) => ({ key, weight, basis })), calendarKeys: cal, source: 'catalogue' },
    risk: { volatility: { multiplier: 1.18, absolutePressure: 0.42, scheduledHighEvents: 1, horizonMinutes: 60, pressureCoefficient: 0.25, eventCoefficient: 0.5, source: 'study:#3' },
      breakingStories: s === 'EURUSD' ? [{ articleId: 9, headline: 'ECB makes unscheduled statement', source: 'ECB', key: 'EUR', legWeight: 1, category: 'MonetaryPolicy', certainty: 'Official', severity: 0.9, magnitude: 0.8, firstSeenUtc: iso(5), pauseUntilUtc: iso(-25) }] : [],
      scheduledEvents: [{ key: 'USD', title: 'US CPI', scheduledAtUtc: iso(-40), impact: 'High', source: 'calendar' }] },
  };
};
const STUDY_RESULTS = [];
for (const [b, n, m] of [['MonetaryPolicy', 140, 0.06], ['Inflation', 90, -0.02], ['Growth', 60, -0.09], ['Earnings', 12, 0.3]]) {
  for (const h of [15, 60]) STUDY_RESULTS.push({ section: 'group', dimension: 'category', bucket: b, horizonMinutes: h, n, clusters: Math.round(n * 0.7), mean: m, hitRate: 0.5 + m, tStat: m * 20, ciLow: m - 0.08, ciHigh: m + 0.08 });
}
for (const t of ['severity', 'reliability', 'certainty', 'decay']) STUDY_RESULTS.push({ section: 'term-ic', dimension: t, bucket: t, horizonMinutes: 60, n: 300, clusters: 200, mean: 0.02, hitRate: null, tStat: null, ciLow: -0.03, ciHigh: 0.07 });
const RUN = { id: 3, status: 'Completed', trigger: 'nightly', requestedBy: null, fromUtc: iso(60 * 24 * 30), toUtc: iso(60), lineageFilter: null, paramsFingerprint: 'fp1',
  labelsConsidered: 5400, observations: 21000, alignmentVerdict: 'Inconclusive', alignmentHorizonMinutes: 60, alignmentMean: -0.01, alignmentCiLow: -0.04, alignmentCiHigh: 0.02,
  coverageJson: '{"EURUSD":{"M1":true}}', volCalibrationJson: '{"bands":[]}', summaryJson: '{"lineages":["legacy"]}', error: null, startedAtUtc: iso(300), completedAtUtc: iso(280) };

const UNIVERSE = ['EURUSD', 'GBPUSD', 'USDJPY', 'AAPL', 'USOIL', 'BTCUSD'];
const coverageRow = (s) => {
  const f = focus(s);
  const fx = ['EURUSD', 'GBPUSD', 'USDJPY'].includes(s);
  return {
    symbol: s, assetClass: fx ? 'FX' : s === 'AAPL' ? 'Stock' : s === 'USOIL' ? 'Energy' : 'Crypto', source: 'catalogue',
    legs: f.context.legs.map((l) => ({ key: l.key, kind: null, weight: l.weight, basis: l.basis, covered: l.covered, score: l.score,
      contribution: l.contribution, absolutePressure: l.absolutePressure, newestItemAgeMinutes: l.covered ? 14 : null })),
    coverage: f.context.coverage, symbolBias: f.context.symbolBias, newestItemAgeMinutes: 14, includedInPrompt: f.includedInPrompt,
    omissionReason: f.omissionReason, calendarKeys: f.exposure.calendarKeys,
    legacyEnforced: fx ? f.exposure.calendarKeys : [], modeGoverned: fx ? [] : ['USD'],
    scheduledEventKeys: fx ? [] : f.exposure.calendarKeys, blockingKeys: fx ? f.exposure.calendarKeys : [],
    riskObservations7d: s === 'AAPL' ? 2 : 0, problem: null,
  };
};
const OBS = [
  { id: 2, kind: 'ScheduledEventBlackout', mode: 'Observe', symbol: 'AAPL', key: 'EQ:AAPL', eventRef: 'sched:7', storyId: null, observedAtUtc: iso(30), eventAtUtc: iso(10), detail: 'Earnings: Apple Q4 earnings' },
  { id: 1, kind: 'MultiAssetBlackout', mode: 'Observe', symbol: 'AAPL', key: 'USD', eventRef: 'econ:44', storyId: null, observedAtUtc: iso(90), eventAtUtc: iso(80), detail: 'CPI y/y' },
];

// NI_FIXTURES=<dir>: answer news-intel GETs from captured engine responses (one JSON envelope per file, named by
// path: `status.json`, `eval_runs_2.json`, `focus_<SYMBOL>.json`, `stories_X_articles.json`, `config_blackout.json`)
// so the cockpit renders at real density. Capture them read-only from a live engine; anything not captured falls
// back to the stubs below. Fixtures hold live headlines — keep them outside the repo.
const FIX = process.env.NI_FIXTURES;
function fixture(p, q) {
  if (!FIX) return null;
  let name = null;
  if (p.includes('/config/NewsBlackout')) name = 'config_blackout';
  const at = p.indexOf('/news-intel/');
  if (!name && at >= 0) {
    const rest = p.slice(at + '/news-intel/'.length);
    if (rest === 'focus') name = `focus_${(q.get('symbol') || 'EURUSD').toUpperCase()}`;
    else if (/^stories\/\d+\/articles$/.test(rest)) name = 'stories_X_articles';
    else name = rest.replace(/\//g, '_');
  }
  if (!name) return null;
  const file = path.join(FIX, `${name}.json`);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function stub(method, p, q) {
  const fx = fixture(p, q);
  if (fx) return fx;
  const notFound = { status: 404 };
  const gaps404 = !!process.env.NI_GAPS_404;
  if (p.endsWith('/news-intel/coverage')) return gaps404 ? notFound : ok({ asOfUtc: iso(0), computedAtUtc: iso(0), cached: false, moduleEnabled: true,
    multiAssetMode: 'Observe', tracked: [...TRACKED], pressureKeysComputed: 14, symbols: UNIVERSE.map(coverageRow), untrackedKeysNeeded: ['EQ:AAPL', 'WTI', 'CR:BTC', 'F:RISK'] });
  if (p.endsWith('/news-intel/exposures')) return gaps404 ? notFound : ok({ tracked: [...TRACKED], recommended: ['WTI', 'IDX:US500', 'EQ:AAPL', 'F:NOPE'], searchEnabled: true,
    searchTerms: [
      { key: 'USD', kind: 'Currency', tracked: true, recommended: true, term: '(Federal Reserve OR "US economy") when:1d', source: 'config', polled: true },
      { key: 'EUR', kind: 'Currency', tracked: true, recommended: true, term: '(ECB OR eurozone) when:1d', source: 'shipped-default', polled: true },
      { key: 'XAU', kind: 'Commodity', tracked: true, recommended: true, term: null, source: 'none', polled: false },
      { key: 'WTI', kind: 'Commodity', tracked: false, recommended: true, term: '("crude oil" OR OPEC) when:1d', source: 'built-in', polled: false },
      { key: 'EQ:AAPL', kind: 'Equity', tracked: false, recommended: true, term: '("Apple" stock OR "Apple" earnings) when:1d', source: 'built-in', polled: false },
    ] });
  if (p.endsWith('/news-intel/risk-observations')) {
    if (gaps404) return notFound;
    const sym = (q.get('symbol') || '').toUpperCase();
    const items = OBS.filter((o) => !sym || o.symbol === sym);
    return ok({ fromUtc: iso(60 * 24 * 7), toUtc: iso(0), total: items.length, countsByKind: { ScheduledEventBlackout: 1, MultiAssetBlackout: 1 },
      counts: [{ kind: 'ScheduledEventBlackout', symbol: 'AAPL', mode: 'Observe', count: 1, lastObservedAtUtc: iso(30) }, { kind: 'MultiAssetBlackout', symbol: 'AAPL', mode: 'Observe', count: 1, lastObservedAtUtc: iso(90) }], items });
  }
  if (/\/news-intel\/stories\/\d+\/articles$/.test(p)) return gaps404 ? notFound : ok({
    story: { id: 11, eventKey: 'fed-rate-decision-2026-11', title: 'Fed holds rates steady', firstArticleId: 1, firstSeenUtc: iso(300), lastSeenUtc: iso(30), exposures: 'USD,F:USRATES', state: 'Confirmed', stateChangedAtUtc: iso(200), deniedAtUtc: null, resolvedAtUtc: null, articleCount: 2, publisherCount: 2, lastMatchBasis: 'event-key', publishers: ['Federal Reserve', 'Reuters'] },
    articles: [
      { id: 1, title: 'Fed leaves rates unchanged', sourceName: 'Federal Reserve', sourceKind: 'CentralBank', url: null, publishedAtUtc: iso(301), firstSeenUtc: iso(300), classificationStatus: 'Completed', eventKey: 'fed-rate-decision-2026-11', stance: 'Asserts', isOrigin: true,
        labels: [{ exposureKey: 'USD', category: 'MonetaryPolicy', direction: 'Neutral', certainty: 'Official', novelty: 'New', relevance: 0.95, confidence: 0.9 }] },
      { id: 2, title: 'FOMC holds steady as officials signal patience', sourceName: 'Reuters', sourceKind: 'Rss', url: 'https://example.com/a', publishedAtUtc: iso(40), firstSeenUtc: iso(30), classificationStatus: 'Completed', eventKey: 'fed-rate-decision-2026-11', stance: 'Asserts', isOrigin: false,
        labels: [{ exposureKey: 'USD', category: 'MonetaryPolicy', direction: 'Neutral', certainty: 'Confirmed', novelty: 'FollowUp', relevance: 0.9, confidence: 0.85 }] },
    ] });
  if (/\/news-intel\/vendors\/[^/]+\/verify$/.test(p)) return gaps404 ? notFound : ok({ vendor: 'Finnhub', keySet: true, keyFingerprint: '3fa9c01b', keyLength: 32, ok: false, status: 'http-error',
    httpStatus: 401, itemsParsed: null, error: 'vendor answered HTTP 401: {"error":"Invalid API key ***"}', enabled: false, checkedAtUtc: iso(0), elapsedMs: 312 });
  if (p.endsWith('/admin/auth/me')) return ok({ id: 1, username: 'stub', displayName: 'Stub', email: 'stub@local', isSuperAdmin: true, mustChangePassword: false, roles: ['SuperAdmin'], permissions: PERMS });
  if (p.endsWith('/currency-pair/list')) return ok({ data: ['EURUSD', 'GBPUSD', 'USDJPY', 'AAPL', 'USOIL', 'BTCUSD'].map((symbol, id) => ({ id, symbol, isActive: true })), pager: { totalItemCount: 6 } });
  if (p.endsWith('/news-intel/config')) return ok(CONFIG);
  if (p.endsWith('/news-intel/focus')) return ok(focus((q.get('symbol') || 'EURUSD').toUpperCase()));
  if (p.endsWith('/news-intel/pressure')) return ok([{ currency: 'USD', asOfUtc: iso(0), weightedScore: 0.1, absolutePressure: 0.3, articleCount: 4, storyCount: 2, dominantCategory: 'Inflation', paramsFingerprint: 'fp1',
    topContributors: [{ articleId: 1, title: 'Fed holds', sourceName: 'Reuters', currency: 'USD', ageMinutes: 35, weight: 0.4, signedWeight: 0.4, storyId: 11 }] }]);
  if (p.endsWith('/news-intel/status')) return ok({ enabled: true, windowHours: 24, articlesByStatus: { Completed: 400, Skipped: 200 },
    channelBreakdown: [{ kind: 'Rss', count: 300, publishers: 7, newest: iso(4), staleMinutes: 4, stale: false }, { kind: 'Search', count: 500, publishers: 90, newest: iso(20), staleMinutes: 20, stale: false }, { kind: 'Filing', count: 0, publishers: 0, newest: iso(3000), staleMinutes: 3000, stale: true }],
    sourceBreakdown: [], latestPressure: [],
    latency: [{ channel: 'Rss', source: null, windowHours: 24, count: 300, p50Minutes: 6, p90Minutes: 25 }, { channel: 'Rss', source: null, windowHours: 168, count: 2000, p50Minutes: 18, p90Minutes: 60 },
      { channel: 'Search', source: null, windowHours: 168, count: 4000, p50Minutes: 70, p90Minutes: 1020 }, { channel: 'Rss', source: 'Reuters', windowHours: 168, count: 400, p50Minutes: 9, p90Minutes: 31 }],
    feeds: [{ url: 'https://feeds.example.com/rss/markets.xml', lastStatus: 304, lastPolledUtc: iso(1), notModifiedStreak: 12, hasValidators: true }, { url: 'https://www.eia.gov/rss/press_rss.xml', lastStatus: 200, lastPolledUtc: iso(2), notModifiedStreak: 0, hasValidators: false }],
    sourceNotes: ['sec-edgar: OFF — set NewsIntel:Ingest:SecUserAgent to "<Company> <contact email>" (SEC fair-access policy requires it).', 'vendor Polygon: enabled but NewsIntel:Vendor:Polygon:ApiKey is empty — not polled.'] });
  if (p.endsWith('/news-intel/scheduled-events')) return ok([
    { id: 1, exposureKey: 'WTI', kind: 'Inventories', scheduledAtUtc: iso(-60 * 26), impact: 'High', title: 'EIA Weekly Petroleum Status Report', source: 'computed', firstSeenUtc: iso(6000), notes: 'computed', actual: null },
    { id: 2, exposureKey: 'EQ:AAPL', kind: 'Earnings', scheduledAtUtc: iso(-60 * 50), impact: 'High', title: 'Apple Inc earnings', source: 'nasdaq', firstSeenUtc: iso(9000), notes: null, actual: null },
    { id: 3, exposureKey: 'IDX:US500', kind: 'OptionsExpiry', scheduledAtUtc: iso(-60 * 50), impact: 'Medium', title: 'Monthly options expiry', source: 'computed', firstSeenUtc: iso(9000), notes: null, actual: null }]);
  if (p.endsWith('/news-intel/stories')) return ok([{ id: 11, eventKey: 'fed-rate-decision-2026-11', title: 'Fed holds rates steady', firstArticleId: 1, firstSeenUtc: iso(300), lastSeenUtc: iso(30), exposures: 'USD,F:USRATES', state: 'Confirmed', stateChangedAtUtc: iso(200), deniedAtUtc: null, resolvedAtUtc: null, articleCount: 9, publisherCount: 5, lastMatchBasis: 'event-key' },
    { id: 12, eventKey: null, title: 'Report: Japan readies intervention', firstArticleId: 5, firstSeenUtc: iso(100), lastSeenUtc: iso(90), exposures: 'JPY', state: 'Denied', stateChangedAtUtc: iso(90), deniedAtUtc: iso(90), resolvedAtUtc: null, articleCount: 3, publisherCount: 2, lastMatchBasis: 'lexical' }]);
  if (p.endsWith('/news-intel/gold')) return ok({ total: 2, countsByProvenance: { AgentDraft: 290, OperatorConfirmed: 9 }, items: [
    { id: 1, articleId: 100, title: 'ECB signals December cut', sourceName: 'Reuters', firstSeenUtc: iso(9000), exposureKey: 'EUR', relevant: true, category: 'MonetaryPolicy', direction: 'Bearish', certainty: 'Reported', relevance: 0.9, stance: 'Asserts', eventKey: 'ecb-dec-cut', provenance: 'AgentDraft', labeller: 'agent', labelledAtUtc: iso(9000), note: null },
    { id: 2, articleId: 101, title: 'Oil jumps on pipeline outage', sourceName: 'CNBC', firstSeenUtc: iso(9100), exposureKey: 'WTI', relevant: true, category: 'SupplyDisruption', direction: 'Bullish', certainty: 'Reported', relevance: 0.8, stance: 'Asserts', eventKey: null, provenance: 'AgentDraft', labeller: 'agent', labelledAtUtc: iso(9100), note: null }] });
  if (/\/news-intel\/eval\/runs\/\d+$/.test(p)) return ok({ id: 4, status: 'Completed', classifierModel: 'claude', promptVersion: 'p-abc123', triageMode: 'Off', articleCount: 80, draftLabelCount: 76, repeats: 2, relevanceF1: 0.86, categoryMacroF1: 0.61, directionMacroF1: 0.7, runToRunAgreement: 0.91,
    metricsJson: JSON.stringify({ trackedKeys: ['USD', 'EUR'], reviewedOnly: false, draftShare: 0.95, passes: [{ Articles: 80, ArticlesWithVerdict: 79, Relevance: { TruePositive: 50, FalsePositive: 9, FalseNegative: 3, TrueNegative: 17, Precision: 0.847, Recall: 0.943, F1: 0.893 }, Category: { Pairs: 40, Accuracy: 0.7, MacroF1: 0.61, PerClassF1: { Inflation: 0.8, Growth: 0.4 } } }], agreement: { Articles: 79, Overall: 0.91 } }),
    requestedBy: 'op', error: null, startedAtUtc: iso(100), completedAtUtc: iso(90) });
  if (p.endsWith('/news-intel/eval/runs')) return ok([{ id: 4, status: 'Completed', classifierModel: 'claude', promptVersion: 'p-abc123', triageMode: 'Off', articleCount: 80, draftLabelCount: 76, repeats: 2, relevanceF1: 0.86, categoryMacroF1: 0.61, directionMacroF1: 0.7, runToRunAgreement: 0.91, metricsJson: null, requestedBy: 'op', error: null, startedAtUtc: iso(100), completedAtUtc: iso(90) }]);
  if (p.includes('/news-intel/event-study')) {
    if (process.env.NI_STUDY_404) return notFound;
    if (p.endsWith('/recommended-weights')) return ok([{ category: 'MonetaryPolicy', current: 0.9, recommended: 0.85, fitted: 0.7, n: 140, clusters: 98, meanSignedR: 0.06, basis: 'shrunk' }, { category: 'Earnings', current: 0.5, recommended: 0.5, fitted: null, n: 12, clusters: 8, meanSignedR: 0.3, basis: 'insufficient data — kept' }]);
    if (/\/runs\/\d+$/.test(p)) return ok({ run: RUN, results: STUDY_RESULTS });
    if (p.endsWith('/runs')) return ok([RUN]);
  }
  if (p.includes('/config/NewsBlackout')) return ok({ id: 1, key: 'NewsBlackout:MultiAsset:Mode', value: 'Observe', description: null, dataType: 'String', isHotReloadable: true, lastUpdatedAt: iso(0) });
  if (p.endsWith('/news-intel/articles')) return ok([]);
  return ok([]);
}

(async () => {
  const app = express();
  app.get('/config.json', (_q, r) => {
    const f = path.join(ROOT, 'config.json');
    const base = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
    r.json({ ...base, apiBaseUrl: '', releaseId: 'news-intel-check', environmentLabel: 'verify', featureFlags: { ...(base.featureFlags ?? {}), bffAuth: false } });
  });
  app.use(express.static(ROOT, { index: false, dotfiles: 'allow' }));
  app.use((_q, r) => r.sendFile(path.join(ROOT, 'index.html'), { dotfiles: 'allow' }));
  const server = app.listen(PORT);
  const BASE = `http://localhost:${PORT}`;

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: Number(process.env.WIDTH || 1440), height: 1000 } });
  const blocked = [];
  let answered = 0;
  // vendors/{name}/verify changes nothing (one stubbed vendor read); it is answered so the Sources result renders.
  const READ_POSTS = [/\/currency-pair\/list$/, /\/news-intel\/vendors\/[^/]+\/verify$/];
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
    if (url.pathname.includes('/hubs/')) return route.abort('blockedbyclient');
    answered++;
    const body = stub(m, url.pathname, url.searchParams);
    if (body.status === 404) return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
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
    await page.waitForTimeout(900);
    // NI_THEME=dark: render the dark theme (the app keys it off <html data-theme>).
    if (process.env.NI_THEME === 'dark') {
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark')).catch(() => {});
      await page.waitForTimeout(150);
    }
    const r = { url: page.url().replace(BASE, '') };
    for (const [k, fn] of Object.entries(checks)) r[k] = await fn().catch((e) => `error: ${String(e).slice(0, 120)}`);
    // Horizontal-overflow probe: the outermost elements whose right edge passes the viewport (or that make any
    // ancestor scroll sideways). Empty list = no sideways scrolling.
    r.overflow = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      const desc = (el) => el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.') : '');
      const scrollers = [...document.querySelectorAll('*')].filter((el) => {
        const cs = getComputedStyle(el);
        return el.scrollWidth > el.clientWidth + 1 && /(auto|scroll)/.test(cs.overflowX) && el.clientWidth > vw * 0.5;
      }).map((el) => `${desc(el)} scroll ${el.scrollWidth}>${el.clientWidth}`);
      const out = [];
      for (const el of document.querySelectorAll('body *')) {
        const rc = el.getBoundingClientRect();
        if (rc.width === 0 || rc.right <= vw + 1) continue;
        const pr = el.parentElement?.getBoundingClientRect();
        if (pr && pr.right > vw + 1) continue; // report the outermost offender only
        out.push(`${desc(el)} right=${Math.round(rc.right)} w=${Math.round(rc.width)} parent=${el.parentElement ? desc(el.parentElement) : ''}`);
      }
      return { vw, docScroll: document.documentElement.scrollWidth, scrollers, offenders: out.slice(0, 15) };
    }).catch((e) => `error: ${String(e).slice(0, 120)}`);
    // Open the right-most ⓘ tooltip: it must stay inside the window and not widen the page.
    r.rightmostTip = await (async () => {
      const icons = page.locator('app-ni-info .i');
      const n = await icons.count();
      let best = -1, bestX = -1;
      for (let i = 0; i < n; i++) {
        const b = await icons.nth(i).boundingBox();
        if (b && b.width > 0 && b.x > bestX) { bestX = b.x; best = i; }
      }
      if (best < 0) return null;
      await icons.nth(best).hover();
      await page.waitForTimeout(250);
      const res = await page.evaluate(() => {
        const t = [...document.querySelectorAll('app-ni-info .tip')].find((e) => e.getBoundingClientRect().width > 0);
        const rc = t?.getBoundingClientRect();
        return { vw: document.documentElement.clientWidth, docScroll: document.documentElement.scrollWidth, tipLeft: rc && Math.round(rc.left), tipRight: rc && Math.round(rc.right) };
      });
      await page.mouse.move(0, 0);
      return res;
    })().catch((e) => `error: ${String(e).slice(0, 120)}`);
    await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
    results[name] = r;
  };
  const text = (sel) => () => page.locator(sel).first().innerText({ timeout: 4000 });
  const count = (sel) => () => page.locator(sel).count();

  await visit('/news-intel', 'overview', { h1: text('h1'), tabs: count('.ni-tab'), recommendedReadOnly: count('textarea[readonly]') });
  await page.locator('.sym-input').fill('AAPL').catch(() => {});
  await page.locator('.focus-input .btn').click().catch(() => {});
  await page.waitForTimeout(700);
  results.overview.legsTable = await count('app-news-exposure-legs tbody tr')();
  results.overview.focusRisk = await count('[data-testid="focus-risk"]')();
  await page.screenshot({ path: path.join(OUT, 'overview-aapl.png'), fullPage: false });

  await visit('/news-intel/settings', 'settings', { groups: count('details.cfg-group') });
  await visit('/news-intel/coverage', 'coverage', { rows: count('tbody tr.clickable'), demand: count('.key.untracked'),
    bulk: count('[data-testid="coverage-bulk"]'), observations: text('[data-testid="coverage-observations"]') });
  await page.locator('tr.clickable', { hasText: 'AAPL' }).first().click().catch(() => {});
  await page.waitForTimeout(400);
  results.coverage.detail = await text('.detail')().then((t) => t.slice(0, 160)).catch(() => 'missing');
  results.coverage.exactKeys = await count('[data-testid="coverage-keys"]')();
  await page.screenshot({ path: path.join(OUT, 'coverage-aapl.png'), fullPage: true });
  await visit('/news-intel/exposures', 'exposures', { missing: count('button.as-btn'), engineTerms: count('[data-testid="search-terms-engine"]') });
  await visit('/news-intel/sources', 'sources', { channels: count('table >> nth=0 >> tbody tr'), notes: count('.note'), password: count('input[type="password"]') });
  await page.locator('[data-testid="vendor-verify"] button', { hasText: 'Verify' }).nth(2).click().catch(() => {});
  await page.waitForTimeout(500);
  results.sources.verify = await text('[data-testid="vendor-verify"] >> nth=2')().catch(() => 'missing');
  await page.screenshot({ path: path.join(OUT, 'sources-verify.png'), fullPage: true });
  await visit('/news-intel/calendar', 'calendar', { days: count('[data-testid="cal-day"]'), timeline: count('app-ni-timeline .cell') });
  await visit('/news-intel/stories', 'stories', { rows: count('tbody tr.clickable') });
  await page.locator('tr.clickable').first().click().catch(() => {});
  await page.waitForTimeout(900);
  results.stories.spark = await count('svg.spark rect')();
  results.stories.members = await count('[data-testid="story-members"] tbody tr')();
  await page.screenshot({ path: path.join(OUT, 'stories-open.png'), fullPage: true });
  await visit('/news-intel/evals', 'evals', { runs: count('tbody tr.clickable'), gold: count('button:has-text("Confirm")') });
  await page.locator('tr.clickable').first().click().catch(() => {});
  await page.waitForTimeout(600);
  results.evals.caveat = await text('.banner.warn')().catch(() => 'missing');
  await page.screenshot({ path: path.join(OUT, 'evals-run.png'), fullPage: true });
  await visit('/news-intel/event-study', 'event-study', { ciBars: count('svg.ci'), diff: count('text=Apply via governance'), notDeployed: count('text=not on this engine yet') });
  await visit('/news-intel/risk', 'risk', { controls: count('.modes'), breaking: count('text=ECB makes unscheduled statement'),
    observations: count('[data-testid="risk-observations"] tbody tr') });

  // Open (never confirm) one write dialog to see it renders; Cancel closes it.
  await page.locator('.modes button', { hasText: 'Enforce' }).first().click().catch(() => {});
  await page.waitForTimeout(300);
  results.risk.dialog = await count('[role="dialog"]')();
  await page.screenshot({ path: path.join(OUT, 'risk-dialog.png'), fullPage: false });
  await page.locator('[role="dialog"] button', { hasText: 'Cancel' }).first().click().catch(() => {});

  console.log(JSON.stringify({ blockedWrites: blocked, answered, results, consoleErrors: [...new Set(consoleErrors)].slice(0, 30) }, null, 2));
  await browser.close();
  server.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
