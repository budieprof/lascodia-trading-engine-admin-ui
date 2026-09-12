/**
 * The join behind the operations page: which work orders are running, which are blocked on a human,
 * what they are watching, and what today amounted to.
 */
import { describe, expect, it } from 'vitest';
import type {
  AgentChangeSetDto,
  AlgoEngineerAuditRowDto,
  AlgoEngineerRunStateDto,
  AnalysisConversationSummaryDto,
  AnalysisMonitorDto,
  SpotAnalysisFollowUpTurnDto,
} from '@core/api/api.types';
import {
  approvalUrgency,
  auditKindLabel,
  buildWorkOrder,
  extractPendingApprovals,
  formatAge,
  isEngineerConversation,
  monitorWatchRow,
  runningWorkOrders,
  startOfLocalDay,
  summariseToday,
  todaysActivity,
  waitingForYou,
  watchRowsFor,
  watchingWorkOrders,
  workOrderTitle,
  type WorkOrderRow,
} from './agent-ops';

const NOW = Date.parse('2026-09-12T12:00:00Z');

function conv(p: Partial<AnalysisConversationSummaryDto> = {}): AnalysisConversationSummaryDto {
  return {
    llmInvocationId: p.llmInvocationId ?? 100,
    symbol: '',
    timeframe: '',
    purpose: p.purpose ?? 'AlgoEngineerSession',
    kind: p.kind ?? 'Engineer',
    preview: p.preview ?? 'Find out why the sweep files nothing on GBPUSD',
    model: 'opus',
    provider: 'claudecode',
    invokedAt: '2026-09-12T09:00:00Z',
    lastActivityAtUtc: p.lastActivityAtUtc ?? '2026-09-12T11:59:00Z',
    followUpCount: 12,
    activeMonitorCount: p.activeMonitorCount ?? 0,
    runStatus: p.runStatus ?? null,
  };
}

function run(p: Partial<AlgoEngineerRunStateDto> = {}): AlgoEngineerRunStateDto {
  return {
    runKey: 'r1',
    status: p.status ?? 'Working',
    trigger: 'new',
    startedAtUtc: p.startedAtUtc ?? '2026-09-12T11:00:00Z',
    updatedAtUtc: '2026-09-12T11:59:00Z',
    endedAtUtc: p.endedAtUtc ?? null,
    steps: p.steps ?? 14,
    maxSteps: 60,
    costUsd: p.costUsd ?? 1.25,
    budgetUsd: 8,
    activity: p.activity ?? 'Reading training diagnostics…',
    stopReason: null,
    capabilitiesJson: null,
    watchesJson: p.watchesJson ?? null,
    runCount: 1,
    sessionCostUsd: p.costUsd ?? 1.25,
  };
}

function approvalTurn(p: {
  id: number;
  verb?: string;
  status?: string | null;
  requestedAtUtc?: string;
  live?: boolean;
}): SpotAnalysisFollowUpTurnDto {
  return {
    id: p.id,
    llmInvocationId: 100,
    role: 'ActionProposal',
    content: 'Approve?',
    toolName: 'approval',
    toolArgsJson: JSON.stringify({
      approvalId: `ap-${p.id}`,
      verb: p.verb ?? 'apply_config_change',
      targets: ['SpotSweep:MaxPerSymbol = 4'],
      sideEffect: 'Writes a live EngineConfig value',
      live: p.live ?? true,
      requestedAtUtc: p.requestedAtUtc ?? '2026-09-12T11:55:00Z',
    }),
    toolResultJson: null,
    actionStatus: p.status === undefined ? 'Pending' : p.status,
    createdAtUtc: p.requestedAtUtc ?? '2026-09-12T11:55:00Z',
  };
}

function monitor(p: Partial<AnalysisMonitorDto> & { id: number }): AnalysisMonitorDto {
  return {
    id: p.id,
    symbol: p.symbol ?? 'EURUSD',
    timeframe: p.timeframe ?? 'H1',
    intentText: p.intentText ?? 'spread above 2.5 pips for 10 minutes',
    evaluationMode: 'Deterministic',
    triggerSpecJson: '{}',
    actionSpecJson: '{}',
    status: p.status ?? 'Active',
    recurring: true,
    triggerCount: 0,
    maxTriggers: 3,
    cooldownSeconds: 600,
    createdAtUtc: '2026-09-12T10:00:00Z',
    expiresAtUtc: '2026-09-13T10:00:00Z',
    cooldownUntilUtc: p.cooldownUntilUtc ?? null,
  };
}

