import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { DatePipe, DecimalPipe, PercentPipe } from '@angular/common';
import { RouterLink } from '@angular/router';

import {
  REC_SOURCE_LABELS,
  TradeRecommendationCardDto,
  recFormatPrice,
  recOutcomeView,
  recPips,
  recSplitReason,
} from '../../trade-recommendations.types';

/**
 * One recommendation card: the trade (direction, levels, R:R, confidence), why it was written,
 * why it is in its status, and how far it got — watch, signal, position, P&L. The whole card links
 * to the detail page. Used by the list grid and, compact, for siblings and OCO partners.
 */
@Component({
  selector: 'app-recommendation-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, DecimalPipe, PercentPipe, RouterLink],
  styleUrls: ['../../rec-shared.scss'],
  template: `
    @let c = card();
    <a
      class="card"
      [class.card--compact]="compact()"
      [class.card--buy]="c.direction === 'Buy'"
      [class.card--sell]="c.direction === 'Sell'"
      [routerLink]="['/trade-recommendations', c.id]"
      [attr.aria-label]="'Recommendation ' + c.id + ', ' + c.direction + ' ' + c.symbol"
    >
      <header class="head">
        <div class="head-main">
          <span class="id mono">#{{ c.id }}</span>
          <span class="sym">{{ c.symbol }}</span>
          <span class="tf muted">{{ c.timeframe }}</span>
          <span
            class="pill"
            [class.pill--buy]="c.direction === 'Buy'"
            [class.pill--sell]="c.direction === 'Sell'"
          >
            {{ c.direction === 'Buy' ? '↑' : '↓' }} {{ c.direction }}{{ orderTypeSuffix() }}
          </span>
        </div>
        <span class="pill" [class]="'pill pill--' + statusTone()">{{ c.status }}</span>
      </header>

      <div class="meta muted">
        <span>{{ sourceLabel() }}</span>
        @if (c.analysisModel) {
          <span>· {{ c.analysisModel }}</span>
        }
        <span>· {{ c.createdAtUtc | date: 'MMM d, HH:mm' : 'UTC' }} UTC</span>
        @if (c.conviction) {
          <span>· {{ c.conviction }}</span>
        }
      </div>

      <div class="levels">
        <div class="lvl">
          <span class="lbl">Entry</span>
          <span class="val mono">{{ price(c.entryPrice) }}</span>
        </div>
        <div class="lvl">
          <span class="lbl">Stop</span>
          <span class="val mono loss">{{ price(c.stopLoss) }}</span>
          @if (riskPips() !== null) {
            <span class="sub mono muted">{{ riskPips() }}p</span>
          }
        </div>
        <div class="lvl">
          <span class="lbl">Target</span>
          <span class="val mono profit">{{ price(c.takeProfit) }}</span>
          @if (rewardPips() !== null) {
            <span class="sub mono muted">{{ rewardPips() }}p</span>
          }
        </div>
        <div class="lvl">
          <span class="lbl">R:R</span>
          <span class="val mono">{{
            c.rewardRisk !== null ? (c.rewardRisk | number: '1.2-2') : '—'
          }}</span>
        </div>
        <div class="lvl">
          <span class="lbl">Conf.</span>
          <span class="val mono">{{
            c.confidence !== null ? (c.confidence | percent: '1.0-0') : '—'
          }}</span>
        </div>
      </div>

      @if (c.rewardRisk !== null) {
        <div
          class="rr-bar"
          [attr.title]="'Risk : reward = 1 : ' + (c.rewardRisk | number: '1.2-2')"
        >
          <span class="rr-risk" [style.flex-grow]="1"></span>
          <span class="rr-reward" [style.flex-grow]="rrGrow()"></span>
        </div>
      }

      @if (!compact() && c.rationale) {
        <p class="rationale">{{ c.rationale }}</p>
      }

      @if (reason(); as r) {
        <p class="reason" [class.reason--bad]="c.status === 'Rejected'">
          @if (r.code) {
            <span class="code mono">{{ r.code }}</span>
          }
          {{ r.detail }}
        </p>
      }

      <footer class="foot">
        <span class="pill" [class]="'pill pill--' + outcome().tone">{{ outcome().label }}</span>
        @if (c.watchingMonitorId) {
          <span class="pill pill--info" title="An active monitor will file this card"
            >👁 #{{ c.watchingMonitorId }}</span
          >
        } @else if (c.monitorCount > 0) {
          <span class="pill" title="Monitors armed for this card"
            >👁 {{ c.monitorCount }} · {{ c.latestMonitorStatus }}</span
          >
        }
        @if (c.ocoGroupId) {
          <span class="pill pill--warn" [attr.title]="'One-cancels-other group ' + c.ocoGroupId"
            >OCO</span
          >
        }
        @if (c.tradeSignalId) {
          <span class="pill"
            >⚡ #{{ c.tradeSignalId }}{{ c.signalStatus ? ' · ' + c.signalStatus : '' }}</span
          >
        }
        @if (c.realizedPnL !== null) {
          <span
            class="pnl mono"
            [class.profit]="c.realizedPnL > 0"
            [class.loss]="c.realizedPnL < 0"
          >
            {{ c.realizedPnL > 0 ? '+' : '' }}{{ c.realizedPnL | number: '1.2-2' }}
          </span>
        } @else if (c.unrealizedPnL !== null) {
          <span
            class="pnl mono muted"
            [class.profit]="c.unrealizedPnL > 0"
            [class.loss]="c.unrealizedPnL < 0"
          >
            {{ c.unrealizedPnL > 0 ? '+' : '' }}{{ c.unrealizedPnL | number: '1.2-2' }} open
          </span>
        }
        @if (!compact() && c.siblingCount > 0) {
          <span class="sibs muted">+{{ c.siblingCount }} from same analysis</span>
        }
      </footer>
    </a>
  `,
  styles: [
    `
      :host {
        display: block;
        min-width: 0;
      }
      .card {
        display: flex;
        flex-direction: column;
        gap: 10px;
        height: 100%;
        box-sizing: border-box;
        padding: 14px 16px;
        border: 1px solid var(--border);
        border-left: 3px solid var(--border);
        border-radius: var(--radius-md);
        background: var(--bg-secondary);
        color: inherit;
        text-decoration: none;
        transition:
          border-color 0.15s ease,
          box-shadow 0.15s ease;
      }
      .card:hover,
      .card:focus-visible {
        border-color: var(--accent);
        box-shadow: 0 2px 10px rgba(0, 0, 0, 0.06);
        outline: none;
      }
      .card--buy {
        border-left-color: var(--profit);
      }
      .card--sell {
        border-left-color: var(--loss);
      }
      .card--compact {
        padding: 10px 12px;
        gap: 8px;
      }
      .head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }
      .head-main {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
        min-width: 0;
      }
      .id {
        font-size: 12px;
        color: var(--text-secondary);
      }
      .sym {
        font-weight: var(--font-semibold);
        font-size: var(--text-base);
      }
      .tf {
        font-size: 12px;
      }
      .meta {
        font-size: 12px;
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
      }
      .levels {
        display: grid;
        grid-template-columns: repeat(5, minmax(0, 1fr));
        gap: 6px;
      }
      .lvl {
        display: flex;
        flex-direction: column;
        min-width: 0;
      }
      .lbl {
        font-size: 10.5px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-secondary);
      }
      .val {
        font-size: 13px;
        font-weight: var(--font-semibold);
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .sub {
        font-size: 11px;
      }
      .rr-bar {
        display: flex;
        height: 4px;
        border-radius: 2px;
        overflow: hidden;
        gap: 2px;
      }
      .rr-risk {
        background: var(--loss);
        opacity: 0.7;
        flex-basis: 0;
      }
      .rr-reward {
        background: var(--profit);
        opacity: 0.7;
        flex-basis: 0;
      }
      .rationale {
        margin: 0;
        font-size: 13px;
        line-height: 1.45;
        color: var(--text-primary);
        display: -webkit-box;
        -webkit-line-clamp: 3;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      .reason {
        margin: 0;
        font-size: 12px;
        line-height: 1.4;
        color: var(--text-secondary);
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      .reason--bad {
        color: var(--loss);
      }
      .code {
        font-size: 11px;
        padding: 1px 5px;
        border-radius: 4px;
        background: var(--bg-tertiary);
        margin-right: 4px;
      }
      .foot {
        margin-top: auto;
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 6px;
      }
      .pnl {
        font-size: 12.5px;
        font-weight: var(--font-semibold);
      }
      .sibs {
        font-size: 11.5px;
        margin-left: auto;
      }
      @media (max-width: 520px) {
        .levels {
          grid-template-columns: repeat(3, minmax(0, 1fr));
        }
      }
    `,
  ],
})
export class RecommendationCardComponent {
  readonly card = input.required<TradeRecommendationCardDto>();
  readonly compact = input(false);

