import { describe, expect, it } from 'vitest';
import type { SpotAnalysisFollowUpTurnDto } from '@core/api/api.types';
import {
  approvalStatus,
  classifyTurn,
  formatElapsed,
  formatUsd,
  groupTurns,
  isHarnessToolTurn,
  isPendingAction,
  isRunLive,
  parseApproval,
  parseCapabilities,
  parsePlan,
  parseReport,
  parseRunNotice,
  parseToolResult,
  parseWatches,
  runElapsedMs,
  runStatusLabel,
  runStatusTone,
  toolStripLabel,
} from './engineer-turns';

let nextId = 1;
function turn(p: Partial<SpotAnalysisFollowUpTurnDto>): SpotAnalysisFollowUpTurnDto {
  return {
    id: p.id ?? nextId++,
    llmInvocationId: 28937,
    role: p.role ?? 'Assistant',
    content: p.content ?? '',
    createdAtUtc: p.createdAtUtc ?? '2026-09-11T10:00:00Z',
    toolName: p.toolName ?? null,
    toolArgsJson: p.toolArgsJson ?? null,
    toolResultJson: p.toolResultJson ?? null,
    actionStatus: p.actionStatus ?? null,
  };
}

const okTool = (name: string, content = '') =>
  turn({
    role: 'Tool',
    toolName: name,
    content,
    toolResultJson: JSON.stringify({ ok: true, summary: 'fine', result: 'rows: 3' }),
  });
const failedTool = (name: string) =>
  turn({
    role: 'Tool',
    toolName: name,
    toolResultJson: JSON.stringify({ ok: false, summary: 'exit 1', result: 'boom' }),
  });

describe('classifyTurn', () => {
  it('reads the harness conventions off role + toolName', () => {
    expect(classifyTurn(turn({ role: 'User' }), true)).toBe('user');
    expect(classifyTurn(turn({ toolName: 'plan' }), true)).toBe('plan');
    expect(classifyTurn(turn({ toolName: 'work_order_report' }), true)).toBe('report');
    expect(classifyTurn(turn({ toolName: 'run_notice' }), true)).toBe('notice');
    expect(classifyTurn(turn({ role: 'ActionProposal', toolName: 'approval' }), true)).toBe(
      'approval',
    );
  });

  it('leaves legacy turns exactly as they were', () => {
    // Everything written before the harness carries toolName = null.
    expect(classifyTurn(turn({ role: 'Assistant' }), false)).toBe('assistant');
    expect(classifyTurn(turn({ role: 'ActionProposal', toolName: 'http_action' }), false)).toBe(
      'action',
    );
    expect(classifyTurn(turn({ role: 'ActionProposal' }), false)).toBe('action');
  });

  it('keeps the spot chat own tool turns on their original rendering', () => {
    // A spot follow-up tool returns raw data, not {ok, summary} — so it is NOT stripped.
    const spotTool = turn({
      role: 'Tool',
      toolName: 'get_positions',
      toolResultJson: JSON.stringify({ positions: [] }),
    });
    expect(isHarnessToolTurn(spotTool)).toBe(false);
    expect(classifyTurn(spotTool, false)).toBe('tool-legacy');
    // …but inside an Engineer thread every tool call folds into the strip.
    expect(classifyTurn(spotTool, true)).toBe('tool');
  });

  it('strips an agent-posted tool turn that has no result at all', () => {
    // The bug this fixes: these rendered as an empty "🔧 … pulled live data" box.
    const bare = turn({ role: 'Tool', toolName: 'Bash', content: 'ran the backtest' });
    expect(isHarnessToolTurn(bare)).toBe(true);
    expect(classifyTurn(bare, false)).toBe('tool');
  });

  it('still renders a recommendation card', () => {
    const rec = turn({ role: 'Tool', toolName: 'recommend', toolResultJson: '{"action":"Buy"}' });
    expect(classifyTurn(rec, true)).toBe('rec');
  });
});

