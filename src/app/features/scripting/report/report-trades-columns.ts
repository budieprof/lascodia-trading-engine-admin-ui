import type { ColDef, ICellRendererParams, ValueGetterParams } from 'ag-grid-community';

import type { ReportTrade } from './strategy-report.model';
import {
  NA,
  formatBars,
  formatDateTime,
  formatMoney,
  formatPercent,
  formatPrice,
  formatQty,
} from './report-format';

/**
 * Column model and filters for the List of trades. Kept apart from the grid component so the
 * column set (what an operator can read about every trade) is unit-tested without a grid.
 */

export type TradeFilter = 'all' | 'long' | 'short' | 'winners' | 'losers' | 'open';

export const TRADE_FILTERS: readonly { id: TradeFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'long', label: 'Long' },
  { id: 'short', label: 'Short' },
  { id: 'winners', label: 'Winners' },
  { id: 'losers', label: 'Losers' },
  { id: 'open', label: 'Open' },
];

export const EXIT_LEG_LABELS: Record<string, string> = {
  TakeProfit: 'take profit',
  StopLoss: 'stop loss',
  Trailing: 'trailing stop',
};

export function filterTrades(trades: readonly ReportTrade[], filter: TradeFilter): ReportTrade[] {
  switch (filter) {
    case 'long':
      return trades.filter((t) => t.direction === 'long');
    case 'short':
      return trades.filter((t) => t.direction === 'short');
    case 'winners':
      return trades.filter((t) => !t.isOpen && (t.profit ?? 0) > 0);
    case 'losers':
      return trades.filter((t) => !t.isOpen && (t.profit ?? 0) < 0);
    case 'open':
      return trades.filter((t) => t.isOpen);
    default:
      return [...trades];
  }
}

export function tradeFilterCounts(trades: readonly ReportTrade[]): Record<TradeFilter, number> {
  const counts: Record<TradeFilter, number> = {
    all: trades.length,
    long: 0,
    short: 0,
    winners: 0,
    losers: 0,
    open: 0,
  };
  for (const t of trades) {
    if (t.direction === 'long') counts.long++;
    else if (t.direction === 'short') counts.short++;
    if (t.isOpen) counts.open++;
    else if ((t.profit ?? 0) > 0) counts.winners++;
    else if ((t.profit ?? 0) < 0) counts.losers++;
  }
  return counts;
}

/** The exit column's text: signal (else id) and the bracket leg that filled; "Open" while open. */
export function exitLabel(t: ReportTrade): string {
  if (t.isOpen) return 'Open';
  const signal = t.exitSignal || t.exitId || NA;
  const leg = EXIT_LEG_LABELS[t.exitLeg] ?? (t.exitLeg ? t.exitLeg : '');
  return leg ? `${signal} · ${leg}` : signal;
}

/**
 * Two stacked lines — a value and its percentage. Only formatted numbers reach this HTML (never
 * script-supplied text), so building it as a string is safe.
 */
function twoLine(main: string, sub: string, tone: '' | 'gain' | 'loss'): string {
  const cls = tone ? ` rpt-${tone}` : '';
  return (
    `<span class="rpt-two-line"><span class="main${cls}">${main}</span>` +
    (sub ? `<span class="sub">${sub}</span>` : '') +
    `</span>`
  );
}

function toneOf(v: number | null): '' | 'gain' | 'loss' {
  if (v === null) return '';
  return v > 0 ? 'gain' : v < 0 ? 'loss' : '';
}

function data(p: { data?: ReportTrade }): ReportTrade | undefined {
  return p.data;
}

