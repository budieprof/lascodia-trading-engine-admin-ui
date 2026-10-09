import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { Component, Input, signal } from '@angular/core';

import { ScriptChipComponent, type ScriptChip } from './script-chip.component';

// Signal inputs cannot be set under the JIT harness before the first render: the spec swaps the
// component's input signal for a writable one before detectChanges, and stands in for the icon
// child (whose signal inputs JIT cannot bind) with a decorator-input stub.

@Component({ selector: 'app-chart-icon', template: '' })
class ChartIconStubComponent {
  @Input() name = '';
  @Input() size = 0;
}

const CHIP: ScriptChip = {
  key: 'mine:7',
  name: 'Squeeze',
  kind: 'indicator',
  placed: true,
  visible: true,
  running: false,
  waitingUntil: null,
  failure: null,
  lastGoodMs: null,
  unavailable: null,
  replay: null,
};

function render(patch: Partial<ScriptChip>) {
  TestBed.configureTestingModule({ imports: [ScriptChipComponent] });
  TestBed.overrideComponent(ScriptChipComponent, { set: { imports: [ChartIconStubComponent] } });
  const fixture = TestBed.createComponent(ScriptChipComponent);
  const cmp = fixture.componentInstance as any;
  const chip = signal<ScriptChip>({ ...CHIP, ...patch });
  cmp.chip = chip;
  fixture.detectChanges();
  const host = fixture.nativeElement as HTMLElement;
  return { fixture, host, chip, cmp };
}

const stateText = (host: HTMLElement) =>
  host.querySelector('[role="status"]')?.textContent?.replace(/\s+/g, ' ').trim() ?? null;

describe('ScriptChipComponent — Bar Replay (PC-08)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('says a script is running to the replay head while its run reaches past it', () => {
    const { host } = render({ replay: 'ahead' });
    expect(stateText(host)).toBe('To the replay head…');
  });

  it('says it is catching up while it shows its run up to an earlier bar', () => {
    const { host, chip, fixture } = render({ replay: 'behind' });
    expect(stateText(host)).toBe('Catching up…');
    // Its run to the head landed.
    chip.set({ ...CHIP, replay: null });
    fixture.detectChanges();
    expect(host.querySelector('[data-testid="script-replay"]')).toBeNull();
  });

  it('an explicit run in flight says so first', () => {
    const { host } = render({ replay: 'behind', running: true });
    expect(stateText(host)).toBe('Updating…');
  });
});

describe('ScriptChipComponent — failures (PC-I7)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('opens the editor at the failing line of the script’s own source', () => {
    const { host, cmp } = render({
      failure: {
        kind: 'error',
        message: 'Unexpected token',
        where: { line: 12, column: 3 },
        unit: null,
        callStack: [],
        atMs: 0,
      },
    });
    const openAt = vi.fn();
    cmp.openAt.subscribe(openAt);
    const line = host.querySelector('button.line') as HTMLButtonElement;
    expect(line.textContent?.trim()).toBe('Line 12');
    line.click();
    expect(openAt).toHaveBeenCalledWith({ line: 12, column: 3 });
  });
});
