import { describe, expect, it } from 'vitest';

import { readApprovalOutcome } from './approval';

const GATES = [
  { name: 'DSR', passed: true, detail: 'DSR=0.97' },
  { name: 'CPCV', passed: false, detail: 'median Sharpe 0.21 < 0.5' },
];

describe('readApprovalOutcome', () => {
  it('reads an approval', () => {
    const o = readApprovalOutcome({
      status: true,
      responseCode: '00',
      message: 'Approved. Strategy 7 now paper-trades (Approved + Paused); …',
      data: { approved: true, stage: 'Approved', gates: [GATES[0]] },
    });
    expect(o).toEqual({
      verdict: 'approved',
      stage: 'Approved',
      gates: [GATES[0]],
      message: 'Approved. Strategy 7 now paper-trades (Approved + Paused); …',
    });
  });

  it('reads a rejection — status true, approved false — with every gate', () => {
    const o = readApprovalOutcome({
      status: true,
      responseCode: '00',
      message: 'Not approved — promotion gates failed: CPCV',
      data: { approved: false, stage: 'Draft', gates: GATES },
    });
    expect(o?.verdict).toBe('rejected');
    expect(o?.stage).toBe('Draft');
    expect(o?.gates).toHaveLength(2);
  });

  it('reads a timed-out evaluation (-12 with an evaluation row) as not judged, never a rejection', () => {
    const o = readApprovalOutcome({
      status: false,
      responseCode: '-12',
      message: 'Not judged (TimedOut): budget 600s exhausted',
      data: {
        approved: false,
        stage: 'Draft',
        gates: [...GATES, { name: 'evaluation', passed: false, detail: 'TimedOut' }],
      },
    });
    expect(o?.verdict).toBe('not-judged');
  });

  it('reads a refusal that ran nothing (not a Draft, or already running) as refused', () => {
    const notDraft = readApprovalOutcome({
      status: false,
      responseCode: '-11',
      message: 'Only a Draft can be submitted for approval — strategy 7 is Approved.',
      data: { approved: true, stage: 'Approved', gates: [] },
    });
    expect(notDraft?.verdict).toBe('refused');
    expect(notDraft?.message).toContain('Only a Draft');
    const busy = readApprovalOutcome({
      status: false,
      responseCode: '-11',
      message: 'An approval evaluation for strategy 7 is already running',
      data: { approved: false, stage: 'Draft', gates: [] },
    });
    expect(busy?.verdict).toBe('refused');
  });

  it('is null without a result and drops the generic "Successful" message', () => {
    expect(readApprovalOutcome(null)).toBeNull();
    expect(
      readApprovalOutcome({ status: false, responseCode: '-14', message: 'x', data: null as any }),
    ).toBeNull();
    const o = readApprovalOutcome({
      status: true,
      responseCode: '00',
      message: 'Successful',
      data: { approved: false, stage: 'Draft', gates: GATES },
    });
    expect(o?.message).toBeNull();
  });
});
