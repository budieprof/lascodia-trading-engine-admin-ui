import { describe, expect, it } from 'vitest';

import {
  MAX_TEMPLATES_PER_SCRIPT,
  SCRIPT_INPUT_TEMPLATES_KEY,
  readTemplates,
  templateScope,
  withTemplate,
  withoutTemplate,
} from './script-input-templates';

describe('named input templates (PC-I12)', () => {
  it('belong to a saved script by its key, to an editor script by its title', () => {
    expect(templateScope({ key: 'mine:7' }, 'MSqueeze')).toBe('mine:7');
    expect(templateScope({ key: 'strategy:12' })).toBe('strategy:12');
    expect(templateScope({ key: 'editor:abc1', name: 'Untitled script' }, 'My RSI')).toBe(
      'title:My RSI',
    );
  });

  it('a name saved again replaces its template (any case); an empty name saves nothing', () => {
    let all = withTemplate({}, 'mine:7', 'Scalp', { a: 1 }, 1)!;
    all = withTemplate(all, 'mine:7', ' scalp ', { a: 2 }, 2)!;
    expect(all['mine:7']).toEqual([{ name: 'scalp', values: { a: 2 }, savedAt: 2 }]);
    expect(withTemplate(all, 'mine:7', '   ', { a: 3 })).toBeNull();
  });

  it('keeps at most so many per script, newest first', () => {
    let all = {};
    for (let i = 0; i < MAX_TEMPLATES_PER_SCRIPT + 5; i++)
      all = withTemplate(all, 's', `T${i}`, {}, i)!;
    const list = (all as Record<string, { name: string }[]>)['s'];
    expect(list).toHaveLength(MAX_TEMPLATES_PER_SCRIPT);
    expect(list[0].name).toBe(`T${MAX_TEMPLATES_PER_SCRIPT + 4}`);
  });

  it('deleting the last one drops the script’s entry', () => {
    const all = withTemplate({}, 's', 'A', {}, 1)!;
    expect(withoutTemplate(all, 's', 'A')).toEqual({});
  });

  it('reads what is stored, skipping what it cannot read', () => {
    const store = (raw: string | null) => ({ getItem: (k: string) => (k === SCRIPT_INPUT_TEMPLATES_KEY ? raw : null) });
    expect(readTemplates(store(null))).toEqual({});
    expect(readTemplates(store('not json'))).toEqual({});
    expect(readTemplates(store('[1,2]'))).toEqual({});
    expect(
      readTemplates(
        store(
          JSON.stringify({
            s: [{ name: 'A', values: { x: 1 }, savedAt: 1 }, { name: 2 }, null],
            t: 'bad',
          }),
        ),
      ),
    ).toEqual({ s: [{ name: 'A', values: { x: 1 }, savedAt: 1 }] });
  });
});
