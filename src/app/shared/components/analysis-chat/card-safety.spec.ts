import { describe, expect, it } from 'vitest';

import type { SpotAnalysisFollowUpTurnDto } from '@core/api/api.types';

import {
  ACK_REQUIRED_CODE,
  approveBlockedByAck,
  batchNeedsAck,
  batchResultRows,
  batchSummary,
  batchableCards,
  cardTitle,
  countdownText,
  errorEnvelope,
  provenanceOf,
  undoFailureText,
  undoOf,
  whoText,
} from './card-safety';

const prov = (over: Record<string, unknown> = {}) => ({
  untrusted: true,
  sources: [
    { kind: 'news', source: '/news-intel/articles/9' },
    { kind: 'web', source: '/wire/sessions/3' },
  ],
  kinds: ['news', 'web'],
  highImpact: true,
  requiresAcknowledgement: true,
  note: 'Check that this change is what YOU want.',
  ...over,
});

const turn = (
  id: number,
  args: Record<string, unknown>,
  status = 'Pending',
  toolName = 'call_endpoint',
): SpotAnalysisFollowUpTurnDto => ({
  id,
  llmInvocationId: 1,
  role: 'ActionProposal',
  content: '',
  toolName,
  toolArgsJson: JSON.stringify(args),
  actionStatus: status,
  createdAtUtc: '2026-11-10T07:00:00Z',
});

describe('provenanceOf', () => {
  it('reads an untrusted card in plain words with every source in the hover', () => {
    const p = provenanceOf(JSON.stringify({ provenance: prov() }))!;
    expect(p.label).toBe('Proposed after reading outside text (news, web)');
    expect(p.title).toContain('/news-intel/articles/9');
    expect(p.title).toContain('Check that this change is what YOU want.');
    expect(p.requiresAck).toBe(true);
  });

  it('is null for a trusted card, an absent block or unreadable args', () => {
    expect(provenanceOf(JSON.stringify({ provenance: { untrusted: false } }))).toBeNull();
    expect(provenanceOf(JSON.stringify({ operationId: 'X' }))).toBeNull();
    expect(provenanceOf('{oops')).toBeNull();
    expect(provenanceOf(null)).toBeNull();
  });

  it('falls back to the sources when kinds is missing', () => {
    const p = provenanceOf(JSON.stringify({ provenance: prov({ kinds: undefined }) }))!;
    expect(p.label).toContain('news');
  });
});

describe('approveBlockedByAck', () => {
  const args = JSON.stringify({ provenance: prov() });
  it('blocks a card that needs the tick until it is ticked', () => {
    expect(approveBlockedByAck(args, false)).toBe(true);
    expect(approveBlockedByAck(args, true)).toBe(false);
  });
  it('never blocks a card that only carries the badge', () => {
    const low = JSON.stringify({
      provenance: prov({ requiresAcknowledgement: false, highImpact: false }),
    });
    expect(approveBlockedByAck(low, false)).toBe(false);
    expect(approveBlockedByAck(JSON.stringify({}), false)).toBe(false);
  });
});

describe('undoOf', () => {
  const now = Date.parse('2026-11-10T07:10:00Z');
  const undo = (over: Record<string, unknown> = {}) => ({
    available: true,
    status: 'available',
    label: 'Cancel monitor #123',
    expiresAtUtc: '2026-11-10T07:15:00Z',
    ...over,
  });

  it('offers the undo on a confirmed card with the time left', () => {
    const v = undoOf(turn(1, { undo: undo() }, 'Confirmed'), now);
    expect(v).toEqual({
      kind: 'offer',
      label: 'Cancel monitor #123',
      expiresAt: '2026-11-10T07:15:00Z',
      remainingMs: 5 * 60_000,
    });
  });

  it('says the window passed once it expired', () => {
    expect(
      undoOf(turn(1, { undo: undo() }, 'Confirmed'), Date.parse('2026-11-10T07:15:00Z'))?.kind,
    ).toBe('expired');
  });

  it('does not offer an undo on a card that is not confirmed', () => {
    expect(undoOf(turn(1, { undo: undo() }, 'Failed'), now)).toBeNull();
  });

  it('reports running, done (with who and why) and failed', () => {
    expect(undoOf(turn(1, { undo: undo({ status: 'running' }) }, 'Confirmed'), now)?.kind).toBe(
      'running',
    );
    expect(
      undoOf(
        turn(
          1,
          {
            undo: undo({
              status: 'done',
              undoneAtUtc: '2026-11-10T07:12:00Z',
              undoneBy: '7',
              undoReason: 'wrong pair',
            }),
          },
          'Confirmed',
        ),
        now,
      ),
    ).toEqual({
      kind: 'done',
      label: 'Cancel monitor #123',
      at: '2026-11-10T07:12:00Z',
      by: '7',
      reason: 'wrong pair',
    });
    expect(
      undoOf(turn(1, { undo: undo({ status: 'failed', error: 'boom' }) }, 'Confirmed'), now),
    ).toEqual({
      kind: 'failed',
      label: 'Cancel monitor #123',
      error: 'boom',
    });
  });

  it('passes the engine reason through when there is no undo', () => {
    expect(
      undoOf(turn(1, { undo: { available: false, reason: 'No undo: x' } }, 'Confirmed'), now),
    ).toEqual({
      kind: 'none',
      reason: 'No undo: x',
    });
    expect(undoOf(turn(1, {}, 'Confirmed'), now)).toBeNull();
  });
});