describe('formatAge', () => {
  it('reads as an operator would say it', () => {
    expect(formatAge(0)).toBe('just now');
    expect(formatAge(30_000)).toBe('just now');
    expect(formatAge(60_000)).toBe('1m');
    expect(formatAge(13 * 60_000)).toBe('13m');
    expect(formatAge(2 * 3_600_000 + 13 * 60_000)).toBe('2h 13m');
    // Past a few hours the minutes stop meaning anything.
    expect(formatAge(9 * 3_600_000)).toBe('9h');
    expect(formatAge(30 * 3_600_000)).toBe('1d 6h');
    expect(formatAge(5 * 86_400_000)).toBe('5d');
  });

  it('never renders a negative or nonsense age', () => {
    expect(formatAge(-5000)).toBe('just now');
    expect(formatAge(Number.NaN)).toBe('just now');
  });
});

describe('approvalUrgency', () => {
  it('escalates the longer nobody answers', () => {
    expect(approvalUrgency(10_000)).toBe('fresh');
    expect(approvalUrgency(3 * 60_000)).toBe('waiting');
    expect(approvalUrgency(45 * 60_000)).toBe('stalled');
  });
});

describe('work-order identity', () => {
  it('picks out the agent conversations', () => {
    expect(isEngineerConversation(conv({ kind: 'Engineer' }))).toBe(true);
    expect(isEngineerConversation(conv({ kind: 'engineer' }))).toBe(true);
    expect(isEngineerConversation(conv({ kind: 'Spot' }))).toBe(false);
  });

  it('titles a work order with its opening instruction, on one line', () => {
    expect(workOrderTitle(conv({ preview: 'Fix the sweep\nsecond line' }))).toBe('Fix the sweep');
    expect(workOrderTitle(conv({ preview: 'x'.repeat(200) })).length).toBe(110);
    expect(workOrderTitle(conv({ preview: '', purpose: 'AlgoEngineerSession' }))).toBe(
      'AlgoEngineerSession',
    );
    expect(workOrderTitle(conv({ preview: '', purpose: '', llmInvocationId: 77 }))).toBe(
      'Work order #77',
    );
  });
});

describe('extractPendingApprovals', () => {
  it('takes only the cards still awaiting an answer', () => {
    const turns = [
      approvalTurn({ id: 1 }),
      approvalTurn({ id: 2, status: 'Approved' }),
      approvalTurn({ id: 3, status: 'Rejected' }),
      // A proposal with no status yet is pending — that is the chat's rule too.
      approvalTurn({ id: 4, status: null }),
      { ...approvalTurn({ id: 5 }), toolName: 'plan', role: 'Assistant' as const },
    ];
    const out = extractPendingApprovals(100, 'WO', turns, NOW);
    expect(out.map((a) => a.turnId)).toEqual([1, 4]);
  });

  it('carries what the operator decides on, and how long it has waited', () => {
    const [a] = extractPendingApprovals(
      100,
      'Sweep investigation',
      [approvalTurn({ id: 9, requestedAtUtc: '2026-09-12T11:30:00Z' })],
      NOW,
    );
    expect(a).toMatchObject({
      sessionId: 100,
      workOrder: 'Sweep investigation',
      verb: 'apply_config_change',
      targets: ['SpotSweep:MaxPerSymbol = 4'],
      live: true,
      urgency: 'stalled',
    });
    expect(a.ageMs).toBe(30 * 60_000);
  });

  it('falls back to the turn time when the card names no request time', () => {
    const t: SpotAnalysisFollowUpTurnDto = {
      ...approvalTurn({ id: 1 }),
      toolArgsJson: JSON.stringify({ verb: 'deploy' }),
      createdAtUtc: '2026-09-12T11:00:00Z',
    };
    expect(extractPendingApprovals(1, 'WO', [t], NOW)[0].ageMs).toBe(3_600_000);
  });
});

