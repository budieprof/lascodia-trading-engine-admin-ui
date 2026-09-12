/**
 * Reading an approval card's payload for what it would actually do. Every fixture here is the
 * shape the host service / engine writes today (see `request_approval` in the algo-engineer host
 * and `CreateApprovalCardAsync` in the engine's platform-call path).
 */
import { describe, expect, it } from 'vitest';
import type { SpotAnalysisFollowUpTurnDto } from '@core/api/api.types';
import {
  modelComparisonRows,
  modelIdsOf,
  modelLabel,
  planFromApproval,
  planNeedsFetch,
  prettyJson,
  splitConfigTarget,
  type ModelLike,
} from './approval-preview';

function card(args: unknown): SpotAnalysisFollowUpTurnDto {
  return {
    id: 1,
    llmInvocationId: 28937,
    role: 'ActionProposal',
    content: 'Approve?',
    toolName: 'approval',
    toolArgsJson: args === null ? null : JSON.stringify(args),
    toolResultJson: null,
    actionStatus: 'Pending',
    createdAtUtc: '2026-09-12T10:00:00Z',
  };
}

describe('planFromApproval — config change', () => {
  it('reads key and value off the named args when the card carries them', () => {
    const plan = planFromApproval(
      card({ verb: 'apply_config_change', key: 'SpotSweep:MaxPerSymbol', value: '4' }),
    );
    expect(plan).toEqual({ kind: 'config', key: 'SpotSweep:MaxPerSymbol', value: '4' });
  });

  it('falls back to the target text, which is where the host actually puts it today', () => {
    const plan = planFromApproval(
      card({
        verb: 'apply_config_change',
        targets: ['ViabilityGates:StopTooTight:Mode = Enforce'],
        sideEffect: 'Writes a live EngineConfig value',
      }),
    );
    expect(plan).toEqual({
      kind: 'config',
      key: 'ViabilityGates:StopTooTight:Mode',
      value: 'Enforce',
    });
  });

  it('keeps a value that itself contains an equals sign', () => {
    expect(splitConfigTarget('A:B = x=y')).toEqual({ key: 'A:B', value: 'x=y' });
  });

  it('renders the plain card when the key cannot be established', () => {
    expect(planFromApproval(card({ verb: 'apply_config_change', targets: [] })).kind).toBe('none');
  });

  it('wants the current value fetched', () => {
    expect(planNeedsFetch(planFromApproval(card({ verb: 'apply_config_change', key: 'K' })))).toBe(
      true,
    );
  });
});

describe('planFromApproval — platform call', () => {
  const canonical = JSON.stringify({
    operationId: 'analysis-monitors.create',
    method: 'POST',
    routeTemplate: '/market-data/analysis-monitors',
    route: {},
    query: { dryRun: 'true' },
    body: { symbol: 'EURUSD', intentText: 'watch the spread' },
  });

  it('renders the method, path and a pretty-printed body', () => {
    const plan = planFromApproval(
      card({
        verb: 'platform_call',
        operationId: 'analysis-monitors.create',
        method: 'post',
        path: '/market-data/analysis-monitors',
        argsCanonical: canonical,
      }),
    );
    expect(plan).toMatchObject({
      kind: 'platform',
      operationId: 'analysis-monitors.create',
      method: 'POST',
      path: '/market-data/analysis-monitors',
    });
    if (plan.kind !== 'platform') throw new Error('wrong kind');
    expect(plan.body).toBe(
      ['{', '  "symbol": "EURUSD",', '  "intentText": "watch the spread"', '}'].join('\n'),
    );
    expect(plan.query).toContain('"dryRun": "true"');
  });

  it('needs no fetch — the card already carries the whole call', () => {
    const plan = planFromApproval(
      card({ verb: 'platform_call', method: 'GET', path: '/config/all' }),
    );
    expect(planNeedsFetch(plan)).toBe(false);
    if (plan.kind !== 'platform') throw new Error('wrong kind');
    expect(plan.body).toBeNull();
  });

  it('falls back to the canonical route template when the card names no path', () => {
    const plan = planFromApproval(card({ verb: 'platform_call', argsCanonical: canonical }));
    expect(plan).toMatchObject({ kind: 'platform', path: '/market-data/analysis-monitors' });
  });

  it('shows an unparseable body verbatim rather than dropping it', () => {
    expect(prettyJson('{not json')).toBe('{not json');
    expect(prettyJson('   ')).toBeNull();
    expect(prettyJson(null)).toBeNull();
    expect(prettyJson({})).toBeNull();
  });
});

