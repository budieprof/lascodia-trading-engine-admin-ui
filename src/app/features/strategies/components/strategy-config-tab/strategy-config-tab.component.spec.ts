import { describe, expect, it } from 'vitest';
import { Component, EventEmitter, Input, Output } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { declareSignalIo } from '@shared/testing/jit-signal-io';
import { StatusBadgeComponent } from '@shared/components/status-badge/status-badge.component';
import { StrategyScriptCardComponent } from '@features/scripting/components/strategy-script-card/strategy-script-card.component';
import { FirstStrategyChecklistComponent } from '@features/scripting/onboarding/first-strategy-checklist.component';
import { StrategyConfigTabComponent } from './strategy-config-tab.component';

declareSignalIo(StrategyConfigTabComponent, {
  inputs: [
    'strategy',
    'isScript',
    'totalSignals',
    'totalOrders',
    'totalOptimizations',
    'totalBacktests',
    'totalWalkForwards',
    'recentSignals',
    'recentOrders',
    'canOperate',
    'canStartPaper',
  ],
  outputs: ['openTab', 'checklistAction', 'editRequested', 'executionRequested'],
});

declareSignalIo(StatusBadgeComponent, { inputs: ['status', 'type'] });

@Component({ selector: 'app-strategy-script-card', standalone: true, template: '<i>script</i>' })
class ScriptCardStub {
  @Input() strategy: unknown;
  @Output() editRequested = new EventEmitter<void>();
  @Output() executionRequested = new EventEmitter<void>();
}

@Component({ selector: 'app-first-strategy-checklist', standalone: true, template: '<i>checklist</i>' })
class ChecklistStub {
  @Input() strategy: unknown;
  @Input() backtests: unknown;
  @Input() canOperate: unknown;
  @Input() canStartPaper: unknown;
  @Output() actionRequested = new EventEmitter<string>();
}

const strategy = (over: Record<string, unknown> = {}) => ({
  id: 77,
  name: 'Mean reversion',
  symbol: 'EURUSD',
  timeframe: 'H1',
  strategyType: 'LlmProposal',
  status: 'Active',
  riskProfileId: 3,
  createdAt: new Date(Date.now() - 3 * 86_400_000 - 60_000).toISOString(),
  parametersJson: JSON.stringify({ period: 14, band: null, mode: 'fast', nested: { a: 1 } }),
  ...over,
});

function render(inputs: Record<string, unknown>) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ imports: [StrategyConfigTabComponent] });
  TestBed.overrideComponent(StrategyConfigTabComponent, {
    remove: { imports: [StrategyScriptCardComponent, FirstStrategyChecklistComponent] },
    add: { imports: [ScriptCardStub, ChecklistStub] },
  });
  const fixture = TestBed.createComponent(StrategyConfigTabComponent);
  for (const [k, v] of Object.entries(inputs)) fixture.componentRef.setInput(k, v);
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement };
}

describe('StrategyConfigTabComponent (U13 split, behaviour unchanged)', () => {
  it('shows the KPI strip, details and the set parameters (unset ones counted, not listed)', () => {
    const { el } = render({
      strategy: strategy(),
      totalSignals: 12,
      totalOrders: 4,
      totalOptimizations: null,
      totalBacktests: 7,
      totalWalkForwards: 2,
    });
    const kpis = [...el.querySelectorAll('.cfg-kpi')].map(
      (k) =>
        `${k.querySelector('.cfg-kpi-label')!.textContent!.trim()} ${k.querySelector('.cfg-kpi-value')!.textContent!.trim()}`,
    );
    expect(kpis[0]).toBe('Signals 12');
    expect(kpis[2]).toBe('Optim. runs —');
    expect(kpis[3]).toBe('Backtests 7');
    expect(kpis[5]).toBe('Days alive 3');
    expect(kpis[7]).toBe('Risk profile #3');
    expect(el.textContent).toContain('LLM Proposal');
    expect(el.textContent).toContain('#77');
    const params = [...el.querySelectorAll('.param-item dt')].map((d) => d.textContent);
    expect(params).toEqual(['period', 'mode', 'nested']);
    expect(el.textContent).toContain('3 set');
    expect(el.textContent).toContain('1 unset hidden');
    expect(el.querySelector('.code-block')!.textContent).toContain('"period": 14');
    expect(el.textContent).toContain('No signals generated yet.');
    expect(el.textContent).toContain('No orders placed yet.');
    // Not a script strategy: no checklist, no script card.
    expect(el.textContent).not.toContain('checklist');
    expect(el.textContent).not.toContain('script');
  });

  it('opens the matching tab from a KPI card', () => {
    const { fixture, el } = render({ strategy: strategy() });
    const opened: string[] = [];
    fixture.componentInstance.openTab.subscribe((t) => opened.push(t));
    const cards = el.querySelectorAll<HTMLButtonElement>('button.cfg-kpi');
    cards.forEach((c) => c.click());
    expect(opened).toEqual(['signals', 'orders', 'optimization', 'backtests', 'walkforward']);
  });

  it('lists recent signals and orders', () => {
    const { el } = render({
      strategy: strategy({ parametersJson: null }),
      recentSignals: [
        { id: 1, generatedAt: new Date().toISOString(), direction: 'Buy', entryPrice: 1.1, confidence: 0.81, status: 'Executed' },
      ],
      recentOrders: [
        { id: 2, createdAt: new Date().toISOString(), orderType: 'Market', quantity: 0.1, price: 1.10005, status: 'Filled' },
      ],
    });
    const rows = el.querySelectorAll('.mini-table tbody tr');
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector('.profit')!.textContent!.trim()).toBe('Buy');
    expect(rows[0].textContent).toContain('1.10000');
    expect(rows[0].textContent).toContain('81');
    expect(rows[1].textContent).toContain('0.10');
    expect(rows[1].textContent).toContain('1.10005');
    expect(el.textContent).toContain('No tunable parameters defined.');
  });

  it('a script strategy gets the checklist and the script card, whose actions it forwards', () => {
    const { fixture, el } = render({ strategy: strategy(), isScript: true });
    expect(el.textContent).toContain('checklist');
    expect(el.textContent).toContain('script');
    const events: string[] = [];
    const cmp = fixture.componentInstance;
    cmp.checklistAction.subscribe((a) => events.push(`checklist:${a}`));
    cmp.editRequested.subscribe(() => events.push('edit'));
    cmp.executionRequested.subscribe(() => events.push('execution'));
    const stubs = fixture.debugElement;
    const checklist = stubs.query((d) => d.componentInstance instanceof ChecklistStub)
      .componentInstance as ChecklistStub;
    const card = stubs.query((d) => d.componentInstance instanceof ScriptCardStub)
      .componentInstance as ScriptCardStub;
    checklist.actionRequested.emit('backtest');
    card.editRequested.emit();
    card.executionRequested.emit();
    expect(events).toEqual(['checklist:backtest', 'edit', 'execution']);
  });
});
