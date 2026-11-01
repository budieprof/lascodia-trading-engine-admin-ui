import { describe, expect, it } from 'vitest';

import {
  fxChangeWarning,
  fxControlKind,
  fxKeyLabel,
  fxValueProblem,
  prerequisitesOn,
  routeSummary,
  sessionTone,
} from './fx-routing.logic';
import type { FxConfigKey, FxVenueKind } from './venues.types';

const key = (
  k: string,
  dataType: FxConfigKey['dataType'],
  value: string | null,
  def: string,
): FxConfigKey => ({
  key: k,
  value,
  default: def,
  dataType,
  description: '',
  group: 'route',
  lastChangedAtUtc: null,
  lastChangedBy: null,
});

describe('fx routing logic', () => {
  it('picks a typed control per key', () => {
    expect(fxControlKind(key('Execution:Fx:oanda:Enabled', 'Bool', null, 'false'))).toBe('bool');
    expect(fxControlKind(key('Execution:Fx:PreTradeGates:Mode', 'String', null, 'Enforce'))).toBe(
      'mode',
    );
    expect(
      fxControlKind(key('Execution:Fx:PreTradeGates:MaxOrdersPerMinute', 'Int', null, '10')),
    ).toBe('int');
  });

  it('refuses values the engine would not take', () => {
    const mode = key('Execution:Fx:PreTradeGates:Mode', 'String', null, 'Enforce');
    expect(fxValueProblem(mode, 'Observe')).toBeNull();
    expect(fxValueProblem(mode, 'observe')).toBe('Enforce or Observe.');
    const rate = key('Execution:Fx:PreTradeGates:MaxOrdersPerMinute', 'Int', null, '10');
    expect(fxValueProblem(rate, '0')).toBe('Between 1 and 120.');
    expect(fxValueProblem(rate, '2.5')).toBe('A whole number.');
    expect(fxValueProblem(rate, '30')).toBeNull();
  });

  it('labels keys in words', () => {
    expect(fxKeyLabel('Execution:Fx:ctrader:Enabled')).toBe('ctrader route');
    expect(fxKeyLabel('Execution:Fx:PreTradeGates:Mode')).toBe('Pre-trade gates mode');
    expect(fxKeyLabel('Execution:Fx:PreTradeGates:MaxOrdersPerMinute')).toBe(
      'Max orders per minute',
    );
    expect(fxKeyLabel('Execution:Router:Enabled')).toBe('Router');
  });

  it('warns before a change that routes or loosens', () => {
    const route = key('Execution:Fx:fix44:Enabled', 'Bool', null, 'false');
    expect(fxChangeWarning(route, 'true')).toContain('NEW entries');
    expect(
      fxChangeWarning(key('Execution:Fx:PreTradeGates:Mode', 'String', null, 'Enforce'), 'Observe'),
    ).toContain('recorded');
  });

  it('says why a route is not live', () => {
    const v = {
      kind: 'oanda',
      registered: true,
      enabled: true,
      environment: 'Demo',
      endpoint: '',
      gatewayTokenSet: null,
      accounts: 1,
      activeAccounts: 1,
      capabilities: null,
      sessions: [],
      credentialFields: [],
    } satisfies FxVenueKind;
    expect(routeSummary(v, false)).toContain('prerequisite');
    expect(routeSummary(v, true)).toContain('1 active');
    expect(routeSummary({ ...v, enabled: false }, true)).toContain('Off');
    const keys = [
      key('Execution:Router:Enabled', 'Bool', 'true', 'false'),
      key('Execution:Entries:Enabled', 'Bool', 'true', 'false'),
      key('Risk:MultiAsset:Enabled', 'Bool', null, 'false'),
    ];
    expect(prerequisitesOn(keys)).toBe(false);
    keys[2].value = 'true';
    expect(prerequisitesOn(keys)).toBe(true);
  });

  it('colours sessions', () => {
    expect(
      sessionTone({
        executionAccountId: 1,
        connected: true,
        lastConnectedUtc: null,
        lastRequestUtc: null,
        lastErrorUtc: null,
        lastError: null,
        requests: 1,
        errors: 0,
      }),
    ).toBe('ok');
    expect(
      sessionTone({
        sessionKey: 'acct-1',
        profile: 'lmax',
        environment: 'Demo',
        state: 'Disconnected',
        nextSenderSeqNum: 1,
        nextTargetSeqNum: 1,
        loggedOnAtUtc: null,
        lastMessageAtUtc: null,
        logons: 0,
        gapFillsReceived: 0,
        resendRequestsSent: 0,
        lastError: null,
        openOrders: 0,
        fills: 0,
        unverified: [],
      }),
    ).toBe('bad');
  });
});
