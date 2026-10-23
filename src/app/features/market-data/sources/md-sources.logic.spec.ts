import { describe, expect, it } from 'vitest';

import {
  badWriters,
  changes,
  formatSymbolMap,
  isEditable,
  isVenueId,
  parseSymbolMap,
  parseWriters,
  readiness,
} from './md-sources.logic';
import type { MarketDataSourceAdmin } from './md-sources.types';

const row = (over: Partial<MarketDataSourceAdmin> = {}): MarketDataSourceAdmin => ({
  sourceId: 'venue-lmax',
  kind: 'FixVenue',
  displayName: 'LMAX',
  feedId: 'venue:lmax',
  enabled: false,
  sizeUnit: 'Units',
  contractSize: 1,
  priceTransform: 'None',
  symbolMap: { EURUSD: '4001' },
  brokerServer: null,
  writerInstanceIds: [],
  createdAtUtc: '2026-10-23T00:00:00Z',
  updatedAtUtc: '2026-10-23T00:00:00Z',
  ...over,
});

describe('market-data sources', () => {
  it('parses writers from lines or commas, sorted and distinct', () => {
    expect(parseWriters(' venue-feed-1\nvenue-feed-2, venue-feed-1 ')).toEqual(['venue-feed-1', 'venue-feed-2']);
    expect(badWriters(['ok-1', 'not ok', 'x'.repeat(129)])).toEqual(['not ok', 'x'.repeat(129)]);
  });

  it('parses and formats a symbol map', () => {
    const { map, problems } = parseSymbolMap('eurusd=4001\nUSDJPY = 4004; bad entry, =x');
    expect(map).toEqual({ EURUSD: '4001', USDJPY: '4004' });
    expect(problems).toEqual(['bad entry', '=x']);
    expect(formatSymbolMap({ USDJPY: '4004', EURUSD: '4001' })).toBe('EURUSD=4001\nUSDJPY=4004');
  });

  it('sends only what changed', () => {
    const r = row();
    expect(changes(r, { enabled: false, displayName: 'LMAX', writers: [], symbolMap: { EURUSD: '4001' }, contractSize: 1 })).toEqual({});
    expect(
      changes(r, { enabled: true, displayName: ' LMAX Global ', writers: ['venue-feed-1'], symbolMap: { EURUSD: '4001', GBPUSD: '4002' }, contractSize: 10_000 }),
    ).toEqual({
      enabled: true,
      displayName: 'LMAX Global',
      writerInstanceIds: ['venue-feed-1'],
      symbolMap: { EURUSD: '4001', GBPUSD: '4002' },
      contractSize: 10_000,
    });
  });

  it('says why a source delivers nothing', () => {
    expect(readiness(row()).text).toMatch(/Disabled/);
    expect(readiness(row({ enabled: true })).tone).toBe('warn');
    expect(readiness(row({ enabled: true, writerInstanceIds: ['venue-feed-1'] })).tone).toBe('ok');
    expect(readiness(row({ kind: 'Mt5Broker', enabled: true })).text).toMatch(/trusted EAs/);
  });

  it('leaves MT5 broker rows to the engine and checks venue ids', () => {
    expect(isEditable({ kind: 'Mt5Broker' })).toBe(false);
    expect(isEditable({ kind: 'CmeFutures' })).toBe(true);
    expect(isVenueId('lmax')).toBe(true);
    expect(isVenueId('LMAX')).toBe(false);
    expect(isVenueId('-lmax')).toBe(false);
  });
});
