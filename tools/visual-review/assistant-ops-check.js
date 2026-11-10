// Write-blocked check of the Assistant page (/assistant: Health + Lessons) and the approval card's preflight badge,
// on a LOCAL production build with STUBBED engine answers: nothing reaches any engine — every /api, /health, /bff and
// hub request is answered in the browser by the stubs below, and every non-GET except the read-POST alert/list is
// ABORTED and recorded (so clicking a dialog's confirm shows the request was attempted, never sent).
//
// Usage (repo root, after `npx ng build --configuration production`):
//   OUT=/tmp/shots node tools/visual-review/assistant-ops-check.js
const path = require('path');
const fs = require('fs');
const express = require('express');
const { chromium } = require('@playwright/test');

const ROOT = path.resolve(__dirname, '../../dist/lascodia-admin/browser');
const OUT = process.env.OUT || path.resolve(__dirname, 'shots-assistant');
const PORT = Number(process.env.PORT || 4318);
fs.mkdirSync(OUT, { recursive: true });

// Every permission key of the catalogue (the session is a stubbed super admin).
const PERMS = [
  ...fs
    .readFileSync(
      path.resolve(__dirname, '../../src/app/core/auth/permissions.generated.ts'),
      'utf8',
    )
    .matchAll(/^\s+[A-Z][A-Za-z0-9]+: '([a-z0-9_.-]+)',$/gm),
].map((m) => m[1]);

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const JWT = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({
  passportId: '1',
  firstName: 'Stub',
  lastName: 'Admin',
  email: 'stub@local',
  mobileNo: '0',
  adminUserId: '1',
  is_superadmin: 'true',
  exp: Math.floor(Date.now() / 1000) + 3600,
  'http://schemas.microsoft.com/ws/2008/06/identity/claims/role': [
    'SuperAdmin',
    'Admin',
    'Operator',
  ],
})}.stub`;

const ok = (data) => ({ status: true, message: 'Successful', responseCode: '00', data });

const turns = (n, extra = {}) => ({
  turns: n,
  answered: Math.round(n * 0.86),
  finalAnswerRate: 0.86,
  answerAttempts: n - 2,
  holdRate: 0.31,
  gateHoldsNumbers: 9,
  gateHoldsAbsence: 3,
  gateHoldsCausal: 1,
  unverifiedRate: 0.14,
  unverified: Math.round((n - 2) * 0.14),
  checkpointRate: 0.08,
  spendGuardTrips: 0,
  preflightBlocks: 4,
  writesNotRun: 1,
  writesRefused: 0,
  toolParseRetries: 2,
  outcomes: { answered: Math.round(n * 0.8), proposal: 6, checkpoint: 3, failed: 1 },
  wallP50Seconds: 179,
  wallP95Seconds: 610,
  avgRounds: 4.2,
  avgModelCalls: 5.1,
  avgToolCalls: 7.3,
  toolErrorRate: 0.06,
  tokensInput: 4_120_000,
  tokensOutput: 210_000,
  tokensCacheRead: 2_900_000,
  avgTokensInput: 41_200,
  avgTokensOutput: 2_100,
  cacheHitRatio: 0.7,
  notionalCostUsd: 18.42,
  avgNotionalCostUsd: 0.18,
  ...extra,
});
const METRICS = {
  fromUtc: '2026-11-03T07:00:00Z',
  toUtc: '2026-11-10T07:00:00Z',
  windowHours: 168,
  all: turns(140),
  operator: turns(100),
  headless: turns(40, { wallP50Seconds: 420, wallP95Seconds: 1300 }),
  tools: [
    {
      tool: 'call_endpoint',
      calls: 420,
      errors: 31,
      errorRate: 0.0738,
      errorClasses: { http_4xx: 20, timeout: 11 },
      p50Ms: 180,
      p95Ms: 1900,
      truncatedRate: 0.05,
      avgResultChars: 5400,
      parallelShare: 0.4,
      operatorCalls: 300,
      headlessCalls: 120,
      nonReads: { write_proposed: 22, preflight_blocked: 4 },
    },
    {
      tool: 'get_candles',
      calls: 160,
      errors: 72,
      errorRate: 0.45,
      errorClasses: { not_found: 60, other: 12 },
      p50Ms: 90,
      p95Ms: 400,
      truncatedRate: 0,
      avgResultChars: 9000,
      parallelShare: 0.7,
      operatorCalls: 100,
      headlessCalls: 60,
      nonReads: {},
    },
    {
      tool: 'ui_action',
      calls: 0,
      errors: 0,
      errorRate: 0,
      errorClasses: {},
      p50Ms: 0,
      p95Ms: 0,
      truncatedRate: 0,
      avgResultChars: 0,
      parallelShare: 0,
      operatorCalls: 0,
      headlessCalls: 0,
      nonReads: { ui_action: 9 },
    },
  ],
  approvals: {
    proposed: 26,
    confirmed: 15,
    rejected: 6,
    failed: 2,
    pending: 3,
    approvalRate: 0.652,
    failedAfterConfirmRate: 0.1176,
  },
  truncated: false,
};
const ALERTS = {
  pager: { totalItemCount: 1 },
  data: [
    {
      id: 900,
      severity: 'Medium',
      isActive: true,
      deduplicationKey: 'assistant-health:tool-errors:get_candles',
      lastTriggeredAt: '2026-11-10T05:00:00Z',
      conditionJson: JSON.stringify({
        detector: 'AssistantHealth',
        condition: { Tool: 'get_candles', Calls: 160, Errors: 72, rate: 0.45, threshold: 40 },
        evaluatedAtUtc: '2026-11-10T05:00:00Z',
      }),
    },
  ],
};
const lesson = (id, status, over = {}) => ({
  id,
  status,
  source: 'card_rejection',
  scopeKind: 'global',
  scopeValue: null,
  text: 'Never propose arming an OCO whose legs are market orders: the engine refuses it. Ask for limit or stop legs.',
  evidence: 'Operator rejected card #4412: "legs were market orders again, this is the third time"',
  sourceConversationIds: [45861],
  sourceTurnId: 4412,
  sourceRef: null,
  createdBy: null,
  reviewedBy: null,
  reviewNote: null,
  createdAtUtc: '2026-11-09T18:30:00Z',
  reviewedAtUtc: null,
  injectedCount: 0,
  lastInjectedAtUtc: null,
  ...over,
});
const LESSONS = [
  lesson(12, 'Candidate'),
  lesson(11, 'Candidate', {
    source: 'correction',
    scopeKind: 'symbol',
    scopeValue: 'XAUUSD',
    text: 'XAUUSD prices are quoted to 2 decimals; do not round stop distances to whole pips.',
    sourceConversationIds: [45990],
    sourceTurnId: null,
  }),
  lesson(9, 'Approved', {
    source: 'seed',
    sourceConversationIds: [],
    sourceTurnId: null,
    sourceRef: 'incident 2026-11-04',
    text: 'A spot analysis answer must quote the live price it used.',
    reviewedBy: 'admin-user:1',
    reviewedAtUtc: '2026-11-05T10:00:00Z',
    reviewNote: 'Shipped with the engine',
    injectedCount: 57,
    lastInjectedAtUtc: '2026-11-10T06:40:00Z',
  }),
  lesson(4, 'Rejected', {
    source: 'gate_exhausted',
    reviewedBy: 'admin-user:1',
    reviewedAtUtc: '2026-11-06T10:00:00Z',
    reviewNote: 'Wrong — the figure was right',
  }),
];

const preflight = (verdict, label, warnings = []) => ({
  verdict,
  label,
  errors: [],
  warnings,
  note: null,
  checkedAtUtc: '2026-11-10T06:59:12.123Z',
});
const card = (id, args, status = 'Pending') => ({
  id,
  llmInvocationId: 1,
  role: 'ActionProposal',
  content: '',
  toolName: 'call_endpoint',
  toolArgsJson: JSON.stringify(args),
  toolResultJson: null,
  actionStatus: status,
  createdAtUtc: '2026-11-10T07:00:0' + id + 'Z',
});
const opArgs = {
  operationId: 'TradeRecommendation_ArmOco',
  method: 'POST',
  path: '/trade-recommendation/12/arm-oco',
  route: { id: 12 },
  summary: 'Arm the OCO on recommendation #12',
  body: { buyStop: 1.0912, sellStop: 1.0841 },
};
const THREAD = [
  {
    id: 1,
    llmInvocationId: 1,
    role: 'User',
    content: 'Arm the OCO on #12 please',
    createdAtUtc: '2026-11-10T07:00:00Z',
  },
  card(2, { ...opArgs, preflight: preflight('wouldSucceed', 'checked: would succeed') }),
  card(3, {
    ...opArgs,
    preflight: preflight('wouldSucceedWithWarnings', 'checked: would succeed, with 1 warning(s)', [
      'The sell stop is inside the current spread.',
    ]),
  }),
  card(4, {
    ...opArgs,
    preflight: {
      ...preflight('notChecked', 'not checked (no dry run exists for this operation)'),
      note: 'no dry run exists for this operation',
    },
  }),
  card(5, opArgs),
];

/** Stub answer for a GET (or an allowed read-POST) by path. */
function stub(method, p, search) {
  if (p.endsWith('/admin/auth/me'))
    return ok({
      id: 1,
      username: 'stub',
      displayName: 'Stub',
      email: 'stub@local',
      isSuperAdmin: true,
      mustChangePassword: false,
      roles: ['SuperAdmin'],
      permissions: PERMS,
    });
  if (p.endsWith('/assistant/metrics')) return ok(METRICS);
  if (p.endsWith('/assistant/lessons')) {
    const status = new URLSearchParams(search).get('status');
    return ok(LESSONS.filter((l) => !status || l.status === status));
  }
  if (p.endsWith('/alert/list')) return ok(ALERTS);
  if (p.endsWith('/market-data/analyze/1/follow-up')) return ok(THREAD);
  if (p.endsWith('/market-data/analysis-conversations'))
    return ok({
      items: [
        {
          llmInvocationId: 1,
          symbol: 'EURUSD',
          timeframe: 'H1',
          purpose: 'admin_assistant.session',
          kind: 'Assistant',
          preview: 'Arm the OCO',
          model: 'stub',
          provider: 'stub',
          invokedAt: '2026-11-10T07:00:00Z',
          lastActivityAtUtc: '2026-11-10T07:00:05Z',
          followUpCount: 5,
          activeMonitorCount: 0,
        },
      ],
      currentPage: 1,
      pageSize: 50,
      totalItems: 1,
    });
  if (p.endsWith('/market-data/analysis-conversations/1'))
    return ok({
      llmInvocationId: 1,
      symbol: 'EURUSD',
      timeframe: 'H1',
      purpose: 'admin_assistant.session',
      kind: 'Assistant',
      model: 'stub',
      provider: 'stub',
      invokedAt: '2026-11-10T07:00:00Z',
      analysis: 'Assistant conversation',
      recommendations: [],
    });
  return ok([]);
}

(async () => {
  const app = express();
  app.get('/config.json', (_q, r) => {
    const f = path.join(ROOT, 'config.json');
    const base = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
    r.json({
      ...base,
      apiBaseUrl: '',
      releaseId: 'assistant-check',
      environmentLabel: 'verify',
      featureFlags: { ...(base.featureFlags ?? {}), bffAuth: false },
    });
  });
  app.use(express.static(ROOT, { index: false, dotfiles: 'allow' }));
  app.use((_q, r) => r.sendFile(path.join(ROOT, 'index.html'), { dotfiles: 'allow' }));
  const server = app.listen(PORT);
  const BASE = `http://localhost:${PORT}`;

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const blocked = [];
  const answered = [];
  const READ_POSTS = [/\/alert\/list$/];
  await ctx.route('**/*', (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const engine =
      url.pathname.startsWith('/api/') ||
      url.pathname.startsWith('/health') ||
      url.pathname.startsWith('/bff') ||
      url.port === '5081' ||
      url.port === '5083';
    if (!engine)
      return url.hostname === 'localhost' ? route.continue() : route.abort('blockedbyclient');
    const m = req.method();
    if (m !== 'GET' && !(m === 'POST' && READ_POSTS.some((r) => r.test(url.pathname)))) {
      blocked.push(`${m} ${url.pathname}`);
      return route.abort('blockedbyclient');
    }
    if (url.pathname.includes('/hubs/')) return route.abort('blockedbyclient'); // no realtime in a stubbed check
    answered.push(`${m} ${url.pathname}`);
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(stub(m, url.pathname, url.search)),
    });
  });
  await ctx.addInitScript(
    ({ token, perms }) => {
      if (location.pathname === '/login') return;
      sessionStorage.setItem('lascodia.auth.token', token);
      sessionStorage.setItem(
        'lascodia.auth.user',
        JSON.stringify({
          passportId: '1',
          firstName: 'Stub',
          lastName: 'Admin',
          email: 'stub@local',
        }),
      );
      sessionStorage.setItem('lascodia.auth.perms', JSON.stringify(perms));
    },
    { token: JWT, perms: PERMS },
  );

  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text().slice(0, 200)));
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 200)}`));

  const results = {};
  const visit = async (route, name, checks) => {
    await page.goto(BASE + route, { waitUntil: 'networkidle' }).catch(() => {});
    await page.waitForTimeout(800);
    const r = { url: page.url().replace(BASE, '') };
    for (const [k, fn] of Object.entries(checks))
      r[k] = await fn().catch((e) => `error: ${String(e).slice(0, 120)}`);
    await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
    results[name] = r;
  };
  const text = (sel) => () => page.locator(sel).first().innerText({ timeout: 4000 });
  const count = (sel) => () => page.locator(sel).count();

  await visit('/assistant', 'health', {
    title: text('h1'),
    breach: text('text=keeps failing'),
    tools: count('table.tools tbody tr'),
  });
  await page
    .locator('button', { hasText: 'Last 30 days' })
    .first()
    .click()
    .catch(() => {});
  await page.waitForTimeout(400);
  results.health.lastMetricsCall = answered.filter((a) => a.includes('/assistant/metrics')).pop();

  await visit('/assistant?tab=lessons', 'lessons', {
    cards: count('li.lesson'),
    source: text('text=conversation #45861'),
  });
  await page.locator('li.lesson button', { hasText: 'Reject' }).first().click();
  await page.waitForTimeout(300);
  await page.locator('[role=dialog] button', { hasText: 'Reject' }).click(); // no reason yet → refused locally
  await page.waitForTimeout(200);
  results.lessons.reasonPrompt = await text('[role=dialog] .problem')();
  await page.screenshot({ path: path.join(OUT, 'lessons-reject-dialog.png'), fullPage: false });
  await page.locator('[role=dialog] textarea').last().fill('Market legs are fine for this broker');
  await page.locator('[role=dialog] button', { hasText: 'Reject' }).click(); // aborted by the route guard
  await page.waitForTimeout(500);
  results.lessons.dialogError = await text('[role=dialog] .problem')().catch(() => 'none');
  await page.screenshot({ path: path.join(OUT, 'lessons-reject-aborted.png'), fullPage: false });
  await page.keyboard.press('Escape');
  await page.locator('.seg button', { hasText: 'All' }).click();
  await page.waitForTimeout(400);
  results.lessons.allCards = await count('li.lesson')();
  await page.screenshot({ path: path.join(OUT, 'lessons-all.png'), fullPage: true });

  await visit('/conversations?conversation=1', 'chat', {
    badges: () => page.locator('app-preflight-badge .pill').allInnerTexts(),
  });
  await page
    .locator('app-preflight-badge')
    .first()
    .scrollIntoViewIfNeeded()
    .catch(() => {});
  await page.screenshot({ path: path.join(OUT, 'chat-badges.png'), fullPage: false });

  console.log(
    JSON.stringify(
      {
        blockedWrites: blocked,
        answeredCount: answered.length,
        results,
        consoleErrors: [...new Set(consoleErrors)].slice(0, 30),
      },
      null,
      2,
    ),
  );
  await browser.close();
  server.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
