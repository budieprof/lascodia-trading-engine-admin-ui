import type { UiCommand, UiCommandOutcome } from '@core/assistant/ui-command.types';
import type { MarketAnalysisResultDto } from '@core/api/api.types';

import type { ChartAlertDto, ChartAlertInput } from '../alerts/chart-alerts.types';
import { conditionFor, describeAlert } from '../alerts/chart-alert-rules';
import type { TicketPrefill } from '../trading/ticket-model';
import { analysisOutcome, recommendationsOf, tradesOf } from './analysis-overlay';
import type { AnalysisRequestMode } from './chart-analysis.types';

/**
 * The assistant's chart tools (SP-I8), as page commands the browser runs (ADR-0026 `ui_action`). They exist only while
 * the chart is mounted — the browser registry is the gate — and every one that changes something (an alert, the
 * watchlist, an AI analysis that costs a call and may arm a watch) is `confirm: true`, so it waits for the operator's
 * click on the card. Reads come back bounded. `chart.proposeTrade` only fills the order ticket: the ticket's own
 * Submit is the operator's decision, and nothing is sent before it.
 *
 * <p>Defined against a narrow surface so the vocabulary is testable without a chart.</p>
 */
export interface AnalysisCommandHost {
  symbol(): string;
  /** The chart resolution, e.g. "60". */
  resolution(): string;
  precision(): number;
  /** The newest close on the chart, for checking a proposed stop's side at market. */
  lastPrice(): number | null;
  /** Bars and every data-window value per bar (chart-host `exportRows`): header row first. Null without a chart. */
  valueRows(): (string | number | null)[][] | null;

  listAlerts(): Promise<ChartAlertDto[]>;
  createAlert(
    input: ChartAlertInput,
  ): Promise<{ ok: boolean; message: string; alert?: ChartAlertDto }>;
  deleteAlert(id: number): Promise<{ ok: boolean; message: string }>;

  /** The chart's active watchlist: its name and symbols. Null when watchlists cannot be read. */
  watchlist(): Promise<{ name: string; symbols: string[]; otherLists: string[] } | null>;
  addToWatchlist(symbol: string): Promise<{ ok: boolean; message: string }>;
  removeFromWatchlist(symbol: string): Promise<{ ok: boolean; message: string }>;

  analyse(
    mode: AnalysisRequestMode,
  ): Promise<{ ok: boolean; message: string; result?: MarketAnalysisResultDto }>;
  proposeTrade(prefill: TicketPrefill): void;
}

/** Most bars `chart.readValues` returns. */
export const MAX_READ_BARS = 100;
/** Most value columns `chart.readValues` returns. */
export const MAX_READ_COLUMNS = 40;
/** Most alerts `chart.alerts.list` returns. */
export const MAX_LIST_ALERTS = 50;
const MAX_TEXT = 600;

const ok = (message: string, data?: unknown): UiCommandOutcome => ({ ok: true, message, data });
const fail = (message: string): UiCommandOutcome => ({ ok: false, message });
const clip = (s: string | null | undefined, n = MAX_TEXT) =>
  !s ? '' : s.length <= n ? s : s.slice(0, n - 1) + '…';

/** A number trimmed to what a reader needs (8 significant digits), keeping the payload small. */
function compact(v: string | number | null): string | number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return v;
  return Number(v.toPrecision(8));
}

/** The price columns every bar has; the rest of the header are study and script values. */
const BAR_COLUMNS = 6; // time, open, high, low, close, volume

/** `chart.readValues`: the last N bars' study and Pine values, bounded. Pure, exported for tests. */
export function readValues(
  rows: (string | number | null)[][] | null,
  args: { bars?: number; match?: string },
): UiCommandOutcome {
  if (!rows || rows.length < 2) return fail('The chart has no bars loaded yet.');
  const n = Math.max(1, Math.min(MAX_READ_BARS, Math.trunc(Number(args.bars ?? 20)) || 20));
  const header = rows[0].map((h) => String(h));
  const match = String(args.match ?? '')
    .trim()
    .toLowerCase();
  const valueCols = header
    .map((name, i) => ({ name, i }))
    .slice(BAR_COLUMNS)
    .filter((c) => !match || c.name.toLowerCase().includes(match));
  if (header.length <= BAR_COLUMNS)
    return fail(
      'No studies or scripts are on the chart, so there are no values to read — only prices.',
    );
  if (valueCols.length === 0)
    return fail(
      `No value matches "${args.match}". On the chart: ${header
        .slice(BAR_COLUMNS)
        .slice(0, 20)
        .join('; ')}.`,
    );
  const kept = valueCols.slice(0, MAX_READ_COLUMNS);
  const body = rows.slice(1).slice(-n);
  const columns = ['time (UTC)', 'close', ...kept.map((c) => c.name)];
  const out = body.map((r) => [r[0], compact(r[4]), ...kept.map((c) => compact(r[c.i] ?? null))]);
  const notes: string[] = [];
  if (valueCols.length > kept.length)
    notes.push(
      `${valueCols.length - kept.length} more value columns left out — narrow with "match".`,
    );
  if (rows.length - 1 < n) notes.push(`Only ${rows.length - 1} bars are loaded.`);
  return ok(
    `Read ${out.length} bars × ${kept.length} values (oldest first).${notes.length ? ' ' + notes.join(' ') : ''}`,
    { columns, rows: out },
  );
}

