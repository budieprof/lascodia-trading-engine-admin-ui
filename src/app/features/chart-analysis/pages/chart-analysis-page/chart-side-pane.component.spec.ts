import { describe, expect, it } from 'vitest';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { resolveJitResources } from '@shared/testing/jit-resources';
import { declareSignalIo } from '@shared/testing/jit-signal-io';
import { ChartIconComponent } from '../../icons/chart-icon.component';
import { LongPressDirective } from '../../panels/long-press.directive';
import { ChartPanelsState } from '../../panels/side/chart-panels-state.service';
import { ChartSessionStore } from './chart-session-store';
import { ChartSidePaneComponent } from './chart-side-pane.component';

declareSignalIo(ChartIconComponent, { inputs: ['name', 'size'] });
declareSignalIo(LongPressDirective, { outputs: ['appLongPress'] });
const MODELS = ['calendarAll', 'calendarMinImpact'];
declareSignalIo(ChartSidePaneComponent, {
  inputs: [
    'sidePane',
    'details',
    'marketView',
    'newsFocus',
    'newsLoading',
    'articles',
    'timezone',
    'calendarCurrencies',
    'eventRelevance',
    'precision',
    'facts',
    'orderFlowReplayClip',
    'orderFlowSourceId',
    'tickReplayBook',
    'dataWindowSections',
    ...MODELS,
  ],
  outputs: [
    ...MODELS.map((m) => `${m}Change`),
    'articleAnalysis',
    'calendarEventOpened',
    'symbolSelected',
  ],
});

const TEMPLATE = readFileSync(
  resolve(
    process.cwd(),
    'src/app/features/chart-analysis/pages/chart-analysis-page/chart-side-pane.component.html',
  ),
  'utf8',
);

// US02b: the side pane takes its content as inputs and reports picks as outputs (no page slice).
describe('ChartSidePaneComponent (US02b inputs/outputs)', () => {
  it('lists the news and sends a tapped item out for its analysis', async () => {
    await resolveJitResources({
      'chart-side-pane.component.html': TEMPLATE,
      'chart-side-pane.component.scss': '',
    });
    TestBed.configureTestingModule({
      imports: [ChartSidePaneComponent],
      providers: [
        {
          provide: ChartSessionStore,
          useValue: { symbol: signal('EURUSD'), resolution: signal('60'), bars: signal([]) },
        },
        { provide: ChartPanelsState, useValue: { open: signal(null) } },
      ],
    });
    const fixture = TestBed.createComponent(ChartSidePaneComponent);
    const set = (name: string, value: unknown) => fixture.componentRef.setInput(name, value);
    const article = {
      id: 7,
      title: 'ECB holds',
      sourceName: 'Reuters',
      url: null,
      publishedAtUtc: '2026-11-08T09:00:00Z',
      labels: [],
    };
    set('sidePane', 'news');
    set('details', { symbol: 'EURUSD', base: 'EUR', quote: 'USD', isFx: true });
    set('marketView', { label: 'Open', title: '' });
    set('newsFocus', null);
    set('newsLoading', false);
    set('articles', [article]);
    set('timezone', 'UTC');
    set('calendarCurrencies', ['EUR', 'USD']);
    set('eventRelevance', { summary: '', marketKeys: [] });
    set('precision', 5);
    set('facts', null);
    set('orderFlowReplayClip', null);
    set('orderFlowSourceId', null);
    set('tickReplayBook', undefined);
    set('dataWindowSections', []);
    set('calendarAll', false);
    set('calendarMinImpact', 'Low');
    const picked: unknown[] = [];
    fixture.componentInstance.articleAnalysis.subscribe((a) => picked.push(a));
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;

    expect(el.querySelector('.tree-title')!.textContent).toContain('News · EUR / USD');
    const item = el.querySelector('.news-list li') as HTMLElement;
    expect(item.textContent).toContain('ECB holds');
    item.click();
    expect(picked).toEqual([article]);
  });
});
