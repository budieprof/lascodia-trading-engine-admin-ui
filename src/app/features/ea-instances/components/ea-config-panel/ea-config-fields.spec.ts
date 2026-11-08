import { describe, expect, it } from 'vitest';

import {
  HOT_RELOAD_FIELDS,
  buildConfigBody,
  buildDisableDailyLossPerSymbolBody,
  buildGapFillPatch,
  gapFillState,
  validateGapFillMaxAge,
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
    expect(keys.length).toBe(44); // W3d: 7 inputs EA 8.47.292 deleted are gone
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

  // ── Batch 8: the request builder never sends what the operator did not set ──

  const ID = 'LASC-EURUSD-1';
  const fields = (...keys: string[]) => keys.map(field);

  it('sends only the edited settings — never a default, a blank or an unchanged neighbour', () => {
    const body = buildConfigBody(ID, fields('maxDailyLossPerSymbolPct'), {
      maxDailyLossPerSymbolPct: '2',
    });
    expect(body).toEqual({ instanceId: ID, maxDailyLossPerSymbolPct: 2 });
    expect(JSON.stringify(body)).toBe(`{"instanceId":"${ID}","maxDailyLossPerSymbolPct":2}`);

    // Edits for keys that are not in the push list are ignored (row Save pushes one setting).
    expect(
      buildConfigBody(ID, fields('signalPollSec'), { signalPollSec: '3', maxLotPerOrder: '1' }),
    ).toEqual({ instanceId: ID, signalPollSec: 3 });
    // Mixed kinds keep their wire types.
    expect(
      buildConfigBody(ID, fields('enableChartMarkers', 'logLevel', 'symbols'), {
        enableChartMarkers: false,
        logLevel: ' WARN ',
        symbols: 'eurusd, gbpusd',
      }),
    ).toEqual({
      instanceId: ID,
      enableChartMarkers: false,
      logLevel: 'WARN',
      symbols: 'EURUSD,GBPUSD',
    });
  });

  it('sends no request at all when nothing is left to send', () => {
    expect(buildConfigBody(ID, [], {})).toBeNull();
    expect(buildConfigBody(ID, fields('maxDailyLossPerSymbolPct'), {})).toBeNull();
    expect(
      buildConfigBody(ID, fields('maxDailyLossPerSymbolPct'), { maxDailyLossPerSymbolPct: '  ' }),
    ).toBeNull();
  });

  it('never turns a 0 on a circuit-breaker limit into a request (0 = keep current, not Off)', () => {
    const cb = HOT_RELOAD_FIELDS.filter((f) => f.zeroKeepsCurrent).map((f) => f.key);
    expect(cb.sort()).toEqual(
      [
        'consecLossPauseMin',
        'maxConsecLosses',
        'maxDailyLossPct',
        'maxDailyLossPerSymbolPct',
        'maxLotPerOrder',
        'maxOpenPositions',
        'maxOrdersPerMin',
        'maxPosPerSymbol',
        'maxSpreadPoints',
        'maxTotalLots',
      ].sort(),
    );
    for (const key of cb) {
      expect(validateField(field(key), '0')).toMatch(/keeps the current value/);
      expect(buildConfigBody(ID, fields(key), { [key]: '0' })).toBeNull();
    }
    expect(validateField(field('maxDailyLossPerSymbolPct'), '0')).toMatch(/Switch off the gate/);
    // The old "0 = Off" chip is gone; a reported 0 is labelled as the EA's current state only.
    const f = field('maxDailyLossPerSymbolPct');
    expect(f.zeroMeans).toBeUndefined();
    expect(f.currentZeroMeans).toMatch(/^Off/);
    // A 0 is still a real value on settings whose 0 means something to the EA.
    expect(
      buildConfigBody(ID, fields('entryToleranceTpFrac'), { entryToleranceTpFrac: '0' }),
    ).toEqual({
      instanceId: ID,
      entryToleranceTpFrac: 0,
    });
  });

  it('switches the per-symbol daily-loss gate off only through the explicit flag', () => {
    expect(buildDisableDailyLossPerSymbolBody(ID)).toEqual({
      instanceId: ID,
      disableMaxDailyLossPerSymbol: true,
    });
    // The generic builder can never produce the flag.
    const all = buildConfigBody(
      ID,
      HOT_RELOAD_FIELDS,
      Object.fromEntries(HOT_RELOAD_FIELDS.map((x) => [x.key, '0'])),
    );
    expect(all && 'disableMaxDailyLossPerSymbol' in all).toBe(false);
    expect(all && 'maxDailyLossPerSymbolPct' in all).toBe(false);
  });

  // ── Tick gap fill ──

  const inputsMode = gapFillState({
    mdGapFill: false,
    mdGapFillRemote: false,
    mdGapFillMaxAgeHours: 24,
    mdGapFillOverride: false,
    mdGapFillActive: false,
  });
  const overrideOn = gapFillState({
    mdGapFill: true,
    mdGapFillRemote: false,
    mdGapFillMaxAgeHours: 24,
    mdGapFillOverride: true,
    mdGapFillActive: true,
  });

  it('reads the effective gap-fill state from the heartbeat inputs', () => {
    expect(inputsMode).toMatchObject({ supported: true, mode: 'inputs', active: false });
    expect(overrideOn).toMatchObject({ supported: true, mode: 'on', enabled: true, active: true });
    expect(gapFillState({ mdGapFill: false, mdGapFillOverride: true }).mode).toBe('off');
    expect(gapFillState({ mdGapFill: true }).supported).toBe(false); // EA before 8.47.287
  });

  it('builds the gap-fill on / off / clear patches', () => {
    expect(buildGapFillPatch(inputsMode, { mode: 'on' })).toEqual({ mdGapFill: true });
    // Pinning the value the inputs already give is still an override.
    expect(buildGapFillPatch(inputsMode, { mode: 'off' })).toEqual({ mdGapFill: false });
    expect(buildGapFillPatch(overrideOn, { mode: 'off' })).toEqual({ mdGapFill: false });
    expect(buildGapFillPatch(overrideOn, { mode: 'inputs' })).toEqual({
      mdGapFillOverride: 'clear',
    });
    // Clear is sent alone even when other gap-fill edits are pending.
    expect(
      buildGapFillPatch(overrideOn, { mode: 'inputs', remote: true, maxAgeHours: '48' }),
    ).toEqual({ mdGapFillOverride: 'clear' });
  });

  it('sends remote / max age only when they change, and nothing for a no-op', () => {
    expect(buildGapFillPatch(overrideOn, { remote: true, maxAgeHours: '48' })).toEqual({
      mdGapFillRemote: true,
      mdGapFillMaxAgeHours: 48,
    });
    expect(buildGapFillPatch(overrideOn, { remote: false, maxAgeHours: '24' })).toBeNull();
    expect(buildGapFillPatch(overrideOn, { mode: 'on' })).toBeNull();
    expect(buildGapFillPatch(inputsMode, { mode: 'inputs' })).toBeNull();
    expect(buildGapFillPatch(inputsMode, {})).toBeNull();
    // On the chart inputs, remote / age alone would start an override — not sent.
    expect(buildGapFillPatch(inputsMode, { remote: true })).toBeNull();
    // Unsupported EA build → nothing.
    expect(buildGapFillPatch(gapFillState({}), { mode: 'on' })).toBeNull();
  });

  it('validates the gap-fill max age (1..168 whole hours)', () => {
    expect(validateGapFillMaxAge(undefined)).toBeNull();
    expect(validateGapFillMaxAge('')).toBeNull();
    expect(validateGapFillMaxAge('1')).toBeNull();
    expect(validateGapFillMaxAge('168')).toBeNull();
    expect(validateGapFillMaxAge('0')).toMatch(/Between 1 and 168/);
    expect(validateGapFillMaxAge('169')).toMatch(/Between 1 and 168/);
    expect(validateGapFillMaxAge('2.5')).toMatch(/whole number/);
    expect(buildGapFillPatch(overrideOn, { maxAgeHours: '500' })).toBeNull();
  });
});