describe('groupTurns', () => {
  it('folds consecutive tool calls into one strip and counts the failures', () => {
    const items = groupTurns(
      [
        turn({ role: 'User', content: 'investigate' }),
        okTool('Read'),
        failedTool('Bash'),
        okTool('ml_trigger_training'),
        turn({ role: 'Assistant', content: 'here is what I found' }),
        okTool('Read'),
      ],
      true,
    );

    expect(items.map((i) => i.type)).toEqual(['turn', 'tools', 'turn', 'tools']);
    const strip = items[1];
    if (strip.type !== 'tools') throw new Error('expected a strip');
    expect(strip.rows).toHaveLength(3);
    expect(strip.failed).toBe(1);
    expect(strip.last.toolName).toBe('ml_trigger_training');
    expect(toolStripLabel(strip.rows.length, strip.failed)).toBe('3 tool calls · 1 failed');
  });

  it('does not let a strip swallow a date divider', () => {
    const items = groupTurns(
      [
        turn({ createdAtUtc: '2026-09-10T22:00:00Z', role: 'Tool', toolName: 'Read' }),
        turn({ createdAtUtc: '2026-09-11T09:00:00Z', role: 'Tool', toolName: 'Read' }),
      ],
      true,
    );
    // Two calendar days → two strips, each carrying its own divider flag.
    expect(items).toHaveLength(2);
    expect(items[1].newDay).toBe(true);
  });

  it('marks the first turn as a new day only when the opener does not already carry the date', () => {
    const t = turn({ createdAtUtc: '2026-09-11T10:00:00Z' });
    expect(groupTurns([t], true, '2026-09-11T09:00:00Z')[0].newDay).toBe(false);
    expect(groupTurns([t], true, null)[0].newDay).toBe(true);
  });

  it('gives a strip a stable key so expanding it survives the next refresh', () => {
    const first = okTool('Read');
    const a = groupTurns([first], true);
    const b = groupTurns([first, okTool('Bash')], true);
    expect(a[0].key).toBe(b[0].key);
  });
});

describe('toolStripLabel', () => {
  it('stays quiet when nothing failed, and singularises one call', () => {
    expect(toolStripLabel(1, 0)).toBe('1 tool call');
    expect(toolStripLabel(4, 0)).toBe('4 tool calls');
  });
});

describe('parseToolResult', () => {
  it('reads the harness shape', () => {
    const r = parseToolResult('{"ok":false,"summary":"exit 1","result":"stack"}');
    expect(r).toMatchObject({ ok: false, summary: 'exit 1', result: 'stack' });
  });

  it('keeps a non-harness payload raw rather than throwing', () => {
    expect(parseToolResult('not json').raw).toBe('not json');
    expect(parseToolResult('not json').ok).toBeNull();
    expect(parseToolResult(null)).toMatchObject({ ok: null, raw: null });
    expect(parseToolResult('{"ok":true,"result":{"rows":2}}').result).toContain('"rows": 2');
  });
});

describe('parsePlan', () => {
  const plan = [
    '**Definition of done:** the stop geometry is fixed and evidenced.',
    '',
    '- [x] pull the losing sample',
    '- [~] measure MAE against the `1.5×ATR` bumper',
    '  - [ ] nested follow-up',
    '- [ ] propose the change',
  ].join('\n');

  it('splits prose from tasks and counts progress', () => {
    const p = parsePlan(plan);
    expect(p.total).toBe(4);
    expect(p.done).toBe(1);
    expect(p.blocks[0]).toEqual({
      type: 'md',
      text: '**Definition of done:** the stop geometry is fixed and evidenced.',
    });
    const tasks = p.blocks[1];
    if (tasks.type !== 'tasks') throw new Error('expected tasks');
    expect(tasks.tasks.map((t) => t.state)).toEqual(['done', 'doing', 'todo', 'todo']);
    expect(tasks.tasks[2].depth).toBe(1);
    expect(tasks.tasks[1].text).toBe('measure MAE against the `1.5×ATR` bumper');
  });

  it('is inert on an empty or task-free plan', () => {
    expect(parsePlan(null)).toEqual({ blocks: [], done: 0, total: 0 });
    expect(parsePlan('just prose').blocks).toEqual([{ type: 'md', text: 'just prose' }]);
  });
});

