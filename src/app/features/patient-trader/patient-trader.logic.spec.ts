import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PATIENT_TRADER_CONFIG,
  PatientTraderConfig,
  PatientTraderMarketHealth,
} from './patient-trader.types';
import {
  EMPTY_PLAN_FILTERS,
  boardQuery,
  boardQueryString,
  catalystLines,
  codeWords,
  effectiveMode,
  filtersFromParams,
  filtersToParams,
  formatR,
  isConfigDirty,
  isCustomInstruction,
  linePath,
  marketHealthState,
  newlyLiveMarkets,
  normaliseScenario,
  outcomeWords,
  parseOutcome,
  planRewardRisk,
  refusalStage,
  relativeTime,
  scenarioRows,
  summariseOutcome,
  toPips,
  toSavePayload,
  withInstructionShown,
} from './patient-trader.logic';

const cfg = (over: Partial<PatientTraderConfig> = {}): PatientTraderConfig => ({
  ...DEFAULT_PATIENT_TRADER_CONFIG,
  ...over,
});

describe('outcomes', () => {
  it('parses tolerantly', () => {
    expect(parseOutcome(null)).toBeNull();
    expect(parseOutcome('not json')).toBeNull();
    expect(parseOutcome('[1,2]')).toBeNull();
    expect(parseOutcome('{"outcome":"HitTP","rMultiple":2}')?.rMultiple).toBe(2);
  });

  it('puts outcome codes into plain words', () => {
    expect(outcomeWords('HitTP')).toBe('hit target');
    expect(outcomeWords('HitSL')).toBe('hit stop');
    expect(outcomeWords('BreakEven')).toBe('stopped at break-even');
    expect(outcomeWords('EntryNotReached')).toBe('entry never reached');
    expect(outcomeWords('SomethingNew')).toBe('something new');
    expect(outcomeWords(null)).toBe('');
  });

  it('summarises a real trade with its as-written counterpart', () => {
    const s = summariseOutcome(
      JSON.stringify({
        outcome: 'BreakEven',
        rMultiple: 0.02,
        mfeR: 1.4,
        source: 'trade',
        asWritten: { outcome: 'HitTP', rMultiple: 2, mfeR: 2.1 },
      }),
    );
    expect(s).toMatchObject({
      label: 'stopped at break-even',
      r: 0.02,
      bestR: 1.4,
      isTrade: true,
      isReplay: false,
      asWritten: 'as written: hit target +2.00R',
    });
  });

  it('marks a refused card replay as a replay and keeps no as-written line', () => {
    const s = summariseOutcome(
      JSON.stringify({
        outcome: 'HitSL',
        rMultiple: -1,
        source: 'replay',
        forgone: true,
        from: 'fire',
        asWritten: { outcome: 'HitSL' },
      }),
    );
    expect(s?.isReplay).toBe(true);
    expect(s?.asWritten).toBeNull();
  });

  it('is null for an empty blob', () => {
    expect(summariseOutcome('{}')).toBeNull();
  });

  it('formats R with a sign', () => {
    expect(formatR(1.234)).toBe('+1.23R');
    expect(formatR(-0.5)).toBe('-0.50R');
    expect(formatR(0)).toBe('0.00R');
    expect(formatR(null)).toBe('—');
  });
});

describe('scenarios', () => {
  it('renders an Assistant wake level with its price, direction and probability', () => {
    const rows = scenarioRows(
      JSON.stringify([
        {
          trigger: 'Break of the Asia high',
          direction: 'Up',
          watch: { op: 'above', value: 1.085 },
          probability: 0.6,
        },
      ]),
    );
    expect(rows).toEqual([
      {
        kind: 'level',
        text: 'Break of the Asia high',
        level: 'above 1.085',
        direction: 'Up',
        probability: 0.6,
        expectedReaction: null,
        myAction: null,
        invalidation: null,
      },
    ]);
  });

  it('maps symbolic operators to words', () => {
    expect(normaliseScenario({ watch: { op: '<=', value: 1.07 } })?.level).toBe('below 1.07');
  });

  it('keeps the Classic reaction shape', () => {
    const row = normaliseScenario({
      trigger: 'NFP beat',
      expectedReaction: 'USD bid',
      myAction: 'sell the rally',
      invalidation: 'close above 1.09',
    });
    expect(row).toMatchObject({
      kind: 'reaction',
      text: 'NFP beat',
      expectedReaction: 'USD bid',
      myAction: 'sell the rally',
      invalidation: 'close above 1.09',
      level: null,
    });
  });

  it('drops empty entries and survives junk', () => {
    expect(scenarioRows('[{}, null, 3]')).toEqual([]);
    expect(scenarioRows('nope')).toEqual([]);
    expect(scenarioRows(null)).toEqual([]);
  });
});

