import { describe, expect, it } from 'vitest';

import { DEFAULT_PATIENT_TRADER_CONFIG } from '@features/patient-trader/patient-trader.types';
import { toSaveResult } from './patient-trader.service';

describe('PatientTraderService toSaveResult', () => {
  const current = { ...DEFAULT_PATIENT_TRADER_CONFIG, version: 'v9', enabled: true };

  it('reports the persisted config and the governance message on success', () => {
    const r = toSaveResult({ status: true, data: current, message: 'Queued', responseCode: '00' });
    expect(r).toEqual({ kind: 'saved', config: current, message: 'Queued' });
  });

  it('turns -409 into a conflict carrying the current config', () => {
    const r = toSaveResult({
      status: false,
      data: current,
      message: 'changed since this page loaded it',
      responseCode: '-409',
    });
    expect(r.kind).toBe('conflict');
    if (r.kind === 'conflict') {
      expect(r.config?.version).toBe('v9');
      expect(r.message).toContain('changed since');
    }
  });

  it('reports validation and other failures as refused', () => {
    expect(
      toSaveResult({ status: false, data: null, message: 'Bad cap', responseCode: '-11' }),
    ).toEqual({ kind: 'refused', message: 'Bad cap' });
    expect(toSaveResult(null).kind).toBe('refused');
  });
});
