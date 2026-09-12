/**
 * The live-thinking convention: classification, grouping, collapse rules, the presence line, and
 * the render-identity rule that keeps a once-a-second refetch from repainting the thread.
 */
import { describe, expect, it } from 'vitest';
import type { SpotAnalysisFollowUpTurnDto } from '@core/api/api.types';
import {
  classifyTurn,
  describeActivity,
  groupTurns,
  isFinalThought,
  isThoughtTurn,
  latestThinkingIndex,
  latestThoughtLine,
  latestThoughtText,
  reuseUnchangedItems,
  runPresence,
  sameChatItem,
  thinkingBlockSummary,
  thinkingDefaultOpen,
  thinkingSummaryLabel,
  watchesSummary,
  type ChatItem,
  type ThinkingItem,
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

/** A thought turn mid-stream. */
const thinking = (content: string, id?: number) =>
  turn({ id, role: 'Assistant', toolName: 'thought', content, toolResultJson: '{"final":false}' });

/** The same turn once the service patches it: this passage IS the answer. */
const finalThought = (content: string, id?: number) =>
  turn({ id, role: 'Assistant', toolName: 'thought', content, toolResultJson: '{"final":true}' });

const tool = (name: string, ok = true, id?: number) =>
  turn({
    id,
    role: 'Tool',
    toolName: name,
    toolResultJson: JSON.stringify({ ok, summary: ok ? 'fine' : 'exit 1' }),
  });

describe('thought turns', () => {
  it('recognises the convention off role + toolName', () => {
    expect(isThoughtTurn(thinking('…'))).toBe(true);
    expect(isThoughtTurn(turn({ role: 'Assistant', toolName: 'plan' }))).toBe(false);
    expect(isThoughtTurn(turn({ role: 'Tool', toolName: 'thought' }))).toBe(false);
  });

  it('reads final off the patched result', () => {
    expect(isFinalThought(finalThought('answer'))).toBe(true);
    expect(isFinalThought(thinking('…'))).toBe(false);
  });

  it('treats a thought with no (or unusable) payload as still thinking', () => {
    // The service writes {"final":false} from the first patch, so no payload means "just created".
    // Erring this way keeps a half-written passage out of the answer column.
    expect(isFinalThought(turn({ toolName: 'thought', toolResultJson: null }))).toBe(false);
    expect(isFinalThought(turn({ toolName: 'thought', toolResultJson: 'not json' }))).toBe(false);
    expect(isFinalThought(turn({ toolName: 'thought', toolResultJson: '{"final":"yes"}' }))).toBe(
      false,
    );
  });

  it('classifies a live thought as narration and a final one as the answer', () => {
    expect(classifyTurn(thinking('weighing the stop'), true)).toBe('thought');
    // A finalised thought is not a special kind: it renders exactly like a normal answer.
    expect(classifyTurn(finalThought('here is what I found'), true)).toBe('assistant');
  });

  it('applies the convention outside Engineer threads too', () => {
    expect(classifyTurn(thinking('…'), false)).toBe('thought');
  });
});

describe('groupTurns — thinking blocks', () => {
  it('folds consecutive thoughts into one block', () => {
    const items = groupTurns([thinking('a'), thinking('b'), thinking('c')], true);
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe('thinking');
    const block = items[0] as ThinkingItem;
    expect(block.thoughtCount).toBe(3);
    expect(block.entries.map((e) => e.type)).toEqual(['thought', 'thought', 'thought']);
  });

  it('keeps tool calls made mid-narration inside the block, in order', () => {
    const items = groupTurns(
      [thinking('looking at the losses'), tool('Read'), tool('Bash', false), thinking('now I see')],
      true,
    );
    expect(items).toHaveLength(1);
    const block = items[0] as ThinkingItem;
    // One narration, not three headers: thought · strip · thought.
    expect(block.entries.map((e) => e.type)).toEqual(['thought', 'tools', 'thought']);
    expect(block.thoughtCount).toBe(2);
    expect(block.toolCount).toBe(2);
    expect(block.failed).toBe(1);
    const strip = block.entries[1];
    if (strip.type !== 'tools') throw new Error('expected a strip');
    expect(strip.rows).toHaveLength(2);
    expect(strip.failed).toBe(1);
  });

  it('closes the block on the answer it produced', () => {
    const items = groupTurns(
      [thinking('thinking'), finalThought('so: the stop is too tight'), thinking('next question')],
      true,
    );
    expect(items.map((i) => i.type)).toEqual(['thinking', 'turn', 'thinking']);
    // The answer renders as an ordinary assistant message.
    const answer = items[1];
    if (answer.type !== 'turn') throw new Error('expected a turn');
    expect(answer.kind).toBe('assistant');
  });

  it('closes the block on a plan, an approval or a user message', () => {
    for (const closer of [
      turn({ toolName: 'plan', content: '- [ ] do it' }),
      turn({ role: 'ActionProposal', toolName: 'approval' }),
      turn({ role: 'User', content: 'stop' }),
    ]) {
      const items = groupTurns([thinking('a'), closer, thinking('b')], true);
      expect(items.map((i) => i.type)).toEqual(['thinking', 'turn', 'thinking']);
    }
  });

  it('leaves tool calls outside any narration as their own strip', () => {
    const items = groupTurns(
      [turn({ role: 'User', content: 'go' }), tool('Read'), tool('Bash')],
      true,
    );
    expect(items.map((i) => i.type)).toEqual(['turn', 'tools']);
  });

  it('never lets a block swallow a date divider', () => {
    const items = groupTurns(
      [
        thinking('late last night', 1),
        turn({
          id: 2,
          role: 'Assistant',
          toolName: 'thought',
          content: 'this morning',
          toolResultJson: '{"final":false}',
          createdAtUtc: '2026-09-12T09:00:00Z',
        }),
      ],
      true,
    );
    expect(items).toHaveLength(2);
    expect(items[1].newDay).toBe(true);
  });

  it('gives a block a stable key so its open state survives the next refresh', () => {
    const first = thinking('a', 900);
    const a = groupTurns([first], true);
    const b = groupTurns([first, thinking('b', 901)], true);
    expect(a[0].key).toBe(b[0].key);
  });

  it('stamps the block with its newest turn', () => {
    const items = groupTurns(
      [thinking('a', 10), tool('Read'), thinking('b', 12)],
      true,
    ) as ThinkingItem[];
    expect(items[0].turn.id).toBe(10);
    expect(items[0].last.id).toBe(12);
  });
});

describe('thinking block presentation', () => {
  const block = groupTurns(
    [thinking('first pass\nsecond line'), tool('Read'), thinking('  the newest thought  ')],
    true,
  )[0] as ThinkingItem;

  it('summarises what a collapsed block is hiding', () => {
    expect(thinkingSummaryLabel(12, 0)).toBe('12 thoughts');
    expect(thinkingSummaryLabel(1, 0)).toBe('1 thought');
    expect(thinkingSummaryLabel(12, 3)).toBe('12 thoughts · 3 tool calls');
    expect(thinkingSummaryLabel(4, 2, 1)).toBe('4 thoughts · 2 tool calls · 1 failed');
  });

  it('opens only the newest block, and only while the run is live', () => {
    expect(thinkingDefaultOpen(true, true)).toBe(true);
    // A finished run reads as answers and cards; the narration folds away.
    expect(thinkingDefaultOpen(true, false)).toBe(false);
    // An older block stays collapsed even mid-run.
    expect(thinkingDefaultOpen(false, true)).toBe(false);
  });

  it('finds the newest passage and its last line', () => {
    expect(latestThoughtText(block)).toBe('the newest thought');
    expect(latestThoughtLine(block)).toBe('the newest thought');
  });

  it('falls back to the previous passage when the newest is still empty', () => {
    const b = groupTurns([thinking('something'), thinking('   ')], true)[0] as ThinkingItem;
    expect(latestThoughtText(b)).toBe('something');
  });

  it('locates the newest block in the thread', () => {
    const items = groupTurns(
      [thinking('a'), finalThought('answer'), thinking('b'), tool('Read')],
      true,
    );
    expect(latestThinkingIndex(items)).toBe(2);
    expect(latestThinkingIndex(groupTurns([turn({ role: 'User' })], true))).toBe(-1);
  });
});

/**
 * The per-block digest: what a CLOSED block says happened inside it. A day-long work order writes
 * hundreds of blocks and they are all read closed, so "12 thoughts" alone loses the content.
 */
describe('thinkingBlockSummary', () => {
  const blockOf = (turns: SpotAnalysisFollowUpTurnDto[]) =>
    groupTurns(turns, true)[0] as ThinkingItem;

  it('names the tools the block ran, most-used first, with their counts', () => {
    const b = blockOf([
      thinking('looking'),
      tool('query_sql'),
      tool('query_sql'),
      tool('platform_call'),
      thinking('done'),
    ]);
    expect(thinkingBlockSummary(b)).toBe('ran query_sql ×2, platform_call');
  });

  it('counts failures separately — the thing worth noticing in a folded block', () => {
    const b = blockOf([thinking('t'), tool('Bash', false), tool('Bash', false), tool('Bash')]);
    expect(thinkingBlockSummary(b)).toBe('ran Bash ×3 · 2 failed calls');
    const one = blockOf([thinking('t'), tool('Read', false)]);
    expect(thinkingBlockSummary(one)).toBe('ran Read · 1 failed call');
  });

  it('caps the named tools at two, counts the rest, and says where it landed', () => {
    // The landing tool is inside the "+2 more" tail, so naming it is the only way to see it.
    const b = blockOf([
      thinking('t'),
      tool('query_sql'),
      tool('query_sql'),
      tool('Read'),
      tool('Grep'),
      tool('gate_reeval'),
    ]);
    expect(thinkingBlockSummary(b)).toBe('ran query_sql ×2, Read +2 more · ended on gate_reeval');
  });

  it('does not repeat a tool the line already names as the landing point', () => {
    const b = blockOf([thinking('t'), tool('query_sql'), tool('Read'), tool('query_sql')]);
    expect(thinkingBlockSummary(b)).toBe('ran query_sql ×2, Read');
  });

  it('falls back to the first sentence of the newest passage when nothing ran', () => {
    const b = blockOf([
      thinking('Checked the gate. Now I will look at the rejection histogram instead.'),
    ]);
    expect(thinkingBlockSummary(b)).toBe('Checked the gate.');
  });

  it('clips a long unpunctuated passage rather than printing a paragraph', () => {
    const s = thinkingBlockSummary(blockOf([thinking('a'.repeat(200))]));
    expect(s.length).toBeLessThanOrEqual(90);
    expect(s.endsWith('…')).toBe(true);
  });

  it('is empty — not a lie — for a block with nothing in it', () => {
    expect(thinkingBlockSummary(blockOf([thinking('   ')]))).toBe('');
  });

  it('is pure: the same block always gives the same line', () => {
    const b = blockOf([thinking('t'), tool('Read'), tool('Bash', false)]);
    expect(thinkingBlockSummary(b)).toBe(thinkingBlockSummary(b));
  });
});

type RunLike = NonNullable<Parameters<typeof runPresence>[0]>;

describe('runPresence', () => {
  const run = (p: Partial<RunLike>) => runPresence({ status: 'Working', ...p });

  it('always gives a live run something to say', () => {
    expect(run({ activity: null })).toEqual({ text: 'Thinking…', live: true });
    expect(run({ activity: '   ' }).text).toBe('Thinking…');
  });

  it('turns a bare tool name into an action', () => {
    expect(run({ activity: 'pnl_sim' }).text).toBe('Running pnl_sim…');
    expect(describeActivity('backtest')).toBe('Running backtest…');
  });

  it('leaves a sentence exactly as the host wrote it', () => {
    expect(run({ activity: 'Reading training diagnostics…' }).text).toBe(
      'Reading training diagnostics…',
    );
  });

  it('names what it is waiting on', () => {
    expect(run({ status: 'WaitingForOperator' }).text).toBe('Waiting for you');
    expect(run({ status: 'WaitingForOperator', activity: 'approval to promote' }).text).toBe(
      'Waiting for you — approval to promote',
    );
  });

  it('counts the watches it is sitting on', () => {
    const watches =
      '[{"id":"w1","kind":"training_run","ids":[1,2,3]},{"id":"w2","kind":"training_run","ids":[4]}]';
    expect(run({ status: 'Watching', watchesJson: watches }).text).toBe('Watching 4 training runs');
    expect(watchesSummary('[{"id":"w1","kind":"training_run","ids":[7]}]')).toBe(
      'Watching 1 training run',
    );
    expect(
      watchesSummary('[{"id":"w1","kind":"backtest"},{"id":"w2","kind":"training_run"}]'),
    ).toBe('Watching 2 watches');
    expect(watchesSummary(null)).toBeNull();
  });

  it('reads as an ending, not an activity, once the run is over', () => {
    expect(runPresence({ status: 'Done', stopReason: 'work order complete' })).toEqual({
      text: 'work order complete',
      live: false,
    });
    expect(runPresence({ status: 'Failed' }).text).toBe('Failed');
    expect(runPresence({ status: 'Stale' })).toEqual({
      text: 'Stalled — no report for 15 minutes',
      live: false,
    });
    expect(runPresence(null)).toEqual({ text: 'Idle', live: false });
  });
});

describe('reuseUnchangedItems — the anti-flicker rule', () => {
  /** One refetch: the payload comes back as brand-new objects, as it does over the wire. */
  const refetch = (turns: SpotAnalysisFollowUpTurnDto[]): ChatItem[] =>
    groupTurns(JSON.parse(JSON.stringify(turns)) as SpotAnalysisFollowUpTurnDto[], true);

  const thread = [
    turn({ id: 1, role: 'User', content: 'investigate the stops' }),
    turn({ id: 2, toolName: 'plan', content: '- [ ] pull the sample' }),
    thinking('weighing it up', 3),
  ];

  it('hands back the same array when nothing changed', () => {
    const first = refetch(thread);
    const second = reuseUnchangedItems(first, refetch(thread));
    expect(second).toBe(first);
  });

  it('keeps every untouched item identical and replaces only the one that grew', () => {
    const first = refetch(thread);
    const grown = [
      ...thread.slice(0, 2),
      thinking('weighing it up — the ATR bumper is the cause', 3),
    ];
    const second = reuseUnchangedItems(first, refetch(grown));

    expect(second).not.toBe(first);
    expect(second[0]).toBe(first[0]); // the user message: same object, no re-render
    expect(second[1]).toBe(first[1]); // the plan card: same object
    expect(second[2]).not.toBe(first[2]); // the thinking block: the only thing that moved
    expect((second[2] as ThinkingItem).entries[0].turn.content).toContain('ATR bumper');
  });

  it('replaces a card whose status flipped, not just its content', () => {
    const pending = [turn({ id: 5, role: 'ActionProposal', toolName: 'approval' })];
    const approved = [
      turn({ id: 5, role: 'ActionProposal', toolName: 'approval', actionStatus: 'Approved' }),
    ];
    const first = refetch(pending);
    expect(reuseUnchangedItems(first, refetch(approved))[0]).not.toBe(first[0]);
  });

  it('appends without disturbing what is already on screen', () => {
    const first = refetch(thread);
    const second = reuseUnchangedItems(first, refetch([...thread, turn({ id: 9, role: 'User' })]));
    expect(second).toHaveLength(4);
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
  });

  /**
   * MEASUREMENT, not a guess.
   *
   * Every render item whose object identity changes is one OnPush child Angular marks dirty and
   * re-renders. This replays a streaming run the way the chat sees it — a full refetch once a
   * second while the agent writes into the last turn — and counts the dirtied children per tick,
   * against the same replay with the stabiliser removed.
   */
  it('dirties ONE item per streaming tick, not the whole thread', () => {
    const settled: SpotAnalysisFollowUpTurnDto[] = [
      turn({ id: 1, role: 'User', content: 'why are the stops so tight?' }),
      turn({ id: 2, toolName: 'plan', content: '- [x] pull the sample\n- [ ] measure MAE' }),
      thinking('the ATR bumper is doing it', 3),
      tool('Read', true, 4),
      tool('Bash', true, 5),
      finalThought('the 1.5×ATR bumper is the cause', 6),
      turn({ id: 7, toolName: 'work_order_report', toolResultJson: '{"outcome":"done"}' }),
      turn({ id: 8, role: 'User', content: 'keep going' }),
    ];

    let prev = refetch(settled);
    const baselinePrev = refetch(settled);
    let stabilised = 0;
    let naive = 0;
    // 60 ticks of the agent writing one more clause into turn 9 each second.
    let text = '';
    for (let tick = 0; tick < 60; tick++) {
      text += `clause ${tick}. `;
      const wire = [...settled, thinking(text, 9)];
      const next = reuseUnchangedItems(prev, refetch(wire));
      stabilised += next.filter((it, i) => it !== prev[i]).length;
      naive += refetch(wire).length; // no reuse: every item is a new object every tick
      prev = next;
    }

    // The settled thread renders as 6 items (the two tool calls fold into the thinking block);
    // the live narration makes 7.
    expect(baselinePrev).toHaveLength(6);
    expect(prev).toHaveLength(7);
    // One thinking block changes per tick; the other six items keep their identity.
    expect(stabilised).toBe(60);
    expect(naive).toBe(60 * 7); // what the thread used to repaint every single second
  });

  it('compares a tool strip by its calls', () => {
    const a = refetch([thinking('a', 1), tool('Read', true, 2)]);
    const b = refetch([thinking('a', 1), tool('Read', true, 2)]);
    expect(sameChatItem(a[0], b[0])).toBe(true);
    const c = refetch([thinking('a', 1), tool('Read', true, 2), tool('Bash', true, 3)]);
    expect(sameChatItem(a[0], c[0])).toBe(false);
  });
});
