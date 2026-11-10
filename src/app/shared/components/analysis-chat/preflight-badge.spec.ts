import { describe, expect, it } from 'vitest';
import { preflightBadgeOf, replayLineOf, replayWindow } from './preflight-badge';

/** Card args as the engine stores them (AssistantProposalPreflight.AttachToArgs). */
function card(preflight?: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    operationId: 'TradeRecommendation_ArmOco',
    route: { id: 12 },
    method: 'POST',
    path: '/trade-recommendation/12/arm-oco',
    ...extra,
    ...(preflight ? { preflight } : {}),
  });
}

describe('preflightBadgeOf', () => {
  it('shows a passing verdict with the engine label', () => {
    const b = preflightBadgeOf(
      'call_endpoint',
      card({
        verdict: 'wouldSucceed',
        label: 'checked: would succeed',
        errors: [],
        warnings: [],
        note: null,
        checkedAtUtc: '2026-11-10T09:12:33.123Z',
      }),
    )!;
    expect(b.tone).toBe('pass');
    expect(b.label).toBe('Checked: would succeed');
    expect(b.details).toEqual([]);
    expect(b.title).toContain('dry run');
    expect(b.title).toContain('2026-11-10 09:12:33 UTC');
  });

  it('lists warnings under a would-succeed-with-warnings verdict', () => {
    const b = preflightBadgeOf(
      'call_endpoint',
      card({
        verdict: 'wouldSucceedWithWarnings',
        label: 'checked: would succeed, with 2 warning(s)',
        errors: [],
        warnings: ['Stop is inside the spread', '  ', 'Market is closed until 22:00'],
      }),
    )!;
    expect(b.tone).toBe('warn');
    expect(b.details).toEqual(['Stop is inside the spread', 'Market is closed until 22:00']);
    expect(b.title).toContain('• Stop is inside the spread');
  });

  it('shows the engine’s not-checked verdict as neutral, with its note in the label', () => {
    const b = preflightBadgeOf(
      'call_endpoint',
      card({
        verdict: 'notChecked',
        label: 'not checked (no dry run exists for this operation)',
        errors: [],
        warnings: [],
        note: 'no dry run exists for this operation',
      }),
    )!;
    expect(b.tone).toBe('neutral');
    expect(b.label).toBe('Not checked (no dry run exists for this operation)');
    expect(b.title).not.toContain('Note:');
  });

  it('never passes a would-fail verdict off as fine', () => {
    const b = preflightBadgeOf(
      'call_endpoint',
      card({ verdict: 'wouldFail', label: 'checked: would fail', errors: ['403'], warnings: [] }),
    )!;
    expect(b.tone).toBe('fail');
    expect(b.details).toEqual(['403']);
  });

  it('says "not pre-checked" on an assistant write with no verdict (the checker failed)', () => {
    const b = preflightBadgeOf('call_endpoint', card())!;
    expect(b.tone).toBe('neutral');
    expect(b.label).toBe('Not pre-checked');
    expect(b.details).toEqual([]);
  });

  it('shows nothing on cards that are never pre-checked', () => {
    // A page command.
    expect(preflightBadgeOf('ui_action', '{"command":"chart.describe"}')).toBeNull();
    // The spot chat's literal http call (no operationId).
    expect(
      preflightBadgeOf('http_action', '{"method":"POST","path":"/order","body":{}}'),
    ).toBeNull();
    // Unreadable / empty args.
    expect(preflightBadgeOf('call_endpoint', null)).toBeNull();
    expect(preflightBadgeOf('call_endpoint', '{oops')).toBeNull();
    expect(preflightBadgeOf('call_endpoint', '[1]')).toBeNull();
  });

  it('reads a verdict even on a card without operationId', () => {
    const b = preflightBadgeOf(
      'http_action',
      JSON.stringify({ preflight: { verdict: 'wouldSucceed', label: 'checked: would succeed' } }),
    )!;
    expect(b.tone).toBe('pass');
  });

  it('falls back to its own words when the label is missing', () => {
    expect(preflightBadgeOf('call_endpoint', card({ verdict: 'wouldSucceed' }))!.label).toBe(
      'Checked: would succeed',
    );
    expect(preflightBadgeOf('call_endpoint', card({ verdict: 'mystery' }))!.tone).toBe('neutral');
  });
});

describe('replayLineOf', () => {
  const withReplay = (replay: unknown) =>
    JSON.stringify({ operationId: 'X', preflight: { verdict: 'wouldSucceed', replay } });

  it('summarises a passed replay over its window', () => {
    const r = replayLineOf(
      withReplay({
        outcome: 'passed',
        legs: [
          {
            label: 'card #327',
            outcome: 'passed',
            summary: 'ready on the retest',
            fromUtc: '2026-11-06T00:00:00Z',
            toUtc: '2026-11-09T12:00:00Z',
            bars: 300,
          },
        ],
      }),
    )!;
    expect(r.text).toBe('Watch script replayed over 2026-11-06..09: ready on the retest ✓');
    expect(r.tone).toBe('pass');
    expect(r.legs[0].bars).toBe(300);
  });

  it('marks a not-checked replay neutrally and counts extra legs', () => {
    const r = replayLineOf(
      withReplay({
        outcome: 'notChecked',
        legs: [
          { label: 'a', outcome: 'notChecked', summary: 'no candles' },
          { label: 'b', outcome: 'passed', summary: 'ok' },
        ],
      }),
    )!;
    expect(r.outcome).toBe('notChecked');
    expect(r.text).toBe('Watch script could not be replayed: no candles (+1 more)');
  });

  it('is null without a replay block', () => {
    expect(replayLineOf(withReplay(undefined))).toBeNull();
    expect(replayLineOf(null)).toBeNull();
  });

  it('shortens windows', () => {
    expect(replayWindow('2026-10-30T00:00Z', '2026-11-02T00:00Z')).toBe('2026-10-30..11-02');
    expect(replayWindow('2026-11-06T00:00Z', '2026-11-06T09:00Z')).toBe('2026-11-06');
  });
});
