import { linkedSignal, type WritableSignal } from '@angular/core';

import type { StrategyDto } from '@core/api/api.types';
import type { ScriptExecutionPolicy, ScriptInputValues } from '@core/api/scripting.types';
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

/** A new strategy's starting point — a complete, compiling Pine v6 strategy. */
export const DEFAULT_STRATEGY_SCRIPT = `//@version=6
strategy("My strategy", overlay = true, initial_capital = 10000, default_qty_type = strategy.percent_of_equity, default_qty_value = 10)

//#region Inputs
fastLength = input.int(9, "Fast length", minval = 1, group = "Moving averages")
slowLength = input.int(21, "Slow length", minval = 1, group = "Moving averages")
//#endregion

fast = ta.ema(close, fastLength)
slow = ta.ema(close, slowLength)

if ta.crossover(fast, slow)
    strategy.entry("Long", strategy.long)
if ta.crossunder(fast, slow)
    strategy.entry("Short", strategy.short)

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
