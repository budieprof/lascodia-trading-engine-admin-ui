import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';

import { CurrencyPairsService } from '@core/services/currency-pairs.service';
import { FeatureStateComponent } from '@shared/components/feedback/feature-state.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { declareSignalIo } from '@shared/testing/jit-signal-io';
import { WatchlistService } from '@features/chart-analysis/watchlist/watchlist.service';
import type { ChartWatchlist } from '@features/chart-analysis/watchlist/watchlist.model';
import { ScriptStrategyService } from '@features/scripting/api/script-strategy.service';
import type { ScreenerRequest, ScreenerRow } from '@features/scripting/api/scripting-api.types';

import { BOARD_CHUNK, PlaybookBoardPageComponent } from './playbook-board-page.component';
import { CLOSE_PLOT, PLAYBOOK_SCRIPT_ID } from './playbook-board.model';

declareSignalIo(PageHeaderComponent, { inputs: ['title', 'subtitle'] });
declareSignalIo(FeatureStateComponent, {
  inputs: [
    'title',
    'kind',
    'stateLabel',
    'switchKey',
    'summary',
    'detail',
    'requirements',
    'links',
  ],
});

const ok = <T>(data: T, status = true, message = 'Successful') => ({
  data,
  status,
  message,
  responseCode: status ? '00' : '-11',
});

const VALUES: Record<string, Record<string, number | null>> = {
  EURUSD: {
    decision: 0,
    middle: 1,
    'Best long': 1.09567,
    'Best short': 1.0975,
    'best long class': 2,
    'best short class': 3,
    'best long visits': 5,
    'best long held': 3,
    'best short visits': 2,
    'best short held': 2,
    'D1 bias': -1,
    'H4 bias': -1,
    regime: 2,
    [CLOSE_PLOT]: 1.09708,
  },
  GBPNZD: {
    decision: 1,
    Entry: 2.38997,
    'plan stop': 2.38611,
    'plan target': 2.39588,
    'plan R': 1.53,
    'Best long': 2.38899,
    'Best short': 2.39894,
    'D1 bias': 1,
    'H4 bias': 1,
    regime: 1,
    [CLOSE_PLOT]: 2.39333,
  },
  NZDJPY: {
    decision: -2,
    'Watch short': 87.365,
    'Best long': 87.166,
    'Best short': 87.365,
    regime: 3,
    [CLOSE_PLOT]: 87.178,
  },
};

const pair = (symbol: string, decimalPlaces: number) => ({
  id: 1,
  symbol,
  baseCurrency: symbol.slice(0, 3),
  quoteCurrency: symbol.slice(3),
  decimalPlaces,
  contractSize: 100000,
  minLotSize: 0.01,
  maxLotSize: 100,
  lotStep: 0.01,
  isActive: true,
  assetClass: 'FxMajor',
});

function watchlist(symbols: string[]): ChartWatchlist {
  return {
    id: 0,
    name: 'Watchlist',
    isActive: true,
    sortOrder: 0,
    sections: [
      {
        id: 'fx',
        name: 'FX',
        collapsed: false,
        items: symbols.map((symbol) => ({ symbol, flag: null })),
      },
    ],
  } as unknown as ChartWatchlist;
}

