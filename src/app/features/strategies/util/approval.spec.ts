import { describe, expect, it } from 'vitest';

import { readApprovalJob, readApprovalOutcome } from './approval';

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

describe('readApprovalJob', () => {
  const base = {
    jobId: '1790253600000',
    strategyId: 7,
    startedAtUtc: '2026-09-24T12:00:00Z',
    finishedAtUtc: '2026-09-24T12:03:00Z',
  };

  it('is null while the job runs', () => {
    expect(
      readApprovalJob({
        ...base,
        status: 'running',
        result: null,
        message: null,
        responseCode: null,
      }),
    ).toBeNull();
    expect(readApprovalJob(null)).toBeNull();
  });

  it('reads a done job as the verdict it carries', () => {
    const approved = readApprovalJob({
      ...base,
      status: 'done',
      result: { approved: true, stage: 'Approved', gates: [GATES[0]] },
      message: 'Approved. Strategy 7 now paper-trades.',
      responseCode: '00',
    });
    expect(approved).toEqual({
      verdict: 'approved',
      stage: 'Approved',
      gates: [GATES[0]],
      message: 'Approved. Strategy 7 now paper-trades.',
    });
    const rejected = readApprovalJob({
      ...base,
      status: 'done',
      result: { approved: false, stage: 'Draft', gates: GATES },
      message: 'Not approved — promotion gates failed: CPCV',
      responseCode: '00',
    });
    expect(rejected?.verdict).toBe('rejected');
  });

  it('reads a failed job as not judged — even with no gate — unless the strategy was refused', () => {
    const interrupted = readApprovalJob({
      ...base,
      status: 'failed',
      result: { approved: false, stage: 'Draft', gates: [] },
      message: 'No verdict was recorded for job 1790253600000: the engine restarted …',
      responseCode: '-12',
    });
    expect(interrupted).toEqual({
      verdict: 'not-judged',
      stage: 'Draft',
      gates: [],
      message: 'No verdict was recorded for job 1790253600000: the engine restarted …',
    });
    const refused = readApprovalJob({
      ...base,
      jobId: null,
      status: 'failed',
      result: { approved: true, stage: 'Approved', gates: [] },
      message: 'Only a Draft can be submitted for approval — strategy 7 is Approved.',
      responseCode: '-11',
    });
    expect(refused?.verdict).toBe('refused');
    expect(refused?.stage).toBe('Approved');
  });
});
