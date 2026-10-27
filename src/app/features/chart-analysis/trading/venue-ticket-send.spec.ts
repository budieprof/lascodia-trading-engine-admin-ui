import { describe, expect, it } from 'vitest';

import type { InstrumentDto } from '@core/instruments/instrument.types';
import type { ExecutionAccount, VenueTicketPreview } from '@features/venues/venues.types';

import { defaultVenueTicket } from './venue-ticket-model';
import {
  SWITCHED_OFF_MESSAGE,
  confirmLines,
  defaultExecutionAccount,
  defaultTradingAccount,
  fourEyesNotice,
  isVenueRoute,
  sendBlockedReason,
  sendOutcome,
  sendRequestOf,
  signalLink,
  switchOn,
  switchesOff,
  venueAccountsOf,
  venueTradingAccountIds,
  type SendGateInput,
} from './venue-ticket-send';

const ES: InstrumentDto = {
  symbol: 'ESZ6',
  assetClass: 'Future',
  exchange: 'CME',
  description: null,
  quoteCurrency: 'USD',
  tickSize: 0.25,
  tickValue: 12.5,
  multiplier: 50,
  quantityUnit: 'Contracts',
  quantityStep: 1,
  minQuantity: 1,
  maxQuantity: 0,
  priceDecimals: 2,
  displayDistance: 'Ticks',
  tradingCalendarCode: 'cme-globex',
  status: 'Active',
  future: {
    root: 'ES',
    contractCode: 'ESZ6',
    expiry: null,
    lastTradeDate: null,
    isFront: true,
    continuousSymbol: 'ES1!',
  },
};

function acct(p: Partial<ExecutionAccount>): ExecutionAccount {
  return {
    id: 1,
    name: 'acct',
    adapterKind: 'cqg',
    venue: 'CME',
    externalAccountId: null,
    tradingAccountId: 7,
    mode: 'Paper',
    status: 'Active',
    currency: 'USD',
    lastConnectResult: null,
    lastConnectedAtUtc: null,
    createdAtUtc: '2026-10-27T00:00:00Z',
    credential: null,
    ...p,
  };
}

function preview(p: Partial<VenueTicketPreview> = {}): VenueTicketPreview {
  return {
    symbol: 'ESZ6',
    assetClass: 'Future',
    instrumentKind: 'Future',
    quantityUnit: 'Contracts',
    tickSize: 0.25,
    tickValue: 12.5,
    multiplier: 50,
    quantityStep: 1,
    minQuantity: 1,
    maxQuantity: 0,
    priceDecimals: 2,
    quoteCurrency: 'USD',
    accountCurrency: 'USD',
    accountEquity: 100000,
    quoteToAccountRate: 1,
    referencePrice: 6000,
    referencePriceSource: 'limit',
    bid: 5999.75,
    ask: 6000,
    notionalQuote: 300000,
    notionalAccount: 300000,
    margin: {
      model: 'futures',
      initialMargin: 15000,
      maintenanceMargin: 13600,
      liquidationPrice: null,
      leverage: null,
      basis: 'CME',
      refusal: null,
    },
    stopLossPrice: 5995,
    takeProfitPrice: 6010,
    riskMoney: 250,
    rewardMoney: 500,
    riskPctOfEquity: 0.25,
    feeEstimate: 2.5,
    feeBasis: 'fee schedule',
    accountLeverage: null,
    accountMarginMode: null,
    multiAssetRiskEnabled: true,
    sessionOpen: true,
    sessionKind: 'Regular',
    valid: true,
    checks: [{ name: 'step', ok: true, blocking: true, message: 'Quantity on the step.' }],
    notes: [],
    ...p,
  };
}

const ACCOUNTS = [
  acct({ id: 3, name: 'CQG paper', tradingAccountId: 7 }),
  acct({ id: 4, name: 'EA', adapterKind: 'mt5-ea', tradingAccountId: 7 }),
  acct({ id: 5, name: 'Rithmic', adapterKind: 'rithmic', tradingAccountId: 9, status: 'Disabled' }),
  acct({ id: 6, name: 'Unlinked', adapterKind: 'binance', tradingAccountId: null }),
  acct({ id: 8, name: 'Rithmic 2', adapterKind: 'rithmic', tradingAccountId: 9 }),
];

