import { describe, expect, it } from 'vitest';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { resolveJitResources } from '@shared/testing/jit-resources';
import { declareSignalIo } from '@shared/testing/jit-signal-io';
import { ChartIconComponent } from '../../icons/chart-icon.component';
import { ChartAlertsService } from '../../alerts/chart-alerts.service';
import { DrawingStore } from '../../drawings/drawing-store.service';
import { ChartPanelsState } from '../../panels/side/chart-panels-state.service';
import { ChartPanelStripComponent } from './chart-panel-strip.component';

declareSignalIo(ChartIconComponent, { inputs: ['name', 'size'] });
declareSignalIo(ChartPanelStripComponent, {
  inputs: ['watchlistOpen', 'objectTreeOpen', 'sidePane', 'alertManagerOpen', 'showFundamentals'],
  outputs: [
    'watchlistOpenChange',
    'objectTreeOpenChange',
    'sidePaneToggle',
    'panelToggle',
    'alertManagerToggle',
  ],
});

const TEMPLATE = readFileSync(
  resolve(
    process.cwd(),
    'src/app/features/chart-analysis/pages/chart-analysis-page/chart-panel-strip.component.html',
  ),
  'utf8',
);

// US02b: the panel strip takes the page's pane state as inputs and asks for changes through outputs (no page slice).
describe('ChartPanelStripComponent (US02b inputs/outputs)', () => {
  it('marks what is open and reports clicks to the page', async () => {
    await resolveJitResources({
      'chart-panel-strip.component.html': TEMPLATE,
      'chart-panel-strip.component.scss': '',
    });
    TestBed.configureTestingModule({
      imports: [ChartPanelStripComponent],
      providers: [
        { provide: ChartPanelsState, useValue: { open: signal('depth') } },
        { provide: DrawingStore, useValue: { symbolDrawings: signal([{ id: 'a' }, { id: 'b' }]) } },
        { provide: ChartAlertsService, useValue: { activeCount: signal(4) } },
      ],
    });
    const fixture = TestBed.createComponent(ChartPanelStripComponent);
    const strip = fixture.componentInstance;
    const set = (name: string, value: unknown) => fixture.componentRef.setInput(name, value);
    set('watchlistOpen', false);
    set('objectTreeOpen', false);
    set('sidePane', 'news');
    set('alertManagerOpen', false);
    set('showFundamentals', false);
    const panes: string[] = [];
    const panels: string[] = [];
    const watchlist: boolean[] = [];
    strip.sidePaneToggle.subscribe((p) => panes.push(p));
    strip.panelToggle.subscribe((p) => panels.push(p));
    strip.watchlistOpen.subscribe((v) => watchlist.push(v));
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const btn = (label: string) =>
      el.querySelector(`button[aria-label^="${label}"]`) as HTMLButtonElement;

    expect(btn('News for this pair').classList).toContain('active');
    expect(el.querySelector('[data-testid="depth-button"]')!.classList).toContain('active');
    expect(el.querySelector('[data-testid="fundamentals-button"]')).toBeNull();
    expect(btn('Drawings on this chart').getAttribute('aria-label')).toBe(
      'Drawings on this chart (2)',
    );
    expect(
      el.querySelector('[data-testid="alert-manager-button"]')!.getAttribute('aria-label'),
    ).toBe('Alerts (4 active)');

    btn('Symbol details').click();
    (el.querySelector('[data-testid="ladder-button"]') as HTMLButtonElement).click();
    btn('Watchlist').click();
    expect(panes).toEqual(['details']);
    expect(panels).toEqual(['ladder']);
    expect(watchlist).toEqual([true]);
  });
});
