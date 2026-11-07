import { describe, expect, it } from 'vitest';

import {
  assetClassOf,
  blackoutModeText,
  calendarDays,
  countByKind,
  coverageRowFrom,
  coverageSummary,
  draftCaveat,
  editExposureList,
  exposureKindOf,
  feedSummary,
  formatMinutes,
  groupKeysByKind,
  invalidExposureTokens,
  isMaskedValue,
  isSecretKey,
  latencyRows,
  newestAgeByKey,
  parseEvalMetrics,
  parseExposureList,
  parseMultiAssetMode,
  parseSearchQueries,
  parseSourceNote,
  pastedKeyTag,
  signed,
  storySampleInstants,
  storyWeightIn,
  untrackedDemand,
  vendorRows,
} from './news-intel.logic';
import { NewsFocusResult, ScheduledMarketEventRow } from './news-intel.types';
import { NewsIntelService } from '@core/services/news-intel.service';

describe('exposure keys', () => {
  it('classifies the key grammar like the engine', () => {
    expect(exposureKindOf('usd')).toBe('Currency');
    expect(exposureKindOf('XAU')).toBe('Commodity');
    expect(exposureKindOf('NATGAS')).toBe('Commodity');
    expect(exposureKindOf('IDX:US500')).toBe('EquityIndex');
    expect(exposureKindOf('EQ:AAPL')).toBe('Equity');
    expect(exposureKindOf('CR:MARKET')).toBe('Crypto');
    expect(exposureKindOf('F:RISK')).toBe('Factor');
    expect(exposureKindOf('IDX:')).toBeNull();
    expect(exposureKindOf('EURUSD')).toBeNull();
    expect(exposureKindOf('')).toBeNull();
  });

  it('parses a tracked list: valid, upper-case, de-duplicated, in order', () => {
    expect(parseExposureList('usd, eur  XAU,usd,bogus1,IDX:US500')).toEqual(['USD', 'EUR', 'XAU', 'IDX:US500']);
    expect(invalidExposureTokens('USD,bogus1, EQ:')).toEqual(['bogus1', 'EQ:']);
  });

  it('adds and removes keys without disturbing the order', () => {
    expect(editExposureList(['USD', 'EUR'], ['wti', 'USD', 'nope!'], ['eur'])).toBe('USD,WTI');
  });

  it('groups keys in the classifier prompt order', () => {
    expect(groupKeysByKind(['F:RISK', 'USD', 'EQ:AAPL', 'XAU'])).toEqual([
      { kind: 'Currency', keys: ['USD'] },
      { kind: 'Commodity', keys: ['XAU'] },
      { kind: 'Equity', keys: ['EQ:AAPL'] },
      { kind: 'Factor', keys: ['F:RISK'] },
    ]);
  });
});

describe('asset class', () => {
  it('reads the leg the symbol is', () => {
    expect(assetClassOf([{ key: 'EUR', weight: 1, basis: 'base' }, { key: 'USD', weight: -1, basis: 'quote' }])).toBe('FX');
    expect(assetClassOf([{ key: 'XAU', weight: 1, basis: 'base' }, { key: 'USD', weight: -1, basis: 'quote' }])).toBe('Metal');
    expect(assetClassOf([{ key: 'WTI', weight: 1, basis: 'own' }, { key: 'F:RISK', weight: 0.2, basis: 'factor:static' }])).toBe('Energy');
    expect(assetClassOf([{ key: 'EQ:AAPL', weight: 1, basis: 'own' }])).toBe('Stock');
    expect(assetClassOf([{ key: 'IDX:US500', weight: 1, basis: 'own' }])).toBe('Index');
    expect(assetClassOf([{ key: 'CR:BTC', weight: 1, basis: 'own' }])).toBe('Crypto');
    expect(assetClassOf([])).toBe('Unplaced');
  });
});

const aaplFocus: NewsFocusResult = {
  context: {
    baseLeg: null,
    quoteLeg: null,
    pairBias: null,
    asOfNote: '',
    paramsFingerprint: 'fp',
    multiLeg: true,
    coverage: 0.4,
    symbolBias: null,
    legs: [
      { key: 'EQ:AAPL', weight: 1, basis: 'own', covered: false, score: null, contribution: null, absolutePressure: null, storyCount: null },
      { key: 'USD', weight: 0.5, basis: 'factor:static', covered: true, score: 0.2, contribution: 0.1, absolutePressure: 0.3, storyCount: 2 },
    ],
  },
  includedInPrompt: false,
  omissionReason: 'own leg untracked',
  baseCurrency: 'EQ:AAPL',
  quoteCurrency: null,
  exposure: {
    symbol: 'AAPL',
    legs: [
      { key: 'EQ:AAPL', weight: 1, basis: 'own' },
      { key: 'USD', weight: 0.5, basis: 'factor:static' },
    ],
    calendarKeys: ['usd', 'EQ:AAPL'],
    source: 'catalogue',
  },
};