  readonly sourceLabel = computed(
    () => REC_SOURCE_LABELS[this.card().source] ?? this.card().source,
  );
  readonly outcome = computed(() => recOutcomeView(this.card().outcome));
  readonly reason = computed(() => {
    const c = this.card();
    if (!c.statusReason) return null;
    return recSplitReason(c.statusReason);
  });
  readonly riskPips = computed(() =>
    recPips(this.card().symbol, this.card().entryPrice, this.card().stopLoss),
  );
  readonly rewardPips = computed(() =>
    recPips(this.card().symbol, this.card().entryPrice, this.card().takeProfit),
  );
  /** Reward segment width relative to risk = 1, capped so a 10R card does not erase the risk bar. */
  readonly rrGrow = computed(() => Math.min(this.card().rewardRisk ?? 0, 6));

  readonly orderTypeSuffix = computed(() => {
    const t = this.card().orderType;
    if (!t) return '';
    // "SellLimit" / "Limit" → " Limit"
    const bare = t.replace(/^(Buy|Sell)/, '');
    return bare ? ' ' + bare : '';
  });

  readonly statusTone = computed(() => {
    switch (this.card().status) {
      case 'Filed':
        return 'good';
      case 'Rejected':
        return 'bad';
      case 'Withdrawn':
      case 'Expired':
        return 'warn';
      case 'Parked':
        return 'info';
      default:
        return 'neutral';
    }
  });

  price(v: number | null): string {
    return recFormatPrice(this.card().symbol, v);
  }
}
