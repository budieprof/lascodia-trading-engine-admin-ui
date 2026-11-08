import { describe, expect, it } from 'vitest';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { resolveJitResources } from '@shared/testing/jit-resources';
import { declareSignalIo } from '@shared/testing/jit-signal-io';
import { ChartIconComponent } from '../../icons/chart-icon.component';
import { LayerGroupsMenuComponent } from '../../overlays/layer-groups-menu.component';
import { ChartOverlaySettings } from './chart-overlay-settings';
import { ChartOverlaysMenuComponent } from './chart-overlays-menu.component';

declareSignalIo(ChartIconComponent, { inputs: ['name', 'size'] });
declareSignalIo(LayerGroupsMenuComponent, { inputs: ['groups'], outputs: ['groupsChange'] });
const MODELS = ['showVolume', 'sessionBreaks', 'showTradeTimeline'];
declareSignalIo(ChartOverlaysMenuComponent, {
  inputs: [
    'open',
    'overlayCount',
    'tradeTimelineInfo',
    'blackoutTitle',
    'deltaOn',
    'autoAnalysis',
    'autoAnalysisOn',
    'autoAnalysisLayers',
    'footprintRowUnit',
    'footprintRowChoices',
    'orderFlowFeed',
    'consolidatableSources',
    ...MODELS,
  ],
  outputs: [
    ...MODELS.map((m) => `${m}Change`),
    'menuToggle',
    'eventsToggle',
    'eventImpactCycle',
    'deltaToggle',
    'autoAnalysisToggle',
    'autoLayerToggle',
    'scorecard',
    'volumeProfileModePick',
    'consolidatedSourceToggle',
  ],
});

const TEMPLATE = readFileSync(
  resolve(
    process.cwd(),
    'src/app/features/chart-analysis/pages/chart-analysis-page/chart-overlays-menu.component.html',
  ),
  'utf8',
);

// U13 / US02b: the overlays menu shows the active-overlay count from its input and asks the page to open it.
describe('ChartOverlaysMenuComponent (US02b inputs/outputs)', () => {
  it('shows the active-overlay count and asks the page to open its menu', async () => {
    await resolveJitResources({ 'chart-overlays-menu.component.html': TEMPLATE });
    TestBed.configureTestingModule({
      imports: [ChartOverlaysMenuComponent],
      providers: [{ provide: ChartOverlaySettings, useValue: new ChartOverlaySettings() }],
    });
    const fixture = TestBed.createComponent(ChartOverlaysMenuComponent);
    const set = (name: string, value: unknown) => fixture.componentRef.setInput(name, value);
    set('open', false);
    set('overlayCount', 3);
    set('showVolume', true);
    set('sessionBreaks', false);
    set('showTradeTimeline', false);
    set('tradeTimelineInfo', null);
    set('blackoutTitle', '');
    set('deltaOn', false);
    set('autoAnalysis', { trendlines: false, htfLevels: false, autoFib: false });
    set('autoAnalysisOn', false);
    set('autoAnalysisLayers', []);
    set('footprintRowUnit', 'points');
    set('footprintRowChoices', []);
    set('orderFlowFeed', { mdSources: signal(null), sourceNotEntitled: () => null });
    set('consolidatableSources', []);
    const toggled: Event[] = [];
    fixture.componentInstance.menuToggle.subscribe((e) => toggled.push(e));
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const button = el.querySelector('[data-testid="overlays-button"]') as HTMLButtonElement;
    expect(button.classList).toContain('active');
    expect(el.querySelector('.tb-badge')!.textContent!.trim()).toBe('3');
    expect(el.querySelector('.tb-overlays-menu')).toBeNull();
    button.click();
    expect(toggled).toHaveLength(1);
    expect(toggled[0]).toBeInstanceOf(MouseEvent);
  });

  it('open, a trade layer switches on the overlay settings themselves', async () => {
    await resolveJitResources({ 'chart-overlays-menu.component.html': TEMPLATE });
    const overlays = new ChartOverlaySettings();
    TestBed.configureTestingModule({
      imports: [ChartOverlaysMenuComponent],
      providers: [{ provide: ChartOverlaySettings, useValue: overlays }],
    });
    const fixture = TestBed.createComponent(ChartOverlaysMenuComponent);
    const set = (name: string, value: unknown) => fixture.componentRef.setInput(name, value);
    set('open', true);
    set('overlayCount', 0);
    set('showVolume', true);
    set('sessionBreaks', false);
    set('showTradeTimeline', false);
    set('tradeTimelineInfo', null);
    set('blackoutTitle', 'Shade the news blackout around high-impact events');
    set('deltaOn', false);
    set('autoAnalysis', { trendlines: false, htfLevels: false, autoFib: false });
    set('autoAnalysisOn', false);
    set('autoAnalysisLayers', []);
    set('footprintRowUnit', 'points');
    set('footprintRowChoices', []);
    set('orderFlowFeed', { mdSources: signal(null), sourceNotEntitled: () => null });
    set('consolidatableSources', []);
    const events: string[] = [];
    fixture.componentInstance.eventsToggle.subscribe(() => events.push('events'));
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const row = (text: string) =>
      [...el.querySelectorAll('button')].find((b) =>
        b.textContent!.includes(text),
      ) as HTMLButtonElement;
    row('Open positions').click();
    expect(overlays.showPositions()).toBe(true);
    row('Economic events').click();
    expect(events).toEqual(['events']);
  });
});
