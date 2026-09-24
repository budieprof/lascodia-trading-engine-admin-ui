import { describe, expect, it } from 'vitest';

import type { TradingAccountDto } from '@core/api/api.types';
import {
  accountEnvironment,
  confirmationTargets,
  deliveryEffect,
  diffBindings,
  isLiveMoney,
  matchesConfirmation,
  requiresTypedConfirmation,
  toBindingInputs,
  toBindingRows,
  unconfirmedLiveChanges,
  validateBindingSet,
  validateMultiplier,
  widensToFleet,
  type BindingRow,
} from './execution.model';

function account(over: Partial<TradingAccountDto>): TradingAccountDto {
  return {
    id: 1,
    accountId: '1000',
    accountName: 'Account',
    brokerServer: null,
    brokerName: 'Exness',
    accountType: 'Demo',
    leverage: 100,
    marginMode: 'Hedging',
    currency: 'USD',
    balance: 0,
    equity: 0,
    marginUsed: 0,
    marginAvailable: 0,
    marginLevel: 0,
    profit: 0,
    credit: 0,
    marginSoMode: null,
    marginSoCall: 0,
    marginSoStopOut: 0,
    maxAbsoluteDailyLoss: 0,
    isActive: true,
    isPaper: false,
    lastSyncedAt: '2026-09-24T00:00:00Z',
    riskProfileId: null,
    ...over,
  };
}

const REAL = account({
  id: 27,
  accountId: '99887766',
  accountName: 'Exness Real',
  accountType: 'Real',
});
const DEMO = account({
  id: 17,
  accountId: '81234567',
  accountName: 'Exness Demo',
  accountType: 'Demo',
});

function row(over: Partial<BindingRow>): BindingRow {
  return {
    tradingAccountId: 27,
    accountName: 'Exness Real',
    accountNumber: '99887766',
    brokerName: 'Exness',
    currency: 'USD',
    environment: 'REAL',
    lotMultiplier: 1,
    isEnabled: true,
    saved: null,
    ...over,
  };
}

describe('account environment', () => {
  it('classifies by where the money lives', () => {
    expect(accountEnvironment(REAL)).toBe('REAL');
    expect(accountEnvironment(DEMO)).toBe('DEMO');
    expect(accountEnvironment(account({ accountType: 'Contest' }))).toBe('CONTEST');
    // Paper wins over the broker type: its fills are simulated inside the engine.
    expect(accountEnvironment(account({ accountType: 'Real', isPaper: true }))).toBe('PAPER');
    expect(accountEnvironment(null)).toBe('UNKNOWN');
  });

  it('treats REAL and unverifiable accounts as live money', () => {
    expect(isLiveMoney('REAL')).toBe(true);
    expect(isLiveMoney('UNKNOWN')).toBe(true);
    expect(isLiveMoney('DEMO')).toBe(false);
    expect(isLiveMoney('PAPER')).toBe(false);
    expect(isLiveMoney('CONTEST')).toBe(false);
    expect(requiresTypedConfirmation({ environment: 'UNKNOWN' })).toBe(true);
    expect(requiresTypedConfirmation({ environment: 'DEMO' })).toBe(false);
  });
});

describe('toBindingRows', () => {
  it('joins the engine’s bindings with the accounts list', () => {
    const rows = toBindingRows(
      [
        { tradingAccountId: 27, accountName: 'Real (engine)', lotMultiplier: 2, isEnabled: false },
        { tradingAccountId: 55, accountName: 'Deleted one', lotMultiplier: 1, isEnabled: true },
      ],
      [REAL, DEMO],
    );
    expect(rows[0]).toMatchObject({
      accountName: 'Exness Real',
      accountNumber: '99887766',
      environment: 'REAL',
      lotMultiplier: 2,
      isEnabled: false,
      saved: { lotMultiplier: 2, isEnabled: false },
    });
    // Not in the list → the engine's name, and treated as live money.
    expect(rows[1]).toMatchObject({ accountName: 'Deleted one', environment: 'UNKNOWN' });
  });
});

describe('typed confirmation', () => {
  it('accepts the account number or the account name', () => {
    const targets = confirmationTargets(row({}));
    expect(targets).toEqual(['99887766', 'Exness Real']);
    expect(matchesConfirmation('99887766', targets)).toBe(true);
    expect(matchesConfirmation('  exness   REAL ', targets)).toBe(true);
    expect(matchesConfirmation('9988776', targets)).toBe(false);
    expect(matchesConfirmation('', targets)).toBe(false);
    expect(matchesConfirmation('   ', targets)).toBe(false);
  });

  it('falls back to the id for an account without number or name', () => {
    expect(
      confirmationTargets({ tradingAccountId: 55, accountName: ' ', accountNumber: null }),
    ).toEqual(['55']);
  });
});