describe('approval card', () => {
  const proposal = turn({
    role: 'ActionProposal',
    toolName: 'approval',
    actionStatus: 'Pending',
    toolArgsJson: JSON.stringify({
      approvalId: 'a-1',
      verb: 'Promote model',
      targets: ['EURUSD H1 Gbm #75961'],
      sideEffect: 'the champion changes for every live account',
      live: true,
      argsHash: 'abc',
      requestedAtUtc: '2026-09-11T10:00:00Z',
    }),
  });

  it('reads the proposal payload', () => {
    const a = parseApproval(proposal);
    expect(a).toMatchObject({
      verb: 'Promote model',
      targets: ['EURUSD H1 Gbm #75961'],
      live: true,
      approvalId: 'a-1',
    });
  });

  it('treats the status case-insensitively', () => {
    expect(isPendingAction('pending')).toBe(true);
    expect(isPendingAction('PENDING')).toBe(true);
    expect(isPendingAction(null)).toBe(true);
    expect(isPendingAction('Approved')).toBe(false);
    expect(approvalStatus('approved')).toEqual({ label: 'Approved', tone: 'ok' });
    expect(approvalStatus('Rejected')).toEqual({ label: 'Rejected', tone: 'bad' });
    expect(approvalStatus('Expired')).toEqual({ label: 'Expired', tone: 'muted' });
  });

  it('picks up the resolution stamp', () => {
    const resolved = turn({
      role: 'ActionProposal',
      toolName: 'approval',
      actionStatus: 'Approved',
      toolResultJson: '{"decision":"approved","resolvedAtUtc":"2026-09-11T10:05:00Z"}',
    });
    expect(parseApproval(resolved).resolvedAtUtc).toBe('2026-09-11T10:05:00Z');
  });

  it('survives a proposal with no args at all', () => {
    expect(parseApproval(turn({ role: 'ActionProposal', toolName: 'approval' }))).toMatchObject({
      verb: null,
      targets: [],
      live: false,
    });
  });
});

describe('parseReport', () => {
  it('reads the outcome and the live-change list', () => {
    const r = parseReport(
      turn({
        toolName: 'work_order_report',
        toolResultJson: JSON.stringify({
          outcome: 'partial',
          liveChanges: [
            {
              kind: 'config',
              ref: 'ViabilityGates:StopTooTight:Mode',
              description: 'Off → Enforce',
              atUtc: '2026-09-11T10:02:00Z',
            },
          ],
          openItems: ['re-check in 24h'],
          nextCheck: 'tomorrow 09:00',
        }),
      }),
    );
    expect(r.outcome).toBe('partial');
    expect(r.liveChanges).toHaveLength(1);
    expect(r.liveChanges?.[0].ref).toBe('ViabilityGates:StopTooTight:Mode');
    expect(r.openItems).toEqual(['re-check in 24h']);
    expect(r.nextCheck).toBe('tomorrow 09:00');
  });

  it('distinguishes an empty list ("None") from an absent one ("Not reported")', () => {
    expect(
      parseReport(turn({ toolResultJson: '{"outcome":"done","liveChanges":[]}' })).liveChanges,
    ).toEqual([]);
    expect(parseReport(turn({ toolResultJson: '{"outcome":"done"}' })).liveChanges).toBeNull();
    expect(parseReport(turn({})).liveChanges).toBeNull();
  });
});

