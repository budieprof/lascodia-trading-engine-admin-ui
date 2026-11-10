import { describe, expect, it, beforeEach } from 'vitest';
import { Component, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';

import { StrategyConfigTabsComponent, type StrategyFormTab } from './strategy-config-tabs.component';

// b10-ui: the strategy form's Risk / Sizing / Filters / Gates tabs, rendered inside a [formGroup] as the form renders
// them: each editor binds to the form's own control, and a script's Sizing tab explains the script sizes itself (D126).

@Component({
  standalone: true,
  imports: [ReactiveFormsModule, StrategyConfigTabsComponent],
  template: `
    <form [formGroup]="form">
      <app-strategy-config-tabs [tab]="tab()" [scriptAuthoring]="script()" [strategyTimeframe]="'H1'" />
    </form>
  `,
})
class HostComponent {
  readonly tab = signal<StrategyFormTab>('risk');
  readonly script = signal(false);
  form = new FormGroup({
    riskOverridesJson: new FormControl(''),
    sizingConfigJson: new FormControl('{"mode":"FixedLot","value":0.1}'),
    sessionFilterJson: new FormControl(''),
    regimeGateJson: new FormControl(''),
    multiTimeframeGateJson: new FormControl(''),
  });
}

describe('StrategyConfigTabsComponent', () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HTMLElement;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [HostComponent] });
    fixture = TestBed.createComponent(HostComponent);
    host = fixture.nativeElement as HTMLElement;
  });

  const editors = () =>
    Array.from(host.querySelectorAll('app-sub-config-editor')).map((e) => e.getAttribute('formcontrolname'));
  const show = (tab: StrategyFormTab, script = false) => {
    fixture.componentInstance.tab.set(tab);
    fixture.componentInstance.script.set(script);
    fixture.detectChanges();
  };

  it('renders each tab’s editors, bound to the enclosing form’s controls', () => {
    show('risk');
    expect(editors()).toEqual(['riskOverridesJson']);
    show('filters');
    expect(editors()).toEqual(['sessionFilterJson']);
    show('gates');
    expect(editors()).toEqual(['regimeGateJson', 'multiTimeframeGateJson']);
    show('inputs');
    expect(editors()).toEqual([]);
  });

  it('a script’s Sizing tab explains the script sizes itself — no sizing config to type (D126)', () => {
    show('sizing');
    expect(editors()).toEqual(['sizingConfigJson']);
    expect(host.querySelector('[data-testid="script-sizing-note"]')).toBeNull();
    show('sizing', true);
    expect(editors()).toEqual([]);
    expect(host.querySelector('[data-testid="script-sizing-note"]')?.textContent).toContain('qty = 100000');
  });
});