describe('planFromApproval — model swap', () => {
  it('takes the model id from the target the host writes', () => {
    const plan = planFromApproval(
      card({ verb: 'ml_activate_model', targets: ['model #918'], live: true }),
    );
    expect(plan).toEqual({
      kind: 'models',
      verb: 'ml_activate_model',
      incomingId: 918,
      outgoingId: null,
      scope: null,
    });
    expect(modelIdsOf(plan)).toEqual([918]);
  });

  it('pairs the incoming and outgoing models when the card names both', () => {
    const plan = planFromApproval(
      card({ verb: 'ml_activate_model', id: 919, championModelId: 918 }),
    );
    expect(modelIdsOf(plan)).toEqual([919, 918]);
    expect(planNeedsFetch(plan)).toBe(true);
  });

  it('keeps the pair as scope when a rollback names no model at all', () => {
    const plan = planFromApproval(card({ verb: 'ml_rollback_model', targets: ['EURUSD H1'] }));
    expect(plan).toMatchObject({ kind: 'models', incomingId: null, scope: 'EURUSD H1' });
    // Nothing to fetch: the card does not say which model it would restore.
    expect(planNeedsFetch(plan)).toBe(false);
    expect(modelIdsOf(plan)).toEqual([]);
  });

  it('never returns the same id twice', () => {
    const plan = planFromApproval(card({ verb: 'ml_activate_model', id: 7, currentModelId: 7 }));
    expect(modelIdsOf(plan)).toEqual([7]);
  });
});

describe('planFromApproval — everything else', () => {
  it('falls through to the card as it renders today', () => {
    expect(planFromApproval(card({ verb: 'deploy', targets: ['docker compose up'] })).kind).toBe(
      'none',
    );
    expect(planFromApproval(card({ verb: 'question' })).kind).toBe('none');
    expect(planFromApproval(card(null)).kind).toBe('none');
    expect(planFromApproval({ ...card({}), toolArgsJson: 'not json' }).kind).toBe('none');
  });
});

describe('modelComparisonRows', () => {
  const model = (p: Partial<ModelLike> & { id: number }): ModelLike => ({
    symbol: 'EURUSD',
    timeframe: 'H1',
    status: 'Trained',
    isActive: false,
    directionAccuracy: null,
    sharpeRatio: null,
    netPnlSharpe: null,
    ...p,
  });

  it('marks the better side of every comparable metric', () => {
    const rows = modelComparisonRows([
      model({ id: 919, directionAccuracy: 0.58, sharpeRatio: 1.4 }),
      model({ id: 918, directionAccuracy: 0.55, sharpeRatio: 1.9, isActive: true }),
    ]);
    const acc = rows.find((r) => r.label === 'Direction accuracy');
    expect(acc?.values).toEqual(['58.0%', '55.0%']);
    expect(acc?.best).toBe(0);
    // Higher is better throughout, so the incumbent can win a row — that is the point of showing it.
    expect(rows.find((r) => r.label === 'Sharpe ratio')?.best).toBe(1);
    expect(rows.find((r) => r.label === 'Status')?.values).toEqual(['Trained', 'Trained · live']);
  });

  it('calls a tie no winner', () => {
    const rows = modelComparisonRows([
      model({ id: 1, directionAccuracy: 0.5 }),
      model({ id: 2, directionAccuracy: 0.5 }),
    ]);
    expect(rows.find((r) => r.label === 'Direction accuracy')?.best).toBeNull();
  });

  it('drops a metric no model reports instead of printing dashes', () => {
    const rows = modelComparisonRows([model({ id: 1, directionAccuracy: 0.6 })]);
    expect(rows.map((r) => r.label)).toEqual(['Direction accuracy', 'Status']);
    // One model is still worth showing — and nothing is "best" with a single column.
    expect(rows[0].best).toBeNull();
  });

  it('reads netPnlSharpe when the payload carries it', () => {
    const rows = modelComparisonRows([
      model({ id: 1, netPnlSharpe: 0.9 }),
      model({ id: 2, netPnlSharpe: 1.25 }),
    ]);
    const row = rows.find((r) => r.label === 'Net-P&L Sharpe');
    expect(row?.values).toEqual(['0.90', '1.25']);
    expect(row?.best).toBe(1);
  });

  it('heads a column with what identifies the model', () => {
    expect(modelLabel({ id: 918, symbol: 'EURUSD', timeframe: 'H1', modelVersion: '3' })).toBe(
      '#918 · EURUSD H1 v3',
    );
    expect(modelLabel({ id: 7 })).toBe('#7');
  });

  it('has nothing to say about no models', () => {
    expect(modelComparisonRows([])).toEqual([]);
  });
});