describe('PlaybookBoardPageComponent', () => {
  let fixture: ComponentFixture<PlaybookBoardPageComponent>;
  let runScreener: ReturnType<typeof vi.fn>;
  let lists: ReturnType<typeof signal<ChartWatchlist[]>>;

  const screenerAnswer = (req: ScreenerRequest) =>
    of(
      ok<ScreenerRow[]>(
        req.symbols.map((symbol) =>
          VALUES[symbol]
            ? {
                symbol,
                lastBarTimeMs: Date.UTC(2026, 10, 24, 16),
                values: VALUES[symbol],
                alerts: [],
                error: null,
              }
            : {
                symbol,
                lastBarTimeMs: null,
                values: {},
                alerts: [],
                error: `No ${symbol} 60 bars.`,
              },
        ),
      ),
    );

  async function render(): Promise<HTMLElement> {
    fixture = TestBed.createComponent(PlaybookBoardPageComponent);
    fixture.detectChanges();
    // Not whenStable(): the page's 5-minute re-read interval keeps the zone busy for good.
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  const texts = (el: HTMLElement, testId: string) =>
    Array.from(el.querySelectorAll(`[data-testid="${testId}"]`)).map((n) =>
      (n.textContent ?? '').replace(/\s+/g, ' ').trim(),
    );

  beforeEach(() => {
    localStorage.clear();
    lists = signal<ChartWatchlist[]>([watchlist(['EURUSD', 'GBPNZD', 'NZDJPY', 'AUDNZD'])]);
    runScreener = vi.fn(screenerAnswer);
    TestBed.configureTestingModule({
      imports: [PlaybookBoardPageComponent],
      providers: [
        provideRouter([]),
        { provide: ScriptStrategyService, useValue: { runScreener } },
        {
          provide: WatchlistService,
          useValue: {
            lists,
            active: computed(() => lists().find((l) => l.isActive) ?? lists()[0] ?? null),
            load: () => Promise.resolve(),
          },
        },
        {
          provide: CurrencyPairsService,
          useValue: {
            list: () =>
              of(
                ok({
                  pager: { totalItemCount: 4, currentPage: 1, itemCountPerPage: 400 },
                  data: [
                    pair('EURUSD', 5),
                    pair('GBPNZD', 5),
                    pair('NZDJPY', 3),
                    pair('AUDNZD', 5),
                  ],
                }),
              ),
          },
        },
      ],
    });
  });

  afterEach(() => {
    fixture?.destroy();
    TestBed.resetTestingModule();
  });

  it('runs script #21 by id through the screener (its reading plots are marked for the screener)', async () => {
    await render();
    expect(runScreener).toHaveBeenCalledTimes(1);
    const req = runScreener.mock.calls[0][0] as ScreenerRequest;
    expect(req.chartScriptId).toBe(PLAYBOOK_SCRIPT_ID);
    expect(req.source).toBeUndefined();
    expect(req.symbols).toEqual(['EURUSD', 'GBPNZD', 'NZDJPY', 'AUDNZD']);
    expect(req.timeframe).toBe('H1');
  });

  it('renders one row per pair, actionable first, in plain words', async () => {
    const el = await render();
    expect(texts(el, 'call')).toEqual([
      'TRADE NOW · BUY at 2.38997',
      'WATCH · SELL at 87.365',
      'HOLD',
      'NO READING',
    ]);
    const rows = Array.from(el.querySelectorAll('[data-testid="row"]'));
    expect(rows.map((r) => r.querySelector('.pair a')?.textContent?.trim())).toEqual([
      'GBPNZD',
      'NZDJPY',
      'EURUSD',
      'AUDNZD',
    ]);
    expect(texts(el, 'next').slice(0, 3)).toEqual([
      'trade now',
      'wait for the sell level',
      'mid-range',
    ]);
    const eur = rows[2].textContent!.replace(/\s+/g, ' ');
    expect(eur).toContain('1.09567');
    expect(eur).toContain('reliable (held 3/5) · 14.1 pips below');
    expect(eur).toContain('strong (held 2/2) · 4.2 pips above');
    expect(eur).toContain('Downtrend (daily & 4h)');
    expect(eur).toContain('Ranging: choppy, range-bound');
    expect(rows[0].textContent).toContain('exit 2.38611 if wrong · profit at 2.39588 · 1.5R');
    expect(rows[3].textContent).toContain('No AUDNZD 60 bars.');
    expect(rows[0].querySelector('.pair a')?.getAttribute('href')).toBe(
      '/chart-analysis/GBPNZD?tf=60',
    );
    expect(el.textContent).toContain('Research tool — no proven edge');
    expect(texts(el, 'status')[0]).toContain('Last read');
  });

  it('splits a long list into screener requests of at most one chunk', async () => {
    const many = Array.from({ length: BOARD_CHUNK + 5 }, (_, i) => `SYM${i}`);
    lists.set([watchlist(many)]);
    const el = await render();
    expect(runScreener).toHaveBeenCalledTimes(2);
    expect((runScreener.mock.calls[0][0] as ScreenerRequest).symbols).toHaveLength(BOARD_CHUNK);
    expect((runScreener.mock.calls[1][0] as ScreenerRequest).symbols).toHaveLength(5);
    expect(el.querySelectorAll('[data-testid="row"]')).toHaveLength(BOARD_CHUNK + 5);
  });

  it('shows the engine refusal when the screener refuses every pair', async () => {
    runScreener.mockReturnValue(of(ok(null, false, 'The script does not compile.')));
    const el = await render();
    expect(texts(el, 'error')).toEqual(['The script does not compile.']);
    expect(texts(el, 'call')).toEqual(['NO READING', 'NO READING', 'NO READING', 'NO READING']);
  });

  it('explains an empty watchlist instead of leaving the page blank', async () => {
    lists.set([watchlist([])]);
    const el = await render();
    expect(runScreener).not.toHaveBeenCalled();
    expect(el.querySelector('app-feature-state')).not.toBeNull();
  });
});
