import { describe, expect, it } from 'vitest';

import type { MdSource } from '@core/realtime/marketdata.types';
import type { InstrumentFacts } from '../datafeed/instrument-facts';
import { ladderQuantityText, ladderQuantityTitle, ladderSourceLabel } from './ladder-source';

const src = (kind: string, displayName: string, sourceId: string): MdSource => ({
  sourceId,
  kind,
  displayName,
  feedId: '',
  feeds: {},
  enabled: true,
  sizeUnit: 'Coins',
  contractSize: 1,
  priceTransform: 'None',
  symbolMap: {},
});

const btc = {
  resolving: false,
  origin: 'catalogue',
  quantityUnit: 'Coins',
  quantityDecimals: 4,
  instrument: { baseCurrency: 'BTC' },
} as unknown as InstrumentFacts;
const eurusd = { resolving: false, origin: 'pair', quantityUnit: 'Lots', quantityDecimals: 2, instrument: {} } as unknown as InstrumentFacts;

describe('ladder-source (UF03)', () => {
  it('MT5 words are unchanged', () => {
    expect(ladderSourceLabel('stream', 'mt5-demo', src('Mt5Broker', 'Demo (MT5 broker)', 'mt5-demo'), null)).toBe(
      "Live book from mt5-demo (one broker's MT5 depth, every change) — not the whole market.",
    );
    expect(ladderSourceLabel('stream', 'mt5-demo', null, null)).toBe(
      "Live book from mt5-demo (one broker's MT5 depth, every change) — not the whole market.",
    );
    expect(ladderSourceLabel('poll', null, null, null)).toContain("one broker's MT5 book");
    expect(ladderSourceLabel('none', null, null, null)).toBe('No depth for this symbol.');
  });

  it('a venue book is named as the venue, with its size unit', () => {
    const label = ladderSourceLabel(
      'stream',
      'crypto-coinbase',
      src('CryptoExchange', 'Coinbase Advanced Trade (spot)', 'crypto-coinbase'),
      'BTC',
    );
    expect(label).toBe(
      "Live Coinbase Advanced Trade book (the venue's own L2 depth, every change; sizes in BTC) — one venue, not the whole market.",
    );
    expect(label).not.toContain('MT5');
    expect(ladderSourceLabel('stream', 'cme-6e', src('CmeFutures', 'CME Globex', 'cme-6e'), null)).toContain(
      'sizes in contracts',
    );
    expect(ladderSourceLabel('stream', 'consolidated', null, null)).toContain('Consolidated book');
  });

  it('quantities: MT5 as before, venue at its step with its unit', () => {
    expect(ladderQuantityText(0.1, eurusd)).toBe('0.1');
    expect(ladderQuantityText(0.1, null)).toBe('0.1');
    expect(ladderQuantityText(null, eurusd)).toBe('·');
    expect(ladderQuantityTitle(0.1, eurusd)).toBe('0.1 lots');
    expect(ladderQuantityText(0.015, btc)).toBe('0.0150');
    expect(ladderQuantityTitle(0.015, btc)).toBe('0.0150 BTC');
  });
});