describe('coverage', () => {
  it('uses the engine\'s coverage and covered flags, never zero for an untracked leg', () => {
    const row = coverageRowFrom('AAPL', aaplFocus, new Set(['EQ:AAPL']), new Map([['USD', 42]]));
    expect(row.assetClass).toBe('Stock');
    expect(row.coverage).toBe(0.4);
    expect(row.symbolBias).toBeNull();
    expect(row.legs[0]).toMatchObject({ key: 'EQ:AAPL', covered: false, score: null, newestAgeMinutes: null });
    expect(row.legs[1]).toMatchObject({ key: 'USD', covered: true, score: 0.2, newestAgeMinutes: 42 });
    expect(row.calendarKeys).toEqual(['USD', 'EQ:AAPL']);
    expect(row.modeGovernedKeys).toEqual(['EQ:AAPL']);
    expect(row.newestAgeMinutes).toBe(42);
  });

  it('falls back to the tracked list and a computed share for an engine without legs', () => {
    const f: NewsFocusResult = { ...aaplFocus, context: { ...aaplFocus.context!, legs: null, coverage: null } };
    const row = coverageRowFrom('AAPL', f, new Set(['EQ:AAPL']));
    expect(row.legs.map((l) => l.covered)).toEqual([true, false]);
    expect(row.coverage).toBeCloseTo(1 / 1.5);
  });

  it('marks a failed or unplaced symbol instead of inventing legs', () => {
    expect(coverageRowFrom('ZZZ', null, new Set(), new Map(), 'focus failed').problem).toBe('focus failed');
    const unplaced = coverageRowFrom('ZZZ', { ...aaplFocus, context: null, exposure: null }, new Set());
    expect(unplaced.problem).toMatch(/cannot place/);
    expect(unplaced.coverage).toBeNull();
  });

  it('summarises and ranks untracked demand', () => {
    const a = coverageRowFrom('AAPL', aaplFocus, new Set());
    const b = coverageRowFrom('MSFT', { ...aaplFocus, exposure: { ...aaplFocus.exposure!, legs: [{ key: 'EQ:MSFT', weight: 1, basis: 'own' }, { key: 'USD', weight: 0.5, basis: 'factor:static' }] }, context: null }, new Set(['USD']));
    const s = coverageSummary([a, b]);
    expect(s).toMatchObject({ symbols: 2, partlyCovered: 2, fullyCovered: 0, withModeGovernedKeys: 2 });
    expect(untrackedDemand([a, b])[0]).toEqual({ key: 'EQ:AAPL', symbols: 1 });
  });

  it('takes the youngest weighted contributor per key', () => {
    const m = newestAgeByKey([{ currency: 'usd', topContributors: [{ ageMinutes: 90.4 }, { ageMinutes: 12.6 }] }, { currency: 'EUR', topContributors: [] }]);
    expect(m.get('USD')).toBe(13);
    expect(m.has('EUR')).toBe(false);
  });
});

describe('multi-asset blackout mode', () => {
  it('reads like the engine: only enforce blocks, unknown is Observe', () => {
    expect(parseMultiAssetMode('ENFORCE')).toBe('Enforce');
    expect(parseMultiAssetMode('off')).toBe('Off');
    expect(parseMultiAssetMode(null)).toBe('Observe');
    expect(parseMultiAssetMode('maybe')).toBe('Observe');
  });

  it('says the mode is not read for a currency-only calendar', () => {
    expect(blackoutModeText('Enforce', [])).toMatch(/not read/);
    expect(blackoutModeText('Observe', ['EQ:AAPL'])).toMatch(/would block/);
    expect(blackoutModeText('Enforce', ['EQ:AAPL'])).toMatch(/refuse/);
  });
});

