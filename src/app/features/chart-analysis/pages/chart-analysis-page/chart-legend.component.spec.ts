import { describe, expect, it } from 'vitest';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { resolveJitResources } from '@shared/testing/jit-resources';
import { declareSignalIo } from '@shared/testing/jit-signal-io';
import { ChartMarketChipsComponent } from '../../datafeed/chart-market-chips.component';
import { ScriptStatusLineComponent } from '../../scripts/script-status-line.component';
import { MeasuredBottomDirective } from '../../chart/measured-bottom.directive';
import { ChartSessionStore } from './chart-session-store';
import { ChartLegendComponent } from './chart-legend.component';

declareSignalIo(ChartMarketChipsComponent, {
  inputs: ['view', 'chips', 'options'],
  outputs: ['switchSeries', 'adjustmentChange'],
});
declareSignalIo(ScriptStatusLineComponent, { inputs: ['row'], outputs: ['action'] });
declareSignalIo(MeasuredBottomDirective, { outputs: ['bottomChange'] });
declareSignalIo(ChartLegendComponent, {
  inputs: [
    'marketView',
    'symbolChips',
    'seriesOptions',
    'legend',
    'legendUp',
    'legendChange',
    'legendVolume',
    'legendVolumeUnit',
    'legendTime',
    'precision',
    'compareSeries',
    'scriptRows',
  ],
  outputs: ['bottomChange', 'switchSeries', 'adjustmentChange', 'scriptAction'],
});

const TEMPLATE = readFileSync(
  resolve(
    process.cwd(),
    'src/app/features/chart-analysis/pages/chart-analysis-page/chart-legend.component.html',
  ),
  'utf8',
);

// US02b: the legend takes what it shows as inputs (no page slice) and the symbol/interval from the session store.
describe('ChartLegendComponent (US02b inputs)', () => {
  it('shows the series, the bar under the crosshair and its time from its inputs', async () => {
    await resolveJitResources({
      'chart-legend.component.html': TEMPLATE,
      'chart-legend.component.scss': '',
    });
    const session = { symbol: signal('EURUSD'), resolution: signal('60') };
    TestBed.configureTestingModule({
      imports: [ChartLegendComponent],
      providers: [{ provide: ChartSessionStore, useValue: session }],
    });
    const fixture = TestBed.createComponent(ChartLegendComponent);
    const set = (name: string, value: unknown) => fixture.componentRef.setInput(name, value);
    set('marketView', null);
    set('symbolChips', []);
    set('seriesOptions', null);
    set('legend', {
      time: 0,
      open: 1.1,
      high: 1.2,
      low: 1.0,
      close: 1.15,
      indicators: [],
    });
    set('legendUp', true);
    set('legendChange', '+0.0500 (+4.55%)');
    set('legendVolume', '1.2K');
    set('legendVolumeUnit', 'ticks');
    set('legendTime', '2026-11-08 10:00 UTC');
    set('precision', 5);
    set('compareSeries', []);
    set('scriptRows', []);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.legend-title strong')!.textContent).toBe('EURUSD');
    expect(el.querySelector('.legend-title .muted')!.textContent).toBe('1h');
    expect(el.querySelector('.legend-ohlc')!.classList).toContain('up');
    expect(el.querySelector('.legend-ohlc')!.textContent).toContain('1.15000');
    expect(el.querySelector('[data-testid="legend-change"]')!.textContent).toBe('+0.0500 (+4.55%)');
    expect(el.querySelector('.legend-time')!.textContent).toBe('2026-11-08 10:00 UTC');
  });
});
