import { describe, expect, it } from 'vitest';

import {
  breachLabels,
  decisionContext,
  definitionJson,
  emptyScenarioForm,
  formFromDefinition,
  forecastTone,
  groupSettings,
  isBreach,
  isLoosening,
  jobTone,
  modeTone,
  organisationValueAllowed,
  scenarioFormProblems,
  settingError,
  varHistoryOption,
  verdictLabel,
} from './risk.logic';
import type { RiskJob, RiskSetting, StressResult } from './risk.types';

function setting(over: Partial<RiskSetting>): RiskSetting {
  return {
    key: 'Risk:Stress:MaxScenarioLossPct',
    label: 'x',
    group: 'Pre-trade check',
    description: '',
    kind: 'Decimal',
    allowedValues: [],
    min: 0.1,
    max: 100,
    unit: null,
    defaultValue: '25',
    platformValue: null,
    organisationValue: null,
    effectiveValue: '25',
    effectiveSource: 'Default',
    layered: true,
    tightenOnly: true,
    platformWritePermission: 'platform.engine.manage',
    organisationWritePermission: 'engine.config',
    dataType: 'Decimal',
    lastChangedAtUtc: null,
    lastChangedBy: null,
    lastChangedLayer: null,
    lastOldValue: null,
    lastNewValue: null,
    ...over,
  };
}

