import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { DatePipe, DecimalPipe, PercentPipe } from '@angular/common';
import { RouterLink } from '@angular/router';

import { OcoChipComponent } from '@shared/components/oco-chip/oco-chip.component';
import { RecExpiryChipComponent } from '../rec-expiry/rec-expiry-chip.component';
import { ocoHue } from '@shared/utils/oco';

import {
  REC_SOURCE_LABELS,
  TradeRecommendationCardDto,
  recFormatPrice,
  recOcoChipPartners,
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
  imports: [
    DatePipe,
    DecimalPipe,
    PercentPipe,
    RouterLink,
    OcoChipComponent,
    RecExpiryChipComponent,
  ],
  styleUrls: ['../../rec-shared.scss'],
  template: `
    @let c = card();
    <a
      class="card"
      [class.card--compact]="compact()"
      [class.card--buy]="c.direction === 'Buy'"
      [class.card--sell]="c.direction === 'Sell'"
      [class.card--oco]="!!c.ocoGroupId"
      [class.card--oco-lit]="ocoHighlight()"
      [style.--oco-h]="ocoHueValue()"
      (mouseenter)="c.ocoGroupId && ocoHover.emit(c.ocoGroupId)"
      (mouseleave)="c.ocoGroupId && ocoHover.emit(null)"
      [routerLink]="['/trade-recommendations', c.id]"
      [attr.aria-label]="'Recommendation ' + c.id + ', ' + c.direction + ' ' + c.symbol"
    >
      <header class="head">
        <div class="head-main">
          <span class="id mono">#{{ c.id }}</span>
          <span class="sym">{{ c.symbol }}</span>
          <span class="tf">{{ c.timeframe }}</span>
          <span
            class="pill"
            [class.pill--buy]="c.direction === 'Buy'"
            [class.pill--sell]="c.direction === 'Sell'"
          >
            {{ c.direction === 'Buy' ? '↑' : '↓' }} {{ c.direction }}{{ orderTypeSuffix() }}
          </span>
        </div>
        <span [class]="'status status--' + statusTone()">{{ c.status }}</span>
      </header>

      <div class="meta">
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
            <span class="sub mono">{{ riskPips() }}p</span>
          }
        </div>
        <div class="lvl">
          <span class="lbl">Target</span>
          <span class="val mono profit">{{ price(c.takeProfit) }}</span>
          @if (rewardPips() !== null) {
            <span class="sub mono">{{ rewardPips() }}p</span>
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

      @if (shownExpiry(); as x) {
        <app-rec-expiry-chip [expiry]="x" />
      }

      <footer class="foot">
        <span class="pill" [class]="'pill pill--' + outcome().tone">{{ outcome().label }}</span>
        @if (c.watchingMonitorId) {
          <span class="tag tag--info" title="An active monitor will file this card"
            >👁 #{{ c.watchingMonitorId }}</span
          >
        } @else if (c.monitorCount > 0) {
          <span class="tag" title="Monitors armed for this card"
            >👁 {{ c.monitorCount }} · {{ c.latestMonitorStatus }}</span
          >
        }
        @if (c.ocoGroupId) {
          <app-oco-chip
            [groupId]="c.ocoGroupId"
            [partners]="ocoPartners()"
            [highlighted]="ocoHighlight()"
            [selectable]="ocoSelectable()"
            [showLonely]="c.ocoPartners !== undefined"
            (hover)="ocoHover.emit($event)"
            (selected)="ocoSelect.emit($event)"
          />
        }
        @if (c.tradeSignalId) {
          <span class="tag"
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
          <span class="sibs">+{{ c.siblingCount }} from same analysis</span>
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
        padding: 14px 16px 12px;
        border: 1px solid var(--border);
        border-left: 3px solid var(--border);
        border-radius: var(--radius-md);
        background: var(--bg-secondary);
        box-shadow: var(--shadow-sm);
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
      /* OCO legs share a colour stripe across the top, so a group pairs up by eye in the grid. */
      .card--oco {
        box-shadow:
          inset 0 3px 0 hsl(var(--oco-h) 65% 52%),
          var(--shadow-sm);
      }
      .card--oco-lit,
      .card--oco-lit:hover {
        border-color: hsl(var(--oco-h) 65% 52%);
        box-shadow:
          inset 0 3px 0 hsl(var(--oco-h) 65% 52%),
          0 0 0 3px hsl(var(--oco-h) 70% 52% / 0.28);
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
        font-size: 11.5px;
        color: var(--text-tertiary);
      }
      .sym {
        font-weight: var(--font-semibold);
        font-size: var(--text-base);
      }
      .tf {
        font-size: 11.5px;
        color: var(--text-tertiary);
      }
      .head .pill {
        font-size: 10.5px;
        padding: 1px 7px;
      }
      /* Status: a calm dot + label, not a second filled chip next to the direction pill. */
      .status {
        flex: none;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: 11.5px;
        font-weight: var(--font-medium);
        color: var(--text-secondary);
        white-space: nowrap;
      }
      .status::before {
        content: '';
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: var(--text-tertiary);
        opacity: 0.6;
      }
      .status--good {
        color: var(--profit);
      }
      .status--good::before {
        background: var(--profit);
        opacity: 1;
      }
      .status--bad::before {
        background: var(--loss);
        opacity: 1;
      }
      .status--warn {
        color: #b25000;
      }
      .status--warn::before {
        background: var(--warning);
        opacity: 1;
      }
      .status--info {
        color: var(--accent);
      }
      .status--info::before {
        background: var(--accent);
        opacity: 1;
      }
      .meta {
        font-size: 11.5px;
        color: var(--text-tertiary);
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        margin-top: -4px;
      }
      .levels {
        display: grid;
        grid-template-columns: repeat(5, minmax(0, 1fr));
        gap: 6px;
        padding-top: 2px;
      }
      .lvl {
        display: flex;
        flex-direction: column;
        gap: 1px;
        min-width: 0;
      }
      .lbl {
        font-size: 10px;
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-tertiary);
      }
      .val {
        font-size: 13px;
        font-weight: var(--font-semibold);
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .sub {
        font-size: 10.5px;
        color: var(--text-tertiary);
      }
      .rr-bar {
        display: flex;
        height: 3px;
        border-radius: 2px;
        overflow: hidden;
        gap: 2px;
      }
      .rr-risk {
        background: var(--loss);
        opacity: 0.55;
        flex-basis: 0;
      }
      .rr-reward {
        background: var(--profit);
        opacity: 0.55;
        flex-basis: 0;
      }
      .rationale {
        margin: 0;
        font-size: 13px;
        line-height: 1.5;
        color: var(--text-primary);
        display: -webkit-box;
        -webkit-line-clamp: 3;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      /* Why the card is in its status: readable, secondary text; a refusal is marked by a thin red
         rule and a tinted code tag rather than by painting the whole sentence red. */
      .reason {
        margin: 0;
        padding-left: 8px;
        border-left: 2px solid var(--border);
        font-size: 12px;
        line-height: 1.45;
        color: var(--text-secondary);
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      .reason--bad {
        border-left-color: rgba(255, 59, 48, 0.45);
      }
      .code {
        font-size: 10.5px;
        padding: 0 5px;
        border-radius: 4px;
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        margin-right: 4px;
      }
      .reason--bad .code {
        background: rgba(255, 59, 48, 0.08);
        color: var(--loss);
      }
      .foot {
        margin-top: auto;
        padding-top: 8px;
        border-top: 1px solid var(--border);
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 6px;
      }
      .foot .pill {
        font-size: 11px;
        font-weight: var(--font-medium);
        padding: 1px 8px;
        line-height: 18px;
      }
      /* Secondary tags (monitor, OCO, signal): one quiet outlined style, same height as the pill. */
      .tag {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        font-size: 11px;
        font-weight: var(--font-medium);
        line-height: 18px;
        padding: 0 7px;
        border-radius: 999px;
        border: 1px solid var(--border);
        color: var(--text-secondary);
        white-space: nowrap;
      }
      .tag--info {
        border-color: rgba(0, 113, 227, 0.35);
        color: var(--accent);
      }
      .pnl {
        font-size: 12.5px;
        font-weight: var(--font-semibold);
      }
      .sibs {
        font-size: 11px;
        color: var(--text-tertiary);
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
  /** A partner in this card's OCO group is hovered on the page. */
  readonly ocoHighlight = input(false);
  /** Clicking the OCO chip asks the page to show the whole group (else it opens the card). */
  readonly ocoSelectable = input(false);

  readonly ocoHover = output<string | null>();
  readonly ocoSelect = output<string>();

  readonly ocoHueValue = computed(() => {
    const g = this.card().ocoGroupId;
    return g ? ocoHue(g) : null;
  });
  readonly ocoPartners = computed(() => recOcoChipPartners(this.card()));

  readonly sourceLabel = computed(
    () => REC_SOURCE_LABELS[this.card().source] ?? this.card().source,
  );
  readonly outcome = computed(() => recOutcomeView(this.card().outcome));

  /**
   * The countdown while a clock runs. Once it ran out, only while the card still looks alive (Proposed / Parked —
   * the status alone would hide that it can no longer trade) or for a day after, so a page of old cards is not a
   * wall of "Expired 20d ago".
   */
  readonly shownExpiry = computed(() => {
    const x = this.card().expiry;
    if (!x) return null;
    if (x.state === 'counting') return x;
    const alive = ['Proposed', 'Parked'].includes(this.card().status);
    const recent = Date.now() - Date.parse(x.binding.atUtc) < 24 * 3_600_000;
    return alive || recent ? x : null;
  });
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
