import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import type { ScriptDeclaration, ScriptStrategyProperties } from '@core/api/scripting.types';

interface PropRow {
  label: string;
  value: string;
  /** Differs from the Pine default — worth a second look. */
  set?: boolean;
}

const QTY_TYPES = ['Fixed', 'Cash', 'PercentOfEquity'];
const COMMISSION_TYPES = ['Percent', 'CashPerContract', 'CashPerOrder'];

function enumText(value: string | number | undefined, names: string[]): string | undefined {
  if (value === undefined || value === null) return undefined;
  return typeof value === 'number' ? (names[value] ?? String(value)) : value;
}

function qtyLabel(p: ScriptStrategyProperties): string {
  const type = enumText(p.defaultQtyType, QTY_TYPES) ?? 'Fixed';
  const v = p.defaultQtyValue ?? 1;
  switch (type.toLowerCase().replace(/[_\s.]/g, '')) {
    case 'cash':
    case 'strategycash':
      return `${v} (cash)`;
    case 'percentofequity':
    case 'strategypercentofequity':
      return `${v}% of equity`;
    default:
      return `${v} (contracts/lots)`;
  }
}

function commissionLabel(p: ScriptStrategyProperties): string {
  const v = p.commissionValue ?? 0;
  if (!v) return 'None';
  const type = (enumText(p.commissionType, COMMISSION_TYPES) ?? 'Percent').toLowerCase();
  if (type.includes('contract')) return `${v} per contract`;
  if (type.includes('order')) return `${v} per order`;
  return `${v}%`;
}

const yesNo = (b: boolean | undefined) => (b ? 'Yes' : 'No');

/**
 * The script's declaration statement as compiled: kind and title, and for strategies every
 * `strategy()` property the backtest and the live emulator will use.
 */
@Component({
  selector: 'app-declaration-summary',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (declaration(); as d) {
      <div class="decl">
        <div class="decl-head">
          <span class="kind">{{ d.kind }}</span>
          <span class="title">{{ d.title }}</span>
          @if (d.shortTitle && d.shortTitle !== d.title) {
            <span class="short">({{ d.shortTitle }})</span>
          }
        </div>
        <dl class="props">
          @for (row of rows(); track row.label) {
            <div class="prop" [class.is-set]="row.set">
              <dt>{{ row.label }}</dt>
              <dd>{{ row.value }}</dd>
            </div>
          }
        </dl>
        @if (d.strategyAlertMessage) {
          <p class="alert-msg">
            <span class="muted">Default alert message:</span> {{ d.strategyAlertMessage }}
          </p>
        }
      </div>
    } @else {
      <p class="empty">{{ emptyText() }}</p>
    }
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .decl-head {
        display: flex;
        align-items: baseline;
        gap: 8px;
        margin-bottom: 8px;
        flex-wrap: wrap;
      }
      .kind {
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        padding: 2px 7px;
        border-radius: 4px;
        background: rgba(0, 113, 227, 0.12);
        color: var(--accent);
      }
      .title {
        font-size: 14px;
        font-weight: 600;
        color: var(--text-primary);
      }
      .short {
        font-size: 12px;
        color: var(--text-secondary);
      }
      .props {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
        gap: 4px 16px;
        margin: 0;
      }
      .prop {
        display: flex;
        justify-content: space-between;
        gap: 8px;
        padding: 3px 0;
        border-bottom: 1px dashed var(--border);
        font-size: 12px;
      }
      dt {
        color: var(--text-secondary);
      }
      dd {
        margin: 0;
        color: var(--text-primary);
        font-variant-numeric: tabular-nums;
        text-align: right;
      }
      .prop.is-set dd {
        font-weight: 600;
      }
      .alert-msg {
        margin: 8px 0 0;
        font-size: 12px;
      }
      .muted {
        color: var(--text-secondary);
      }
      .empty {
        margin: 0;
        font-size: 12px;
        color: var(--text-tertiary);
      }
    `,
  ],
})
export class DeclarationSummaryComponent {
  readonly declaration = input<ScriptDeclaration | null>(null);
  readonly emptyText = input('Compile the script to read its declaration.');

  readonly rows = computed<PropRow[]>(() => {
    const d = this.declaration();
    if (!d) return [];
    const rows: PropRow[] = [{ label: 'Overlay', value: yesNo(d.overlay) }];
    const p = d.strategy;
    if (d.kind === 'strategy' && p) {
      const currency = !p.currency || p.currency === 'NONE' ? 'symbol currency' : p.currency;
      rows.push(
        {
          label: 'Initial capital',
          value: `${(p.initialCapital ?? 1_000_000).toLocaleString()} (${currency})`,
          set: p.initialCapital !== undefined && p.initialCapital !== 1_000_000,
        },
        { label: 'Order size', value: qtyLabel(p) },
        { label: 'Pyramiding', value: String(p.pyramiding ?? 0), set: (p.pyramiding ?? 0) > 1 },
        { label: 'Commission', value: commissionLabel(p), set: !!p.commissionValue },
        { label: 'Slippage', value: `${p.slippage ?? 0} ticks`, set: !!p.slippage },
        {
          label: 'Margin long / short',
          value: `${p.marginLong ?? 100}% / ${p.marginShort ?? 100}%`,
          set: (p.marginLong ?? 100) !== 100 || (p.marginShort ?? 100) !== 100,
        },
        {
          label: 'Orders on close',
          value: yesNo(p.processOrdersOnClose),
          set: !!p.processOrdersOnClose,
        },
        { label: 'Every tick', value: yesNo(p.calcOnEveryTick), set: !!p.calcOnEveryTick },
        { label: 'On order fills', value: yesNo(p.calcOnOrderFills), set: !!p.calcOnOrderFills },
        { label: 'Close entries rule', value: p.closeEntriesRule ?? 'FIFO' },
        { label: 'Bar magnifier', value: yesNo(p.useBarMagnifier), set: !!p.useBarMagnifier },
        {
          label: 'Fill on standard OHLC',
          value: yesNo(p.fillOrdersOnStandardOhlc),
          set: !!p.fillOrdersOnStandardOhlc,
        },
        {
          label: 'Limit fill assumption',
          value: `${p.backtestFillLimitsAssumption ?? 0} ticks`,
          set: !!p.backtestFillLimitsAssumption,
        },
        { label: 'Risk-free rate', value: `${p.riskFreeRate ?? 2}%` },
      );
    }
    if (d.timeframe) rows.push({ label: 'Timeframe', value: d.timeframe, set: true });
    if (d.format && d.format !== 'inherit')
      rows.push({ label: 'Format', value: d.format, set: true });
    if (d.precision !== null && d.precision !== undefined)
      rows.push({ label: 'Precision', value: String(d.precision), set: true });
    const maxBarsBack = p?.maxBarsBack || d.maxBarsBack;
    if (maxBarsBack) rows.push({ label: 'Max bars back', value: String(maxBarsBack), set: true });
    const drawing = [d.maxLinesCount, d.maxLabelsCount, d.maxBoxesCount, d.maxPolylinesCount];
    if (drawing.some((x) => x !== undefined && x !== 50)) {
      rows.push({
        label: 'Max lines / labels / boxes / polylines',
        value: drawing.map((x) => x ?? 50).join(' / '),
        set: true,
      });
    }
    return rows;
  });
}