describe('modes and the Live check', () => {
  it('never lets a market go further than the module', () => {
    expect(effectiveMode('PlanOnly', { mode: 'Live' })).toBe('PlanOnly');
    expect(effectiveMode('Live', { mode: 'PlanOnly' })).toBe('PlanOnly');
    expect(effectiveMode('Live', { mode: null })).toBe('Live');
    expect(effectiveMode('ForecastOnly', undefined)).toBe('ForecastOnly');
  });

  const eur = { symbol: 'EURUSD', timeframe: 'H1', enabled: true, mode: null };
  const gbp = { symbol: 'GBPUSD', timeframe: 'H1', enabled: true, mode: null };

  it('names every market when the module goes Live', () => {
    const before = cfg({ enabled: true, mode: 'PlanOnly', markets: [eur, gbp] });
    const after = cfg({ enabled: true, mode: 'Live', markets: [eur, gbp] });
    expect(newlyLiveMarkets(before, after)).toEqual(['EURUSD', 'GBPUSD']);
  });

  it('excludes a market held back by its own mode', () => {
    const before = cfg({ enabled: true, mode: 'PlanOnly', markets: [eur, gbp] });
    const after = cfg({
      enabled: true,
      mode: 'Live',
      markets: [eur, { ...gbp, mode: 'PlanOnly' }],
    });
    expect(newlyLiveMarkets(before, after)).toEqual(['EURUSD']);
  });

  it('catches switching on while Live, and adding a market to a Live module', () => {
    const off = cfg({ enabled: false, mode: 'Live', markets: [eur] });
    const on = cfg({ enabled: true, mode: 'Live', markets: [eur] });
    expect(newlyLiveMarkets(off, on)).toEqual(['EURUSD']);
    expect(newlyLiveMarkets(on, cfg({ enabled: true, mode: 'Live', markets: [eur, gbp] }))).toEqual(
      ['GBPUSD'],
    );
  });

  it('catches a market releasing its own hold under a Live module', () => {
    const before = cfg({ enabled: true, mode: 'Live', markets: [{ ...eur, mode: 'PlanOnly' }] });
    const after = cfg({ enabled: true, mode: 'Live', markets: [eur] });
    expect(newlyLiveMarkets(before, after)).toEqual(['EURUSD']);
  });

  it('is empty when nothing new goes Live', () => {
    const live = cfg({ enabled: true, mode: 'Live', markets: [eur] });
    expect(newlyLiveMarkets(live, { ...live, viewIntervalMinutes: 60 })).toEqual([]);
    expect(newlyLiveMarkets(live, { ...live, enabled: false })).toEqual([]);
  });
});

