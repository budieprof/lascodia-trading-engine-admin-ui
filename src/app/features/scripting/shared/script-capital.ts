import type { ScriptStrategyProperties } from '@core/api/scripting.types';

/**
 * The capital a script strategy's account opens with (engine D122). Every engine-hosted run of a
 * script — preview, replay, screener, backtest, optimizer, walk-forward, paper and live session —
 * opens with one capital: the script's `strategy(initial_capital=…)` when it declares one, else the
 * engine's default `ScriptBacktest:InitialCapital`. Never Pine's 1,000,000 and never a run's own
 * initial balance, which the engine ignores for scripts.
 */

/** EngineConfig key of the engine's default script capital. */
export const SCRIPT_CAPITAL_CONFIG_KEY = 'ScriptBacktest:InitialCapital';

/**
 * - `declared` — `strategy()` passes `initial_capital`, whatever its value (a declared 1,000,000 is
 *   declared);
 * - `engineDefault` — it passes none, so the engine's default applies;
 * - `unknown` — the compile did not say (no compile yet, or an engine without the flag).
 */
export type ScriptCapitalSource = 'declared' | 'engineDefault' | 'unknown';

export interface ScriptCapital {
  source: ScriptCapitalSource;
  /** The declared amount; null unless `source` is `declared`. */
  amount: number | null;
  /** The script's `strategy(currency=…)`, the currency the capital is in; null when it declares none. */
  currency: string | null;
}

/**
 * Where the capital comes from, read from the compiler's `initialCapitalSpecified` flag only —
 * never from the value, which a declaration may set to Pine's own default.
 */
export function scriptCapitalOf(props: ScriptStrategyProperties | null | undefined): ScriptCapital {
  const currency = declaredCurrency(props?.currency);
  if (props?.initialCapitalSpecified === true) {
    const amount = props.initialCapital;
    return {
      source: 'declared',
      amount: typeof amount === 'number' && Number.isFinite(amount) ? amount : null,
      currency,
    };
  }
  if (props?.initialCapitalSpecified === false) {
    return { source: 'engineDefault', amount: null, currency };
  }
  return { source: 'unknown', amount: null, currency };
}

/** A `strategy(currency=…)` other than `NONE`, upper-cased; null otherwise. */
export function declaredCurrency(currency: string | null | undefined): string | null {
  const code = (currency ?? '').trim().toUpperCase();
  return code && code !== 'NONE' ? code : null;
}

/**
 * The engine's configured default capital (an EngineConfig value) when it is a positive number —
 * the engine falls back to its own default for anything else, which the console cannot see.
 */
export function parseConfiguredCapital(value: string | null | undefined): number | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

const CAPITAL_FORMAT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

/** "25,000", or "25,000 JPY" when the script declares its currency. */
export function formatCapital(amount: number, currency: string | null = null): string {
  const body = CAPITAL_FORMAT.format(amount);
  return currency ? `${body} ${currency}` : body;
}

/** How the engine default is named wherever the console cannot show its value. */
export const ENGINE_DEFAULT_CAPITAL_TEXT = `engine default (${SCRIPT_CAPITAL_CONFIG_KEY})`;

/**
 * The effective capital of a script's runs and its source, as one line: "25,000 · declared by the
 * script", "10,000 · engine default (ScriptBacktest:InitialCapital)", or the source alone when the
 * amount is not known. `configuredDefault` is the engine's default when the console could read it.
 */
export function describeScriptCapital(
  capital: ScriptCapital | null,
  configuredDefault: number | null,
): string {
  if (capital?.source === 'declared') {
    return capital.amount !== null
      ? `${formatCapital(capital.amount, capital.currency)} · declared by the script`
      : 'declared by the script';
  }
  if (capital?.source === 'engineDefault') {
    return configuredDefault !== null
      ? `${formatCapital(configuredDefault, capital.currency)} · ${ENGINE_DEFAULT_CAPITAL_TEXT}`
      : ENGINE_DEFAULT_CAPITAL_TEXT;
  }
  return `the script's initial_capital when it declares one, else the ${ENGINE_DEFAULT_CAPITAL_TEXT}`;
}
