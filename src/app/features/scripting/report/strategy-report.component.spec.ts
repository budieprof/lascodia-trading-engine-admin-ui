import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { AgGridAngular } from 'ag-grid-angular';

import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';

import { StrategyReportComponent } from './strategy-report.component';
import { ReportOverviewComponent } from './report-overview.component';
import { ReportSplitTableComponent } from './report-split-table.component';
import { ReportMetricListComponent } from './report-metric-list.component';
import { ReportTradesGridComponent } from './report-trades-grid.component';
import { ReportMonthlyHeatmapComponent } from './report-monthly-heatmap.component';
import { ReportPropertiesComponent } from './report-properties.component';
import { MINUS } from './report-format';
import { strategyReportFixture, toPascalCaseKeys } from '../testing/strategy-report.fixture';
import { declareSignalIo } from '@shared/testing/jit-signal-io';
import { AgGridStubComponent, ChartCardStubComponent } from '../testing/stubs';

declareSignalIo(StrategyReportComponent, { inputs: ['report', 'backtestRunId', 'heading'] });
declareSignalIo(ReportOverviewComponent, { inputs: ['report', 'currency', 'palette'] });
declareSignalIo(ReportSplitTableComponent, { inputs: ['groups', 'splits', 'currency', 'caption'] });
declareSignalIo(ReportMetricListComponent, { inputs: ['groups', 'report', 'currency'] });
declareSignalIo(ReportTradesGridComponent, { inputs: ['trades', 'currency'] });
declareSignalIo(ReportMonthlyHeatmapComponent, {
  inputs: ['monthlyReturns', 'palette', 'currency'],
});
declareSignalIo(ReportPropertiesComponent, { inputs: ['report', 'currency'] });

const EXPORT_URL = 'http://test/api/v1/lascodia-trading-engine/backtest/812/export';