describe('unconfirmedLiveChanges (the save backstop)', () => {
  const saved = { lotMultiplier: 1, isEnabled: true };

  it('flags a new live-money binding until it is confirmed', () => {
    const r = row({ saved: null });
    expect(unconfirmedLiveChanges([r], new Set())).toEqual([r]);
    expect(unconfirmedLiveChanges([r], new Set([27]))).toEqual([]);
  });

  it('flags enabling a live-money binding that was saved paused', () => {
    const r = row({ isEnabled: true, saved: { lotMultiplier: 1, isEnabled: false } });
    expect(unconfirmedLiveChanges([r], new Set())).toHaveLength(1);
  });

  it('leaves unchanged, paused-now and non-live bindings alone', () => {
    expect(unconfirmedLiveChanges([row({ saved })], new Set())).toEqual([]);
    expect(unconfirmedLiveChanges([row({ isEnabled: false, saved })], new Set())).toEqual([]);
    expect(unconfirmedLiveChanges([row({ environment: 'DEMO', saved: null })], new Set())).toEqual(
      [],
    );
  });
});

describe('validation', () => {
  it('bounds the lot multiplier to (0, 10]', () => {
    expect(validateMultiplier(1)).toBeNull();
    expect(validateMultiplier(10)).toBeNull();
    expect(validateMultiplier('0.5')).toBeNull();
    expect(validateMultiplier(0)).toMatch(/greater than 0/);
    expect(validateMultiplier(-1)).toMatch(/greater than 0/);
    expect(validateMultiplier(10.01)).toMatch(/exceed 10/);
    expect(validateMultiplier('abc')).toMatch(/number/);
    expect(validateMultiplier(NaN)).toMatch(/number/);
  });

  it('rejects an account bound twice and bad multipliers', () => {
    expect(validateBindingSet([row({}), row({})])).toHaveLength(1);
    expect(validateBindingSet([row({ lotMultiplier: 20 })])[0]).toMatch(/Exness Real/);
    expect(validateBindingSet([row({})])).toEqual([]);
  });

  it('sends the complete set as the PUT body', () => {
    expect(toBindingInputs([row({ lotMultiplier: 1.5, isEnabled: false })])).toEqual([
      { tradingAccountId: 27, lotMultiplier: 1.5, isEnabled: false },
    ]);
  });
});

describe('diffBindings', () => {
  it('lists additions, removals, toggles and multiplier changes', () => {
    const savedRows = [
      row({ tradingAccountId: 1, accountName: 'A', saved: { lotMultiplier: 1, isEnabled: true } }),
      row({ tradingAccountId: 2, accountName: 'B', saved: { lotMultiplier: 1, isEnabled: true } }),
      row({
        tradingAccountId: 3,
        accountName: 'C',
        isEnabled: false,
        saved: { lotMultiplier: 1, isEnabled: false },
      }),
    ];
    const current = [
      { ...savedRows[0], lotMultiplier: 2 },
      { ...savedRows[2], isEnabled: true },
      row({ tradingAccountId: 4, accountName: 'D', saved: null }),
    ];
    const kinds = diffBindings(savedRows, current).map((c) => `${c.kind}:${c.row.accountName}`);
    expect(kinds).toEqual(['multiplier:A', 'enabled:C', 'added:D', 'removed:B']);
    expect(diffBindings(savedRows, savedRows)).toEqual([]);
  });
});

describe('deliveryEffect', () => {
  it('a script strategy with no binding trades on no account', () => {
    const e = deliveryEffect([], true, 'EURUSD');
    expect(e.mode).toBe('paper-only');
    expect(e.touchesRealMoney).toBe(false);
    expect(e.summary).toMatch(/emulator \/ paper only/);
  });

  it('any other strategy with no binding fans out to the fleet, REAL accounts included', () => {
    const e = deliveryEffect([], false, 'EURUSD');
    expect(e.mode).toBe('unrestricted');
    expect(e.touchesRealMoney).toBe(true);
    expect(e.summary).toMatch(/every account whose EA streams EURUSD/);
  });

  it('bound but all paused trades nowhere — it never widens back to the fleet', () => {
    const e = deliveryEffect([row({ isEnabled: false })], false, 'EURUSD');
    expect(e.mode).toBe('paused');
    expect(e.touchesRealMoney).toBe(false);
  });

  it('bound and enabled trades only there', () => {
    const e = deliveryEffect(
      [
        row({ lotMultiplier: 2 }),
        row({ tradingAccountId: 17, accountName: 'Demo', environment: 'DEMO', isEnabled: false }),
      ],
      true,
      'EURUSD',
    );
    expect(e.mode).toBe('restricted');
    expect(e.liveRows.map((r) => r.tradingAccountId)).toEqual([27]);
    expect(e.touchesRealMoney).toBe(true);
    expect(e.summary).toBe('Trades only on Exness Real (REAL, lots ×2).');
  });
});

describe('widensToFleet', () => {
  const saved = [row({ saved: { lotMultiplier: 1, isEnabled: true } })];

  it('is true only when a non-script strategy loses its last binding', () => {
    expect(widensToFleet(saved, [], false)).toBe(true);
    expect(widensToFleet(saved, [], true)).toBe(false);
    expect(widensToFleet([], [], false)).toBe(false);
    expect(widensToFleet(saved, saved, false)).toBe(false);
  });
});
