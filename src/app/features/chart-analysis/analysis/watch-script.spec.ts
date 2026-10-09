import { describe, expect, it } from 'vitest';

import { WATCH_TEMPLATES, buildWatchScript, explainWatch, watchInputProblem } from './watch-script';

describe('watch-script', () => {
  it('every template follows the Structure Watch contract', () => {
    for (const t of WATCH_TEMPLATES) {
      const src = buildWatchScript({ template: t.id, level: 1.1495, precision: 5 });
      expect(src.startsWith('//@version=6\nindicator(')).toBe(true);
      expect(src).toContain('armedAt = input.time(0, "armedAt")');
      expect(src).toContain('import lascodia/structure/1 as st');
      expect(src).toContain('level = input.price(1.14950, "level")');
      for (const plot of ['"step"', '"ready"', '"broken"']) expect(src).toContain(plot);
      expect(src).not.toContain('strategy(');
      expect(src).not.toContain('calc_on_every_tick');
      // Steps only count from armedAt, and stop once ready.
      expect(src).toMatch(/^if time >= armedAt and step < \d$/m);
    }
  });

  it('calls every structure block on every candle, never inside the step logic', () => {
    for (const t of WATCH_TEMPLATES) {
      const src = buildWatchScript({ template: t.id, level: 1.1495, precision: 5 });
      const indented = src.split('\n').filter((l) => l.startsWith(' '));
      expect(indented.some((l) => l.includes('st.'))).toBe(false);
    }
  });

  it('adds the extra "called off" guard on the right side', () => {
    const up = buildWatchScript({
      template: 'dipReclaim',
      level: 1.15,
      calledOff: 1.14,
      precision: 5,
    });
    expect(up).toContain('calledOff = input.price(1.14000, "called off")');
    expect(up).toContain('    if close < calledOff\n        broken := true');
    const down = buildWatchScript({
      template: 'pushFail',
      level: 1.15,
      calledOff: 1.16,
      precision: 5,
    });
    expect(down).toContain('    if close > calledOff');
    expect(buildWatchScript({ template: 'closeAbove', level: 1.15, precision: 5 })).not.toContain(
      'calledOff',
    );
  });

  it('refuses a level or a guard that cannot work', () => {
    expect(watchInputProblem({ template: 'closeAbove', level: 0, precision: 5 })).toMatch(/level/);
    expect(
      watchInputProblem({ template: 'breakRetestUp', level: 1.15, calledOff: 1.16, precision: 5 }),
    ).toMatch(/below the level/);
    expect(
      watchInputProblem({
        template: 'breakRetestDown',
        level: 1.15,
        calledOff: 1.14,
        precision: 5,
      }),
    ).toMatch(/above the level/);
    expect(
      watchInputProblem({ template: 'pushFail', level: 1.15, calledOff: 1.16, precision: 5 }),
    ).toBeNull();
  });

  it('explains the watch in plain words with the prices', () => {
    expect(
      explainWatch({ template: 'closeBelow', level: 150.123, calledOff: 151, precision: 3 }),
    ).toBe(
      'Ready when a candle closes below 150.123. Also called off if a candle closes above 151.000.',
    );
  });
});