describe('parseRunNotice', () => {
  it('labels the notice kinds', () => {
    expect(parseRunNotice(turn({ toolResultJson: '{"kind":"budget"}' })).label).toBe(
      'Budget exhausted',
    );
    expect(parseRunNotice(turn({ toolResultJson: '{"kind":"watch_fired"}' })).label).toBe(
      'Watch fired',
    );
    expect(parseRunNotice(turn({})).label).toBe('Notice');
  });
});

describe('run state', () => {
  it('knows which statuses hold the conversation (and so can be stopped)', () => {
    expect(isRunLive('Working')).toBe(true);
    expect(isRunLive('WaitingForOperator')).toBe(true);
    expect(isRunLive('watching')).toBe(true);
    expect(isRunLive('Done')).toBe(false);
    expect(isRunLive('Stale')).toBe(false);
    expect(isRunLive(null)).toBe(false);
  });

  it('labels every status the engine can report', () => {
    expect(runStatusLabel('WaitingForOperator')).toBe('Waiting for you');
    expect(runStatusLabel('Stale')).toBe('Stale');
    expect(runStatusLabel(null)).toBe('Idle');
    expect(runStatusTone('Working')).toBe('working');
    expect(runStatusTone('Stale')).toBe('stopped');
    expect(runStatusTone(undefined)).toBe('idle');
  });

  it('ticks against now while Working, and freezes at the end otherwise', () => {
    const start = Date.parse('2026-09-11T10:00:00Z');
    const now = start + 125_000;
    expect(
      runElapsedMs(
        { status: 'Working', startedAtUtc: '2026-09-11T10:00:00Z', updatedAtUtc: null },
        now,
      ),
    ).toBe(125_000);
    expect(
      runElapsedMs(
        {
          status: 'Done',
          startedAtUtc: '2026-09-11T10:00:00Z',
          endedAtUtc: '2026-09-11T10:01:00Z',
          updatedAtUtc: '2026-09-11T10:01:00Z',
        },
        now,
      ),
    ).toBe(60_000);
    // Waiting with no end: measured to the last update, so the clock does not run away.
    expect(
      runElapsedMs(
        {
          status: 'WaitingForOperator',
          startedAtUtc: '2026-09-11T10:00:00Z',
          updatedAtUtc: '2026-09-11T10:00:30Z',
          endedAtUtc: null,
        },
        now,
      ),
    ).toBe(30_000);
  });

  it('formats elapsed compactly', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(42_000)).toBe('42s');
    expect(formatElapsed(185_000)).toBe('3m 05s');
    expect(formatElapsed(3_720_000)).toBe('1h 02m');
    expect(formatElapsed(-5)).toBe('0s');
  });

  it('formats money without printing a real spend as $0.00', () => {
    expect(formatUsd(1.5)).toBe('$1.50');
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(0.0004)).toBe('$0.0004');
    expect(formatUsd(null)).toBe('$0.00');
  });

  it('builds capability chips, with read-only overriding the gates', () => {
    const chips = parseCapabilities(
      '{"mlControl":true,"configWrite":true,"promote":false,"readOnly":true,"model":"opus"}',
    );
    expect(chips.map((c) => c.label)).toEqual([
      'Read-only',
      'ML control',
      'Config write',
      'Promote',
      'opus',
    ]);
    expect(chips.filter((c) => c.on).map((c) => c.label)).toEqual(['Read-only', 'opus']);
    expect(parseCapabilities(null)).toEqual([]);
    expect(parseCapabilities('{')).toEqual([]);
  });

  it('builds one watch chip per entry', () => {
    const chips = parseWatches(
      '[{"id":"w-1","kind":"training_run","ids":[75961],"note":"waiting on the run","nextCheckAtUtc":"2026-09-11T11:00:00Z"}]',
    );
    expect(chips).toHaveLength(1);
    expect(chips[0].label).toBe('training run 75961');
    expect(chips[0].title).toContain('waiting on the run');
    expect(parseWatches('nonsense')).toEqual([]);
    expect(parseWatches('{"not":"an array"}')).toEqual([]);
  });
});
