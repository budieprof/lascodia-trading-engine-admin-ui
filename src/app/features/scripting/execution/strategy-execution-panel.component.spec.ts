import { beforeEach, describe, expect, it } from 'vitest';
import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  Input,
  Output,
  ViewChild,
  signal,
} from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';

import { AuthService } from '@core/auth/auth.service';

import { StrategyExecutionPanelComponent } from './strategy-execution-panel.component';
import { AccountBindingsEditorComponent } from './account-bindings-editor.component';
import { ExecutionPolicyCardComponent } from './execution-policy-card.component';
import { NewsBlackoutExemptionCardComponent } from './news-blackout-exemption-card.component';
import { declareSignalIo } from '@shared/testing/jit-signal-io';

declareSignalIo(StrategyExecutionPanelComponent, { inputs: ['strategy'], outputs: ['changed'] });
// The panel's viewChild() queries, declared the way the CLI's JIT transform would (see
// declareSignalIo) — without it the JIT compiler never sees them.
for (const [prop, type] of [
  ['bindingsEditor', AccountBindingsEditorComponent],
  ['exemptionCard', NewsBlackoutExemptionCardComponent],
] as const) {
  (ViewChild as unknown as (t: unknown, o: object) => PropertyDecorator)(type, { isSignal: true })(
    StrategyExecutionPanelComponent.prototype,
    prop,
  );
}

// Each stub also answers to the real component's token, so the panel's view queries find it.
@Component({
  selector: 'app-account-bindings-editor',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.Eager,
  template: '',
  providers: [{ provide: AccountBindingsEditorComponent, useExisting: BindingsStubComponent }],
})
class BindingsStubComponent {
  @Input() strategyId = 0;
  @Input() isScript = false;
  @Input() symbol: string | null = null;
  @Input() strategyName: string | null = null;
  @Input() readOnly = false;
  @Output() saved = new EventEmitter<void>();
  readonly dirty = signal(false);
}

@Component({
  selector: 'app-execution-policy-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.Eager,
  template: '',
})
class PolicyStubComponent {
  @Input() strategyId = 0;
  @Input() policy: string | null = null;
  @Input() isScript = false;
  @Input() readOnly = false;
  @Output() policyChanged = new EventEmitter<string>();
}

@Component({
  selector: 'app-news-blackout-exemption-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '',
  providers: [{ provide: NewsBlackoutExemptionCardComponent, useExisting: ExemptionStubComponent }],
})
class ExemptionStubComponent {
  @Input() strategyId = 0;
  @Input() strategyName: string | null = null;
  @Input() exempt = false;
  @Input() readOnly = false;
  @Output() changed = new EventEmitter<boolean>();
  readonly draft = signal<boolean | null>(null);
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

  let canOperate = true;

  beforeEach(() => {
    canOperate = true;
    TestBed.configureTestingModule({
      imports: [StrategyExecutionPanelComponent],
      providers: [{ provide: AuthService, useValue: { hasPermission: () => canOperate } }],
    });
    TestBed.overrideComponent(StrategyExecutionPanelComponent, {
      remove: {
        imports: [
          AccountBindingsEditorComponent,
          ExecutionPolicyCardComponent,
          NewsBlackoutExemptionCardComponent,
        ],
      },
      add: { imports: [BindingsStubComponent, PolicyStubComponent, ExemptionStubComponent] },
    });
  });

  const exemptionCard = () =>
    fixture.debugElement.query((d) => d.name === 'app-news-blackout-exemption-card')
      ?.componentInstance as ExemptionStubComponent | undefined;

  it('offers the news-blackout exemption on a script strategy, with its current state', () => {
    render({ authoringMode: 'Script', newsBlackoutExempt: true });
    expect(exemptionCard()?.strategyId).toBe(41);
    expect(exemptionCard()?.strategyName).toBe('S');
    expect(exemptionCard()?.exempt).toBe(true);
  });

  it('reads an engine that sends no flag as not exempt', () => {
    render({ authoringMode: 'Script' });
    expect(exemptionCard()?.exempt).toBe(false);
  });

  it('has no exemption for a non-script strategy (the engine refuses one)', () => {
    render({ authoringMode: 'Dsl', newsBlackoutExempt: true });
    expect(exemptionCard()).toBeUndefined();
  });

  it('re-emits an exemption change so the page re-reads the strategy', () => {
    render({ authoringMode: 'Script' });
    let count = 0;
    fixture.componentInstance.changed.subscribe(() => count++);
    exemptionCard()!.changed.emit(true);
    expect(count).toBe(1);
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
  it('PE-I13: hands every card read-only without operator access', () => {
    canOperate = false;
    render({ authoringMode: 'Script' });
    const editor = fixture.debugElement.query((d) => d.name === 'app-account-bindings-editor')
      .componentInstance as BindingsStubComponent;
    const policy = fixture.debugElement.query((d) => d.name === 'app-execution-policy-card')
      .componentInstance as PolicyStubComponent;
    expect(editor.readOnly).toBe(true);
    expect(policy.readOnly).toBe(true);
    expect(exemptionCard()!.readOnly).toBe(true);
  });

  it('PE-I13: lets an operator change them', () => {
    render({ authoringMode: 'Script' });
    const editor = fixture.debugElement.query((d) => d.name === 'app-account-bindings-editor')
      .componentInstance as BindingsStubComponent;
    expect(editor.readOnly).toBe(false);
    expect(exemptionCard()!.readOnly).toBe(false);
  });

  it('PE-14: reports unsaved binding or exemption edits to the page', () => {
    render({ authoringMode: 'Script' });
    const panel = fixture.componentInstance;
    const editor = fixture.debugElement.query((d) => d.name === 'app-account-bindings-editor')
      .componentInstance as BindingsStubComponent;
    expect(panel.hasUnsavedChanges()).toBe(false);
    editor.dirty.set(true);
    expect(panel.hasUnsavedChanges()).toBe(true);
    editor.dirty.set(false);
    exemptionCard()!.draft.set(true);
    expect(panel.hasUnsavedChanges()).toBe(true);
  });
});
