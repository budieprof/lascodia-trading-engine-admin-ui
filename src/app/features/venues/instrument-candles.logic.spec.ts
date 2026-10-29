import { describe, expect, it } from 'vitest';

import { candleChain, candleTiles, rollRows, workerRequirement } from './instrument-candles.logic';
import type {
  FuturesCatalogRoot,
  InstrumentCandleReadiness,
  InstrumentCandleState,
} from './venues.types';

const NOW = Date.parse('2026-10-28T12:00:00Z');

const state = (over: Partial<InstrumentCandleState> = {}): InstrumentCandleState => ({
  builderEnabled: true,
  continuousAdjustment: 'Panama',
  cursors: [],
  rolls: [],
  statusCounts: {},
  ...over,
});

const readiness = (over: Partial<InstrumentCandleReadiness> = {}): InstrumentCandleReadiness => ({
  builderEnabled: true,
  continuousEnabled: true,
  continuousAdjustment: 'Panama',
  pollIntervalSeconds: 60,
  backfillMaxDays: 3650,
  excludeEquityOddLots: true,
  workerCapturedAtUtc: '2026-10-28T11:58:00Z',
  workerLastSuccessUtc: '2026-10-28T11:58:00Z',
  workerLastErrorUtc: null,
  workerLastError: null,
  workerConsecutiveFailures: 0,
  eligibleByClass: { Crypto: 7234, Future: 98 },
  sources: [
    {
      sourceId: 'crypto-coinbase',
      kind: 'CryptoExchange',
      displayName: 'Coinbase',
      feedId: 'crypto:coinbase',
      enabled: true,
      writers: 1,
      mappedSymbols: ['BTC-USD'],
      mappedEligible: 1,
      storedSymbols: 0,
      storedEligible: 0,
      firstStoredDay: null,
      lastStoredDay: null,
    },
  ],
  candidateTotal: 1,
  candidates: [],
  roots: [],
  barsLast24h: 0,
  generatedAtUtc: '2026-10-28T12:00:00Z',
  ...over,
});

describe('candleChain', () => {
  it('says off with the switch when the builder is off', () => {
    const c = candleChain(
      state({ builderEnabled: false }),
      readiness({ builderEnabled: false }),
      NOW,
    );
    expect(c.kind).toBe('off');
    expect(c.requirements[0].ok).toBe(false);
  });

  it('waits for stored trades when a source is enabled but nothing is stored', () => {
    const c = candleChain(state(), readiness(), NOW);
    expect(c.kind).toBe('waiting');
    const stored = c.requirements.find((r) => r.label.startsWith('Trades stored'))!;
    expect(stored.ok).toBe(false);
    expect(stored.detail).toContain('feed process');
    expect(c.requirements.find((r) => r.label === 'Builder worker cycling')!.ok).toBe(true);
  });

  it('is partial when no source is enabled with a writer', () => {
    const r = readiness({ sources: [{ ...readiness().sources[0], enabled: false }] });
    expect(candleChain(state(), r, NOW).kind).toBe('partial');
  });

  it('marks receiving today from the last stored day', () => {
    const r = readiness({
      sources: [
        {
          ...readiness().sources[0],
          storedSymbols: 2,
          storedEligible: 2,
          lastStoredDay: '2026-10-28',
        },
      ],
    });
    const c = candleChain(state(), r, NOW);
    expect(c.requirements.find((x) => x.label === 'Receiving today')!.ok).toBe(true);
  });

  it('leaves the readiness links unknown without the endpoint', () => {
    const c = candleChain(state(), null, NOW);
    expect(
      c.requirements.some((r) => r.ok === null && r.label === 'Sources and stored trades'),
    ).toBe(true);
  });
});

