import { describe, expect, it } from 'vitest';

import {
  distribution,
  driftView,
  isoMs,
  latencyText,
  liveMetricRows,
  metricText,
  normalizeParityReconcile,
  normalizeParitySessions,
  normalizeParitySummary,
  pairView,
  pricePrecision,
  reconcileDone,
  reconcileStatusText,
  rText,
  sessionLabel,
  shareText,
  slippageText,
  worseShareText,
} from './parity.model';
import { MINUS, NA } from '../report/report-format';

const dist = (mean: number | null, n = 12, positiveShare: number | null = 0.75) => ({
  n,
  mean,
  median: mean,
  p10: mean,
  p90: mean,
  min: mean,
  max: mean,
  positiveShare,
});

function summaryPayload(overrides: Record<string, unknown> = {}) {
  return {
    strategyId: 41,
    symbol: 'EURUSD',
    timeframe: 'H1',
    fromUtc: '2026-09-09T00:00:00Z',
    toUtc: '2026-10-09T00:00:00Z',
    windowDays: 30,
    pipSize: 0.0001,
    currentScriptRevision: 'abcdef0123456789',
    sessions: 2,
    trades: {
      total: 14,
      closed: 12,
      live: 12,
      paper: 2,
      exitsOnly: 0,
      catchUp: 1,
      signalSent: 12,
      notSent: 0,
      paperBlocked: 0,
      failed: 0,
    },
    live: {
      emulatorTrades: 12,
      tradesSent: 12,
      tradesFilled: 11,
      tradesMissed: 1,
      accountFills: 11,
      closedRoundTrips: 10,
      expectedR: dist(0.8),
      realisedR: dist(0.5),
      rGap: dist(-0.3, 10, 0.2),
      entrySlippagePips: dist(1.2),
      entrySlippagePipsLong: dist(1.4),
      entrySlippagePipsShort: dist(1.0),
      exitSlippagePips: dist(0.6),
      exitSlippagePipsLong: dist(0.5),
      exitSlippagePipsShort: dist(0.7),
      entryLatencyMs: dist(850),
      exitLatencyMs: dist(2400),
    },
    paper: { trades: 2, closed: 2, expectedR: dist(1.1, 2) },
    drift: {
      status: 'drifting',
      reasons: [
        'The accounts’ realised R trails the emulator’s by 0.30 R per trade on average over 10 closed trades (limit 0.15 R).',
      ],
      minTrades: 10,
      maxRGapPerTrade: 0.15,
      maxSlippagePips: 1,
      alertActive: true,
      alertLastTriggeredAtUtc: '2026-10-08T12:00:00Z',
    },
    ...overrides,
  };
}

describe('isoMs', () => {
  it('reads ISO UTC times, treating a time without a zone as UTC', () => {
    expect(isoMs('2026-10-08T12:00:00Z')).toBe(Date.UTC(2026, 9, 8, 12));
    expect(isoMs('2026-10-08T12:00:00')).toBe(Date.UTC(2026, 9, 8, 12));
    expect(isoMs('2026-10-08T14:00:00+02:00')).toBe(Date.UTC(2026, 9, 8, 12));
    expect(isoMs(null)).toBeNull();
    expect(isoMs('')).toBeNull();
    expect(isoMs('not a time')).toBeNull();
  });
});

describe('normalizeParitySummary', () => {
  it('reads the engine’s summary', () => {
    const s = normalizeParitySummary(summaryPayload())!;
    expect(s.strategyId).toBe(41);
    expect(s.trades.total).toBe(14);
    expect(s.live.tradesMissed).toBe(1);
    expect(s.live.entrySlippagePips.mean).toBe(1.2);
    expect(s.live.rGap.positiveShare).toBe(0.2);
    expect(s.paper.expectedR.n).toBe(2);
    expect(s.drift.status).toBe('drifting');
    expect(s.drift.alertActive).toBe(true);
  });

  it('survives a partial or malformed payload', () => {
    expect(normalizeParitySummary(null)).toBeNull();
    expect(normalizeParitySummary([])).toBeNull();
    const s = normalizeParitySummary({ strategyId: '7', pipSize: 'x', live: { rGap: 'nope' } })!;
    expect(s.strategyId).toBe(7);
    expect(s.pipSize).toBe(0.0001);
    expect(s.live.rGap).toEqual(distribution(null));
    expect(s.live.rGap.n).toBe(0);
    expect(s.drift.status).toBe('noLiveTrades');
    expect(s.drift.reasons).toEqual([]);
  });
});