describe('countdown / who / failure text', () => {
  it('formats the countdown', () => {
    expect(countdownText(5 * 60_000 + 3000)).toBe('5:03 left');
    expect(countdownText(42_000)).toBe('42 s left');
    expect(countdownText(-5)).toBe('0 s left');
    expect(countdownText(null)).toBe('');
  });
  it('names the person', () => {
    expect(whoText('admin-user:7')).toBe('operator #7');
    expect(whoText('7')).toBe('operator #7');
    expect(whoText(null)).toBe('an operator');
  });
  it('words the undo refusals', () => {
    expect(undoFailureText('-24', '')).toMatch(/no longer be undone/);
    expect(undoFailureText('-25', 'The undo did not complete: x')).toBe(
      'The undo did not complete: x',
    );
    expect(undoFailureText(null, null)).toMatch(/reachable/);
  });
});

describe('batch review', () => {
  const thread: SpotAnalysisFollowUpTurnDto[] = [
    turn(2, { summary: 'Arm the OCO on #12' }),
    turn(3, { operationId: 'Monitor_Create', provenance: prov() }),
    turn(4, { command: 'chart.setTimeframe' }, 'Pending', 'ui_action'),
    turn(5, { summary: 'Done already' }, 'Confirmed'),
    turn(6, { method: 'POST', path: '/x' }),
  ];

  it('takes pending cards in id order, never page commands, at most 20', () => {
    expect(batchableCards(thread).map((t) => t.id)).toEqual([2, 3, 6]);
    const reversed = [turn(9, {}), turn(7, {}, 'Pending', 'approval')];
    expect(batchableCards(reversed).map((t) => t.id)).toEqual([7, 9]);
    const many = Array.from({ length: 25 }, (_, i) => turn(100 + i, {}));
    expect(batchableCards(many)).toHaveLength(20);
  });

  it('needs the tick when any card does', () => {
    expect(batchNeedsAck(batchableCards(thread))).toBe(true);
    expect(batchNeedsAck([thread[0]])).toBe(false);
  });

  it('titles a card by summary, operation or call', () => {
    expect(cardTitle(thread[0])).toBe('Arm the OCO on #12');
    expect(cardTitle(thread[1])).toBe('Monitor_Create');
    expect(cardTitle(thread[4])).toBe('POST /x');
  });

  it('maps the engine results in card order, in plain words', () => {
    const cards = batchableCards(thread);
    const rows = batchResultRows(
      [
        { turnId: 6, status: 'Skipped' },
        { turnId: 2, status: 'Confirmed', message: '' },
        { turnId: 3, status: 'Refused', code: ACK_REQUIRED_CODE },
      ],
      cards,
    );
    expect(rows.map((r) => [r.turnId, r.status, r.tone])).toEqual([
      [2, 'Confirmed', 'good'],
      [3, 'Refused', 'bad'],
      [6, 'Skipped', 'warn'],
    ]);
    expect(rows[1].text).toMatch(/outside-text check/);
    expect(batchSummary(rows)).toBe('1 approved, 1 refused, 1 skipped');
  });

  it('flags a card the engine did not answer for', () => {
    const rows = batchResultRows([], [thread[0]]);
    expect(rows[0]).toMatchObject({ status: 'Unknown', tone: 'warn' });
  });
});

describe('errorEnvelope', () => {
  it('reads the envelope from an HTTP error body', () => {
    expect(
      errorEnvelope({
        error: { responseCode: '-23', message: 'Tick it' },
        message: 'Http failure',
      }),
    ).toEqual({
      code: '-23',
      message: 'Tick it',
    });
  });
  it('says plainly when the engine was not reached', () => {
    expect(
      errorEnvelope({ status: 0, message: 'Http failure response … 0 Unknown Error' }).message,
    ).toMatch(/could not be reached/);
  });
  it('falls back to the error message', () => {
    expect(errorEnvelope({ message: 'down' })).toEqual({ code: null, message: 'down' });
    expect(errorEnvelope(null)).toEqual({ code: null, message: null });
  });
});
