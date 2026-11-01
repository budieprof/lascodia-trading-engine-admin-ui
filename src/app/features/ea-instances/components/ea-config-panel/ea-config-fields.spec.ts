import { describe, expect, it } from 'vitest';

import {
  HOT_RELOAD_FIELDS,
  formatSymbolMap,
  isPrivateHost,
  normalizeTimeframes,
  parseSymbolCsv,
  parseSymbolMap,
  sameSymbolSet,
  validateField,
  type FieldDef,
} from './ea-config-fields';

const field = (key: string): FieldDef => HOT_RELOAD_FIELDS.find((f) => f.key === key)!;

describe('ea-config-fields', () => {
  it('keeps every setting key once', () => {
    const keys = HOT_RELOAD_FIELDS.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBe(51);
  });

  it('parses a symbol CSV the way the EA does', () => {
    expect(parseSymbolCsv(' eurusd, GBPUSD,,eurusd ')).toEqual(['EURUSD', 'GBPUSD']);
    expect(parseSymbolCsv(null)).toEqual([]);
    expect(sameSymbolSet(['A1', 'B2'], ['B2', 'A1'])).toBe(true);
    expect(sameSymbolSet(['A1'], ['A1', 'B2'])).toBe(false);
  });

  it('round-trips the broker → engine symbol map', () => {
    const rows = parseSymbolMap('EURUSDm=eurusd, XAUUSD.spot=XAUUSD');
    expect(rows).toEqual([
      { broker: 'EURUSDm', engine: 'EURUSD' },
      { broker: 'XAUUSD.spot', engine: 'XAUUSD' },
    ]);
    expect(formatSymbolMap([...rows, { broker: 'X', engine: '' }])).toBe(
      'EURUSDm=EURUSD,XAUUSD.spot=XAUUSD',
    );
  });

  it('normalises timeframes to MT5 order and drops unknown ones', () => {
    expect(normalizeTimeframes('h1, m5,BAD,D1')).toEqual(['M5', 'H1', 'D1']);
  });

  it('validates numbers against kind and range', () => {
    expect(validateField(field('signalPollSec'), 'abc')).toBe('Enter a number.');
    expect(validateField(field('signalPollSec'), '1.5')).toBe('Enter a whole number.');
    expect(validateField(field('heartbeatSec'), '2')).toBe('At least 5.');
    expect(validateField(field('specRefreshHour'), '24')).toBe('At most 23.');
    expect(validateField(field('maxLotPerOrder'), '0.5')).toBeNull();
  });

  it('requires https for a public engine address', () => {
    const f = field('engineBaseUrl');
    expect(validateField(f, 'http://app.example.com/api')).toBe(
      'Public addresses must use https://.',
    );
    expect(validateField(f, 'http://192.168.1.20:5081/api')).toBeNull();
    expect(validateField(f, 'https://app.example.com/api')).toBeNull();
    expect(validateField(f, 'example.com')).toMatch(/full address/);
    expect(isPrivateHost('172.20.0.1')).toBe(true);
    expect(isPrivateHost('172.40.0.1')).toBe(false);
  });

  it('refuses an empty or malformed symbol list', () => {
    const f = field('symbols');
    expect(validateField(f, ' , ')).toBe('Keep at least one symbol.');
    expect(validateField(f, 'EURUSD,EUR USD')).toMatch(/not a valid symbol/);
    expect(validateField(f, 'EURUSD,XAUUSD.spot')).toBeNull();
  });
});
