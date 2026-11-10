// Write-blocked check of the Assistant page (/assistant: Health + Evals + Quality + Lessons) and the approval cards
// (preflight + script replay, outside-text provenance + acknowledgement, undo, "Review all", live progress line),
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
  efficiency: {
    questions: 100,
    nativeRounds: 380,
    sentinelRounds: 31,
    nativeFallbackRounds: 9,
    nativeShare: 0.905,
    sentinelShare: 0.074,
    nativeFallbackShare: 0.021,
    prefixReusedQuestions: 64,
    prefixReuseShare: 0.64,
    cacheHitRatioPrefixReused: 0.82,
    cacheHitRatioPrefixRendered: 0.41,
    routed: 38,
    routedShare: 0.38,
    escalated: 7,
    escalationRate: 0.184,
    escalationReasons: { tool_heavy: 4, low_confidence: 3 },
    questionsByModel: { 'claude-opus-4': 69, 'claude-sonnet-4': 31 },
    avgNotionalCostRoutedUsd: 0.031,
    avgNotionalCostMainUsd: 0.22,
  },
  // Engine 3f04f4b1+: the window's own verdict and limits (OLD_ENGINE=1 drops them to exercise the alert/list fallback).
  ...(process.env.OLD_ENGINE
    ? {}
    : {
        breaches: [
          {
            key: 'assistant-health:tool-errors:get_candles',
            severity: 'Medium',
            message:
              "The assistant's get_candles tool failed 72 of 160 calls in the last 168 h (45%, threshold 40%); most often not_found (60).",
          },
        ],
        thresholds: {
          unverifiedRatePct: 30,
          toolErrorRatePct: 40,
          turnP95Seconds: 900,
          spendGuardTrips: 1,
          minTurns: 10,
          toolMinCalls: 20,
        },
      }),
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
    reviewedByName: 'Bode Olaleye',
    reviewedAtUtc: '2026-11-05T10:00:00Z',
    reviewNote: 'Shipped with the engine',
    injectedCount: 57,
    lastInjectedAtUtc: '2026-11-10T06:40:00Z',
    evalRunId: 41,
    evalStatus: 'Completed',
    evalAtUtc: '2026-11-09T03:00:00Z',
    evalImproved: 0,
    evalWorsened: 0,
    evalUnchanged: 3,
    noMeasurableEffect: true,
  }),
  lesson(8, 'Approved', {
    source: 'correction',
    text: 'Quote the timeframe of every level you cite.',
    reviewedBy: 'admin-user:1',
    reviewedAtUtc: '2026-11-08T10:00:00Z',
    injectedCount: 12,
    evalRunId: 44,
    evalStatus: 'Completed',
    evalAtUtc: '2026-11-09T03:20:00Z',
    evalImproved: 2,
    evalWorsened: 0,
    evalUnchanged: 1,
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
  // Outside text + acknowledgement + script replay.
  card(6, {
    ...opArgs,
    operationId: 'MarketData_CreateAnalysisMonitor',
    summary: 'Watch EURUSD for a retest of 1.0850 and arm the long',
    preflight: {
      ...preflight('wouldSucceed', 'checked: would succeed'),
      replay: {
        outcome: 'passed',
        legs: [
          {
            label: 'card #327',
            outcome: 'passed',
            summary: 'ready on the retest',
            fromUtc: '2026-11-06T00:00:00Z',
            toUtc: '2026-11-09T21:00:00Z',
            bars: 312,
          },
        ],
      },
    },
    provenance: {
      untrusted: true,
      sources: [
        { kind: 'news', source: 'GET /news-intel/articles/88112' },
        { kind: 'web', source: 'GET /wire/sessions/31/briefing' },
      ],
      kinds: ['news', 'web'],
      highImpact: true,
      requiresAcknowledgement: true,
      note: 'Check that this change is what YOU want, not what the text asked for.',
    },
  }),
  // Confirmed with an undo on offer (window still open), one undone, one with no undo.
  card(
    7,
    {
      ...opArgs,
      summary: 'Create monitor #123',
      undo: {
        available: true,
        status: 'available',
        label: 'Cancel monitor #123',
        recordedAtUtc: new Date(Date.now() - 5 * 60_000).toISOString(),
        expiresAtUtc: new Date(Date.now() + 10 * 60_000).toISOString(),
      },
    },
    'Confirmed',
  ),
  card(
    8,
    {
      ...opArgs,
      summary: 'Pause monitor #120',
      undo: {
        available: true,
        status: 'done',
        label: 'Resume monitor #120',
        undoneAtUtc: '2026-11-10T07:09:00Z',
        undoneBy: 'admin-user:1',
        undoReason: 'paused the wrong one',
      },
    },
    'Confirmed',
  ),
  card(
    9,
    {
      ...opArgs,
      summary: 'Set Llm:AssistantEvalEnabled = true',
      undo: {
        available: false,
        reason: 'No undo: this setting change was not recorded before it ran.',
      },
    },
    'Confirmed',
  ),
];

const evalRun = (id, over = {}) => ({
  id,
  kind: 'suite',
  trigger: 'nightly',
  status: 'Completed',
  lessonId: null,
  model: 'opus',
  resolvedModel: 'claude-opus-4',
  promptHash: 'a1b2',
  caseIds: [],
  requestedBy: null,
  queuedAtUtc: `2026-11-0${(id % 9) + 1}T02:00:00Z`,
  startedAtUtc: `2026-11-0${(id % 9) + 1}T02:01:00Z`,
  completedAtUtc: `2026-11-0${(id % 9) + 1}T02:14:00Z`,
  casesTotal: 20,
  casesPassed: 15 + (id % 4),
  casesFailed: 5 - (id % 4),
  casesSkipped: 0,
  passRate: (15 + (id % 4)) / 20,
  meanScore: 0.8 + (id % 4) * 0.04,
  modelCalls: 140,
  tokensInput: 2_400_000,
  tokensOutput: 120_000,
  tokensCacheRead: 1_600_000,
  wallMs: 780_000,
  improved: null,
  worsened: null,
  unchanged: null,
  summary: null,
  error: null,
  ...over,
});
const EVAL_RUNS = {
  runs: [
    evalRun(48, {
      status: 'Running',
      completedAtUtc: null,
      passRate: null,
      meanScore: null,
      trigger: 'manual',
      queuedAtUtc: '2026-11-10T06:50:00Z',
    }),
    evalRun(7),
    evalRun(6, {
      status: 'BudgetStopped',
      casesSkipped: 4,
      summary: 'Stopped at the daily token ceiling after 16 cases.',
    }),
    evalRun(5),
    evalRun(4, {
      status: 'Failed',
      passRate: null,
      meanScore: null,
      error: 'The model provider refused the request (quota).',
    }),
    evalRun(3),
    evalRun(2),
    evalRun(1),
  ],
  live: null,
  settings: {
    evalEnabled: true,
    evalHourUtc: 2,
    evalModel: 'opus',
    evalMaxCases: 20,
    dailyTokenCeiling: 6_000_000,
    tokensSpentToday: 4_900_000,
    regressionPoints: 10,
    judgeEnabled: true,
    judgeIntervalDays: 3,
    judgeHourUtc: 4,
    judgeSampleSize: 12,
    judgeModel: 'opus',
    lessonReplayEnabled: true,
    lessonReplayMaxCases: 6,
    cases: [
      {
        id: '45861-oco-preflight-four-cycles',
        title: 'OCO preflight',
        kind: 'operator',
        skip: null,
        recordedTokens: 90_000,
      },
    ],
  },
};
EVAL_RUNS.live = EVAL_RUNS.runs[0];
const EVAL_DETAIL = {
  run: evalRun(7),
  lessonId: null,
  lessonText: null,
  lessonScope: null,
  cases: [
    {
      id: 1,
      caseId: '45861-oco-preflight-four-cycles',
      caseTitle: 'Arm an OCO that the preflight refuses four times',
      arm: '',
      passed: false,
      skipped: null,
      score: 0.6,
      checksTotal: 5,
      checksFailed: 2,
      checks: [
        { name: 'expect:toolsCalled:live_price', passed: true, detail: null },
        {
          name: 'expect:noWriteAfterRefusal',
          passed: false,
          detail: 'proposed the same OCO a fifth time',
        },
        {
          name: 'expect:answerMentions:refused',
          passed: false,
          detail: 'the answer never said the engine refused it',
        },
      ],
      rounds: 9,
      modelCalls: 11,
      tokensInput: 180_000,
      tokensOutput: 6_000,
      tokensCacheRead: 120_000,
      protocol: 'native',
      modelLatencyMs: 41_000,
      wallMs: 52_000,
      heldForRevision: 1,
      unverified: false,
      failureReason: 'It kept re-proposing a write the engine had refused.',
      answer: 'I armed the OCO on #12 with a buy stop at 1.0912 …',
    },
    {
      id: 2,
      caseId: '36422-buy-and-hold-return',
      caseTitle: 'Buy-and-hold return of EURUSD',
      arm: '',
      passed: true,
      skipped: null,
      score: 1,
      checksTotal: 3,
      checksFailed: 0,
      checks: [{ name: 'expect:toolsCalled:get_candles', passed: true, detail: null }],
      rounds: 3,
      modelCalls: 3,
      tokensInput: 40_000,
      tokensOutput: 1_200,
      tokensCacheRead: 30_000,
      protocol: 'sentinel',
      modelLatencyMs: 9_000,
      wallMs: 12_000,
      heldForRevision: 0,
      unverified: false,
      failureReason: null,
      answer: 'EURUSD returned +2.1 % over the period …',
    },
  ],
};
const QUALITY = {
  fromUtc: '2026-08-12T00:00:00Z',
  answers: 48,
  correctness: 3.9,
  completeness: 3.6,
  clarity: 4.3,
  honesty: 4.1,
  overall: 4.0,
  trend: [1, 2, 3, 4].map((i) => ({
    runId: 60 + i,
    gradedAtUtc: `2026-11-0${i * 2}T04:10:00Z`,
    answers: 12,
    correctness: 3.5 + i * 0.15,
    completeness: 3.3 + i * 0.1,
    clarity: 4.1 + i * 0.05,
    honesty: 3.8 + i * 0.1,
    overall: 3.8 + i * 0.1,
    lowCorrectness: 4 - i,
    judgeModel: 'opus',
  })),
  lowest: [
    {
      id: 1,
      runId: 64,
      conversationId: 55618,
      conversationLink: '/conversations?conversation=55618',
      answerTurnId: 9001,
      questionTurnId: 9000,
      answeredAtUtc: '2026-11-07T14:22:00Z',
      question: 'What is my exposure to USD right now?',
      answerExcerpt: 'You are net long USD by 3.2 lots across EURUSD and GBPUSD …',
      correctness: 1,
      completeness: 3,
      clarity: 4,
      honesty: 2,
      correctnessReason: 'Short EURUSD is LONG USD; it added the GBPUSD leg with the wrong sign.',
      completenessReason: 'It left out XAUUSD.',
      clarityReason: null,
      honestyReason: 'It did not say it had not checked the open positions.',
      overall: 2.4,
      judgeModel: 'opus',
      lessonCandidateId: 13,
      gradedAtUtc: '2026-11-08T04:10:00Z',
    },
  ],
};
const hist = (over = {}) => ({
  questions: 312,
  answerAttempts: 290,
  heldRate: 0.34,
  held: 99,
  unverifiedRate: 0.12,
  unverified: 35,
  avgRounds: 5.1,
  avgToolCalls: 8.2,
  toolErrorRate: 0.07,
  avgTokensInput: 52_000,
  avgTokensOutput: 2_300,
  cacheHitRatio: 0.48,
  wallP50Seconds: 210,
  wallP95Seconds: 780,
  truncated: false,
  exactness: {
    questions: 'exact',
    heldRate: 'exact',
    unverifiedRate: 'exact',
    avgRounds: 'approx',
    toolErrorRate: 'approx',
    avgTokensInput: 'approx',
    avgTokensOutput: 'approx',
    cacheHitRatio: 'approx',
    wallP50Seconds: 'approx',
    wallP95Seconds: 'approx',
  },
  ...over,
});
const COMPARE = {
  baseline: {
    fromUtc: '2026-10-11T00:00:00Z',
    toUtc: '2026-11-10T00:00:00Z',
    history: hist(),
    telemetry: null,
    telemetryFromUtc: null,
  },
  current: {
    fromUtc: '2026-11-10T00:00:00Z',
    toUtc: '2026-11-11T00:00:00Z',
    history: hist({
      questions: 41,
      heldRate: 0.22,
      unverifiedRate: 0.15,
      avgRounds: 4.2,
      cacheHitRatio: 0.71,
      wallP50Seconds: 150,
      wallP95Seconds: 820,
    }),
    telemetry: null,
    telemetryFromUtc: '2026-11-10T09:00:00Z',
  },
  historyDeltas: {},
  telemetryDeltas: null,
  notes: [
    "Questions, held rate and unverified rate are EXACT: every question starts with the operator's User turn.",
    'Rounds are APPROXIMATE: the distinct admin_assistant.turn calls that left a turn behind.',
  ],
};
const PROGRESS = {
  llmInvocationId: 1,
  questionTurnId: 1,
  phase: 'reading',
  round: 3,
  tools: [
    { name: 'live_price', label: 'Live price' },
    { name: 'get_candles', label: 'Candles EURUSD H1' },
  ],
  message: 'Reading the EURUSD candles around the retest',
  model: 'sonnet',
  escalated: false,
  atUtc: new Date(Date.now() - 4000).toISOString(),
};

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
  if (p.endsWith('/assistant/metrics/compare')) return ok(COMPARE);
  if (p.endsWith('/assistant/evals/runs')) return ok(EVAL_RUNS);
  if (/\/assistant\/evals\/runs\/\d+$/.test(p)) return ok(EVAL_DETAIL);
  if (p.endsWith('/assistant/quality')) return ok(QUALITY);
  if (p.endsWith('/market-data/analyze/1/progress')) return ok(PROGRESS);
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
    breachSource: text('.breaches .src'),
  });
  results.health.alertListCalls = answered.filter((a) => a.includes('/alert/list')).length;
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
  results.lessons.reviewerName = await page.locator('text=Bode Olaleye').count();
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

  // ── Approval-card safety, Review all, progress line ──
  const card = (id) => page.locator('.action-card').nth(id - 2);
  results.chat.provenance = await page.locator('app-card-safety .pill').allInnerTexts();
  results.chat.replayLine = await text('app-preflight-badge .replay summary')();
  results.chat.progressLine = await text('app-assistant-progress .prog')();
  const ackConfirm = card(6).locator('button.confirm');
  results.chat.confirmDisabledBeforeAck = await ackConfirm.isDisabled();
  await card(6).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(OUT, 'chat-provenance-ack.png'), fullPage: false });
  await card(6).locator('.ack input').check();
  results.chat.confirmDisabledAfterAck = await ackConfirm.isDisabled();
  await ackConfirm.click(); // aborted: POST resolve
  await page.waitForTimeout(500);
  results.chat.ackRefusal = await card(6)
    .locator('app-card-safety .refusal')
    .innerText()
    .catch(() => 'none');
  await page.screenshot({ path: path.join(OUT, 'chat-provenance-ack-sent.png'), fullPage: false });
  results.chat.undoTexts = await page.locator('app-card-safety .undo').allInnerTexts();
  await card(7).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(OUT, 'chat-undo.png'), fullPage: false });
  await card(7).locator('.undo-btn').click();
  await page.waitForTimeout(300);
  await page.locator('[role=dialog] textarea').fill('wrong pair');
  await page.screenshot({ path: path.join(OUT, 'chat-undo-dialog.png'), fullPage: false });
  await page.locator('[role=dialog] button', { hasText: 'Undo it' }).click(); // aborted: POST undo
  await page.waitForTimeout(500);
  results.chat.undoError = await card(7)
    .locator('app-card-safety .undo .bad')
    .innerText()
    .catch(() => 'none');
  await page.locator('app-batch-review').scrollIntoViewIfNeeded();
  results.chat.batchHead = await text('app-batch-review header')();
  await page.locator('app-batch-review button', { hasText: 'Review all' }).click();
  await page.waitForTimeout(200);
  results.chat.batchRows = await count('app-batch-review .list li')();
  results.chat.approveAllDisabledBeforeAck = await page
    .locator('app-batch-review .confirm')
    .isDisabled();
  await page.locator('app-batch-review .ack input').check();
  await page.locator('app-batch-review').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(OUT, 'chat-review-all.png'), fullPage: false });
  await page.locator('app-batch-review .confirm').click(); // aborted: POST resolve-batch
  await page.waitForTimeout(500);
  results.chat.batchError = await text('app-batch-review .bad')().catch(() => 'none');
  await page.screenshot({ path: path.join(OUT, 'chat-review-all-sent.png'), fullPage: false });
  await page.locator('app-assistant-progress').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(OUT, 'chat-progress.png'), fullPage: false });

  // ── /assistant: Health additions, Evals, Quality, Lessons additions ──
  await visit('/assistant', 'health-wave2', {
    efficiency: text('app-assistant-efficiency-section h4'),
    compareRows: count('app-assistant-compare-section tbody tr'),
    approx: count('app-assistant-compare-section .approx'),
  });
  await page.locator('app-assistant-efficiency-section').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(OUT, 'health-efficiency.png'), fullPage: false });
  await page.locator('app-assistant-compare-section').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(OUT, 'health-compare.png'), fullPage: false });
  results['health-wave2'].compareCall = answered
    .filter((a) => a.includes('/metrics/compare'))
    .pop();

  await visit('/assistant?tab=evals', 'evals', {
    rows: count('app-assistant-evals-panel tbody tr'),
    budget: text('.budget'),
    live: text('.live'),
    chart: count('app-chart-card canvas'),
  });
  await page.locator('app-assistant-evals-panel tbody tr').nth(1).click();
  await page.waitForTimeout(500);
  await page
    .locator('app-assistant-eval-run-detail details')
    .first()
    .locator('summary')
    .first()
    .click();
  await page.waitForTimeout(200);
  results.evals.detailCases = await count('app-assistant-eval-run-detail .cases > li')();
  await page.locator('app-assistant-eval-run-detail').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(OUT, 'evals-run-detail.png'), fullPage: true });
  results.evals.runNowDisabledWhileLive = await page
    .locator('button', { hasText: 'Run now' })
    .isDisabled();

  await visit('/assistant?tab=quality', 'quality', {
    tiles: count('.tiles .tile'),
    lowest: count('.grades > li'),
    link: text('.grades .links a'),
  });

  await visit('/assistant?tab=lessons', 'lessons-wave2', {
    evalLines: () => page.locator('app-lesson-eval-status').allInnerTexts(),
  });
  await page.locator('.seg button', { hasText: 'All' }).click();
  await page.waitForTimeout(400);
  results['lessons-wave2'].evalLinesAll = await page
    .locator('app-lesson-eval-status')
    .allInnerTexts();
  await page.locator('app-lesson-eval-status button', { hasText: 'Evaluate' }).first().click(); // aborted
  await page.waitForTimeout(400);
  results['lessons-wave2'].evaluateMsg = await text('app-lesson-eval-status .msg')().catch(
    () => 'none',
  );
  await page
    .locator('app-lesson-eval-status .badge')
    .first()
    .scrollIntoViewIfNeeded()
    .catch(() => {});
  await page.screenshot({ path: path.join(OUT, 'lessons-eval.png'), fullPage: false });

  for (const theme of ['dark']) {
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
    await visit('/assistant?tab=evals', `evals-${theme}`, {});
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, `evals-${theme}.png`), fullPage: true });
  }

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