describe('dirty check', () => {
  const base = withInstructionShown(
    cfg({ version: 'v1', defaultAnalysisInstruction: 'Read {symbol}.', analysisInstruction: '' }),
  );

  it('is clean for an equal copy whatever the key order', () => {
    const reordered = JSON.parse(JSON.stringify(base, Object.keys(base).reverse()));
    expect(isConfigDirty(base, { ...reordered, markets: [] })).toBe(false);
  });

  it('ignores engine-owned fields', () => {
    expect(isConfigDirty(base, { ...base, version: 'v2', defaultAnalysisInstruction: 'x' })).toBe(
      false,
    );
  });

  it('treats a missing market mode as module mode', () => {
    const a = { ...base, markets: [{ symbol: 'EURUSD', timeframe: 'H1', enabled: true }] };
    const b = {
      ...base,
      markets: [{ symbol: 'EURUSD', timeframe: 'H1', enabled: true, mode: null }],
    };
    expect(isConfigDirty(a, b)).toBe(false);
  });

  it('is dirty on a real edit', () => {
    expect(isConfigDirty(base, { ...base, maxPlansPerDay: 9 })).toBe(true);
    expect(isConfigDirty(base, { ...base, spendCapCountsNotional: true })).toBe(true);
  });

  it('is never dirty without both sides', () => {
    expect(isConfigDirty(null, base)).toBe(false);
  });

  it('shows the built-in instruction and spots a custom one', () => {
    expect(base.analysisInstruction).toBe('Read {symbol}.');
    expect(isCustomInstruction(base)).toBe(false);
    expect(isCustomInstruction({ ...base, analysisInstruction: 'Something else' })).toBe(true);
  });

  it('builds a save payload with version and normalised symbols', () => {
    const p = toSavePayload({
      ...base,
      markets: [
        { symbol: ' eurusd ', timeframe: 'H1', enabled: true },
        { symbol: '  ', timeframe: 'H1', enabled: true },
      ],
    });
    expect(p.version).toBe('v1');
    expect(p.defaultAnalysisInstruction).toBeUndefined();
    expect(p.markets).toEqual([{ symbol: 'EURUSD', timeframe: 'H1', enabled: true, mode: null }]);
  });
});

describe('formatters', () => {
  it('converts price distances to pips', () => {
    expect(toPips(0.0015, 0.0001)).toBe('15.0');
    expect(toPips(0.25, 0.01)).toBe('25.0');
    expect(toPips(0, 0.0001)).toBe('—');
    expect(toPips(0.001, 0)).toBe('—');
    expect(toPips(null, 0.0001)).toBe('—');
  });

  it('writes relative times', () => {
    const now = Date.parse('2026-11-25T12:00:00Z');
    expect(relativeTime('2026-11-25T11:59:40Z', now)).toBe('just now');
    expect(relativeTime('2026-11-25T11:48:00Z', now)).toBe('12m ago');
    expect(relativeTime('2026-11-25T15:05:00Z', now)).toBe('in 3h 05m');
    expect(relativeTime('2026-11-25T14:00:00Z', now)).toBe('in 2h');
    expect(relativeTime('2026-11-21T12:00:00Z', now)).toBe('4d ago');
    expect(relativeTime(null, now)).toBe('—');
    expect(relativeTime('garbage', now)).toBe('—');
  });

  it('puts codes into words', () => {
    expect(codeWords('StopTooTight')).toBe('stop too tight');
    expect(codeWords('news_blackout')).toBe('news blackout');
  });

  it('splits upcoming releases into lines', () => {
    expect(catalystLines('- 13:30 US CPI\n\n• 15:00 ISM\r\n')).toEqual([
      '13:30 US CPI',
      '15:00 ISM',
    ]);
    expect(catalystLines(null)).toEqual([]);
  });

  it('scales a series into a path with a zero line', () => {
    const p = linePath([0, 1, -1], 100, 20, 0);
    expect(p?.d).toBe('M0.0,10.0 L50.0,0.0 L100.0,20.0');
    expect(p?.zeroY).toBe(10);
    expect(linePath([1], 100, 20)).toBeNull();
  });
});

describe('plans', () => {
  it('says when a refusal happened', () => {
    expect(refusalStage({ status: 'Rejected', refusedBeforeArming: true })).toBe(
      'refused before arming',
    );
    expect(refusalStage({ status: 'Rejected', refusedBeforeArming: false })).toBe(
      'refused when it fired',
    );
    expect(refusalStage({ status: 'Declined' })).toBeNull();
  });

  it('derives reward:risk from the levels when it is missing', () => {
    expect(planRewardRisk({ rewardRisk: 2.5, entryPrice: 1, stopLoss: 0.9, takeProfit: 1.2 })).toBe(
      2.5,
    );
    expect(
      planRewardRisk({ rewardRisk: 0, entryPrice: 1.1, stopLoss: 1.09, takeProfit: 1.13 }),
    ).toBeCloseTo(3);
    expect(planRewardRisk({ rewardRisk: 0, entryPrice: 0, stopLoss: 0, takeProfit: 0 })).toBeNull();
  });
});