describe('watches', () => {
  it('merges the agent own watches with the monitors armed in the engine', () => {
    const rows = watchRowsFor(
      run({
        watchesJson: JSON.stringify([
          { id: 'w1', kind: 'training_run', ids: [75961], nextCheckAtUtc: '2026-09-12T12:30:00Z' },
        ]),
      }),
      [monitor({ id: 55 })],
      NOW,
    );
    expect(rows.map((r) => r.source)).toEqual(['watch', 'monitor']);
    expect(rows[0].what).toBe('training run 75961');
    expect(rows[1].what).toBe('spread above 2.5 pips for 10 minutes');
    expect(rows[1].monitorId).toBe(55);
  });

  it('says when a monitor next looks', () => {
    expect(monitorWatchRow(monitor({ id: 1 }), NOW).note).toBe('every cycle');
    expect(monitorWatchRow(monitor({ id: 2, status: 'Paused' }), NOW).note).toBe('paused');
    const cooling = monitorWatchRow(
      monitor({ id: 3, cooldownUntilUtc: '2026-09-12T12:20:00Z' }),
      NOW,
    );
    expect(cooling.note).toBe('cooling down');
    expect(cooling.nextCheckAtUtc).toBe('2026-09-12T12:20:00Z');
  });

  it('reads a past cooldown as no longer cooling', () => {
    const done = monitorWatchRow(monitor({ id: 4, cooldownUntilUtc: '2026-09-12T11:00:00Z' }), NOW);
    expect(done.note).toBe('every cycle');
    expect(done.nextCheckAtUtc).toBeNull();
  });

  it('has nothing to show for a work order with no run and no monitors', () => {
    expect(watchRowsFor(null, [], NOW)).toEqual([]);
  });
});

describe('buildWorkOrder', () => {
  it('prefers the run row status over the list summary', () => {
    const row = buildWorkOrder(
      { conversation: conv({ runStatus: 'Working' }), run: run({ status: 'WaitingForOperator' }) },
      NOW,
    );
    expect(row.status).toBe('WaitingForOperator');
    expect(row.statusLabel).toBe('Waiting for you');
    expect(row.live).toBe(true);
  });

  it('still describes a work order whose run state was never fetched', () => {
    const row = buildWorkOrder({ conversation: conv({ runStatus: 'Watching' }) }, NOW);
    expect(row.statusLabel).toBe('Watching');
    expect(row.run).toBeNull();
    expect(row.approvals).toEqual([]);
  });
});

describe('grouping', () => {
  const rowFor = (p: {
    id: number;
    status: string;
    lastActivity?: string;
    turns?: SpotAnalysisFollowUpTurnDto[];
    monitors?: AnalysisMonitorDto[];
  }): WorkOrderRow =>
    buildWorkOrder(
      {
        conversation: conv({
          llmInvocationId: p.id,
          runStatus: p.status,
          lastActivityAtUtc: p.lastActivity ?? '2026-09-12T11:00:00Z',
        }),
        run: run({ status: p.status }),
        turns: p.turns,
        monitors: p.monitors,
      },
      NOW,
    );

  it('puts what needs a human first, then what is burning budget', () => {
    const rows = [
      rowFor({ id: 1, status: 'Watching' }),
      rowFor({ id: 2, status: 'Done' }),
      rowFor({ id: 3, status: 'Working' }),
      rowFor({ id: 4, status: 'WaitingForOperator' }),
    ];
    expect(runningWorkOrders(rows).map((r) => r.sessionId)).toEqual([4, 3, 1]);
  });

  it('keeps a stalled run on the page — that is the one nobody would notice', () => {
    const rows = [rowFor({ id: 1, status: 'Working' }), rowFor({ id: 2, status: 'Stale' })];
    expect(runningWorkOrders(rows).map((r) => r.sessionId)).toEqual([1, 2]);
  });

  it('breaks ties on the most recent activity', () => {
    const rows = [
      rowFor({ id: 1, status: 'Working', lastActivity: '2026-09-12T09:00:00Z' }),
      rowFor({ id: 2, status: 'Working', lastActivity: '2026-09-12T11:30:00Z' }),
    ];
    expect(runningWorkOrders(rows).map((r) => r.sessionId)).toEqual([2, 1]);
  });

  it('lists every open approval across the fleet, longest-waiting first', () => {
    const rows = [
      rowFor({
        id: 1,
        status: 'WaitingForOperator',
        turns: [approvalTurn({ id: 11, requestedAtUtc: '2026-09-12T11:50:00Z' })],
      }),
      rowFor({
        id: 2,
        status: 'Working',
        turns: [approvalTurn({ id: 22, requestedAtUtc: '2026-09-12T08:00:00Z' })],
      }),
    ];
    const waiting = waitingForYou(rows);
    expect(waiting.map((a) => a.turnId)).toEqual([22, 11]);
    expect(waiting[0].sessionId).toBe(2);
  });

  it('shows watching work orders busiest first', () => {
    const rows = [
      rowFor({ id: 1, status: 'Watching', monitors: [monitor({ id: 1 })] }),
      rowFor({ id: 2, status: 'Working' }),
      rowFor({
        id: 3,
        status: 'Watching',
        monitors: [monitor({ id: 2 }), monitor({ id: 3 })],
      }),
    ];
    expect(watchingWorkOrders(rows).map((r) => r.sessionId)).toEqual([3, 1]);
  });
});

