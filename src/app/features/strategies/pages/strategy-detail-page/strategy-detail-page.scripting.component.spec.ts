import { beforeEach, describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { EMPTY } from 'rxjs';

import { StrategyDetailPageComponent } from './strategy-detail-page.component';
import { RealtimeService } from '@core/realtime/realtime.service';
import { RUNTIME_CONFIG } from '@core/config/runtime-config';

// ADR-0027 wiring on the strategy detail page: which tabs a strategy gets. Kept in its own spec
// so it never collides with edits to the page's main spec.

describe('StrategyDetailPageComponent (script-strategy tabs)', () => {
  let cmp: StrategyDetailPageComponent;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [StrategyDetailPageComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: RUNTIME_CONFIG, useValue: { apiBaseUrl: 'http://test' } },
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => '41' } } } },
        { provide: RealtimeService, useValue: { on: () => EMPTY } },
      ],
    });
    cmp = TestBed.createComponent(StrategyDetailPageComponent).componentInstance;
  });

  const tabs = () => cmp.visibleDetailTabs().map((t) => t.value);

  it('gives every strategy the Execution tab (bindings + policy)', () => {
    cmp.strategy.set({ id: 41, strategyType: 'RuleBased' } as any);
    expect(tabs()).toContain('execution');
  });

  it('adds the script-only tabs for a script strategy', () => {
    cmp.strategy.set({ id: 41, strategyType: 'RuleBased', authoringMode: 'Script' } as any);
    expect(cmp.isScript()).toBe(true);
    expect(tabs()).toEqual(expect.arrayContaining(['execution', 'live', 'alerts']));
  });

  it('hides them for a DSL strategy', () => {
    cmp.strategy.set({ id: 41, strategyType: 'RuleBased', authoringMode: 'Dsl' } as any);
    expect(cmp.isScript()).toBe(false);
    expect(tabs()).not.toContain('live');
    expect(tabs()).not.toContain('alerts');
    expect(tabs()).toContain('config');
  });
});
