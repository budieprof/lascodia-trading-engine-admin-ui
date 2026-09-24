import type { StrategyDto } from '@core/api/api.types';

import type {
  ExecutionPolicy,
  ScriptStrategyDto,
  ScriptStrategyFields,
} from '../api/scripting-api.types';

/**
 * Reading the ADR-0027 fields off a strategy DTO. Every field is optional on the wire (older
 * engine builds omit them), so these helpers are the one place that decides what "a script
 * strategy" is and what a missing value means.
 */

type AnyStrategy = (StrategyDto & Partial<ScriptStrategyFields>) | ScriptStrategyDto;

/** True for a Pine-script strategy: `authoringMode: "Script"`, or script source on an older DTO. */
export function isScriptStrategy(s: AnyStrategy | null | undefined): boolean {
  if (!s) return false;
  const mode = (s as ScriptStrategyFields).authoringMode;
  if (typeof mode === 'string' && mode.trim() !== '') return mode.toLowerCase() === 'script';
  const source = (s as ScriptStrategyFields).scriptSource;
  return typeof source === 'string' && source.trim().length > 0;
}

export function scriptSourceOf(s: AnyStrategy | null | undefined): string | null {
  const source = (s as ScriptStrategyFields | null | undefined)?.scriptSource;
  return typeof source === 'string' && source.trim().length > 0 ? source : null;
}

/** The saved input overrides (`{ inputId: value }`); tolerates the stored JSON text. */
export function scriptInputsOf(s: AnyStrategy | null | undefined): Record<string, unknown> {
  const raw = (s as ScriptStrategyFields | null | undefined)?.scriptInputs;
  if (!raw) return {};
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : {};
}

/** The execution policy, or null when the engine did not report one. */
export function executionPolicyOf(s: AnyStrategy | null | undefined): ExecutionPolicy | null {
  const raw = (s as ScriptStrategyFields | null | undefined)?.executionPolicy;
  if (raw === 0 || raw === '0') return 'Standard';
  if (raw === 1 || raw === '1') return 'Direct';
  if (typeof raw === 'string') {
    const v = raw.trim().toLowerCase();
    if (v === 'standard') return 'Standard';
    if (v === 'direct') return 'Direct';
  }
  return null;
}
