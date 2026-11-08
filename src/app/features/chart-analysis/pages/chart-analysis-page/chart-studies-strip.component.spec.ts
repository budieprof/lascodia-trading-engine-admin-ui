import { describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { resolveJitResources } from '@shared/testing/jit-resources';
import { declareSignalIo } from '@shared/testing/jit-signal-io';
import { ChartIconComponent } from '../../icons/chart-icon.component';
import { ScriptChipComponent } from '../../scripts/script-chip.component';
import { ChartStudiesStripComponent } from './chart-studies-strip.component';

declareSignalIo(ChartIconComponent, { inputs: ['name', 'size'] });
declareSignalIo(ScriptChipComponent, {
  inputs: ['chip'],
  outputs: ['visibility', 'settings', 'source', 'tester', 'logs', 'alert', 'removed', 'openAt'],
});
declareSignalIo(ChartStudiesStripComponent, {
  inputs: ['active', 'scriptChips', 'scriptError', 'testerOpen', 'canPickOnChart', 'studyNote'],
  outputs: [
    'scriptErrorChange',
    'testerOpenChange',
    'scriptVisibility',
    'scriptSettings',
    'scriptSource',
    'scriptLogs',
    'scriptAlert',
    'scriptRemove',
    'scriptOpenAt',
    'indicatorToggle',
    'indicatorRemove',
    'paramChange',
    'timePick',
    'scorecard',
    'studySettings',
  ],
});

const TEMPLATE = readFileSync(
  resolve(
    process.cwd(),
    'src/app/features/chart-analysis/pages/chart-analysis-page/chart-studies-strip.component.html',
  ),
  'utf8',
);

// US02b: the studies strip takes the studies as inputs and reports actions as outputs (no page slice).
describe('ChartStudiesStripComponent (US02b inputs/outputs)', () => {
  it('lists a study with its note and inputs, and reports edits, toggles and removal', async () => {
    await resolveJitResources({
      'chart-studies-strip.component.html': TEMPLATE,
      'chart-studies-strip.component.scss': '',
    });
    TestBed.configureTestingModule({ imports: [ChartStudiesStripComponent] });
    const fixture = TestBed.createComponent(ChartStudiesStripComponent);
    const strip = fixture.componentInstance;
    const set = (name: string, value: unknown) => fixture.componentRef.setInput(name, value);
    set('active', [{ uid: 'rsi-1', defId: 'rsi', params: { length: 14 }, visible: true }]);
    set('scriptChips', []);
    set('scriptError', 'Script failed');
    set('testerOpen', false);
    set('canPickOnChart', true);
    set('studyNote', () => 'tick volume');
    const events: unknown[] = [];
    strip.paramChange.subscribe((e) => events.push(['param', e]));
    strip.indicatorToggle.subscribe((e) => events.push(['toggle', e]));
    strip.indicatorRemove.subscribe((e) => events.push(['remove', e]));
    strip.studySettings.subscribe((e) => events.push(['settings', e]));
    const errors: (string | null)[] = [];
    strip.scriptError.subscribe((e) => errors.push(e));
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;

    expect(el.querySelector('.script-error')!.textContent).toContain('Script failed');
    expect(el.querySelector('.study-label')!.textContent).toContain('RSI');
    expect(el.querySelector('.study-note')!.textContent).toBe('tick volume');
    const length = el.querySelector('.study-input input[type="number"]') as HTMLInputElement;
    length.value = '21';
    length.dispatchEvent(new Event('change'));
    (el.querySelector('.study-toggle') as HTMLButtonElement).click();
    (el.querySelector('.study button[aria-label="Settings"]') as HTMLButtonElement).click();
    (el.querySelector('.study button[aria-label="Remove"]') as HTMLButtonElement).click();
    (el.querySelector('.script-error .study-remove') as HTMLButtonElement).click();

    expect(events).toEqual([
      ['param', { uid: 'rsi-1', key: 'length', value: '21' }],
      ['toggle', 'rsi-1'],
      ['settings', 'rsi-1'],
      ['remove', 'rsi-1'],
    ]);
    expect(errors).toEqual([null]);
  });
});