describe('StrategyReportComponent', () => {
  let fixture: ComponentFixture<StrategyReportComponent>;
  let http: HttpTestingController;
  let el: HTMLElement;

  function render(report: unknown, runId: number | null = null): void {
    fixture = TestBed.createComponent(StrategyReportComponent);
    fixture.componentRef.setInput('report', report);
    fixture.componentRef.setInput('backtestRunId', runId);
    fixture.detectChanges();
    el = fixture.nativeElement as HTMLElement;
  }

  const text = (selector: string) =>
    [...el.querySelectorAll(selector)].map((n) => n.textContent!.replace(/\s+/g, ' ').trim());

  function openTab(label: string): void {
    const tab = [...el.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((b) =>
      b.textContent!.trim().startsWith(label),
    )!;
    tab.click();
    fixture.detectChanges();
  }

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [StrategyReportComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: RUNTIME_CONFIG, useValue: { apiBaseUrl: 'http://test' } },
      ],
    });
    for (const cmp of [StrategyReportComponent, ReportOverviewComponent]) {
      TestBed.overrideComponent(cmp, {
        remove: { imports: [ChartCardComponent] },
        add: { imports: [ChartCardStubComponent] },
      });
    }
    TestBed.overrideComponent(ReportTradesGridComponent, {
      remove: { imports: [AgGridAngular] },
      add: { imports: [AgGridStubComponent] },
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    vi.restoreAllMocks();
  });

  it('renders the headline statistics from the engine’s report', () => {
    render(strategyReportFixture());
    expect(el.querySelector('.title')!.textContent).toContain('Strategy report');
    expect(el.querySelector('.meta')!.textContent).toContain(
      'EURUSD · 60 · 2025-01-02 → 2026-01-09 UTC',
    );
    const tiles = text('.tile');
    expect(tiles[0]).toContain('Total P&L');
    expect(tiles[0]).toContain('+606.20 USD');
    expect(tiles[1]).toContain('65.80 USD');
    expect(tiles[2]).toContain('6');
    expect(tiles[2]).toContain('1 still open');
    expect(tiles[3]).toContain('66.67%');
    expect(tiles[4]).toContain('6.967');
    expect(tiles[5]).toContain('Open P&L');
    // The equity chart gets a real options object, not the empty state.
    expect(el.querySelector('.chart-stub')!.getAttribute('data-title')).toBe('Equity');
    expect(el.querySelector('.chart-stub-empty')).toBeNull();
  });

  it('reads a PascalCase report and JSON text the same way', () => {
    render(JSON.stringify(toPascalCaseKeys(strategyReportFixture())));
    expect(text('.tile')[0]).toContain('+606.20 USD');
  });

  it('shows engine warnings, risk halts and margin calls above the tabs', () => {
    const raw = strategyReportFixture();
    raw['meta']['riskHalted'] = true;
    raw['meta']['riskHaltReason'] = 'strategy.risk.max_drawdown(5%) reached';
    raw['capital']['marginCalls'] = 2;
    raw['capital']['liquidatedQty'] = 4000;
    raw['meta']['trimmedTrades'] = 120;
    render(raw);
    const notices = text('.notice');
    expect(notices[0]).toContain('Halted');
    expect(notices[0]).toContain('max_drawdown(5%)');
    expect(notices[1]).toContain('2 margin calls');
    expect(notices[1]).toContain('liquidated 4,000 units');
    expect(notices[2]).toContain('120 oldest closed trades');
    expect(notices[3]).toContain('PS9101');
  });

  it('switches tabs with the mouse and the keyboard, keeping ARIA state in sync', () => {
    render(strategyReportFixture());
    openTab('Performance');
    const selected = el.querySelector('[role="tab"][aria-selected="true"]')!;
    expect(selected.textContent).toContain('Performance');
    const panel = el.querySelector('[role="tabpanel"]')!;
    expect(panel.getAttribute('aria-labelledby')).toBe(selected.id);
    const netRow = [...el.querySelectorAll('tbody tr')].find((r) =>
      r.textContent!.includes('Net profit'),
    )!;
    expect(netRow.textContent).toContain('+606.20 USD');
    expect(netRow.textContent).toContain('+700.60 USD');
    expect(netRow.textContent).toContain(`${MINUS}94.40 USD`);

    selected.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    fixture.detectChanges();
    expect(el.querySelector('[role="tab"][aria-selected="true"]')!.textContent).toContain(
      'Trades analysis',
    );
  });

  it('lists every trade, and the pills narrow it to the open one', () => {
    render(strategyReportFixture());
    openTab('List of trades');
    expect(el.querySelector('.grid-stub')!.getAttribute('data-rows')).toBe('7');
    const open = [...el.querySelectorAll<HTMLButtonElement>('.pill')].find((b) =>
      b.textContent!.includes('Open'),
    )!;
    open.click();
    fixture.detectChanges();
    expect(el.querySelector('.grid-stub')!.getAttribute('data-rows')).toBe('1');
    expect(el.querySelector('.grid-stub-row')!.textContent).toContain('"isOpen":true');
  });

  it('renders risk, capital, monthly returns and properties tabs', () => {
    render(strategyReportFixture());
    openTab('Risk & returns');
    expect(el.textContent).toContain('Sortino ratio');
    expect(el.textContent).toContain('1.874');
    openTab('Capital efficiency');
    expect(el.textContent).toContain('Account size required');
    expect(el.textContent).toContain('412.45 USD');
    // Max contracts held is a Pine quantity: units of the underlying.
    expect(el.textContent).toContain('10,000 units');
    openTab('Monthly returns');
    const rows = el.querySelectorAll('.wrap tbody tr');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('+4.94%');
    expect(rows[0].textContent).toContain('+6.06%');
    openTab('Properties');
    expect(el.textContent).toContain('Cash per order');
    expect(el.textContent).toContain('10,000 units · Fixed');
  });

  it('offers no export for a report that is not a backtest run', () => {
    render(strategyReportFixture());
    expect(el.querySelector('.exports')).toBeNull();
  });

  it('downloads the engine’s CSV export for a backtest run', async () => {
    const createUrl = vi.fn(() => 'blob:report');
    Object.assign(URL, { createObjectURL: createUrl, revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render(strategyReportFixture(), 812);

    const csvBtn = [...el.querySelectorAll<HTMLButtonElement>('.exports .btn')][0];
    csvBtn.click();
    fixture.detectChanges();
    expect(csvBtn.textContent).toContain('Exporting');

    const req = http.expectOne((r) => r.url === EXPORT_URL);
    expect(req.request.params.get('format')).toBe('csv');
    expect(req.request.withCredentials).toBe(true);
    req.flush(new Blob(['Metric,All\n'], { type: 'text/csv' }), {
      headers: {
        'content-type': 'text/csv',
        'content-disposition': 'attachment; filename="backtest-812.csv"',
      },
    });
    await fixture.whenStable();
    await new Promise((r) => setTimeout(r, 0));
    fixture.detectChanges();

    expect(createUrl).toHaveBeenCalled();
    expect(click).toHaveBeenCalled();
    expect(csvBtn.textContent).toContain('Export CSV');
    expect(el.querySelector('.export-error')).toBeNull();
  });

  it('shows the engine’s reason when the export answers with an envelope', async () => {
    render(strategyReportFixture(), 812);
    [...el.querySelectorAll<HTMLButtonElement>('.exports .btn')][1].click();
    const req = http.expectOne((r) => r.url === EXPORT_URL);
    expect(req.request.params.get('format')).toBe('xlsx');
    req.flush(
      new Blob(
        [
          JSON.stringify({
            data: null,
            status: false,
            message: 'BacktestRun is Running, not Completed',
            responseCode: '-11',
          }),
        ],
        { type: 'application/json' },
      ),
      { headers: { 'content-type': 'application/json; charset=utf-8' } },
    );
    await fixture.whenStable();
    await new Promise((r) => setTimeout(r, 0));
    fixture.detectChanges();
    expect(el.querySelector('[role="alert"]')!.textContent).toContain(
      'BacktestRun is Running, not Completed',
    );
  });

  it('says so when the run carries something that is not a report', () => {
    render(JSON.stringify({ TotalReturn: 1, Trades: [] }));
    expect(el.querySelector('.unreadable')).not.toBeNull();
    expect(el.querySelector('.report')).toBeNull();
  });
});
