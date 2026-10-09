import { linkedSignal, type WritableSignal } from '@angular/core';

import type { StrategyDto } from '@core/api/api.types';
import type {
  ScriptExecutionPolicy,
  ScriptInputValues,
  StrategyScriptRevisionField,
} from '@core/api/scripting.types';
import { parseSavedInputs } from '../../pine/pine-saved-inputs';

/**
 * How a RuleBased / LlmProposal strategy is authored. Pine v6 scripts are the only rules
 * authoring; `legacy` is a saved JSON-rules (DSL) row, which the engine no longer runs — it is
 * shown read-only and has to be rewritten in Pine.
 */
export type AuthoringMode = 'legacy' | 'script';

/** A strategy's authoring mode — `legacy` only for a saved row without a script. */
export function authoringModeOf(strategy: StrategyDto | null | undefined): AuthoringMode {
  if (!strategy) return 'script';
  if (strategy.authoringMode === 'Script') return 'script';
  if (strategy.authoringMode === 'Dsl') return 'legacy';
  return strategy.scriptSource ? 'script' : 'legacy';
}

/**
 * The strategy form's authoring mode: re-derived from the strategy whenever the form opens or is
 * pointed at another strategy (create → script).
 */
export function linkedAuthoringMode(
  strategy: () => StrategyDto | null,
  open: () => boolean,
): WritableSignal<AuthoringMode> {
  return linkedSignal({
    source: () => ({ strategy: strategy(), open: open() }),
    computation: ({ strategy: s }) => authoringModeOf(s),
  });
}

/** The script being written in the form, kept by the form so it survives tab switches. */
export interface ScriptDraft {
  source: string;
  /** Input overrides `{ inputId: value }`. */
  inputs: ScriptInputValues;
  executionPolicy: ScriptExecutionPolicy;
}

/**
 * A new strategy's starting point — a complete, compiling Pine v6 strategy. Every entry carries a
 * protective stop sized to the market's noise (ATR) and a target: live accounts reject an entry
 * without a stop (PS9002), so a script started from here can go live as written (PE-09).
 */
export const DEFAULT_STRATEGY_SCRIPT = `//@version=6
strategy("My strategy", overlay = true, initial_capital = 10000, default_qty_type = strategy.percent_of_equity, default_qty_value = 10)

//#region Inputs
fastLength = input.int(9, "Fast length", minval = 1, group = "Moving averages")
slowLength = input.int(21, "Slow length", minval = 1, group = "Moving averages")
atrLength = input.int(14, "ATR length", minval = 1, group = "Risk")
stopAtr = input.float(1.5, "Stop (x ATR)", minval = 0.1, step = 0.1, group = "Risk")
targetAtr = input.float(2.0, "Target (x ATR)", minval = 0.1, step = 0.1, group = "Risk")
//#endregion

fast = ta.ema(close, fastLength)
slow = ta.ema(close, slowLength)
atr = ta.atr(atrLength)

// The stop and target are fixed when the trade opens, from the ATR of that bar.
if ta.crossover(fast, slow)
    strategy.entry("Long", strategy.long)
    strategy.exit("Long exit", "Long", stop = close - atr * stopAtr, limit = close + atr * targetAtr)
if ta.crossunder(fast, slow)
    strategy.entry("Short", strategy.short)
    strategy.exit("Short exit", "Short", stop = close + atr * stopAtr, limit = close - atr * targetAtr)

plot(fast, "Fast", color.teal)
plot(slow, "Slow", color.orange)
`;

/** The draft a strategy starts from: its saved script, or the default script for a new one. */
export function draftFor(strategy: StrategyDto | null | undefined): ScriptDraft {
  return {
    source: strategy?.scriptSource ?? DEFAULT_STRATEGY_SCRIPT,
    inputs: parseSavedInputs(strategy?.scriptInputs),
    executionPolicy: strategy?.executionPolicy ?? 'Direct',
  };
}

/**
 * The saved script an edit started from (PE-01 / PE-05): what "unsaved changes" compares with,
 * and the revision a save sends as `expectedScriptRevision` so it never overwrites a newer script
 * (another tab, a rollback, an approved optimization).
 */
export interface ScriptBase {
  source: string;
  inputs: ScriptInputValues;
  /** `scriptRevision` of the saved script; null for a new strategy or an older engine. */
  revision: string | null;
}

export function baseFor(
  strategy: (StrategyDto & StrategyScriptRevisionField) | null | undefined,
): ScriptBase {
  const d = draftFor(strategy);
  return {
    source: d.source,
    inputs: d.inputs,
    revision: strategy?.scriptRevision ?? null,
  };
}

/** The form's draft, reset (like the mode) when the form opens or its strategy changes. */
export function linkedScriptDraft(
  strategy: () => StrategyDto | null,
  open: () => boolean,
): WritableSignal<ScriptDraft> {
  return linkedSignal({
    source: () => ({ strategy: strategy(), open: open() }),
    computation: ({ strategy: s }) => draftFor(s),
  });
}
