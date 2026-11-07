import { Injectable, inject } from '@angular/core';
import { DerivativesDataService } from './derivatives-data.service';
import type { FundamentalPaneId, PanePoint } from './fx-fundamentals';
import {
  cmeBasisSeries,
  cmeBasisSymbol,
  cotSeries,
  emptyNote,
  fundingInstants,
  fundingSeries,
  liquidationSeries,
  notApplicable,
  openInterestChange,
  openInterestSeries,
  paneApplies,
  premiumSeries,
  rollYieldSeries,
  type PaneScope,
} from './market-panes';

/** A pane's lines and, when it drew nothing (or only part), why. */
export interface MarketPaneResult {
  lines: {
    title: string;
    color: string;
    points: PanePoint[];
    precision?: number;
    aggregate?: 'sum';
    kind?: 'histogram';
  }[];
  stepped?: boolean;
  note: string | null;
}

const DAY = 86_400_000;

/**
 * Loads the market panes (UA03) for the chart's window: crypto derivatives, CME basis, futures roll yield, COT. Each
 * result names its unit in the line title and carries the engine's reason when it is empty.
 */
@Injectable({ providedIn: 'root' })
export class MarketPanesService {
  private readonly data = inject(DerivativesDataService);

  async load(
    id: FundamentalPaneId,
    params: Record<string, number | string>,
    scope: PaneScope,
    window: { from: number; to: number },
  ): Promise<MarketPaneResult> {
    if (!paneApplies(id, scope)) return { lines: [], note: notApplicable(id, scope) };
    const s = scope.symbol.toUpperCase();
    switch (id) {
      case 'funding-rate':
      case 'funding-times':
      case 'open-interest':
      case 'liquidations':
        return this.derivativesPane(id, params, scope, window);
      case 'basis':
        if (scope.perpetual) return this.derivativesPane(id, params, scope, window);
        if (cmeBasisSymbol(s)) {
          const a = await this.data.basis(s, window.from, window.to);
          const pts = cmeBasisSeries(a.data?.minutes ?? []);
          return {
            stepped: false,
            note: pts.length ? null : emptyNote('CME basis', s, a.message),
            lines: pts.length
              ? [
                  {
                    title: `CME ${a.data?.root ?? ''} − spot basis (price)`.replace('  ', ' '),
                    color: '#7E57C2',
                    points: pts,
                    precision: 5,
                  },
                ]
              : [],
          };
        }
        return { lines: [], note: notApplicable(id, scope) };
      case 'term-structure': {
        const root = scope.futureRoot!;
        const [curve, stats] = await Promise.all([
          this.data.termStructure(root),
          this.data.futureStatistics(root, window.from - 7 * DAY, window.to),
        ]);
        const last = new Map<string, number>();
        for (const c of curve.data?.curve ?? []) {
          const t = Date.parse(c.lastTradeUtc ?? c.expiryUtc ?? '');
          if (Number.isFinite(t)) last.set(c.contract.toUpperCase(), t);
        }
        const pts = rollYieldSeries(stats.data ?? [], last);
        return {
          note: pts.length
            ? null
            : emptyNote(
                'settlement statistics',
                root,
                stats.ok && !(stats.data ?? []).length
                  ? 'the engine holds no settlements for this root yet'
                  : stats.message,
              ),
          lines: pts.length
            ? [{ title: `${root} roll yield % / yr`, color: '#00897B', points: pts }]
            : [],
        };
      }
      case 'cot': {
        const colors = ['#2962FF', '#EF5350'];
        const answers = await Promise.all(scope.currencies.map((c) => this.data.cot(c)));
        const lines = scope.currencies
          .map((c, i) => ({
            title: `COT ${c} net non-commercial (contracts)`,
            color: colors[i % colors.length],
            points: cotSeries(answers[i].data ?? []),
            precision: 0,
          }))
          .filter((l) => l.points.length);
        const missing = scope.currencies.filter((_, i) => !cotSeries(answers[i].data ?? []).length);
        return {
          lines,
          note: missing.length
            ? `No COT reports ingested for ${missing.join(', ')}${answers.find((a) => !a.ok)?.message ? `: ${answers.find((a) => !a.ok)!.message}` : '.'}`
            : null,
        };
      }
      default:
        return { lines: [], note: notApplicable(id, scope) };
    }
  }

  private async derivativesPane(
    id: FundamentalPaneId,
    params: Record<string, number | string>,
    scope: PaneScope,
    window: { from: number; to: number },
  ): Promise<MarketPaneResult> {
    const s = scope.symbol.toUpperCase();
    if (!scope.sourceId)
      return {
        lines: [],
        note: `No derivatives source for ${s}: the chart's bars do not come from a venue.`,
      };
    const to = Math.min(window.to, Date.now());
    const a = await this.data.derivatives(s, scope.sourceId, window.from, to);
    const minutes = a.data?.minutes ?? [];
    if (!minutes.length) return { lines: [], note: emptyNote('derivatives data', s, a.message) };
    const partial =
      window.from < minutes[0].t - 3_600_000
        ? `Derivatives history from ${new Date(minutes[0].t).toISOString().slice(0, 10)} only (the engine stores it from then, read up to 28 days).`
        : null;
    switch (id) {
      case 'funding-rate': {
        const pts = fundingSeries(minutes);
        return {
          note: pts.length ? partial : emptyNote('funding readings', s, a.message),
          lines: pts.length
            ? [{ title: 'Funding % / interval', color: '#FF6D00', points: pts, precision: 4 }]
            : [],
        };
      }
      case 'funding-times': {
        const pts = fundingInstants(minutes);
        return {
          stepped: false,
          note: pts.length ? partial : emptyNote('funding instants in the window', s, a.message),
          lines: pts.length
            ? [
                {
                  title: 'Funding charged % / interval',
                  color: '#FF6D00',
                  points: pts,
                  precision: 4,
                  aggregate: 'sum',
                  kind: 'histogram',
                },
              ]
            : [],
        };
      }
      case 'open-interest': {
        const oi = openInterestSeries(minutes);
        const windowMinutes = Number(params['windowMinutes']) || 60;
        return {
          stepped: false,
          note: oi.length ? partial : emptyNote('open-interest readings', s, a.message),
          lines: oi.length
            ? [
                { title: 'Open interest', color: '#2962FF', points: oi, precision: 2 },
                {
                  title: `OI change % (${windowMinutes} min)`,
                  color: '#AB47BC',
                  points: openInterestChange(minutes, windowMinutes),
                  precision: 2,
                },
              ]
            : [],
        };
      }
      case 'basis': {
        const pts = premiumSeries(minutes);
        return {
          stepped: false,
          note: pts.length ? partial : emptyNote('mark and index prices', s, a.message),
          lines: pts.length
            ? [{ title: 'Premium % (mark − index)', color: '#7E57C2', points: pts, precision: 4 }]
            : [],
        };
      }
      default: {
        const { buy, sell } = liquidationSeries(minutes);
        return {
          stepped: false,
          note: partial,
          lines: [
            {
              title: 'Liquidated shorts (quote)',
              color: '#26A69A',
              points: buy,
              precision: 0,
              aggregate: 'sum',
              kind: 'histogram',
            },
            {
              title: 'Liquidated longs (quote)',
              color: '#EF5350',
              points: sell,
              precision: 0,
              aggregate: 'sum',
              kind: 'histogram',
            },
          ],
        };
      }
    }
  }
}