describe('plan filters in the URL', () => {
  it('round-trips', () => {
    const f = {
      status: ['Armed', 'Rejected'],
      direction: 'Buy',
      rejectionCode: 'StopTooTight',
      symbol: 'EURUSD',
      page: 2,
    };
    const params = filtersToParams(f);
    expect(filtersFromParams((n) => params[n] ?? null)).toEqual(f);
  });

  it('clears params for empty filters and tolerates junk', () => {
    expect(Object.values(filtersToParams(EMPTY_PLAN_FILTERS)).every((v) => v === null)).toBe(true);
    expect(
      filtersFromParams((n) => (n === 'ppage' ? '-3' : n === 'psym' ? ' gbpusd ' : null)),
    ).toEqual({ ...EMPTY_PLAN_FILTERS, symbol: 'GBPUSD' });
  });

  it('builds the board request; an OCO focus overrides the filters', () => {
    const f = { ...EMPTY_PLAN_FILTERS, status: ['Armed'], page: 1 };
    expect(boardQueryString(boardQuery(f, 50, null))).toBe('limit=50&offset=50&status=Armed');
    expect(boardQueryString(boardQuery(f, 50, 'oco-1'))).toBe('limit=200&ocoGroupId=oco-1');
  });
});

describe('market health', () => {
  const now = Date.parse('2026-11-25T12:00:00Z');
  const h = {
    enabled: true,
    killSwitchActive: false,
    respectKillSwitch: true,
    spend: {
      paidToday: 0,
      notionalToday: 0,
      dailyCapUsd: 5,
      perMarketCapUsd: 1.5,
      capCountsNotional: false,
      countedToday: 0,
      dailyCapReached: false,
    },
  };
  const m = (over: Partial<PatientTraderMarketHealth> = {}): PatientTraderMarketHealth => ({
    symbol: 'EURUSD',
    timeframe: 'H1',
    mode: 'PlanOnly',
    ownMode: false,
    lastViewAtUtc: '2026-11-25T10:00:00Z',
    lastViewTrigger: 'cadence',
    nextDueAtUtc: '2026-11-25T14:00:00Z',
    lastRunWithoutViewAtUtc: null,
    lastRunWithoutViewSessionId: null,
    closedUntilUtc: null,
    closedReason: null,
    blackoutUntilUtc: null,
    blackoutTitle: null,
    upcomingCatalysts: null,
    armedCards: 0,
    paidToday: 0,
    notionalToday: 0,
    marketCapReached: false,
    limits: null,
    ...over,
  });

  it('is ok when running on time', () => {
    expect(marketHealthState(m(), h, now).state).toBe('ok');
  });

  it('flags a run that wrote no view after the last view as stuck', () => {
    expect(
      marketHealthState(m({ lastRunWithoutViewAtUtc: '2026-11-25T11:00:00Z' }), h, now).state,
    ).toBe('stuck');
    expect(
      marketHealthState(m({ lastRunWithoutViewAtUtc: '2026-11-25T09:00:00Z' }), h, now).state,
    ).toBe('ok');
  });

  it('explains a pause before calling anything overdue', () => {
    const late = { nextDueAtUtc: '2026-11-25T10:00:00Z' };
    expect(marketHealthState(m(late), h, now).state).toBe('overdue');
    expect(
      marketHealthState(m({ ...late, closedUntilUtc: '2026-11-26T00:00:00Z' }), h, now).reason,
    ).toBe('market closed');
    expect(
      marketHealthState(m({ ...late, blackoutUntilUtc: '2026-11-25T12:30:00Z' }), h, now).reason,
    ).toBe('news blackout');
    expect(marketHealthState(m(late), { ...h, killSwitchActive: true }, now).reason).toBe(
      'kill switch on',
    );
    expect(marketHealthState(m(late), { ...h, enabled: false }, now).state).toBe('off');
  });
});