/** One alert, as the model reads it. */
function alertRow(a: ChartAlertDto, precision: number) {
  return {
    id: a.id,
    status: a.status,
    what: describeAlert(a, precision),
    price: a.price ?? null,
    upperPrice: a.upperPrice ?? null,
    fireCount: a.fireCount,
    lastFiredAt: a.lastFiredAt,
  };
}

/** What an analysis said, bounded, for `chart.analyse`. */
export function analysisSummary(r: MarketAnalysisResultDto) {
  return {
    analysisId: r.llmInvocationId,
    symbol: r.symbol,
    timeframe: r.timeframe,
    outcome: analysisOutcome(r),
    trades: tradesOf(r).map(({ rec }) => ({
      side: rec.action,
      entry: rec.entryPrice,
      stop: rec.stopLoss,
      target: rec.takeProfit,
      confidence: rec.confidence,
      why: clip(rec.rationale, 300),
    })),
    holds: recommendationsOf(r).filter((x) => x.action === 'Hold').length,
    notUsable: (r.rejectedRecommendations ?? []).map((x) => ({
      side: x.recommendation.action,
      reason: clip(x.reasonDetail || x.reasonCode, 200),
    })),
    armedWatchIds: r.armedMonitorIds ?? [],
    text: clip(r.analysis, 1500),
  };
}

/** Why a proposed trade's levels are on the wrong side, or null. */
export function proposeProblem(
  side: 'Buy' | 'Sell',
  entry: number | null,
  stop: number,
  target: number | null,
  last: number | null,
): string | null {
  const ref = entry ?? last;
  if (!(stop > 0)) return 'The stop must be a price.';
  if (ref === null) return null;
  if (side === 'Buy' && stop >= ref) return `A buy's stop must be below the entry (${ref}).`;
  if (side === 'Sell' && stop <= ref) return `A sell's stop must be above the entry (${ref}).`;
  if (target !== null && side === 'Buy' && target <= ref)
    return `A buy's target must be above the entry (${ref}).`;
  if (target !== null && side === 'Sell' && target >= ref)
    return `A sell's target must be below the entry (${ref}).`;
  return null;
}

const MODES: readonly AnalysisRequestMode[] = [
  'spot',
  'limitBuy',
  'limitSell',
  'stopBuy',
  'stopSell',
];

