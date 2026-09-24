import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import type { ReportStrategyProperties, StrategyReport } from './strategy-report.model';
import {
  NA,
  formatDateTime,
  formatInteger,
  formatMoney,
  formatNumber,
  formatPercent,
} from './report-format';

interface PropRow {
  label: string;
  value: string;
}

const QTY_TYPE_LABELS: Record<string, string> = {
  Fixed: 'Fixed contracts',
  Cash: 'Cash amount',
  PercentOfEquity: '% of equity',
};

const COMMISSION_LABELS: Record<string, string> = {
  Percent: '% of order value',
  CashPerContract: 'Cash per contract',
  CashPerOrder: 'Cash per order',
};

function yesNo(v: boolean | null): string {
  return v === null ? NA : v ? 'On' : 'Off';
}

function commissionText(p: ReportStrategyProperties): string {
  if (p.commissionValue === null) return NA;
  const type = p.commissionType ?? '';
  if (type === 'Percent') return formatPercent(p.commissionValue, { decimals: 4 });
  return `${formatNumber(p.commissionValue, 4)} (${COMMISSION_LABELS[type] ?? type})`;
}

/**
 * Properties tab: what was tested (symbol, range, bars, currency) and the `strategy()`
 * declaration parameters the emulator ran with.
 */
@Component({
  selector: 'app-report-properties',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="groups">
      <section class="group" aria-label="Run">
        <h4 class="group-title">Run</h4>
        <dl>
          @for (r of runRows(); track r.label) {
            <div class="row">
              <dt>{{ r.label }}</dt>
              <dd>{{ r.value }}</dd>
            </div>
          }
        </dl>
      </section>
      <section class="group" aria-label="Strategy properties">
        <h4 class="group-title">Strategy properties</h4>
        @if (propertyRows().length > 0) {
          <dl>
            @for (r of propertyRows(); track r.label) {
              <div class="row">
                <dt>{{ r.label }}</dt>
                <dd>{{ r.value }}</dd>
              </div>
            }
          </dl>
        } @else {
          <p class="muted">This report does not carry the strategy's declaration properties.</p>
        }
      </section>
    </div>
  `,
  styles: [
    `
      .groups {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(min(100%, 380px), 1fr));
        gap: var(--space-4);
        align-items: start;
      }
      .group {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
      }
      .group-title {
        margin: 0;
        padding: var(--space-3) var(--space-4);
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-secondary);
        background: var(--bg-tertiary);
      }
      dl {
        margin: 0;
      }
      .row {
        display: flex;
        justify-content: space-between;
        gap: var(--space-4);
        padding: var(--space-2) var(--space-4);
        border-bottom: 1px solid var(--border);
        font-size: var(--text-sm);
      }
      .row:last-child {
        border-bottom: none;
      }
      dt {
        color: var(--text-secondary);
      }
      dd {
        margin: 0;
        color: var(--text-primary);
        font-weight: var(--font-medium);
        text-align: right;
        overflow-wrap: anywhere;
      }
      .muted {
        margin: 0;
        padding: var(--space-4);
        color: var(--text-secondary);
        font-size: var(--text-sm);
      }
    `,
  ],
})
export class ReportPropertiesComponent {
  readonly report = input.required<StrategyReport>();
  readonly currency = input('');

  readonly runRows = computed<PropRow[]>(() => {
    const m = this.report().meta;
    const cur = this.currency();
    const rows: PropRow[] = [
      { label: 'Symbol', value: m.symbol || NA },
      { label: 'Timeframe', value: m.timeframe || NA },
      { label: 'First bar (UTC)', value: formatDateTime(m.firstBarTime) },
      { label: 'Last bar close (UTC)', value: formatDateTime(m.lastBarTimeClose ?? m.lastBarTime) },
      { label: 'Bars processed', value: formatInteger(m.bars) },
      { label: 'Initial capital', value: formatMoney(m.initialCapital, cur) },
      { label: 'Account currency', value: m.accountCurrency || NA },
      { label: 'Symbol currency', value: m.symbolCurrency || NA },
      { label: 'Bar magnifier', value: m.useBarMagnifier ? 'On' : 'Off' },
    ];
    if ((m.trimmedTrades ?? 0) > 0) {
      rows.push({ label: 'Trimmed closed trades', value: formatInteger(m.trimmedTrades) });
    }
    if (m.riskHalted) {
      rows.push({ label: 'Risk halt', value: m.riskHaltReason || 'Halted' });
    }
    return rows;
  });

  readonly propertyRows = computed<PropRow[]>(() => {
    const p = this.report().meta.properties;
    if (!p) return [];
    const qtyType = p.defaultQtyType ?? '';
    return [
      {
        label: 'Order size',
        value:
          p.defaultQtyValue === null
            ? NA
            : `${formatNumber(p.defaultQtyValue, qtyType === 'Fixed' ? 4 : 2)} · ${QTY_TYPE_LABELS[qtyType] ?? (qtyType || NA)}`,
      },
      { label: 'Pyramiding', value: formatInteger(p.pyramiding) },
      { label: 'Commission', value: commissionText(p) },
      { label: 'Slippage (ticks)', value: formatInteger(p.slippage) },
      { label: 'Margin for longs', value: formatPercent(p.marginLong) },
      { label: 'Margin for shorts', value: formatPercent(p.marginShort) },
      { label: 'Currency', value: p.currency || NA },
      { label: 'Close entries rule', value: p.closeEntriesRule || NA },
      { label: 'Process orders on close', value: yesNo(p.processOrdersOnClose) },
      { label: 'Recalculate after order fills', value: yesNo(p.calcOnOrderFills) },
      { label: 'Recalculate on every tick', value: yesNo(p.calcOnEveryTick) },
      { label: 'Recalculate on every history tick', value: yesNo(p.calcOnEveryHistoryTick) },
      {
        label: 'Verify limit fills (ticks)',
        value: formatInteger(p.backtestFillLimitsAssumption),
      },
      { label: 'Bar magnifier (declared)', value: yesNo(p.useBarMagnifier) },
      { label: 'Fill orders on standard OHLC', value: yesNo(p.fillOrdersOnStandardOhlc) },
      { label: 'Risk-free rate', value: formatPercent(p.riskFreeRate) },
      { label: 'Max bars back', value: formatInteger(p.maxBarsBack) },
    ];
  });
}
