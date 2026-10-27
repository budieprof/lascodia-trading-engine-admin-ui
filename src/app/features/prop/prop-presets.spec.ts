import { describe, expect, it } from 'vitest';

import { defaultRules, ruleErrors } from './prop.logic';
import { PROP_PRESETS, presetById, sizeLabels } from './prop-presets';

describe('prop presets (multi-asset WS7 7.8)', () => {
  it('the FX preset IS the existing default (unchanged)', () => {
    expect(presetById('fx-two-step').rules()).toEqual(defaultRules());
    expect(presetById('nope').id).toBe('fx-two-step');
    expect(sizeLabels('lots')).toEqual({ perPosition: 'Max lots per position', total: 'Max total open lots' });
  });

  it('every preset passes the editor’s (= engine’s) rule validation', () => {
    for (const p of PROP_PRESETS) expect(ruleErrors(p.rules()), p.id).toEqual([]);
  });

  it('futures: contracts, CME day, trailing drawdown locking, no weekend holding', () => {
    const r = presetById('futures-one-step').rules();
    expect(r.tradingDay).toEqual({ resetTime: '17:00', timeZone: 'America/Chicago' });
    const ev = r.phases[0];
    expect(ev.maxLotsPerPosition).toBe(5);
    expect(ev.drawdownMode).toBe('Trailing');
    expect(ev.trailingLocksAtInitialBalance).toBe(true);
    expect(ev.weekendHoldingAllowed).toBe(false);
    expect(r.phases.at(-1)!.kind).toBe('Funded');
    expect(sizeLabels('contracts').perPosition).toBe('Max contracts per position');
  });

  it('crypto: 24/7 UTC day, weekends allowed, no default coin cap', () => {
    const r = presetById('crypto-two-step').rules();
    expect(r.tradingDay.timeZone).toBe('UTC');
    expect(r.phases.every((p) => p.weekendHoldingAllowed && p.maxLotsPerPosition === null)).toBe(true);
  });

  it('a preset is a fresh copy each time', () => {
    const a = presetById('futures-one-step').rules();
    a.phases[0].profitTargetPct = 99;
    expect(presetById('futures-one-step').rules().phases[0].profitTargetPct).toBe(6);
  });
});
