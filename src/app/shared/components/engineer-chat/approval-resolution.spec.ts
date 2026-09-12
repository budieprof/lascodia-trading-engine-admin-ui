/**
 * Resolving an approval card with words, and with an edit.
 *
 * The fixtures are the shapes the engine writes today: an algo-engineer platform card carries
 * `operationId` + `routeTemplate` + the bound `args` object (`{route,query,body}`), and a resolved
 * card carries `decision` / `reason` / `amendment.changes` on `toolResultJson`
 * (`ResolveSpotAnalysisFollowUpActionCommand`). A host-gated verb card (apply_config_change) carries
 * neither, which is exactly why it must not be offered an amendment.
 */
import { describe, expect, it } from 'vitest';
import type { SpotAnalysisFollowUpTurnDto } from '@core/api/api.types';
import {
  amendableFields,
  buildAmendedArgs,
  changedFields,
  decisionEchoLine,
  describeChange,
  isAmendable,
  parseDecisionEcho,
  parseResolution,
  resolveApprovalBody,
  resolutionByline,
  validateAmendEdits,
  MAX_REASON_LENGTH,
} from './approval-resolution';

function turn(partial: Partial<SpotAnalysisFollowUpTurnDto>): SpotAnalysisFollowUpTurnDto {
  return {
    id: 7,
    llmInvocationId: 28937,
    role: 'ActionProposal',
    content: 'Approve?',
    toolName: 'approval',
    toolArgsJson: null,
    toolResultJson: null,
    actionStatus: 'Pending',
    createdAtUtc: '2026-09-12T10:00:00Z',
    ...partial,
  };
}

function card(args: unknown, result: unknown = null): SpotAnalysisFollowUpTurnDto {
  return turn({
    toolArgsJson: args === null ? null : JSON.stringify(args),
    toolResultJson: result === null ? null : JSON.stringify(result),
  });
}

/** A platform card as the engine binds it: an operation, a route template, and bound args. */
const PLATFORM_ARGS = {
  verb: 'platform_call',
  targets: ['POST /trade-signal/17'],
  live: true,
  operationId: 'TradeSignal_Create',
  routeTemplate: '/trade-signal/{accountId}',
  method: 'POST',
  path: '/trade-signal/17',
  args: {
    route: { accountId: 17 },
    query: { dryRun: false },
    body: { lots: 0.5, comment: 'sweep', tags: ['a', 'b'] },
  },
  argsCanonical: '{"operationId":"TradeSignal_Create"}',
};

// ── The request body ─────────────────────────────────────────────────────────────────────────

describe('resolveApprovalBody', () => {
  it('is an empty object when nothing was said — the request this endpoint always sent', () => {
    expect(resolveApprovalBody()).toEqual({});
    expect(resolveApprovalBody({ reason: '   ' })).toEqual({});
    expect(resolveApprovalBody({ reason: null, amendedArgs: null })).toEqual({});
  });

  it('trims the operator words', () => {
    expect(resolveApprovalBody({ reason: '  re-propose with 1.2 ATR \n' })).toEqual({
      reason: 're-propose with 1.2 ATR',
    });
  });

  it('caps the reason where the engine caps it, so the clip is not a surprise', () => {
    const body = resolveApprovalBody({ reason: 'x'.repeat(MAX_REASON_LENGTH + 500) });
    expect((body['reason'] as string).length).toBe(MAX_REASON_LENGTH);
  });

  it('carries amendedArgs only when it holds something', () => {
    expect(resolveApprovalBody({ amendedArgs: {} })).toEqual({});
    expect(resolveApprovalBody({ reason: 'lower', amendedArgs: { body: { lots: 0.25 } } })).toEqual(
      {
        reason: 'lower',
        amendedArgs: { body: { lots: 0.25 } },
      },
    );
  });
});

// ── What may be amended ──────────────────────────────────────────────────────────────────────