export function analysisCommands(host: AnalysisCommandHost): UiCommand[] {
  return [
    {
      id: 'chart.readValues',
      description:
        'Read the values of the studies and Pine scripts on the chart for the last N bars (the data window, bar by ' +
        'bar). Use this instead of guessing what an indicator shows.',
      params: [
        {
          name: 'bars',
          type: 'number',
          description: `How many recent bars (1-${MAX_READ_BARS}, default 20).`,
        },
        {
          name: 'match',
          type: 'string',
          description: 'Only columns whose name contains this text, e.g. "RSI" or the script name.',
        },
      ],
      run: (a) =>
        readValues(host.valueRows(), { bars: a['bars'] as number, match: a['match'] as string }),
    },
    {
      id: 'chart.alerts.list',
      description: "List the operator's price and drawing alerts on the chart's symbol.",
      run: async () => {
        const all = await host.listAlerts();
        const sym = host.symbol().toUpperCase();
        const mine = all.filter((x) => x.symbol.toUpperCase() === sym);
        const rows = mine.slice(0, MAX_LIST_ALERTS).map((x) => alertRow(x, host.precision()));
        return ok(
          mine.length === 0
            ? `No alerts on ${sym}.`
            : `${mine.length} alert${mine.length === 1 ? '' : 's'} on ${sym}${mine.length > rows.length ? ` (first ${rows.length})` : ''}.`,
          rows,
        );
      },
    },
    {
      id: 'chart.alerts.create',
      description:
        'Create a price alert on the chart symbol: notify in the app when the price crosses a level. Waits for the ' +
        "operator's click.",
      confirm: true,
      params: [
        { name: 'price', type: 'number', description: 'The level.', required: true },
        {
          name: 'direction',
          type: 'enum',
          values: ['above', 'below', 'either'],
          description: 'Crosses above, crosses below, or either way.',
          required: true,
        },
        {
          name: 'side',
          type: 'enum',
          values: ['Bid', 'Ask', 'Mid'],
          description: 'Which price is compared (default Bid, the price the chart draws).',
        },
        { name: 'message', type: 'string', description: 'Optional text for the notification.' },
      ],
      run: async (a) => {
        const price = Number(a['price']);
        if (!(price > 0)) return fail('"price" must be a price.');
        const input: ChartAlertInput = {
          symbol: host.symbol(),
          timeframe: host.resolution(),
          kind: 'Price',
          side: ((a['side'] as string) || 'Bid') as ChartAlertInput['side'],
          condition: conditionFor(a['direction'] as 'above' | 'below' | 'either'),
          price,
          frequency: 'once',
          channels: ['InApp'],
          messageTemplate: (a['message'] as string) || null,
          severity: 'Medium',
        };
        const res = await host.createAlert(input);
        return res.ok && res.alert
          ? ok(
              `Created alert ${res.alert.id}: ${describeAlert(res.alert, host.precision())}.`,
              alertRow(res.alert, host.precision()),
            )
          : fail(res.message);
      },
    },
    {
      id: 'chart.alerts.delete',
      description:
        "Delete one of the operator's chart alerts by id. Waits for the operator's click.",
      confirm: true,
      params: [
        {
          name: 'id',
          type: 'number',
          description: 'The alert id (from chart.alerts.list).',
          required: true,
        },
      ],
      run: async (a) => {
        const res = await host.deleteAlert(Math.trunc(Number(a['id'])));
        return res.ok ? ok(res.message) : fail(res.message);
      },
    },
    {
      id: 'chart.watchlist.list',
      description: "List the symbols on the chart's active watchlist.",
      run: async () => {
        const w = await host.watchlist();
        if (!w) return fail('The watchlists could not be read.');
        return ok(`${w.name}: ${w.symbols.length} symbols.`, w);
      },
    },
    {
      id: 'chart.watchlist.add',
      description: "Add a symbol to the chart's active watchlist. Waits for the operator's click.",
      confirm: true,
      params: [
        {
          name: 'symbol',
          type: 'string',
          description: 'Engine symbol, e.g. GBPUSD.',
          required: true,
        },
      ],
      run: async (a) => {
        const res = await host.addToWatchlist(String(a['symbol']).trim().toUpperCase());
        return res.ok ? ok(res.message) : fail(res.message);
      },
    },
    {
      id: 'chart.watchlist.remove',
      description:
        "Remove a symbol from the chart's active watchlist. Waits for the operator's click.",
      confirm: true,
      params: [
        { name: 'symbol', type: 'string', description: 'The symbol to remove.', required: true },
      ],
      run: async (a) => {
        const res = await host.removeFromWatchlist(String(a['symbol']).trim().toUpperCase());
        return res.ok ? ok(res.message) : fail(res.message);
      },
    },
    {
      id: 'chart.analyse',
      description:
        "Run the engine's AI market analysis on the chart symbol and timeframe and draw its plan on the chart. " +
        '"spot" is the free analysis (trade now / watch / stand aside — a watch it decides on is armed by the ' +
        'engine); the others pin a side and an order type. Costs one AI call; never files a signal. Waits for the ' +
        "operator's click.",
      confirm: true,
      params: [
        {
          name: 'mode',
          type: 'enum',
          values: MODES,
          description:
            'spot | limitBuy (buy on a pullback) | limitSell (sell on a rally) | stopBuy (buy a breakout) | stopSell (sell a breakdown).',
          required: true,
        },
      ],
      run: async (a) => {
        const res = await host.analyse(a['mode'] as AnalysisRequestMode);
        return res.ok && res.result
          ? ok(res.message, analysisSummary(res.result))
          : fail(res.message);
      },
    },
    {
      id: 'chart.proposeTrade',
      description:
        "Fill the chart's order ticket with a proposed trade (side, stop, optional target and entry) for the operator " +
        'to review. It opens in PAPER at market; nothing is sent — the operator checks it and presses Submit.',
      params: [
        {
          name: 'side',
          type: 'enum',
          values: ['Buy', 'Sell'],
          description: 'Buy or Sell.',
          required: true,
        },
        { name: 'stop', type: 'number', description: 'Stop loss price.', required: true },
        { name: 'target', type: 'number', description: 'Take profit price (optional).' },
        {
          name: 'entry',
          type: 'number',
          description: 'Entry for a pending order (optional; default at market).',
        },
      ],
      run: (a) => {
        const side = a['side'] as 'Buy' | 'Sell';
        const stop = Number(a['stop']);
        const target = a['target'] === undefined ? null : Number(a['target']);
        const entry = a['entry'] === undefined ? null : Number(a['entry']);
        const problem = proposeProblem(side, entry, stop, target, host.lastPrice());
        if (problem) return fail(problem);
        host.proposeTrade({ direction: side, entry, stop, target });
        return ok(
          `Opened the order ticket: ${side} ${host.symbol()}, stop ${stop}${target !== null ? `, target ${target}` : ''}` +
            `${entry !== null ? ` (entry ${entry} kept for "At price")` : ''}, in paper at market. Nothing has been ` +
            'sent: the operator reviews the engine checks on the ticket and decides.',
        );
      },
    },
  ];
}
