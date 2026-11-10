import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';

import type { ResponseData } from '@core/api/api.types';
import { ScriptStrategyService } from '@features/scripting/api/script-strategy.service';
import type { PortfolioReadiness } from '@features/scripting/api/scripting-api.types';
import { RefreshButtonComponent } from '@shared/components/refresh-button/refresh-button.component';
import { declareSignalIo } from '@shared/testing/jit-signal-io';
import {
  PortfolioReadinessCardComponent,
  readinessStatusLabel,
  walkForwardText,
} from './portfolio-readiness-card.component';

// b11-portfolio-hardening: a portfolio strategy's readiness — checklist, members (feed + capacity), evidence run, walk-forward.

declareSignalIo(RefreshButtonComponent, { inputs: ['refreshing', 'label', 'variant'], outputs: ['refresh'] });
declareSignalIo(PortfolioReadinessCardComponent, { inputs: ['strategyId', 'portfolioWalkForwardRunId'] });

const readiness = (over: Partial<PortfolioReadiness> = {}): PortfolioReadiness => ({
  strategyId: 9,
  lifecycleStage: 'PaperTrading',
  members: ['EURUSD', 'US500'],
  accountModel: 'Shared',
  mode: 'Paper',
  feeds: [
    { symbol: 'EURUSD', serving: true, instances: 2, newestHeartbeatUtc: new Date().toISOString(), detail: '2 active' },
    { symbol: 'US500', serving: false, instances: 0, newestHeartbeatUtc: null, detail: 'no active EA instance owning US500' },
  ],
  grid: {
    closeAligned: false,
    straddles: 120,
    example: "US500's bar spans EURUSD's close",
    refusal: null,
    detail: 'Straddling (PS9401): exact live only while every member is on ticks',
  },
  evidencePortfolioBacktestRunId: 400,
  evidenceDetail: 'Run 400: 2025-01-01 → 2026-01-01, 80 trades',
  capacity: [
    { symbol: 'EURUSD', capacityCeilingLots: 12.5, estimatedAtUtc: null },
    { symbol: 'US500', capacityCeilingLots: null, estimatedAtUtc: null },
  ],
  estimatedCapacityLots: 12.5,
  paperFills: 12,
  paperClosedTrades: 10,
  paperFirstFillUtc: null,
  holdTimeouts: 1,
  barRevised: 2,
  outOfOrderBars: 3,
  checklist: [
    { key: 'feeds', title: 'Every member symbol has a serving EA feed', status: 'fail', detail: 'US500 has none' },
    { key: 'paper', title: 'Paper trading on every member', status: 'pending', detail: '12 fills' },
    { key: 'drill_restart', title: 'Restart drill', status: 'manual', detail: 'restart' },
  ],
  ready: false,
  ...over,
});

const env = (data: PortfolioReadiness | null, status = true, message = 'Successful'): ResponseData<PortfolioReadiness> => ({
  data,
  status,
  message,
  responseCode: status ? '00' : '-11',
});

describe('PortfolioReadinessCardComponent', () => {
  let fixture: ComponentFixture<PortfolioReadinessCardComponent>;
  let el: HTMLElement;
  let get: ReturnType<typeof vi.fn>;

  function render(answer: ResponseData<PortfolioReadiness>, walkForward?: number | null): void {
    get.mockReturnValue(of(answer));
    fixture = TestBed.createComponent(PortfolioReadinessCardComponent);
    el = fixture.nativeElement as HTMLElement;
    fixture.componentRef.setInput('strategyId', 9);
    if (walkForward !== undefined) fixture.componentRef.setInput('portfolioWalkForwardRunId', walkForward);
    fixture.detectChanges();
    fixture.detectChanges();
  }

  beforeEach(() => {
    get = vi.fn();
    TestBed.configureTestingModule({
      imports: [PortfolioReadinessCardComponent],
      providers: [provideRouter([]), { provide: ScriptStrategyService, useValue: { getPortfolioReadiness: get } }],
    });
  });

  it('renders the checklist, each member with its feed and capacity, and the evidence run', () => {
    render(env(readiness()));
    expect(get).toHaveBeenCalledWith(9);
    expect(el.querySelector('[data-testid="portfolio-ready"]')?.textContent).toContain('Not ready');
    const items = [...el.querySelectorAll('[data-testid="portfolio-checklist"] li')];
    expect(items.map((li) => li.getAttribute('data-key'))).toEqual(['feeds', 'paper', 'drill_restart']);
    expect(items[0].textContent).toContain('Fail');
    expect(items[2].textContent).toContain('Operator drill');
    const rows = [...el.querySelectorAll('[data-testid="portfolio-members"] tbody tr')].map((r) => r.textContent ?? '');
    expect(rows[0]).toContain('EURUSD');
    expect(rows[0]).toContain('2 EA instance(s)');
    expect(rows[0]).toContain('12.5');
    expect(rows[1]).toContain('No serving EA');
    expect(rows[1]).toContain('not estimated');
    const evidence = el.querySelector('[data-testid="portfolio-evidence"] a');
    expect(evidence?.getAttribute('href')).toBe('/portfolio-backtests/400');
    expect(el.querySelector('[data-testid="portfolio-live-record"]')?.textContent).toContain('3 bar(s) out of order');
  });

  it('shows the portfolio walk-forward when the engine sends it, and degrades without it', () => {
    render(env(readiness()), 77);
    expect(el.querySelector('[data-testid="portfolio-walk-forward"]')?.textContent).toContain('#77');
    render(env(readiness()), null);
    expect(el.querySelector('[data-testid="portfolio-walk-forward"]')?.textContent).toContain('None yet');
    render(env(readiness()));
    expect(el.querySelector('[data-testid="portfolio-walk-forward"]')?.textContent).toContain('Not available on this engine build');
  });

  it('says why when the engine refuses', () => {
    render(env(null, false, 'Not a portfolio strategy'));
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('Not a portfolio strategy');
  });

  it('labels every status and walk-forward state', () => {
    expect(readinessStatusLabel('pass').tone).toBe('ok');
    expect(readinessStatusLabel('fail').tone).toBe('bad');
    expect(readinessStatusLabel('pending').tone).toBe('wait');
    expect(readinessStatusLabel('manual').text).toBe('Operator drill');
    expect(readinessStatusLabel('something-new').tone).toBe('info');
    expect(walkForwardText(undefined)).toContain('Not available');
    expect(walkForwardText(null)).toContain('None yet');
    expect(walkForwardText(5)).toBe('Portfolio walk-forward run #5');
  });
});