describe('venue ticket send — picker', () => {
  it('a venue route is a linked, non-MT5 account', () => {
    expect(ACCOUNTS.map(isVenueRoute)).toEqual([true, false, true, false, true]);
    expect(isVenueRoute(acct({ adapterKind: ' MT5-EA ' }))).toBe(false);
  });

  it('offers trading accounts that have venue accounts, and only their venue accounts', () => {
    expect(venueTradingAccountIds(ACCOUNTS)).toEqual([7, 9]);
    expect(venueAccountsOf(ACCOUNTS, 7).map((a) => a.id)).toEqual([3]);
    expect(venueAccountsOf(ACCOUNTS, 9).map((a) => a.id)).toEqual([5, 8]);
    expect(venueAccountsOf(ACCOUNTS, null)).toEqual([]);
  });

  it('starts on the scope account when it has venue accounts, else the only one', () => {
    expect(defaultTradingAccount(ACCOUNTS, 9)).toBe(9);
    expect(defaultTradingAccount(ACCOUNTS, 12)).toBeNull(); // two candidates: the operator picks
    expect(defaultTradingAccount(ACCOUNTS.slice(0, 2), null)).toBe(7);
  });

  it('starts on the only Active venue account of the trading account', () => {
    expect(defaultExecutionAccount(ACCOUNTS, 7)).toBe(3);
    expect(defaultExecutionAccount(ACCOUNTS, 9)).toBe(8); // 5 is Disabled
    expect(
      defaultExecutionAccount([...ACCOUNTS, acct({ id: 10, tradingAccountId: 9 })], 9),
    ).toBeNull();
  });
});

describe('venue ticket send — gates', () => {
  it('reads switches the way the engine does (bool.TryParse; missing = off)', () => {
    expect([
      switchOn('true'),
      switchOn(' True '),
      switchOn('false'),
      switchOn(''),
      switchOn(undefined),
      switchOn('1'),
    ]).toEqual([true, true, false, false, false, false]);
  });

  it('names the switches that are off; unknown switches are left to the engine', () => {
    expect(switchesOff({}, null)).toEqual([
      'Execution:Router:Enabled',
      'Execution:Entries:Enabled',
    ]);
    expect(
      switchesOff(
        { 'Execution:Router:Enabled': 'true', 'Execution:Entries:Enabled': 'true' },
        false,
      ),
    ).toEqual(['Risk:MultiAsset:Enabled']);
    expect(
      switchesOff(
        { 'Execution:Router:Enabled': 'true', 'Execution:Entries:Enabled': 'true' },
        true,
      ),
    ).toEqual([]);
    expect(switchesOff(null, null)).toEqual([]);
  });

  const ok: SendGateInput = {
    canSend: true,
    off: [],
    account: acct({ id: 3 }),
    problems: [],
    preview: preview(),
    loading: false,
    submitting: false,
  };

  it('may be pressed only when every gate passes', () => {
    expect(sendBlockedReason(ok)).toBeNull();
  });

  it('says why, in the engine’s words, first reason first', () => {
    expect(sendBlockedReason({ ...ok, canSend: false })).toContain('access.trader');
    expect(sendBlockedReason({ ...ok, off: ['Execution:Entries:Enabled'] })).toBe(
      `${SWITCHED_OFF_MESSAGE} Off: Execution:Entries:Enabled.`,
    );
    expect(sendBlockedReason({ ...ok, account: null })).toBe('Choose a venue execution account.');
    expect(sendBlockedReason({ ...ok, account: acct({ id: 3, status: 'Disabled' }) })).toBe(
      'Execution account 3 is Disabled: activate and verify it first.',
    );
    expect(sendBlockedReason({ ...ok, problems: ['A limit order needs a price.'] })).toBe(
      'A limit order needs a price.',
    );
    expect(sendBlockedReason({ ...ok, preview: null, loading: true })).toBe(
      'Waiting for the engine to check the ticket.',
    );
    expect(
      sendBlockedReason({
        ...ok,
        preview: preview({
          valid: false,
          checks: [
            { name: 'margin', ok: false, blocking: true, message: 'No margin requirement.' },
          ],
        }),
      }),
    ).toBe('No margin requirement.');
    expect(sendBlockedReason({ ...ok, preview: preview({ referencePrice: null }) })).toBe(
      'The ticket has no price to be valued at.',
    );
    expect(sendBlockedReason({ ...ok, submitting: true })).toBe('Sending…');
  });
});