describe('risk.logic', () => {
  it('tones the mode: Enforce ok, Observe warn, Off muted', () => {
    expect(modeTone('Enforce')).toBe('ok');
    expect(modeTone('Observe')).toBe('warn');
    expect(modeTone('Off')).toBe('muted');
  });

  it('tones the forecast by how close the stop-out is', () => {
    expect(forecastTone('AtStopOut')).toBe('bad');
    expect(forecastTone('AtMarginCall')).toBe('bad');
    expect(forecastTone('WithinAlertBuffer')).toBe('warn');
    expect(forecastTone('Ok')).toBe('ok');
    expect(forecastTone('Flat')).toBe('muted');
  });

  it('labels Observe verdicts as would-have', () => {
    expect(verdictLabel('WouldReject')).toContain('Observe');
    expect(verdictLabel('Shrunk')).toBe('Size cut');
  });

  it('validates typed controls', () => {
    expect(settingError(setting({}), '30')).toBeNull();
    expect(settingError(setting({}), '0')).toContain('At least');
    expect(settingError(setting({}), 'abc')).toContain('number');
    expect(settingError(setting({ kind: 'Int', min: 1, max: 10 }), '2.5')).toContain('whole');
    expect(settingError(setting({ kind: 'Bool' }), 'true')).toBeNull();
    expect(settingError(setting({ kind: 'Enum', allowedValues: ['Enforce', 'Observe', 'Off'] }), 'Maybe')).toContain('Enforce');
  });

  it('knows which direction loosens each risk knob', () => {
    expect(isLoosening(setting({ key: 'Risk:Stress:Mode' }), 'Observe', 'Off')).toBe(true);
    expect(isLoosening(setting({ key: 'Risk:Stress:Mode' }), 'Observe', 'Enforce')).toBe(false);
    expect(isLoosening(setting({}), '25', '30')).toBe(true);
    expect(isLoosening(setting({ key: 'Risk:Margin:MinStopOutSigma' }), '3', '2')).toBe(true);
    expect(isLoosening(setting({ key: 'Risk:Margin:AlertSigma' }), '2', '1')).toBeNull();
  });

  it('refuses an organisation value looser than what it inherits', () => {
    const s = setting({ platformValue: '20' });
    expect(organisationValueAllowed(s, '15')).toBe(true);
    expect(organisationValueAllowed(s, '30')).toBe(false);
    expect(organisationValueAllowed(setting({ tightenOnly: false }), '99')).toBe(true);
  });

  it('groups settings in order', () => {
    const g = groupSettings([setting({ group: 'A', key: '1' }), setting({ group: 'B', key: '2' }), setting({ group: 'A', key: '3' })]);
    expect(g.map((x) => x.group)).toEqual(['A', 'B']);
    expect(g[0].items.map((i) => i.key)).toEqual(['1', '3']);
  });

  it('flags failing, overdue and disabled jobs', () => {
    const job: RiskJob = {
      name: 'PortfolioRiskWorker', purpose: '', enabled: true, lastRunAtUtc: null, lastStatus: null, lastResult: null,
      nextRunAtUtc: new Date(Date.now() + 60_000).toISOString(), lastErrorAtUtc: null, lastError: null, consecutiveFailures: 0,
      runNow: '', runNowPermission: 'risk.manage', operatorNote: null,
    };
    expect(jobTone(job)).toBe('ok');
    expect(jobTone({ ...job, consecutiveFailures: 2 })).toBe('bad');
    expect(jobTone({ ...job, nextRunAtUtc: new Date(Date.now() - 3_600_000).toISOString() })).toBe('warn');
    expect(jobTone({ ...job, enabled: false })).toBe('muted');
  });

  it('builds a hypothetical scenario definition from the editor rows', () => {
    const f = emptyScenarioForm();
    f.name = 'USD up';
    f.rows = [
      { kind: 'currency', key: 'usd', pctChange: 3 },
      { kind: 'symbol', key: 'xauusd', pctChange: -8 },
      { kind: 'assetClass', key: 'Index', pctChange: -10 },
      { kind: 'currency', key: '', pctChange: 1 },
    ];
    expect(JSON.parse(definitionJson(f))).toEqual({
      currencyShocks: [{ currency: 'USD', pctChange: 3 }],
      symbolShocks: [{ symbol: 'XAUUSD', pctChange: -8 }],
      assetClassShocks: [{ assetClass: 'Index', pctChange: -10 }],
    });
    expect(scenarioFormProblems(f)).toEqual([]);
  });

  it('round-trips a stored definition through the form', () => {
    const f = formFromDefinition('SNB', 'Historical', {
      dateFrom: '2015-01-15T00:00:00Z', dateTo: '2015-01-15T00:00:00Z', currencyShocks: [{ currency: 'CHF', pctChange: 16 }],
      symbolShocks: [], assetClassShocks: [], searchSymbols: [],
    });
    expect(JSON.parse(definitionJson(f))).toMatchObject({ dateFrom: '2015-01-15', currencyShocks: [{ currency: 'CHF', pctChange: 16 }] });
  });

  it('reports editor problems', () => {
    const f = { ...emptyScenarioForm(), scenarioType: 'Historical' as const, dateFrom: '2020-02-01', dateTo: '2020-01-01' };
    expect(scenarioFormProblems(f).join(' ')).toContain('name');
    expect(scenarioFormProblems(f).join(' ')).toContain('from date');
    expect(scenarioFormProblems({ ...f, scenarioType: 'ReverseStress', targetLossPct: 150 }).join(' ')).toContain('target loss');
  });

  it('labels breaches', () => {
    const r = { wouldTriggerMarginCall: true, wouldTriggerStopOut: true, wouldBreachDrawdownLimit: true } as StressResult;
    expect(isBreach(r)).toBe(true);
    expect(breachLabels(r)).toEqual(['Stop-out', 'Drawdown limit']);
  });

  it('parses decision context defensively', () => {
    expect(decisionContext('{"maxLots":0.47}')).toEqual({ maxLots: 0.47 });
    expect(decisionContext('nope')).toBeNull();
    expect(decisionContext(null)).toBeNull();
  });

  it('charts only measured points', () => {
    const opt = varHistoryOption(
      [
        { computedAtUtc: '2026-11-01T00:00:00Z', status: 'Computed', equity: 1, vaR95: 10, vaR99: 20, cVaR95: 15, cVaR99: 25, stressedVaR: 30, vaR95Pct: 1, marginLevelPct: null, stopOutSigma1d: null, grossExposure: 0, openPositionCount: 1 },
        { computedAtUtc: '2026-11-01T00:05:00Z', status: 'MissingHistory', equity: 1, vaR95: 0, vaR99: 0, cVaR95: 0, cVaR99: 0, stressedVaR: 0, vaR95Pct: null, marginLevelPct: null, stopOutSigma1d: null, grossExposure: 0, openPositionCount: 1 },
      ],
      'USD',
    );
    const series = opt.series as { data: unknown[] }[];
    expect(series).toHaveLength(4);
    expect(series[0].data).toHaveLength(1);
  });
});