describe('config helpers', () => {
  it('mirrors the engine secret-key rule', () => {
    expect(isSecretKey('NewsIntel:Vendor:Polygon:ApiKey')).toBe(true);
    expect(isSecretKey('NewsIntel:Ingest:SecUserAgent')).toBe(false);
    expect(isMaskedValue('***SET')).toBe(true);
    expect(isMaskedValue('abc')).toBe(false);
  });

  it('reads search queries tolerantly', () => {
    expect(parseSearchQueries('{"usd":"Fed","n":1}')).toEqual({ USD: 'Fed' });
    expect(parseSearchQueries('not json')).toEqual({});
    expect(parseSearchQueries('[1]')).toEqual({});
  });

  it('derives vendor rows and flags enabled-without-key', () => {
    const rows = vendorRows([
      { key: 'NewsIntel:Vendor:Polygon:Enabled', value: 'true', dataType: 'Bool', description: null, isHotReloadable: true },
      { key: 'NewsIntel:Vendor:Polygon:ApiKey', value: '***UNSET', dataType: 'String', description: null, isHotReloadable: true },
      { key: 'NewsIntel:Vendor:Finnhub:ApiKey', value: '***SET', dataType: 'String', description: null, isHotReloadable: true },
    ]);
    expect(rows.find((r) => r.name === 'Polygon')).toMatchObject({ enabled: true, keyState: 'unset', blocked: true });
    expect(rows.find((r) => r.name === 'Finnhub')).toMatchObject({ enabled: null, keyState: 'set', blocked: false });
    expect(rows.find((r) => r.name === 'Benzinga')).toMatchObject({ keyState: 'unknown' });
  });

  it('never echoes a pasted key back', () => {
    expect(pastedKeyTag('abcdefghijklmnop')).toBe('…mnop (16 characters)');
    expect(pastedKeyTag('short')).toBe('5 characters');
  });

  it('puts the bare Exposures key and the new prefixes in their own sections', () => {
    const e = (key: string) => ({ key, value: '', dataType: 'String', description: null, isHotReloadable: true });
    const groups = NewsIntelService.groupConfig([
      e('NewsIntel:Enabled'),
      e('NewsIntel:Exposures'),
      e('NewsIntel:Exposures:Recommended'),
      e('NewsIntel:Vendor:Polygon:ApiKey'),
      e('NewsIntel:Calendar:Enabled'),
      e('NewsIntel:Story:Mode'),
      e('NewsIntel:Eval:MaxArticles'),
    ]);
    const titleOf = (key: string) => groups.find((g) => g.entries.some((x) => x.key === key))?.title;
    expect(titleOf('NewsIntel:Enabled')).toBe('Module');
    expect(titleOf('NewsIntel:Exposures')).toBe('Exposures');
    expect(titleOf('NewsIntel:Exposures:Recommended')).toBe('Exposures');
    expect(titleOf('NewsIntel:Vendor:Polygon:ApiKey')).toBe('Paid news vendors');
    expect(titleOf('NewsIntel:Calendar:Enabled')).toBe('Scheduled market events');
    expect(titleOf('NewsIntel:Story:Mode')).toBe('Stories');
    expect(titleOf('NewsIntel:Eval:MaxArticles')).toBe('Evaluation');
  });
});

describe('sources', () => {
  it('joins 24 h and 7 d latency rows, slowest first', () => {
    const { channels, publishers } = latencyRows([
      { channel: 'Rss', source: null, windowHours: 24, count: 10, p50Minutes: 18, p90Minutes: 60 },
      { channel: 'Rss', source: null, windowHours: 168, count: 70, p50Minutes: 20, p90Minutes: 70 },
      { channel: 'Search', source: null, windowHours: 168, count: 300, p50Minutes: 70, p90Minutes: 1020 },
      { channel: 'Rss', source: 'Reuters', windowHours: 24, count: 5, p50Minutes: 9, p90Minutes: 30 },
    ]);
    expect(channels.map((c) => c.channel)).toEqual(['Search', 'Rss']);
    expect(channels[1].day?.p50).toBe(18);
    expect(channels[1].week?.p90).toBe(70);
    expect(channels[0].day).toBeNull();
    expect(publishers).toHaveLength(1);
  });

  it('formats lags compactly', () => {
    expect(formatMinutes(18)).toBe('18m');
    expect(formatMinutes(70)).toBe('1h 10m');
    expect(formatMinutes(1020)).toBe('17h');
    expect(formatMinutes(60 * 51)).toBe('2d 3h');
    expect(formatMinutes(null)).toBe('—');
  });

  it('summarises conditional GET at the last poll', () => {
    const s = feedSummary([
      { url: 'a', lastStatus: 304, lastPolledUtc: '', notModifiedStreak: 3, hasValidators: true },
      { url: 'b', lastStatus: 200, lastPolledUtc: '', notModifiedStreak: 0, hasValidators: false },
      { url: 'c', lastStatus: 403, lastPolledUtc: '', notModifiedStreak: 0, hasValidators: false },
    ]);
    expect(s).toEqual({ feeds: 3, withValidators: 1, lastNotModified: 1, hitRate: 1 / 3, failing: 1 });
    expect(feedSummary([]).hitRate).toBeNull();
  });

  it('splits a source note into subject and sentence', () => {
    expect(parseSourceNote('sec-edgar: OFF — set NewsIntel:Ingest:SecUserAgent')).toEqual({
      subject: 'sec-edgar',
      text: 'OFF — set NewsIntel:Ingest:SecUserAgent',
    });
  });
});

