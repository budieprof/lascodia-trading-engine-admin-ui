/**
 * What the LLM settings page tells the operator after a save: applied, held for cooling-off, or
 * refused. The engine (UpdateLlmSettingsCommand, 2026-10-19) puts the applied count in `data` and
 * the held / failed counts only in its message.
 */
import { describe, expect, it } from 'vitest';
import type { ResponseData } from '@core/api/api.types';
import { isLlmRiskLoosening, readLlmSaveOutcome } from './llm-settings-save';

const env = (
  status: boolean,
  data: number | null,
  message: string,
  code = '00',
): ResponseData<number> => ({
  status,
  data,
  message,
  responseCode: code,
});

describe('readLlmSaveOutcome', () => {
  it('reads a plain save as applied', () => {
    const o = readLlmSaveOutcome(env(true, 2, 'Updated 2 setting(s).'));
    expect(o).toMatchObject({ ok: true, applied: 2, held: 0, failed: 0, needsReason: false });
  });

  it('counts loosening entries held for cooling-off', () => {
    const o = readLlmSaveOutcome(
      env(
        true,
        1,
        'Updated 1 setting(s). 1 risk-loosening change(s) held for cooling-off — Llm:SpotAnalysisHighConfidenceBypassThreshold: queued',
      ),
    );
    expect(o).toMatchObject({ ok: true, applied: 1, held: 1, failed: 0 });
  });

  it('reads the no-reason refusal as nothing saved, reason needed', () => {
    const o = readLlmSaveOutcome(
      env(
        false,
        0,
        'Risk-loosening change(s) need a reason: Llm:SpotAnalysisHighConfidenceBypassThreshold (0.8 → 0.7). Resubmit with a reason — they will be held for the cooling-off period unless Immediate=true (break-glass). Nothing was saved.',
        '-11',
      ),
    );
    expect(o).toMatchObject({ ok: false, applied: 0, held: 0, failed: 0, needsReason: true });
  });

  it('reads a governed-path failure after direct writes as partial', () => {
    const o = readLlmSaveOutcome(
      env(
        false,
        3,
        'Updated 3 setting(s). 1 risk-loosening change(s) failed — Llm:X: refused',
        '-11',
      ),
    );
    expect(o).toMatchObject({ ok: false, applied: 3, failed: 1, needsReason: false });
  });

  it('survives a missing envelope', () => {
    expect(readLlmSaveOutcome(null)).toMatchObject({ ok: false, applied: 0, needsReason: false });
  });
});

describe('isLlmRiskLoosening', () => {
  const KEY = 'Llm:SpotAnalysisHighConfidenceBypassThreshold';

  it('flags a lower bypass threshold and zeroing it', () => {
    expect(isLlmRiskLoosening(KEY, '0.8', '0.7')).toBe(true);
    expect(isLlmRiskLoosening(KEY, '0.8', '0')).toBe(true);
  });

  it('does not flag raising it, an unchanged value, or a non-number', () => {
    expect(isLlmRiskLoosening(KEY, '0.7', '0.8')).toBe(false);
    expect(isLlmRiskLoosening(KEY, '0.8', '0.80')).toBe(false);
    expect(isLlmRiskLoosening(KEY, '0.8', '')).toBe(false);
    expect(isLlmRiskLoosening(KEY, 'abc', '0.5')).toBe(false);
  });

  it('flags a shorter cooldown, as the engine catalog does', () => {
    expect(isLlmRiskLoosening('Llm:SpotAnalysisCooldownMinutes', '30', '10')).toBe(true);
    expect(isLlmRiskLoosening('Llm:SpotAnalysisCooldownMinutes', '10', '30')).toBe(false);
  });

  it('ignores other keys', () => {
    expect(isLlmRiskLoosening('Llm:DailyCostCapUsd', '50', '10')).toBe(false);
  });
});