describe('texts', () => {
  it('says whether a slippage was worse or better for the strategy, in words', () => {
    expect(slippageText(1.24)).toBe('1.2 pips worse');
    expect(slippageText(-0.4)).toBe('0.4 pips better');
    expect(slippageText(1)).toBe('1.0 pip worse');
    expect(slippageText(-1)).toBe('1.0 pip better');
    expect(slippageText(0.04)).toBe('even');
    expect(slippageText(0)).toBe('even');
    expect(slippageText(null)).toBe(NA);
    expect(slippageText(Number.NaN)).toBe(NA);
  });

  it('signs R values with a true minus', () => {
    expect(rText(1.6)).toBe('+1.60 R');
    expect(rText(-0.4)).toBe(`${MINUS}0.40 R`);
    expect(rText(0.001)).toBe('0.00 R');
    expect(rText(undefined)).toBe(NA);
  });

  it('reads latencies in the unit that fits', () => {
    expect(latencyText(350)).toBe('350 ms');
    expect(latencyText(2_000)).toBe('2.0 s');
    expect(latencyText(186_000)).toBe('3.1 min');
    expect(latencyText(-500)).toBe(`${MINUS}500 ms`);
    expect(latencyText(null)).toBe(NA);
  });

  it('formats shares', () => {
    expect(shareText(0.666)).toBe('67%');
    expect(shareText(null)).toBe(NA);
  });

  it('derives a symbol’s price precision from its pip size', () => {
    expect(pricePrecision(0.0001)).toBe(5);
    expect(pricePrecision(0.01)).toBe(3);
    expect(pricePrecision(0.1)).toBe(2);
    expect(pricePrecision(1)).toBe(1);
    expect(pricePrecision(0)).toBe(5);
    expect(pricePrecision(null)).toBe(5);
    expect(pricePrecision(1e-9)).toBe(6);
  });
});

describe('driftView', () => {
  it('shows the alarm’s reasons when the live fills drift, and that the alert is active', () => {
    const s = normalizeParitySummary(summaryPayload())!;
    const v = driftView(s.drift, s.live);
    expect(v.tone).toBe('error');
    expect(v.title).toBe('Live fills drift from the emulator');
    expect(v.lines[0]).toContain('trails the emulator’s by 0.30 R');
    expect(v.lines.at(-1)).toBe('The drift alert is active (last sent 2026-10-08 12:00 UTC).');
  });

  it('summarises a strategy within the limits', () => {
    const s = normalizeParitySummary(
      summaryPayload({
        drift: {
          status: 'ok',
          reasons: [],
          minTrades: 10,
          maxRGapPerTrade: 0.15,
          maxSlippagePips: 1,
        },
      }),
    )!;
    const v = driftView(s.drift, s.live);
    expect(v.tone).toBe('success');
    expect(v.lines).toHaveLength(1);
    expect(v.lines[0]).toContain('Over 10 closed live trades');
    expect(v.lines[0]).toContain(`R gap ${MINUS}0.30 R per trade (limit ${MINUS}0.15 R)`);
    expect(v.lines[0]).toContain('entries 1.2 pips worse, exits 0.6 pips worse (limit 1.0 pips)');
  });

  it('says when there are too few trades or none', () => {
    const few = normalizeParitySummary(
      summaryPayload({ drift: { status: 'insufficient', minTrades: 10 } }),
    )!;
    expect(driftView(few.drift, few.live).title).toBe('Too few closed live trades to judge yet');
    expect(driftView(few.drift, few.live).lines[0]).toContain('once 10 trades have closed');

    const none = normalizeParitySummary(summaryPayload({ drift: {} }))!;
    const v = driftView(none.drift, none.live);
    expect(v.tone).toBe('neutral');
    expect(v.title).toBe('No live trades in this window');
  });
});

describe('metric rows', () => {
  it('lists slippage (overall, longs, shorts), R and latency', () => {
    const rows = liveMetricRows(normalizeParitySummary(summaryPayload())!.live);
    expect(rows.map((r) => r.label)).toEqual([
      'Entry slippage',
      '· longs',
      '· shorts',
      'Exit slippage',
      '· longs',
      '· shorts',
      'Expected R',
      'Realised R',
      'R gap',
      'Entry latency',
      'Exit latency',
    ]);
    expect(metricText(rows[0].kind, rows[0].dist.mean)).toBe('1.2 pips worse');
    expect(metricText(rows[8].kind, rows[8].dist.mean)).toBe(`${MINUS}0.30 R`);
    expect(metricText(rows[9].kind, rows[9].dist.mean)).toBe('850 ms');
  });

  it('claims a "worse" share only for slippage, where positive is worse', () => {
    const rows = liveMetricRows(normalizeParitySummary(summaryPayload())!.live);
    expect(worseShareText(rows[0].kind, rows[0].dist)).toBe('75%');
    expect(worseShareText(rows[8].kind, rows[8].dist)).toBe(NA);
    expect(worseShareText('slippage', distribution({ n: 0, positiveShare: null }))).toBe(NA);
  });
});

