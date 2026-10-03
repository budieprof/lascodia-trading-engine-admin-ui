import { describe, expect, it } from 'vitest';
import { applyExactEdit, pineAssistCommands, type PineEditorAdapter } from './pine-assist';

function adapter(initial: string): PineEditorAdapter & { src: string } {
  const a = {
    src: initial,
    label: () => 'test editor',
    getSource: () => a.src,
    setSource: (s: string) => {
      a.src = s;
    },
    compile: async () => ({ ok: true, diagnostics: [] }),
    run: async () => ({ title: 't', kind: 'strategy', metrics: {}, tradeCount: 3, warnings: [] }),
  };
  return a;
}

const run = (cmds: ReturnType<typeof pineAssistCommands>, id: string, args: Record<string, unknown> = {}) =>
  cmds.find((c) => c.id === id)!.run(args);

describe('pine assist commands', () => {
  it('reads numbered, paged lines', async () => {
    const a = adapter(Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join('\n'));
    const r = await run(pineAssistCommands(a), 'pine.read', { fromLine: 4, lines: 3 });
    expect(r.ok).toBe(true);
    expect((r.data as { text: string }).text).toBe('4| l4\n5| l5\n6| l6');
    expect((r.data as { more: boolean }).more).toBe(true);
  });

  it('edits exactly once, refuses ambiguous or missing matches', async () => {
    const a = adapter('len = 14\nplot(ta.rsi(close, len))\nlen2 = 14');
    const cmds = pineAssistCommands(a);
    expect((await run(cmds, 'pine.edit', { find: '14', replace: '3' })).ok).toBe(false);
    expect((await run(cmds, 'pine.edit', { find: 'nope', replace: 'x' })).ok).toBe(false);
    expect((await run(cmds, 'pine.edit', { find: 'len = 14', replace: 'len = 3' })).ok).toBe(true);
    expect(a.src.startsWith('len = 3\n')).toBe(true);
    expect((await run(cmds, 'pine.edit', { find: '14', replace: '21', all: true })).ok).toBe(true);
    expect(a.src.endsWith('len2 = 21')).toBe(true);
  });

  it('replaces and inserts line ranges', async () => {
    const a = adapter('a\nb\nc');
    const cmds = pineAssistCommands(a);
    await run(cmds, 'pine.replaceLines', { fromLine: 2, toLine: 2, text: 'B1\nB2' });
    expect(a.src).toBe('a\nB1\nB2\nc');
    await run(cmds, 'pine.replaceLines', { fromLine: 1, toLine: 0, text: '//@version=6' });
    expect(a.src.split('\n')[0]).toBe('//@version=6');
  });

  it('hands the source to a buffer through the result data', async () => {
    const a = adapter('x = 1');
    const r = await run(pineAssistCommands(a), 'pine.toBuffer', { name: 'live' });
    expect(r.data).toEqual({ buffer: { name: 'live', text: 'x = 1' } });
  });

  it('save is confirm-gated and only offered when the page can save', () => {
    expect(pineAssistCommands(adapter('')).some((c) => c.id === 'strategy.save')).toBe(false);
    const a = { ...adapter(''), save: async () => ({ ok: true, message: 'saved' }) };
    expect(pineAssistCommands(a).find((c) => c.id === 'strategy.save')!.confirm).toBe(true);
  });

  it('applyExactEdit reports the first line changed', () => {
    const r = applyExactEdit('a\nb\nc', 'c', 'C', false);
    expect(r.ok && r.firstLine).toBe(3);
  });
});