describe('venue ticket send — request and answer', () => {
  it('the body is the preview request with the execution account required', () => {
    const s = { ...defaultVenueTicket(ES), price: 6000, stopLossTicks: 20 };
    expect(sendRequestOf('ESZ6', s)).toBeNull();
    expect(sendRequestOf('ESZ6', { ...s, executionAccountId: 3 })).toEqual({
      executionAccountId: 3,
      symbol: 'ESZ6',
      side: 'Buy',
      orderType: 'Limit',
      quantity: 1,
      price: 6000,
      stopPrice: null,
      timeInForce: 'Gtc',
      postOnly: false,
      reduceOnly: false,
      leverage: null,
      marginMode: null,
      stopLossTicks: 20,
      takeProfitTicks: null,
    });
  });

  it('reads placed / refused / approval from the envelope', () => {
    expect(
      sendOutcome({
        status: true,
        responseCode: '00',
        message: 'm',
        data: {
          placed: true,
          message: 'Manual venue signal 42 created',
          tradeSignalId: 42,
          manualStrategyId: 9,
          preview: null,
        },
      }),
    ).toEqual({
      kind: 'placed',
      message: 'Manual venue signal 42 created',
      tradeSignalId: 42,
      preview: null,
    });
    const refused = sendOutcome({
      status: false,
      responseCode: '-11',
      message: 'Venue tickets are switched off',
      data: {
        placed: false,
        message: 'Venue tickets are switched off',
        tradeSignalId: null,
        manualStrategyId: null,
        preview: preview(),
      },
    });
    expect(refused.kind).toBe('refused');
    expect(refused.message).toBe('Venue tickets are switched off');
    expect(
      sendOutcome({
        status: false,
        responseCode: '-14',
        message: 'Execution account 3 not found',
        data: null,
      }),
    ).toEqual({
      kind: 'refused',
      message: 'Execution account 3 not found',
      code: '-14',
      preview: null,
    });
    const approval = sendOutcome({
      status: false,
      responseCode: '-202-approval',
      message: null,
      data: { approvalId: 77, expiresAtUtc: 'x' } as never,
    });
    expect(approval.kind).toBe('approval');
    expect(approval.message).toContain('request #77');
    expect(sendOutcome(null).kind).toBe('refused');
  });

  it('the confirm step shows the order as sent and the four-eyes notice', () => {
    const s = {
      ...defaultVenueTicket(ES),
      price: 6000,
      stopLossTicks: 20,
      takeProfitTicks: 40,
      executionAccountId: 3,
    };
    const lines = confirmLines(
      'ESZ6',
      'contract',
      s,
      preview(),
      acct({ id: 3, name: 'CQG paper' }),
    );
    const byLabel = Object.fromEntries(lines.map((l) => [l.label, l.value]));
    expect(byLabel['Order']).toBe('Buy 1 contract ESZ6');
    expect(byLabel['Type']).toBe('Limit · GTC');
    expect(byLabel['Limit']).toBe('6,000');
    expect(byLabel['Stop / target']).toBe('5,995 (20 ticks) / 6,010 (40 ticks)');
    expect(
      confirmLines(
        'ESZ6',
        'contract',
        { ...s, takeProfitTicks: null },
        preview(),
        acct({ id: 3 }),
      ).find((l) => l.label === 'Stop / target')?.value,
    ).toBe('5,995 (20 ticks) / 6,010');
    expect(byLabel['Account']).toBe('CQG paper · CME · Paper (#3)');
    expect(fourEyesNotice(preview())).toContain('300,000 USD');
    expect(fourEyesNotice(preview())).toContain('second authorised person');
    expect(signalLink(42)).toBe('/trade-signals/42');
  });
});