describe('sessions', () => {
  const raw = [
    {
      id: 9,
      scriptRevision: 'abcdef0123456789',
      isCurrentRevision: true,
      symbol: 'EURUSD',
      timeframe: 'H1',
      warmupFromUtc: '2026-08-01T00:00:00Z',
      liveFromUtc: '2026-10-01T08:00:00Z',
      startedAtUtc: '2026-10-01T07:59:00Z',
      lastStartedAtUtc: '2026-10-05T07:59:00Z',
      restarts: 1,
      stoppedAtUtc: null,
      endedAtUtc: null,
      endReason: null,
      trades: 1,
      liveTrades: 1,
      paperTrades: 0,
      lastReconcileRunId: 7001,
    },
    {
      id: 8,
      scriptRevision: '0123456789abcdef',
      isCurrentRevision: false,
      liveFromUtc: '2026-09-01T08:00:00Z',
      endedAtUtc: '2026-10-01T07:59:00Z',
      trades: 5,
    },
    'garbage',
  ];

  it('reads the sessions, skipping anything that is not one', () => {
    const list = normalizeParitySessions(raw);
    expect(list.map((s) => s.id)).toEqual([9, 8]);
    expect(list[0].lastReconcileRunId).toBe(7001);
    expect(list[1].lastReconcileRunId).toBeNull();
    expect(normalizeParitySessions({})).toEqual([]);
  });

  it('labels a session by when it ran, its state and its script', () => {
    const [running, ended] = normalizeParitySessions(raw);
    expect(sessionLabel(running)).toBe(
      'Session 9 — live from 2026-10-01 08:00 UTC, running; 1 trade; revision abcdef01, the current script',
    );
    expect(sessionLabel(ended)).toBe(
      'Session 8 — live from 2026-09-01 08:00 UTC, ended 2026-10-01 07:59; 5 trades; revision 01234567, an earlier script',
    );
    expect(sessionLabel({ ...running, stoppedAtUtc: '2026-10-06T10:00:00Z' })).toContain(
      'stopped 2026-10-06 10:00',
    );
  });
});