describe('amendableFields', () => {
  it('lists every scalar in query and body, and never the route', () => {
    const fields = amendableFields(card(PLATFORM_ARGS));
    expect(fields.map((f) => f.path)).toEqual([
      'query.dryRun',
      'body.lots',
      'body.comment',
      'body.tags[0]',
      'body.tags[1]',
    ]);
    expect(fields.some((f) => f.path.startsWith('route'))).toBe(false);
  });

  it('carries the kind and the value, which decide the input and the re-typing', () => {
    const byPath = new Map(amendableFields(card(PLATFORM_ARGS)).map((f) => [f.path, f]));
    expect(byPath.get('body.lots')).toMatchObject({ kind: 'number', value: '0.5', label: 'lots' });
    expect(byPath.get('query.dryRun')).toMatchObject({ kind: 'boolean', value: 'false' });
    expect(byPath.get('body.comment')).toMatchObject({ kind: 'string', value: 'sweep' });
  });

  it('offers nothing on a host-gated verb card — the engine would refuse the amendment', () => {
    const config = card({
      verb: 'apply_config_change',
      targets: ['SpotSweep:MaxPerSymbol = 4'],
      sideEffect: 'Writes a live EngineConfig value',
    });
    expect(amendableFields(config)).toEqual([]);
    expect(isAmendable(config)).toBe(false);
  });

  it('offers nothing when the card carries no bound args to re-bind', () => {
    const { args: _args, ...noArgs } = PLATFORM_ARGS;
    expect(isAmendable(card(noArgs))).toBe(false);
  });

  it('offers nothing when the card names no route template', () => {
    const { routeTemplate: _rt, ...noTemplate } = PLATFORM_ARGS;
    expect(isAmendable(card(noTemplate))).toBe(false);
  });

  it('survives an unreadable or absent payload', () => {
    expect(amendableFields(card(null))).toEqual([]);
    expect(amendableFields(turn({ toolArgsJson: '{not json' }))).toEqual([]);
  });

  it('walks nested objects inside the body', () => {
    const nested = card({
      ...PLATFORM_ARGS,
      args: { route: {}, query: {}, body: { risk: { maxLots: 2, note: null } } },
    });
    expect(amendableFields(nested).map((f) => [f.path, f.kind])).toEqual([
      ['body.risk.maxLots', 'number'],
      ['body.risk.note', 'null'],
    ]);
  });
});

// ── Validating an edit before it is sent ─────────────────────────────────────────────────────

describe('validateAmendEdits', () => {
  const fields = amendableFields(card(PLATFORM_ARGS));

  it('refuses an empty edit rather than earning the engine "identical to the card"', () => {
    expect(validateAmendEdits(fields, {})).toMatch(/Nothing is changed/);
    expect(validateAmendEdits(fields, { 'body.lots': '0.5' })).toMatch(/Nothing is changed/);
  });

  it('treats a re-spelled number as no change at all', () => {
    expect(changedFields(fields, { 'body.lots': ' 0.50 ' })).toEqual([]);
  });

  it('refuses a number that no longer parses', () => {
    expect(validateAmendEdits(fields, { 'body.lots': 'half' })).toMatch(/must be a number/);
    expect(validateAmendEdits(fields, { 'body.lots': '' })).toMatch(/must be a number/);
  });

  it('refuses a boolean that is not true or false', () => {
    expect(validateAmendEdits(fields, { 'query.dryRun': 'yes' })).toMatch(/true or false/);
  });

  it('passes a real value change', () => {
    expect(validateAmendEdits(fields, { 'body.lots': '0.92' })).toBeNull();
    expect(changedFields(fields, { 'body.lots': '0.92' }).map((f) => f.path)).toEqual([
      'body.lots',
    ]);
  });
});

// ── Composing the amendment ──────────────────────────────────────────────────────────────────

describe('buildAmendedArgs', () => {
  const t = card(PLATFORM_ARGS);
  const fields = amendableFields(t);

  it('sends the WHOLE bound object, with the route unchanged, so the engine can match the shape', () => {
    expect(buildAmendedArgs(t, fields, { 'body.lots': '0.92' })).toEqual({
      route: { accountId: 17 },
      query: { dryRun: false },
      body: { lots: 0.92, comment: 'sweep', tags: ['a', 'b'] },
    });
  });

  it('keeps each value the type the card carried', () => {
    const out = buildAmendedArgs(t, fields, {
      'query.dryRun': 'true',
      'body.comment': 'operator-sized',
      'body.tags[1]': 'c',
    });
    expect(out).toEqual({
      route: { accountId: 17 },
      query: { dryRun: true },
      body: { lots: 0.5, comment: 'operator-sized', tags: ['a', 'c'] },
    });
  });

  it('never mutates the card it was read from', () => {
    buildAmendedArgs(t, fields, { 'body.lots': '0.92' });
    expect(JSON.parse(t.toolArgsJson!).args.body.lots).toBe(0.5);
  });

  it('is null when there is nothing valid to send', () => {
    expect(buildAmendedArgs(t, fields, {})).toBeNull();
    expect(buildAmendedArgs(t, fields, { 'body.lots': 'half' })).toBeNull();
    expect(buildAmendedArgs(card({ verb: 'apply_config_change' }), [], {})).toBeNull();
  });

  it('omits the body entirely for a call that carries none — adding one is a different call', () => {
    const noBody = card({
      ...PLATFORM_ARGS,
      args: { route: { accountId: 17 }, query: { limit: 10 } },
    });
    const out = buildAmendedArgs(noBody, amendableFields(noBody), { 'query.limit': '25' });
    expect(out).toEqual({ route: { accountId: 17 }, query: { limit: 25 } });
    expect(out && 'body' in out).toBe(false);
  });
});