describe('rollRows', () => {
  const catalog: FuturesCatalogRoot[] = [
    {
      root: 'ES',
      exchange: 'CME',
      dataset: 'GLBX.MDP3',
      group: 'EquityIndex',
      description: 'E-mini S&P',
      currency: 'USD',
      tickSize: 0.25,
      tickValue: 12.5,
      multiplier: 50,
      cycleMonths: 'HMUZ',
      rollRule: 'expiry-days:8',
      tradingCalendarCode: 'cme-equity-index',
      continuousSymbol: 'ES1!',
      spotSymbol: null,
      nearby: [
        { contract: 'ESZ6', lastTradeUtc: '2026-12-18T00:00:00Z', rollUtc: '2026-12-10T00:00:00Z' },
        { contract: 'ESH7', lastTradeUtc: '2027-03-19T00:00:00Z', rollUtc: '2027-03-11T00:00:00Z' },
      ],
    },
  ];

  it('puts master roots first with their recorded contracts', () => {
    const r = readiness({
      roots: [
        {
          root: '6E',
          exchange: 'CME',
          description: 'Euro FX',
          continuousSymbol: '6E1!',
          rollRule: 'expiry-days:2',
          cycleMonths: 'HMUZ',
          tradingCalendarCode: 'cme-globex',
          spotSymbol: 'EURUSD',
          contracts: 14,
          lastRolled: {
            contract: '6EU6',
            rollUtc: '2026-09-08T00:00:00Z',
            lastTradeUtc: '',
            expiryUtc: '',
            hasCursor: false,
          },
          upcoming: [
            {
              contract: '6EZ6',
              rollUtc: '2026-12-08T00:00:00Z',
              lastTradeUtc: '',
              expiryUtc: '',
              hasCursor: false,
            },
          ],
          continuousStatus: null,
        },
      ],
    });
    const rows = rollRows(r, catalog, NOW);
    expect(rows.map((x) => x.root)).toEqual(['6E', 'ES']);
    expect(rows[0].inMaster).toBe(true);
    expect(rows[0].next).toEqual({ contract: '6EZ6', rollUtc: '2026-12-08T00:00:00Z', days: 41 });
    expect(rows[1].inMaster).toBe(false);
    expect(rows[1].following?.contract).toBe('ESH7');
  });

  it('feeds the next-roll tile', () => {
    const tiles = candleTiles(state(), readiness(), rollRows(null, catalog, NOW), NOW);
    const next = tiles.find((t) => t.label === 'Next futures roll')!;
    expect(next.value).toBe('43 d');
    expect(next.hint).toContain('ESZ6');
    expect(tiles.find((t) => t.label === 'Symbols eligible')!.value).toBe('7,332');
  });

  describe('candleTiles without readiness', () => {
    it('counts candle rows written from the cursors', () => {
      const cursor = {
        id: 1,
        symbol: 'BTC-USD',
        kind: 'Instrument',
        sourceId: 'crypto-coinbase',
        root: null,
        builtFromUtc: null,
        builtToUtc: null,
        status: 'Live',
        note: null,
        barsWritten: 564,
        tradesRead: 1,
        tradesExcluded: 0,
        updatedAtUtc: '',
        lagMinutes: 2,
      };
      const tiles = candleTiles(
        state({ cursors: [cursor, { ...cursor, id: 2, barsWritten: 563 }] }),
        null,
        [],
        NOW,
      );
      expect(tiles.find((t) => t.label === 'Candle rows written')!.value).toBe('1,127');
      expect(tiles.find((t) => t.label === 'Worst lag')!.value).toBe('2 min');
    });
  });
});

describe('workerRequirement', () => {
  const cursor = (updatedAtUtc: string) =>
    ({ symbol: 'BTC-USD', kind: 'Instrument', status: 'Live', updatedAtUtc }) as unknown as InstrumentCandleState['cursors'][number];

  it('is unknown with a plain reason when neither a snapshot nor a cursor exists', () => {
    const w = workerRequirement(state(), readiness({ workerLastSuccessUtc: null }), NOW);
    expect(w.ok).toBeNull();
    expect(w.detail).toContain('No cycle recorded yet');
  });

  it('uses the builder cursor updates when the restart snapshot has no success', () => {
    const w = workerRequirement(
      state(),
      readiness({ workerLastSuccessUtc: null, builderLastCycleUtc: '2026-10-28T11:59:00Z' }),
      NOW,
    );
    expect(w.ok).toBe(true);
    expect(w.detail).toContain('Last cycle 1 min ago');
    expect(w.detail).toContain('cursor updates');
  });

  it('falls back to the state cursors on an engine without builderLastCycleUtc', () => {
    const w = workerRequirement(
      state({ cursors: [cursor('2026-10-28T11:58:00Z')] }),
      readiness({ workerLastSuccessUtc: null }),
      NOW,
    );
    expect(w.ok).toBe(true);
  });

  it('takes the newer of snapshot and cursor evidence and flags a stale worker', () => {
    const stale = workerRequirement(
      state(),
      readiness({ workerLastSuccessUtc: '2026-10-28T10:00:00Z', builderLastCycleUtc: '2026-10-28T10:30:00Z' }),
      NOW,
    );
    expect(stale.ok).toBe(false);
    expect(stale.detail).toContain('No cycle for 90 min');
  });

  it('is not ok while cycles are failing', () => {
    const w = workerRequirement(
      state(),
      readiness({ workerConsecutiveFailures: 3, workerLastError: 'timeout' }),
      NOW,
    );
    expect(w.ok).toBe(false);
    expect(w.detail).toContain('3 failed cycle(s) in a row');
  });
});
