import type { ScriptInputValues } from '@core/api/scripting.types';

// Kept apart from pine-inputs so the strategy form (eagerly part of the strategies bundle) can
// read a strategy's saved inputs without pulling in the inputs-form helpers.

/** Parses a strategy's `scriptInputs`, which older engines may send as JSON text. */
export function parseSavedInputs(raw: unknown): ScriptInputValues {
  if (!raw) return {};
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof raw === 'object' && !Array.isArray(raw) ? (raw as ScriptInputValues) : {};
}