describe('scheduled events', () => {
  const ev = (id: number, at: string, key: string, kind: string, impact = 'High'): ScheduledMarketEventRow => ({
    id, exposureKey: key, kind, scheduledAtUtc: at, impact, title: `${kind} ${key}`, source: 's', firstSeenUtc: at, notes: null, actual: null,
  });
  const events = [
    ev(2, '2026-11-09T21:05:00Z', 'EQ:AAPL', 'Earnings', 'Medium'),
    ev(1, '2026-11-09T15:30:00Z', 'WTI', 'Inventories'),
    ev(3, '2026-11-10T15:30:00Z', 'NATGAS', 'Inventories'),
  ];

  it('groups by UTC day in time order and filters', () => {
    const days = calendarDays(events);
    expect(days.map((d) => d.day)).toEqual(['2026-11-09', '2026-11-10']);
    expect(days[0].events.map((e) => e.id)).toEqual([1, 2]);
    expect(calendarDays(events, { exposureKind: 'Equity' })).toHaveLength(1);
    expect(calendarDays(events, { highOnly: true }).flatMap((d) => d.events)).toHaveLength(2);
    expect(countByKind(events)[0]).toEqual({ kind: 'Inventories', count: 2 });
  });
});

describe('stories', () => {
  it('samples instants inside the story life, never in the future', () => {
    const now = new Date('2026-11-07T12:00:00Z');
    const pts = storySampleInstants({ firstSeenUtc: '2026-11-07T08:00:00Z', lastSeenUtc: '2026-11-07T10:00:00Z' }, now, 4);
    expect(pts).toHaveLength(4);
    expect(pts[3]).toBe('2026-11-07T12:00:00.000Z');
    expect(pts.every((p) => Date.parse(p) <= now.getTime())).toBe(true);
  });

  it('sums a story\'s contribution across keys', () => {
    const r = storyWeightIn(
      [
        { currency: 'USD', asOfUtc: '', weightedScore: 0, absolutePressure: 0, articleCount: 0, storyCount: 0, dominantCategory: null, paramsFingerprint: '',
          topContributors: [
            { articleId: 1, title: 'a', sourceName: null, currency: 'USD', ageMinutes: 1, weight: 0.4, signedWeight: -0.4, storyId: 7 },
            { articleId: 2, title: 'b', sourceName: null, currency: 'USD', ageMinutes: 1, weight: 0.2, signedWeight: 0.2, storyId: 8 },
          ] },
        { currency: 'EUR', asOfUtc: '', weightedScore: 0, absolutePressure: 0, articleCount: 0, storyCount: 0, dominantCategory: null, paramsFingerprint: '',
          topContributors: [{ articleId: 1, title: 'a', sourceName: null, currency: 'EUR', ageMinutes: 1, weight: 0.1, signedWeight: 0.1, storyId: 7 }] },
      ],
      7,
    );
    expect(r.total).toBeCloseTo(0.5);
    expect(r.signed).toBeCloseTo(-0.3);
    expect(r.members).toHaveLength(2);
  });
});

describe('evaluation metrics', () => {
  it('reads PascalCase records inside the camelCase envelope', () => {
    const json = JSON.stringify({
      trackedKeys: ['USD'],
      reviewedOnly: false,
      draftShare: 0.9,
      passes: [
        {
          Articles: 80, ArticlesWithVerdict: 78,
          Relevance: { TruePositive: 50, FalsePositive: 10, FalseNegative: 2, TrueNegative: 16, Precision: 0.8333, Recall: 0.9615, F1: 0.8929 },
          ExposurePairs: null,
          Category: { Pairs: 40, Accuracy: 0.7, MacroF1: 0.6, PerClassF1: { Inflation: 0.8 } },
          Direction: null, Certainty: null, RelevanceMae: 0.12, StanceAccuracy: null, SameEventPairs: null,
        },
      ],
      agreement: { Articles: 78, Relevance: 0.97, ExposureSet: 0.9, CategoryAndDirection: 0.85, Overall: 0.88 },
      triage: null,
    });
    const m = parseEvalMetrics(json)!;
    expect(m.passes[0].relevance?.f1).toBe(0.8929);
    expect(m.passes[0].relevance?.tp).toBe(50);
    expect(m.passes[0].category?.perClassF1).toEqual({ Inflation: 0.8 });
    expect(m.agreement?.overall).toBe(0.88);
    expect(m.draftShare).toBe(0.9);
    expect(parseEvalMetrics('{bad')).toBeNull();
    expect(parseEvalMetrics(null)).toBeNull();
  });

  it('warns when graded against agent drafts', () => {
    expect(draftCaveat({ draftLabelCount: 10, articleCount: 80 }, 0.9)).toMatch(/90%/);
    expect(draftCaveat({ draftLabelCount: 0, articleCount: 80 }, 0)).toBeNull();
  });

  it('formats signed numbers with a real minus', () => {
    expect(signed(-0.0451)).toBe('−0.045');
    expect(signed(0.1)).toBe('+0.100');
    expect(signed(null)).toBe('—');
  });
});
