import { describe, expect, it } from 'vitest';

import {
  STATUS_STALE_MS,
  describeScriptAlert,
  scriptAlertStatusText,
  timeframeLabel,
  type ChartScriptAlertDto,
} from './chart-script-alerts.types';

const NOW = Date.UTC(2026, 9, 9, 12, 0);

function alert(over: Partial<ChartScriptAlertDto> = {}): ChartScriptAlertDto {
  return {
    id: 5,
    name: null,
    displayName: 'EMA pair',
    chartScriptId: 45,
    scriptName: 'EMA pair',
    scriptRevision: 'aa',
    currentScriptRevision: 'aa',
    scriptChanged: false,
    scriptMissing: false,
    inputs: null,
    symbols: ['EURUSD', 'GBPUSD'],
    watchlistId: null,
    watchlistName: null,
    timeframe: '60',
    alertKey: 'Cross up',
    frequency: 'once_per_bar',
    channels: ['InApp'],
    webhookUrl: null,
    messageTemplate: null,
    expiresAtUtc: null,
    isEnabled: true,
    status: 'Active',
    statusNote: 'Watching EURUSD, GBPUSD on 60.',
    statusAt: new Date(NOW - 60_000).toISOString(),
    disabledReason: null,
    disabledAt: null,
    armedAtUtc: new Date(NOW - 3_600_000).toISOString(),
    lastFiredAt: null,
    fireCount: 0,
    lastDeliveryError: null,
    createdAt: new Date(NOW - 3_600_000).toISOString(),
    updatedAt: new Date(NOW - 3_600_000).toISOString(),
    ...over,
  };
}

describe('scriptAlertStatusText (SS-I1)', () => {
  it('shows the engine’s own note while it reports', () => {
    expect(scriptAlertStatusText(alert(), NOW)).toEqual({ text: 'Watching EURUSD, GBPUSD on 60.', stale: false });
  });

  it('says when no engine process has reported for a while', () => {
    const s = scriptAlertStatusText(alert({ statusAt: new Date(NOW - STATUS_STALE_MS - 60_000).toISOString() }), NOW);
    expect(s.stale).toBe(true);
    expect(s.text).toContain('the engine may not be watching it');
  });

  it('a new alert waits for the engine; a stopped one says why', () => {
    expect(scriptAlertStatusText(alert({ statusAt: null }), NOW).text).toBe('Armed — waiting for the engine to pick it up.');
    expect(
      scriptAlertStatusText(alert({ isEnabled: false, status: 'Disabled', disabledReason: 'Fired once.' }), NOW).text,
    ).toBe('Disabled — Fired once.');
  });
});

describe('describeScriptAlert / timeframeLabel', () => {
  it('says what it watches in a line', () => {
    expect(describeScriptAlert(alert())).toBe('“Cross up” · EURUSD, GBPUSD · 1h');
    expect(describeScriptAlert(alert({ alertKey: 'alert()', watchlistName: 'Majors', timeframe: '15' }))).toBe(
      'alert() calls · watchlist Majors · 15m',
    );
    expect(describeScriptAlert(alert({ alertKey: 'order-fills', timeframe: '1D' }))).toBe('order fills · EURUSD, GBPUSD · 1D');
  });

  it('names Pine timeframes as people say them', () => {
    expect(timeframeLabel('240')).toBe('4h');
    expect(timeframeLabel('1440')).toBe('1D');
    expect(timeframeLabel('5')).toBe('5m');
    expect(timeframeLabel('1W')).toBe('1W');
  });
});