export function buildTradeColumns(currency: string, priceDecimals: number): ColDef<ReportTrade>[] {
  const money = (v: number | null, signedPlus = false) =>
    formatMoney(v, currency, { signed: signedPlus });

  return [
    {
      headerName: '#',
      field: 'number',
      width: 72,
      minWidth: 64,
      type: 'numericColumn',
      filter: 'agNumberColumnFilter',
    },
    {
      headerName: 'Type',
      colId: 'type',
      width: 120,
      valueGetter: (p: ValueGetterParams<ReportTrade>) =>
        data(p)?.direction === 'short' ? 'Short' : 'Long',
      cellRenderer: (p: ICellRendererParams<ReportTrade>) => {
        const t = p.data;
        if (!t) return '';
        const dir = t.direction === 'short' ? 'short' : 'long';
        const badge = t.isOpen ? ' <span class="rpt-open-badge">Open</span>' : '';
        return `<span class="rpt-dir rpt-dir-${dir}">${dir === 'short' ? 'Short' : 'Long'}</span>${badge}`;
      },
      filter: 'agTextColumnFilter',
    },
    {
      headerName: 'Entry signal',
      field: 'entrySignal',
      minWidth: 140,
      flex: 1,
      tooltipValueGetter: (p) => (data(p)?.entryId ? `Entry id: ${data(p)!.entryId}` : ''),
      filter: 'agTextColumnFilter',
    },
    {
      headerName: 'Entry time (UTC)',
      field: 'entryTime',
      width: 150,
      valueFormatter: (p) => formatDateTime(p.value ?? null),
      filter: false,
    },
    {
      headerName: 'Entry price',
      field: 'entryPrice',
      width: 116,
      type: 'numericColumn',
      valueFormatter: (p) => formatPrice(p.value ?? null, priceDecimals),
      filter: 'agNumberColumnFilter',
    },
    {
      headerName: 'Exit signal',
      colId: 'exitSignal',
      minWidth: 150,
      flex: 1,
      valueGetter: (p: ValueGetterParams<ReportTrade>) => (data(p) ? exitLabel(data(p)!) : ''),
      tooltipValueGetter: (p) =>
        data(p)?.exitId && !data(p)!.isOpen ? `Exit id: ${data(p)!.exitId}` : '',
      filter: 'agTextColumnFilter',
    },
    {
      headerName: 'Exit time (UTC)',
      field: 'exitTime',
      width: 150,
      valueFormatter: (p) => (p.data?.isOpen ? 'Open' : formatDateTime(p.value ?? null)),
      filter: false,
    },
    {
      headerName: 'Exit price',
      field: 'exitPrice',
      width: 116,
      type: 'numericColumn',
      valueFormatter: (p) => (p.data?.isOpen ? NA : formatPrice(p.value ?? null, priceDecimals)),
      filter: 'agNumberColumnFilter',
    },
    {
      // Pine units (1 contract = 1 unit of the underlying), not broker lots.
      headerName: 'Qty (units)',
      field: 'qty',
      width: 116,
      type: 'numericColumn',
      valueFormatter: (p) => formatQty(p.value ?? null),
      headerTooltip: 'Units of the underlying — 100,000 units is one standard FX lot',
      filter: 'agNumberColumnFilter',
    },
    {
      headerName: 'Profit',
      field: 'profit',
      width: 150,
      type: 'numericColumn',
      cellRenderer: (p: ICellRendererParams<ReportTrade>) =>
        p.data
          ? twoLine(
              money(p.data.profit, true),
              formatPercent(p.data.profitPercent, { signed: true }),
              toneOf(p.data.profit),
            )
          : '',
      filter: 'agNumberColumnFilter',
    },
    {
      headerName: 'Cum. profit',
      field: 'cumulativeProfit',
      width: 150,
      type: 'numericColumn',
      cellRenderer: (p: ICellRendererParams<ReportTrade>) =>
        p.data
          ? twoLine(
              money(p.data.cumulativeProfit, true),
              p.data.cumulativeProfitPercent === null
                ? ''
                : formatPercent(p.data.cumulativeProfitPercent, { signed: true }),
              toneOf(p.data.cumulativeProfit),
            )
          : '',
      filter: 'agNumberColumnFilter',
    },
    {
      headerName: 'Run-up (MFE)',
      field: 'runUp',
      width: 140,
      type: 'numericColumn',
      cellRenderer: (p: ICellRendererParams<ReportTrade>) =>
        p.data ? twoLine(money(p.data.runUp), formatPercent(p.data.runUpPercent), '') : '',
      filter: 'agNumberColumnFilter',
    },
    {
      headerName: 'Drawdown (MAE)',
      field: 'drawdown',
      width: 150,
      type: 'numericColumn',
      cellRenderer: (p: ICellRendererParams<ReportTrade>) =>
        p.data ? twoLine(money(p.data.drawdown), formatPercent(p.data.drawdownPercent), '') : '',
      filter: 'agNumberColumnFilter',
    },
    {
      headerName: 'Bars',
      field: 'barsHeld',
      width: 84,
      type: 'numericColumn',
      valueFormatter: (p) => formatBars(p.value ?? null),
      filter: 'agNumberColumnFilter',
    },
    {
      headerName: 'Commission',
      field: 'commission',
      width: 120,
      type: 'numericColumn',
      valueFormatter: (p) => money(p.value ?? null),
      filter: 'agNumberColumnFilter',
    },
  ];
}
