import { describe, expect, it } from 'vitest';

import { confirmationMatches } from './organisation.logic';
import type { EffectiveConfigEntry, ScopedKillSwitchStatus } from './organisation.types';
import {
  flattenEffects,
  flattenPhrase,
  lastChange,
  limitLabel,
  reasonProblem,
  riskLimitEntries,
  switchState,
} from './risk.logic';

const status = (over: Partial<ScopedKillSwitchStatus> = {}): ScopedKillSwitchStatus => ({
  enabled: false,
  reason: null,
  changedAt: null,
  changedBy: null,
  scope: 'Account',
  haltedBy: null,
  ...over,
});

describe('kill switch state', () => {
  it('names its own state, or the outer switch that halts the scope', () => {
    expect(switchState(status())).toEqual({ label: 'Trading', tone: 'ok' });
    expect(switchState(status({ enabled: true, haltedBy: 'Account' }))).toEqual({
      label: 'Engaged',
      tone: 'bad',
    });
    expect(switchState(status({ haltedBy: 'Tenant' })).label).toBe('Halted by the organisation');
    expect(switchState(status({ haltedBy: 'Platform' })).label).toBe('Halted by the platform');
    expect(switchState(null).label).toBe('Unknown');
  });

  it('says who changed it, when and why', () => {
    expect(lastChange(status())).toBeNull();
    const text = lastChange(
      status({
        enabled: true,
        changedAt: '2026-10-20T09:00:00Z',
        changedBy: 'Ola',
        reason: 'news',
      }),
    );
    expect(text).toMatch(/^Engaged by Ola on .+: news$/);
  });

  it('needs a reason, at most 1000 characters', () => {
    expect(reasonProblem('  ')).toContain('Give a reason');
    expect(reasonProblem('x'.repeat(1001))).toContain('1000');
    expect(reasonProblem('Desk halt')).toBeNull();
  });
});

describe('emergency flatten', () => {
  it('asks for the organisation’s name, or an account’s login', () => {
    expect(flattenPhrase('organisation', 'House')).toBe('House');
    expect(flattenPhrase('organisation', null)).toBe('FLATTEN');
    const account = {
      id: 7,
      login: '10077',
      name: 'Main',
      brokerServer: 'S',
      accountType: 'Real',
      isPaper: false,
    };
    expect(flattenPhrase('account', 'House', account)).toBe('10077');
    expect(flattenPhrase('account', 'House', { ...account, login: null })).toBe('account 7');
  });

  it('matches the typed phrase exactly, apart from spaces and case', () => {
    expect(confirmationMatches(' house ', 'House')).toBe(true);
    expect(confirmationMatches('Hous', 'House')).toBe(false);
    expect(confirmationMatches('', '')).toBe(false);
  });

  it('says what a flatten does, and how trading resumes', () => {
    const org = flattenEffects('organisation');
    expect(org.join(' ')).toContain("Pauses the organisation's own strategies");
    expect(org.at(-1)).toContain('releases the kill switch');
    expect(flattenEffects('account').join(' ')).not.toContain('strategies');
  });
});

describe('organisation-wide limits', () => {
  it('picks the four limits in page order and names them', () => {
    const e = (key: string) => ({ key }) as EffectiveConfigEntry;
    const rows = riskLimitEntries([
      e('EA:FillMode'),
      e('TenantRisk:MaxOrdersPerMinute'),
      e('TenantRisk:MaxOpenPositions'),
    ]);
    expect(rows.map((r) => r.key)).toEqual([
      'TenantRisk:MaxOpenPositions',
      'TenantRisk:MaxOrdersPerMinute',
    ]);
    expect(limitLabel('TenantRisk:MaxDailyLossPct')).toContain('Daily loss');
  });
});