describe('reconcile', () => {
  function reconcilePayload(overrides: Record<string, unknown> = {}) {
    return {
      backtestRunId: 7001,
      sessionId: 9,
      status: 'completed',
      error: null,
      queuedAtUtc: '2026-10-08T10:00:00Z',
      completedAtUtc: '2026-10-08T10:03:00Z',
      session: {
        scriptRevision: 'abcdef0123456789',
        isCurrentRevision: true,
        warmupFromUtc: '2026-08-01T00:00:00Z',
        liveFromUtc: '2026-10-01T08:00:00Z',
        endedAtUtc: null,
        stoppedAtUtc: null,
        restarts: 1,
      },
      fromUtc: '2026-08-01T00:00:00Z',
      toUtc: '2026-10-08T10:00:00Z',
      compareFromUtc: '2026-10-01T08:00:00Z',
      compareToUtc: '2026-10-08T10:00:00Z',
      pipSize: 0.0001,
      matchToleranceBars: 1,
      summary: {
        backtestTrades: 2,
        sessionTrades: 2,
        matched: 1,
        missing: 1,
        extra: 1,
        matchedWithAccounts: 1,
        entrySlippagePips: dist(0.5, 1),
        exitSlippagePips: dist(-0.2, 1),
        rDifference: dist(-0.05, 1),
        accountEntrySlippagePips: dist(1.5, 1),
        accountExitSlippagePips: dist(0.8, 1),
        accountRDifference: dist(-0.3, 1),
      },
      pairs: [
        {
          status: 'matched',
          direction: 'long',
          entryId: 'L',
          backtest: {
            entryTimeUtc: '2026-10-02T09:00:00Z',
            entryPrice: 1.1,
            exitTimeUtc: '2026-10-02T15:00:00Z',
            exitPrice: 1.105,
            lots: 1,
            initialStopPrice: 1.095,
            r: 1,
          },
          session: {
            entryTimeUtc: '2026-10-02T09:00:00Z',
            entryPrice: 1.10005,
            exitTimeUtc: '2026-10-02T15:00:00Z',
            exitPrice: 1.10498,
            lots: 1,
            initialStopPrice: 1.095,
            r: 0.99,
            mode: 'live',
            outcome: 'SignalSent',
            tradeKey: 3,
            signalId: 501,
            exitKind: 'TakeProfit',
          },
          accounts: [
            {
              accountId: 27,
              orderId: 900,
              positionId: 77,
              orderStatus: 'Filled',
              lots: 0.5,
              entryPrice: 1.10015,
              entryTimeUtc: '2026-10-02T09:00:02Z',
              exitPrice: 1.1049,
              exitTimeUtc: '2026-10-02T15:00:03Z',
              entrySlippagePips: 1.5,
              exitSlippagePips: 1,
              rDifference: -0.05,
            },
            {
              accountId: 31,
              orderId: 901,
              positionId: null,
              orderStatus: 'Pending',
              lots: 0.5,
              entryPrice: null,
              entryTimeUtc: null,
              exitPrice: null,
              exitTimeUtc: null,
              entrySlippagePips: null,
              exitSlippagePips: null,
              rDifference: null,
            },
          ],
          entrySlippagePips: 0.5,
          exitSlippagePips: 0.2,
          rDifference: -0.01,
          note: null,
        },
        {
          status: 'missing',
          direction: 'short',
          entryId: 'S',
          backtest: {
            entryTimeUtc: '2026-10-03T11:00:00Z',
            entryPrice: 1.11,
            exitTimeUtc: null,
            exitPrice: null,
            lots: 1,
            initialStopPrice: null,
            r: null,
          },
          session: null,
          accounts: [],
          entrySlippagePips: null,
          exitSlippagePips: null,
          rDifference: null,
          note: 'The session was not running then (stopped 2026-10-03 10:00 UTC).',
        },
      ],
      notes: ['The backtest warms up from its own start.'],
      ...overrides,
    };
  }

  it('reads a completed reconcile', () => {
    const r = normalizeParityReconcile(reconcilePayload())!;
    expect(r.status).toBe('completed');
    expect(r.summary!.matched).toBe(1);
    expect(r.summary!.accountRDifference.mean).toBe(-0.3);
    expect(r.pairs).toHaveLength(2);
    expect(r.pairs[0].accounts[1].positionId).toBeNull();
    expect(r.pairs[1].session).toBeNull();
    expect(r.notes).toHaveLength(1);
    expect(reconcileDone(r.status)).toBe(true);
    expect(reconcileStatusText(r)).toBe('Backtest #7001 finished 2026-10-08 10:03 UTC.');
  });

  it('reads a queued, running or failed reconcile', () => {
    const queued = normalizeParityReconcile(
      reconcilePayload({ status: 'queued', summary: null, pairs: [] }),
    )!;
    expect(queued.summary).toBeNull();
    expect(reconcileDone(queued.status)).toBe(false);
    expect(reconcileStatusText(queued)).toBe('Backtest #7001 is queued.');
    expect(reconcileStatusText({ ...queued, status: 'running' })).toBe(
      'Backtest #7001 is running.',
    );

    const failed = { ...queued, status: 'failed', error: 'No candles for EURUSD H1' };
    expect(reconcileDone(failed.status)).toBe(true);
    expect(reconcileStatusText(failed)).toBe('Backtest #7001 failed: No candles for EURUSD H1.');
    expect(normalizeParityReconcile('nope')).toBeNull();
  });

  it('shows a matched pair with each account’s fills against the backtest', () => {
    const [matched] = normalizeParityReconcile(reconcilePayload())!.pairs;
    const v = pairView(matched, 5, (id) => (id === 27 ? 'Exness Real 27 (#27)' : `Account #${id}`));
    expect(v.statusLabel).toBe('Matched');
    expect(v.direction).toBe('Long');
    expect(v.timeText).toBe('2026-10-02 09:00');
    expect(v.backtestText).toBe('1.10000 → 1.10500 (+1.00 R)');
    expect(v.sessionText).toBe('1.10005 → 1.10498 (+0.99 R) · live');
    expect(v.entryText).toBe('0.5 pips worse');
    expect(v.exitText).toBe('0.2 pips worse');
    expect(v.rText).toBe(`${MINUS}0.01 R`);
    expect(v.accounts).toEqual([
      `Exness Real 27 (#27): 1.10015 → 1.10490 (in 1.5 pips worse, out 1.0 pip worse, ${MINUS}0.05 R vs the backtest)`,
      `Account #31: ${NA} → still open`,
    ]);
  });

  it('shows a trade only one side took, with the engine’s note', () => {
    const [, missing] = normalizeParityReconcile(reconcilePayload())!.pairs;
    const v = pairView(missing, 5);
    expect(v.statusLabel).toBe('Backtest only');
    expect(v.direction).toBe('Short');
    expect(v.backtestText).toBe('1.11000 → open');
    expect(v.sessionText).toBe(NA);
    expect(v.entryText).toBe(NA);
    expect(v.rText).toBe(NA);
    expect(v.note).toContain('not running then');
  });
});
