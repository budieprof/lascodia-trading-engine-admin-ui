import { beforeEach, describe, expect, it } from 'vitest';
import { Component, EventEmitter, Input, Output } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';

import { StrategyExecutionPanelComponent } from './strategy-execution-panel.component';
import { AccountBindingsEditorComponent } from './account-bindings-editor.component';
import { ExecutionPolicyCardComponent } from './execution-policy-card.component';
import { declareSignalIo } from '../testing/jit-signal-io';

declareSignalIo(StrategyExecutionPanelComponent, { inputs: ['strategy'], outputs: ['changed'] });

@Component({ selector: 'app-account-bindings-editor', standalone: true, template: '' })
class BindingsStubComponent {
  @Input() strategyId = 0;
  @Input() isScript = false;
  @Input() symbol: string | null = null;
  @Input() strategyName: string | null = null;
  @Output() saved = new EventEmitter<void>();
}

@Component({ selector: 'app-execution-policy-card', standalone: true, template: '' })
class PolicyStubComponent {
  @Input() strategyId = 0;
  @Input() policy: string | null = null;
  @Input() isScript = false;
  @Output() policyChanged = new EventEmitter<string>();
}

describe('StrategyExecutionPanelComponent', () => {
  let fixture: ComponentFixture<StrategyExecutionPanelComponent>;
  let el: HTMLElement;

  function render(strategy: Record<string, unknown>): void {
    fixture = TestBed.createComponent(StrategyExecutionPanelComponent);
    fixture.componentRef.setInput('strategy', { id: 41, name: 'S', symbol: 'EURUSD', ...strategy });
    fixture.detectChanges();
    el = fixture.nativeElement as HTMLElement;
  }

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [StrategyExecutionPanelComponent] });
    TestBed.overrideComponent(StrategyExecutionPanelComponent, {
      remove: { imports: [AccountBindingsEditorComponent, ExecutionPolicyCardComponent] },
      add: { imports: [BindingsStubComponent, PolicyStubComponent] },
    });
  });

  it('explains that a script strategy with no binding never trades live', () => {
    render({ authoringMode: 'Script', executionPolicy: 'Direct' });
    const banner = el.querySelector('[role="note"]')!.textContent!.replace(/\s+/g, ' ');
    expect(banner).toContain('trades only on its enabled bound accounts');
    expect(banner).toContain('never trades live');
    expect(banner).not.toContain('This strategy is not a script');
  });

  it('warns that an unbound non-script strategy trades on every account', () => {
    render({ authoringMode: 'Dsl', executionPolicy: 'Standard' });
    const banner = el.querySelector('[role="note"]')!.textContent!.replace(/\s+/g, ' ');
    expect(banner).toContain('every account whose EA streams EURUSD');
    expect(banner).toContain('REAL accounts included');
  });

  it('hands the strategy to the editor and the policy card', () => {
    render({ authoringMode: 'Script', executionPolicy: 1 });
    const editor = fixture.debugElement.query((d) => d.name === 'app-account-bindings-editor')
      .componentInstance as BindingsStubComponent;
    const policy = fixture.debugElement.query((d) => d.name === 'app-execution-policy-card')
      .componentInstance as PolicyStubComponent;
    expect(editor.strategyId).toBe(41);
    expect(editor.isScript).toBe(true);
    expect(editor.symbol).toBe('EURUSD');
    expect(policy.policy).toBe('Direct');
  });

  it('re-emits changes so the page can re-read the strategy', () => {
    render({ authoringMode: 'Script' });
    let count = 0;
    fixture.componentInstance.changed.subscribe(() => count++);
    const editor = fixture.debugElement.query((d) => d.name === 'app-account-bindings-editor')
      .componentInstance as BindingsStubComponent;
    editor.saved.emit();
    const policy = fixture.debugElement.query((d) => d.name === 'app-execution-policy-card')
      .componentInstance as PolicyStubComponent;
    policy.policyChanged.emit('Standard');
    expect(count).toBe(2);
  });
});