describe('summariseToday', () => {
  const dayStart = startOfLocalDay(NOW);
  const iso = (offsetHours: number) => new Date(dayStart + offsetHours * 3_600_000).toISOString();

  const auditRow = (p: Partial<AlgoEngineerAuditRowDto>): AlgoEngineerAuditRowDto => ({
    atUtc: p.atUtc ?? iso(1),
    sessionLlmInvocationId: p.sessionLlmInvocationId ?? 100,
    kind: p.kind ?? 'run_started',
    actor: p.actor ?? 'agent',
    summary: p.summary ?? '',
    detail: null,
    ref: p.ref ?? null,
  });

  const changeSet = (createdAtUtc: string): AgentChangeSetDto => ({
    id: 1,
    sha: 'abc1234',
    branchRef: 'agent/x',
    area: 'engine',
    summary: 'tighten the gate',
    diffStatJson: null,
    conversationLlmInvocationId: 100,
    experimentRunId: null,
    proposalFollowUpId: null,
    status: 'Deployed',
    revertedByChangeSetId: null,
    createdAtUtc,
    mergedAtUtc: null,
    deployedAtUtc: null,
  });

  it('counts the day off the audit timeline when it is there', () => {
    const s = summariseToday({
      audit: [
        auditRow({ kind: 'run_started' }),
        auditRow({ kind: 'run_ended' }),
        auditRow({ kind: 'config_change' }),
        auditRow({ kind: 'change_set' }),
        auditRow({ kind: 'model_lifecycle' }),
        auditRow({ kind: 'approval_requested' }),
        // Yesterday's rows never count, however the window was asked for.
        auditRow({ kind: 'config_change', atUtc: iso(-5) }),
      ],
      runs: [run({ costUsd: 1.5, startedAtUtc: iso(2) })],
      changeSets: [],
      dayStartMs: dayStart,
    });
    expect(s).toEqual({
      liveChanges: 3,
      spendUsd: 1.5,
      started: 1,
      finished: 1,
      fromAudit: true,
    });
  });

  it('answers the same questions from the other endpoints while the audit is undeployed', () => {
    const s = summariseToday({
      audit: null,
      runs: [
        run({ costUsd: 2, startedAtUtc: iso(1), endedAtUtc: iso(3) }),
        run({ costUsd: 0.5, startedAtUtc: iso(4) }),
        // Started yesterday: neither its start nor its spend belongs to today.
        run({ costUsd: 9, startedAtUtc: iso(-20), endedAtUtc: iso(2) }),
      ],
      changeSets: [changeSet(iso(2)), changeSet(iso(-30))],
      dayStartMs: dayStart,
    });
    expect(s).toEqual({
      liveChanges: 1,
      spendUsd: 2.5,
      started: 2,
      // The overnight run ENDED today, so it finished today.
      finished: 2,
      fromAudit: false,
    });
  });

  it('is a real zero, not an error, on a quiet day', () => {
    expect(summariseToday({ audit: [], runs: [], changeSets: [], dayStartMs: dayStart })).toEqual({
      liveChanges: 0,
      spendUsd: 0,
      started: 0,
      finished: 0,
      fromAudit: true,
    });
  });

  it('takes the local day, not the UTC one', () => {
    const start = startOfLocalDay(NOW);
    expect(new Date(start).getHours()).toBe(0);
    expect(start).toBeLessThanOrEqual(NOW);
  });

  it('feeds the activity list newest-first and capped', () => {
    const rows = [
      auditRow({ atUtc: iso(1) }),
      auditRow({ atUtc: iso(5) }),
      auditRow({ atUtc: iso(-2) }),
    ];
    const feed = todaysActivity(rows, dayStart, 2);
    expect(feed.map((r) => r.atUtc)).toEqual([iso(5), iso(1)]);
    expect(todaysActivity(null, dayStart)).toEqual([]);
  });

  it('labels every kind it knows, and does not swallow one it does not', () => {
    expect(auditKindLabel('approval_requested')).toBe('Approval asked');
    expect(auditKindLabel('monitor_fired')).toBe('Monitor fired');
    expect(auditKindLabel('something_new')).toBe('something new');
  });
});
