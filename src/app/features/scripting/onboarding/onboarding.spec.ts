import { beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_STRATEGY_SCRIPT } from '../components/script-authoring/authoring-mode';
import { PINE_SNIPPETS } from '../pine/pine-snippets';
import {
  checklistSteps,
  dismissChecklist,
  isChecklistDismissed,
  nextStep,
  type ChecklistFacts,
} from './first-strategy-checklist';
import { PREVIEWED_KEY, markPreviewed, wasPreviewed } from './previewed-scripts';
import { STRATEGY_EXAMPLES } from './strategy-examples';

describe('strategy examples (PE-I9)', () => {
  it('are complete Pine v6 strategies with unique ids', () => {
    const ids = STRATEGY_EXAMPLES.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of STRATEGY_EXAMPLES) {
      expect(e.source.startsWith('//@version=6\nstrategy("')).toBe(true);
      expect(e.summary.length).toBeGreaterThan(20);
    }
  });

  it('protect every entry with a stop (no PS9002)', () => {
    for (const e of STRATEGY_EXAMPLES) {
      const entries = e.source.match(/strategy\.entry\(/g)?.length ?? 0;
      const stops = e.source.match(/strategy\.exit\([^)]*stop = /g)?.length ?? 0;
      expect(entries, e.id).toBeGreaterThan(0);
      expect(stops, e.id).toBe(entries);
    }
  });

  it('import lascodia/classic/1 exactly when they say so', () => {
    for (const e of STRATEGY_EXAMPLES) {
      expect(e.source.includes('import lascodia/classic/1 as classic'), e.id).toBe(e.usesClassic);
    }
    expect(STRATEGY_EXAMPLES.filter((e) => e.usesClassic)).toHaveLength(3);
  });

  it('size orders the engine does not round to nothing (100% of equity, not 10%)', () => {
    // 10% of 10,000 on EURUSD is ~900 units, under the engine's 1,000-unit (0.01 lot) minimum:
    // every order was rejected and the starting script never traded.
    const sources = [
      ...STRATEGY_EXAMPLES.map((e) => e.source),
      DEFAULT_STRATEGY_SCRIPT,
      String(PINE_SNIPPETS.find((s) => s.label === 'strategy skeleton')!.template),
    ];
    for (const src of sources) {
      expect(src).toContain(
        'default_qty_type = strategy.percent_of_equity, default_qty_value = 100)',
      );
    }
  });
});

describe('first-strategy checklist (PE-I9)', () => {
  const facts = (over: Partial<ChecklistFacts> = {}): ChecklistFacts => ({
    hasScript: true,
    previewed: false,
    backtests: 0,
    lifecycleStage: 'Draft',
    demoBound: false,
    ...over,
  });

  it('walks compile → preview → backtest → paper → demo binding', () => {
    const steps = checklistSteps(facts());
    expect(steps.map((s) => s.id)).toEqual(['compile', 'preview', 'backtest', 'paper', 'demo']);
    expect(steps.map((s) => s.done)).toEqual([true, false, false, false, false]);
    expect(nextStep(steps)!.id).toBe('preview');
  });

  it('counts paper trading done from the PaperTrading stage on', () => {
    expect(checklistSteps(facts({ lifecycleStage: 'PaperTrading' }))[3].done).toBe(true);
    expect(checklistSteps(facts({ lifecycleStage: 'BacktestQualified' }))[3].done).toBe(true);
    expect(checklistSteps(facts({ lifecycleStage: 'Draft' }))[3].done).toBe(false);
  });

  it('keeps unknown facts unknown, and treats them as not done for the next step', () => {
    const steps = checklistSteps(facts({ previewed: true, backtests: null, demoBound: null }));
    expect(steps[2].done).toBeNull();
    expect(steps[4].done).toBeNull();
    expect(nextStep(steps)!.id).toBe('backtest');
    const all = checklistSteps(
      facts({ previewed: true, backtests: 2, lifecycleStage: 'PaperTrading', demoBound: true }),
    );
    expect(nextStep(all)).toBeNull();
  });

  it('remembers a hidden checklist per strategy', () => {
    localStorage.clear();
    expect(isChecklistDismissed(7)).toBe(false);
    dismissChecklist(7);
    expect(isChecklistDismissed(7)).toBe(true);
    expect(isChecklistDismissed(8)).toBe(false);
  });
});

describe('previewed scripts (PE-I9)', () => {
  beforeEach(() => localStorage.clear());

  it('remembers the exact source that ran', () => {
    expect(wasPreviewed('a')).toBe(false);
    markPreviewed('a');
    expect(wasPreviewed('a')).toBe(true);
    expect(wasPreviewed('a ')).toBe(false);
    expect(wasPreviewed(null)).toBe(false);
  });

  it('keeps the newest 300 and survives bad storage', () => {
    for (let i = 0; i < 305; i++) markPreviewed(`s${i}`);
    expect(JSON.parse(localStorage.getItem(PREVIEWED_KEY)!)).toHaveLength(300);
    expect(wasPreviewed('s0')).toBe(false);
    expect(wasPreviewed('s304')).toBe(true);
    localStorage.setItem(PREVIEWED_KEY, '{not json');
    expect(wasPreviewed('s304')).toBe(false);
    markPreviewed('again');
    expect(wasPreviewed('again')).toBe(true);
  });
});