// ── What a resolved card says ────────────────────────────────────────────────────────────────

describe('parseResolution', () => {
  it('reads a rejection and its reason', () => {
    const res = parseResolution(
      card(PLATFORM_ARGS, {
        decision: 'rejected',
        resolvedAtUtc: '2026-09-12T10:05:00Z',
        resolvedByUserId: 'olabode',
        reason: 'the stop is inside the spread — re-propose with 1.2 ATR',
      }),
    );
    expect(res.decision).toBe('rejected');
    expect(res.reason).toBe('the stop is inside the spread — re-propose with 1.2 ATR');
    expect(res.resolvedByUserId).toBe('olabode');
    expect(res.amended).toBe(false);
    expect(resolutionByline(res)).toBe('Rejected by olabode');
  });

  it('reads an approval that carried an edit', () => {
    const res = parseResolution(
      card(PLATFORM_ARGS, {
        decision: 'approved',
        resolvedByUserId: 'olabode',
        amendedByUserId: 'olabode',
        amendedAtUtc: '2026-09-12T10:06:00Z',
        reason: 'yes, but at 0.25 lots',
        amendment: { changes: [{ path: 'body.lots', from: '0.5', to: '0.25' }] },
      }),
    );
    expect(res.amended).toBe(true);
    expect(res.changes).toEqual([{ path: 'body.lots', from: '0.5', to: '0.25' }]);
    expect(describeChange(res.changes[0])).toBe('lots 0.5 → 0.25');
    expect(resolutionByline(res)).toBe('Approved with an edit by olabode');
  });

  it('reads the half-state where one more approver is needed', () => {
    const res = parseResolution(
      card(PLATFORM_ARGS, { awaitingSecondApprover: true, reason: 'fine by me', approvals: [] }),
    );
    expect(res.awaitingSecondApprover).toBe(true);
    expect(res.reason).toBe('fine by me');
    expect(resolutionByline(res)).toBe('Approved (one of two)');
  });

  it('says nothing about an unresolved or unreadable card', () => {
    expect(parseResolution(card(PLATFORM_ARGS)).decision).toBeNull();
    expect(parseResolution(turn({ toolResultJson: 'not json' })).reason).toBeNull();
    expect(parseResolution(card(PLATFORM_ARGS, { decision: 'rejected' })).reason).toBeNull();
  });
});

// ── The engine's echo of the decision ────────────────────────────────────────────────────────

describe('parseDecisionEcho', () => {
  it('recognises the User turn the engine writes for a rejection', () => {
    const echo = parseDecisionEcho(
      turn({ role: 'User', toolName: null, content: '**Rejected.** the stop is too tight' }),
    );
    expect(echo).toEqual({ decision: 'Rejected', text: 'the stop is too tight' });
    expect(decisionEchoLine(echo!)).toBe('You rejected this — your note is on the card');
  });

  it('recognises the one-of-two approval variant', () => {
    expect(
      parseDecisionEcho(
        turn({ role: 'User', toolName: null, content: '**Approved (one of two).** looks right' }),
      ),
    ).toEqual({ decision: 'Approved (one of two)', text: 'looks right' });
  });

  it('leaves an ordinary operator message alone', () => {
    expect(parseDecisionEcho(turn({ role: 'User', content: 'what changed live?' }))).toBeNull();
    expect(parseDecisionEcho(turn({ role: 'Assistant', content: '**Rejected.** ...' }))).toBeNull();
    // The decision with no words is never written as a turn at all.
    expect(parseDecisionEcho(turn({ role: 'User', content: '**Rejected.**' }))).toBeNull();
  });
});
