import { describe, expect, it } from 'vitest';
import { INDICATORS, indicatorById } from '../indicators/registry';
import type { ChartScriptResult } from '../scripts/chart-script.model';
import {
  linkedCharts,
  panelLayers,
  panelStudyChoices,
  sharedRun,
  withStudy,
  withoutStudy,
  type PanelScript,
} from './chart-panels';

const result = (tag: string) => ({ title: tag }) as unknown as ChartScriptResult;
const item = { key: 'mine:7', source: 'mine', name: 'Trend', description: '', kind: 'indicator' } as const;
const script = (over: Partial<PanelScript> = {}): PanelScript => ({
  item: { ...item },
  values: { len: 5 },
  result: null,
  error: null,
  ranTo: null,
  ...over,
});
const mainRun = { item: { key: 'mine:7' }, values: { len: 5 }, symbol: 'EURUSD', resolution: '60', result: result('main') };

describe('multi-chart: the other charts’ studies and scripts (CC-I5)', () => {
  it('adds a study at its defaults and removes it', () => {
    const rsi = indicatorById('rsi')!;
    const studies = withStudy([], rsi, 'u1');
    expect(studies).toEqual([{ uid: 'u1', defId: 'rsi', params: expect.objectContaining({}), visible: true }]);
    expect(withoutStudy(studies, 'u1')).toEqual([]);
  });

  it('offers the studies that read the chart’s own bars only', () => {
    const offered = panelStudyChoices(INDICATORS);
    expect(offered.some((d) => d.needsCompare)).toBe(false);
    expect(offered.some((d) => d.id === 'rsi')).toBe(true);
  });

  it('shares the main chart’s identical run — and only an identical one', () => {
    expect(sharedRun([mainRun], script(), 'eurusd', '60')).toBe(mainRun);
    expect(sharedRun([mainRun], script({ values: { len: 6 } }), 'EURUSD', '60')).toBeNull();
    expect(sharedRun([mainRun], script(), 'EURUSD', '240')).toBeNull();
    expect(sharedRun([{ ...mainRun, until: 5 }], script(), 'EURUSD', '60')).toBeNull();
    expect(panelLayers([script({ result: result('own') })], [mainRun], 'EURUSD', '60')[0].result).toBe(mainRun.result);
    expect(panelLayers([script({ result: result('own') })], [mainRun], 'GBPUSD', '60')[0].result).toEqual(result('own'));
    expect(panelLayers([script()], [], 'GBPUSD', '60')).toEqual([]);
  });

  it('a link group ties the charts that share it', () => {
    const panels = [
      { id: 'a', link: 1 },
      { id: 'b', link: 2 },
      { id: 'c', link: 1 },
    ];
    expect(linkedCharts('main', 1, 1, panels)).toEqual(['a', 'c']);
    expect(linkedCharts('a', 1, 1, panels)).toEqual(['main', 'c']);
    expect(linkedCharts('b', 2, 1, panels)).toEqual([]);
    expect(linkedCharts('a', 0, 0, panels)).toEqual([]);
  });
});
