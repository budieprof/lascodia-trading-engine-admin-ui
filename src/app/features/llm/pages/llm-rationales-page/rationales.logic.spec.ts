import { describe, expect, it } from 'vitest';
import type { RationaleCoverageDto } from '@core/api/api.types';
import {
  ageText,
  entryHistory,
  latestAnyType,
  rationaleRequirements,
  rationaleStateKind,
} from './rationales.logic';

const NOW = Date.parse('2026-10-28T12:00:00Z');

const cov = (over: Partial<RationaleCoverageDto> = {}): RationaleCoverageDto => ({
  windowHours: 168,
  totalRationales: 0,
  averageConfidence: 0,
  lowConfidenceCount: 0,
  totalCostUsd: 0,
  byEventType: [
    {
      eventType: 'StrategyActivated',
      description: '',
      count: 0,
      averageConfidence: null,
      latestAt: null,
      latestRationaleId: null,
      allTimeCount: 2,
      allTimeLatestAt: '2026-09-25T16:21:47Z',
      enabled: true,
    },
    {
      eventType: 'EmergencyFlatten',
      description: '',
      count: 0,
      averageConfidence: null,
      latestAt: null,
      latestRationaleId: null,
      allTimeCount: 0,
      allTimeLatestAt: null,
      enabled: true,
    },
  ],
  allTimeTotal: 2,
  allTimeLatestAt: '2026-09-25T16:21:47Z',
  layerEnabled: true,
  ...over,
});

describe('rationales.logic', () => {
  it('ageText is coarse and says never for null', () => {
    expect(ageText(null, NOW)).toBe('never');
    expect(ageText('2026-10-28T11:30:00Z', NOW)).toBe('30 min ago');
    expect(ageText('2026-10-28T02:00:00Z', NOW)).toBe('10 h ago');
    expect(ageText('2026-09-25T12:00:00Z', NOW)).toBe('33 days ago');
  });

  it('latestAnyType prefers the all-time stamp', () => {
    expect(latestAnyType(cov())).toEqual({
      at: '2026-09-25T16:21:47Z',
      eventType: 'StrategyActivated',
    });
    expect(latestAnyType(null)).toBeNull();
  });

  it('state kind follows the real switches and the window', () => {
    expect(rationaleStateKind(cov())).toBe('waiting');
    expect(rationaleStateKind(cov({ totalRationales: 3 }))).toBe('on');
    expect(rationaleStateKind(cov({ layerEnabled: false }))).toBe('off');
    const partial = cov();
    partial.byEventType[1].enabled = false;
    expect(rationaleStateKind(partial)).toBe('partial');
  });

  it('requirements carry each handler switch and history; unknown stays null', () => {
    const reqs = rationaleRequirements(cov({ layerEnabled: undefined }));
    expect(reqs[0].ok).toBeNull();
    expect(reqs[1]).toMatchObject({ label: 'Strategy activated handler', ok: true });
    expect(reqs[2].detail).toContain('never written');
  });

  it('entryHistory falls back to the window count on an older engine', () => {
    expect(
      entryHistory({
        eventType: 'X',
        description: '',
        count: 4,
        averageConfidence: 0.5,
        latestAt: null,
        latestRationaleId: null,
      }),
    ).toBe('4 in window');
  });
});
