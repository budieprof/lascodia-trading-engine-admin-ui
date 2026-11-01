import { describe, expect, it } from 'vitest';

import { surveillanceQuery } from './surveillance-api.service';
import {
  boundsOf,
  controlKind,
  detectorKeys,
  globalKeys,
  jobHealth,
  keyLabel,
  leiProblem,
  metricText,
  relative,
  transitionProblem,
  valueProblem,
} from './surveillance.logic';
import type { JobStatus, SurveillanceDetector, SurveillanceKey } from './surveillance.types';

const key = (
  k: string,
  dataType: SurveillanceKey['dataType'],
  value: string | null = null,
): SurveillanceKey => ({
  key: k,
  value,
  default: '1',
  dataType,
  description: '',
  lastChangedAtUtc: null,
  lastChangedBy: null,
});

const detectors: SurveillanceDetector[] = [
  {
    key: 'WashTrade',
    name: 'Wash trade',
    description: '',
    enabled: true,
    severity: 'High',
    parameters: [
      {
        name: 'WindowSeconds',
        configKey: 'Surveillance:WashTrade:WindowSeconds',
        value: 60,
        default: 60,
        min: 1,
        max: 3600,
        description: '',
      },
    ],
  },
];

describe('surveillance review rules', () => {
  it('mirrors the engine life cycle', () => {
    expect(transitionProblem('Open', 'UnderReview', null, '')).toBeNull();
    expect(transitionProblem('UnderReview', 'Open', null, '')).toBeNull();
    expect(transitionProblem('Open', 'Closed', 'FalsePositive', 'explained by news')).toBeNull();
    expect(transitionProblem('UnderReview', 'Closed', null, 'explained by news')).toMatch(
      /resolution/,
    );
    expect(transitionProblem('UnderReview', 'Closed', 'Actioned', 'short')).toMatch(
      /10 characters/,
    );
    expect(transitionProblem('Closed', 'Open', null, '')).toMatch(/stays closed/);
    expect(transitionProblem('Open', 'Open', null, '')).toMatch(/already/);
  });
});

describe('surveillance settings controls', () => {
  it('picks a typed control per key', () => {
    expect(controlKind(key('Surveillance:Enabled', 'Bool'))).toBe('bool');
    expect(controlKind(key('Surveillance:WashTrade:Severity', 'String'))).toBe('severity');
    expect(controlKind(key('Surveillance:Alerts:NotifyMinSeverity', 'String'))).toBe('severity');
    expect(controlKind(key('Surveillance:WashTrade:WindowSeconds', 'Int'))).toBe('int');
    expect(controlKind(key('Surveillance:WashTrade:PriceTolerancePips', 'Decimal'))).toBe(
      'decimal',
    );
  });

  it('refuses values outside the bounds before the engine is asked', () => {
    const w = key('Surveillance:WashTrade:WindowSeconds', 'Int');
    expect(boundsOf(w.key, detectors)).toEqual({ min: 1, max: 3600 });
    expect(valueProblem(w, '30', detectors)).toBeNull();
    expect(valueProblem(w, '0', detectors)).toMatch(/Between 1 and 3600/);
    expect(valueProblem(w, '2.5', detectors)).toMatch(/whole/);
    expect(valueProblem(w, 'abc', detectors)).toMatch(/number/);
    expect(valueProblem(key('Surveillance:Enabled', 'Bool'), 'yes', detectors)).toMatch(
      /true or false/,
    );
    expect(
      valueProblem(key('Surveillance:WashTrade:Severity', 'String'), 'High', detectors),
    ).toBeNull();
    expect(
      valueProblem(key('Surveillance:WashTrade:Severity', 'String'), 'Loud', detectors),
    ).not.toBeNull();
    expect(valueProblem(key('Surveillance:PollIntervalSeconds', 'Int'), '30', detectors)).toMatch(
      /60/,
    );
  });

  it('groups keys by detector with the switch and severity first', () => {
    const keys = [
      key('Surveillance:WashTrade:WindowSeconds', 'Int'),
      key('Surveillance:WashTrade:Severity', 'String'),
      key('Surveillance:WashTrade:Enabled', 'Bool'),
      key('Surveillance:Enabled', 'Bool'),
    ];
    expect(detectorKeys(keys, 'WashTrade').map((k) => keyLabel(k.key))).toEqual([
      'Enabled',
      'Severity',
      'Window seconds',
    ]);
    expect(globalKeys(keys, detectors).map((k) => k.key)).toEqual(['Surveillance:Enabled']);
  });
});

describe('job status', () => {
  const now = new Date('2026-11-01T12:00:00Z');
  const status = (patch: Partial<JobStatus>): JobStatus => ({
    jobName: 'surveillance-scan',
    lastStartedAtUtc: '2026-11-01T11:45:00Z',
    lastFinishedAtUtc: '2026-11-01T11:45:02Z',
    lastOutcome: 'Succeeded',
    lastMessage: null,
    lastDurationMs: 2000,
    consecutiveFailures: 0,
    nextRunAtUtc: '2026-11-01T12:00:02Z',
    runRequestedAtUtc: null,
    runRequestedBy: null,
    detail: null,
    ...patch,
  });

  it('reads as never run, ok, failing, late or skipped', () => {
    expect(jobHealth(null, now)).toBe('never');
    expect(jobHealth(status({}), now)).toBe('ok');
    expect(jobHealth(status({ lastOutcome: 'Failed' }), now)).toBe('failing');
    expect(jobHealth(status({ nextRunAtUtc: '2026-11-01T11:00:00Z' }), now)).toBe('late');
    expect(jobHealth(status({ lastOutcome: 'Skipped' }), now)).toBe('skipped');
  });

  it('says times relative to now', () => {
    expect(relative('2026-11-01T11:57:00Z', now)).toBe('3 min ago');
    expect(relative('2026-11-01T12:15:00', now)).toBe('in 15 min');
    expect(relative(null, now)).toBe('—');
  });
});

describe('small formatting', () => {
  it('formats metrics and queries', () => {
    expect(metricText(0.5)).toBe('0.5');
    expect(metricText(3)).toBe('3');
    expect(metricText(true)).toBe('yes');
    expect(metricText(null)).toBe('—');
    expect(surveillanceQuery({ status: 'Open', mine: false, symbol: '', page: 2 })).toBe(
      '?status=Open&page=2',
    );
  });
});

describe('LEI check', () => {
  it('accepts valid LEIs and refuses mistyped ones', () => {
    expect(leiProblem('5493001KJTIIGC8Y1R12')).toBeNull();
    expect(leiProblem('7LTWFZYICNSX8D621K86')).toBeNull();
    expect(leiProblem('5493001KJTIIGC8Y1R13')).toMatch(/check digits/);
    expect(leiProblem('ABC')).toMatch(/20 letters/);
    expect(leiProblem('')).toBeNull();
  });
});
