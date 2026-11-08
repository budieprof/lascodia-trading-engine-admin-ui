import { describe, expect, it } from 'vitest';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { resolveJitResources } from '@shared/testing/jit-resources';
import { declareSignalIo } from '@shared/testing/jit-signal-io';
import { ChartIconComponent } from '../../icons/chart-icon.component';
import { DrawingStore } from '../../drawings/drawing-store.service';
import { ChartContextMenusComponent } from './chart-context-menus.component';

declareSignalIo(ChartIconComponent, { inputs: ['name', 'size'] });
const MODELS = ['settingsFor', 'invertScale', 'scaleMode', 'scaleSide', 'showCountdown'];
declareSignalIo(ChartContextMenusComponent, {
  inputs: ['drawingMenu', 'contextMenu', 'precision', ...MODELS],
  outputs: [
    ...MODELS.map((m) => `${m}Change`),
    'drawingAction',
    'closeMenu',
    'resetScales',
    'chartSettings',
    'commands',
    'saveImage',
    'copyImage',
    'exportData',
    'showObjects',
    'addIndicator',
    'alertAtLevel',
    'alertHere',
    'saveLayoutAs',
    'removeAllDrawings',
  ],
});

const TEMPLATE = readFileSync(
  resolve(
    process.cwd(),
    'src/app/features/chart-analysis/pages/chart-analysis-page/chart-context-menus.component.html',
  ),
  'utf8',
);

async function setup(menus: { drawingMenu?: unknown; contextMenu?: unknown }) {
  await resolveJitResources({
    'chart-context-menus.component.html': TEMPLATE,
    'chart-context-menus.component.scss': '',
  });
  TestBed.configureTestingModule({
    imports: [ChartContextMenusComponent],
    providers: [
      {
        provide: DrawingStore,
        useValue: {
          allDrawings: signal([{ id: 'd1', locked: false }]),
          visible: signal([{ id: 'd1' }]),
        },
      },
    ],
  });
  const fixture = TestBed.createComponent(ChartContextMenusComponent);
  const set = (name: string, value: unknown) => fixture.componentRef.setInput(name, value);
  set('drawingMenu', menus.drawingMenu ?? null);
  set('contextMenu', menus.contextMenu ?? null);
  set('precision', 5);
  set('settingsFor', null);
  set('invertScale', false);
  set('scaleMode', 'normal');
  set('scaleSide', 'right');
  set('showCountdown', true);
  const events: unknown[] = [];
  const c = fixture.componentInstance;
  c.drawingAction.subscribe((e) => events.push(['drawing', e]));
  c.closeMenu.subscribe(() => events.push(['close']));
  c.invertScale.subscribe((v) => events.push(['invert', v]));
  c.chartSettings.subscribe(() => events.push(['settings']));
  c.alertHere.subscribe(() => events.push(['alertHere']));
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const button = (text: string) =>
    [...el.querySelectorAll('button')].find((b) => b.textContent!.trim().startsWith(text))!;
  return { events, button, el };
}

// US02b: the menus take their state as inputs and send every command out (no page slice).
describe('ChartContextMenusComponent (US02b inputs/outputs)', () => {
  it('a drawing’s menu sends its action with the drawing', async () => {
    const { events, button } = await setup({ drawingMenu: { id: 'd1', x: 1, y: 2 } });
    button('Lock').click();
    button('Remove').click();
    expect(events).toEqual([
      ['drawing', { id: 'd1', action: 'lock' }],
      ['drawing', { id: 'd1', action: 'remove' }],
    ]);
  });

  it('the chart menu toggles a scale option then closes; commands go out as asked', async () => {
    const { events, button } = await setup({ contextMenu: { x: 1, y: 2, price: 1.23456 } });
    expect(button('Add alert at').textContent).toContain('1.23456');
    button('Invert scale').click();
    button('Settings').click();
    button('Add alert at').click();
    expect(events).toEqual([['invert', true], ['close'], ['settings'], ['alertHere']]);
  });
});
