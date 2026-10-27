import { DecimalPipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  NgZone,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { AuthService } from '@core/auth/auth.service';
import { Permission } from '@core/auth/permissions.generated';
import { NotificationService } from '@core/notifications/notification.service';
import { AccountScopeService } from '@core/scope/account-scope.service';
import { ModalA11yDirective } from '@shared/directives/modal-a11y.directive';

import { ChartPanelsService } from '../panels/side/chart-panels.service';
import type { AccountStrip } from '../panels/side/chart-panels.types';
import { formatUnits } from '../panels/side/depth';
import { ManualTradingService } from '../trading/manual-trading.service';
import type {
  ManualTradePreview,
  ManualTradeRequest,
  OcoGroup,
  OrderEntryMovePreview,
  TicketMode,
} from '../trading/manual-trading.types';
import { DEFAULT_STOP_ATR, DEFAULT_TARGET_R, firstRefusal } from '../trading/ticket-model';
import { newCorrelationId } from '../trading/position-lines';
import { LadderArmingService } from './ladder-arming.service';
import { VenueTicketBus } from '../trading/venue-ticket-bus.service';
import { unitWord, venueInstrumentFor } from '@features/venues/venues.logic';
import { MarketDataApiService } from '@core/realtime/marketdata-api.service';
import { MarketDataStreamService, type MdWatch } from '@core/realtime/marketdata-stream.service';
import { LiveDepthService, type LiveDepth } from '../orderflow/live-depth.service';
import { pickBookStream } from '../orderflow/stream-depth';
import { parseDepth } from '../panels/side/depth';
import {
  addTicks,
  buildLadder,
  centreIndexFor,
  dropProblem,
  ladderBrackets,
  ladderIntent,
  needsRecentre,
  ocoPairProblem,
  pointSize,
  rowIndex,
  type LadderColumn,
  type LadderIntent,
  type LadderOrder,
  type LadderRow,
} from './ladder-model';
import {
  fxSessionStart,
  ladderOrdersFrom,
  ladderPositionsFrom,
  movedLevels,
} from './ladder-orders';

/** Rows above and below the centre. */
const HALF_ROWS = 20;
/** My orders, signals, positions and OCO pairs are re-read this often while the panel is open. */
const ORDERS_POLL_MS = 3_000;
/** The ATR behind the default brackets is re-read this often. */
const ATR_TTL_MS = 5 * 60_000;

/** What the ladder shows: where its book comes from, the book (price → size maps), the quote. */
interface LadderView {
  mode: 'connecting' | 'stream' | 'poll' | 'none';
  sourceId: string | null;
  book: { bids: ReadonlyMap<number, number>; asks: ReadonlyMap<number, number> } | null;
  quote: { bid: number | null; ask: number | null };
}

const NO_VIEW: LadderView = {
  mode: 'none',
  sourceId: null,
  book: null,
  quote: { bid: null, ask: null },
};

/** What the confirm dialog is about. */
type LadderAction =
  | {
      type: 'place';
      request: ManualTradeRequest;
      intent: LadderIntent | null;
      preview: ManualTradePreview | null;
    }
  | {
      type: 'oco';
      legs: [ManualTradeRequest, ManualTradeRequest];
      previews: (ManualTradePreview | null)[];
    }
  | { type: 'move'; order: LadderOrder; to: number; preview: OrderEntryMovePreview | null }
  | { type: 'cancel'; order: LadderOrder }
  | { type: 'arm' };

/**
 * The price ladder (DOM) — chart side panel (market-data program, dom-trading). A fixed price grid around the market
 * (re-centre with C or the button; it re-centres itself when the market leaves the middle unless that is switched
 * off): the broker book's size per price (live from the market-data hub, else the 1.5 s polled snapshot — the panel
 * says which), my working orders and pending manual signals in their own columns, my position's average, and the
 * session's tick count per price (ticks, not traded volume: MT5 FX feeds carry none).
 *
 * Trading from it goes through the existing manual-signal path only: a click in the bid column buys at that price
 * (limit; Shift: a sell stop), in the ask column sells (limit; Shift: a buy stop) — a LIVE manual ticket with the
 * ticket's default brackets (1.5 ATR stop, 2R target), previewed by the engine (lots, risk, every gate) in a confirm
 * dialog. One-click trading is an explicit per-session opt-in (default off, visibly ARMED, for one account + symbol).
 * A working order is dragged to another price to move it (order/{id}/move-entry) or cancelled with ×. OCO mode takes
 * two clicks — one buy and one sell leg — and sends them as one pair (`POST order/oco`). Every action is gated on the
 * permission its endpoint enforces; the engine checks again.
 */
@Component({
  selector: 'app-ladder-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DecimalPipe, ModalA11yDirective],
  template: `
    <div class="lp-head">
      <p class="lp-note" data-testid="ladder-source">
        {{ sourceLabel() }}
      </p>
      @if (notEntitled(); as why) {
        <p class="lp-warn" data-testid="ladder-denied">{{ why }}</p>
      }
      @if (delayedCaption(); as delayed) {
        <p class="lp-note" data-testid="ladder-delayed">{{ delayed }}</p>
      }
      @if (venue(); as v) {
        <!-- Multi-asset WS7 7.6: an exchange-traded instrument — rows on its tick, sizes in its unit, and a click opens
             the venue ticket at that price (the MT5 manual-signal path below does not apply to it). -->
        <p class="lp-note" data-testid="ladder-venue">
          {{ v.exchange || 'Exchange' }} · tick {{ v.tickSize }} · sizes in {{ venueUnit() }}. A click opens the order
          ticket at that price (bid column: buy, ask column: sell; Shift: stop). One-click and OCO are off here.
        </p>
      }
      <div class="lp-controls">
        <label>
          <span class="sr">Account</span>
          <select
            [value]="accountId() ?? ''"
            (change)="setAccount($any($event.target).value)"
            data-testid="ladder-account"
          >
            <option value="">Account…</option>
            @for (a of accounts(); track a.id) {
              <option [value]="a.id">
                {{ a.accountName || a.accountId }} ({{ a.accountType }})
              </option>
            }
          </select>
        </label>
        <span class="lp-mode" role="group" aria-label="Mode">
          <label
            ><input
              type="radio"
              name="lp-mode"
              [checked]="mode() === 'Paper'"
              (change)="setMode('Paper')"
            />
            Paper</label
          >
          <label
            ><input
              type="radio"
              name="lp-mode"
              [checked]="mode() === 'Live'"
              (change)="setMode('Live')"
              data-testid="ladder-live"
            />
            Live</label
          >
        </span>
      </div>
      <div class="lp-controls">
        <button
          type="button"
          class="lp-mkt buy"
          [disabled]="!canPlace()"
          (click)="market('Buy')"
          data-testid="ladder-buy-mkt"
        >
          Buy MKT
        </button>
        <button
          type="button"
          class="lp-mkt sell"
          [disabled]="!canPlace()"
          (click)="market('Sell')"
          data-testid="ladder-sell-mkt"
        >
          Sell MKT
        </button>
        <button
          type="button"
          [class.on]="ocoMode()"
          [disabled]="!canOco()"
          (click)="toggleOco()"
          title="OCO: click two prices — one buy and one sell leg — and send them as one pair"
          data-testid="ladder-oco"
        >
          OCO{{ ocoFirst() ? ' · leg 2…' : '' }}
        </button>
        @if (armedHere()) {
          <button
            type="button"
            class="lp-armed"
            (click)="disarm()"
            data-testid="ladder-armed"
            title="Click to disarm"
          >
            ARMED · one-click
          </button>
        } @else {
          <button
            type="button"
            [disabled]="!canArm()"
            (click)="askArm()"
            [title]="
              mode() === 'Live'
                ? 'Send ladder clicks without a confirmation'
                : 'One-click trading is for live orders only'
            "
            data-testid="ladder-arm"
          >
            One-click
          </button>
        }
      </div>
      <div class="lp-controls lp-small">
        <label title="Stop distance of a ladder order, in ATRs (the ticket's default)"
          >SL
          <input
            type="number"
            min="0.25"
            step="0.25"
            [value]="stopAtr()"
            (change)="setStopAtr($any($event.target).value)"
          />
          ATR</label
        >
        <label title="Target of a ladder order, in R (0 = none)"
          >TP
          <input
            type="number"
            min="0"
            step="0.5"
            [value]="targetR()"
            (change)="setTargetR($any($event.target).value)"
          />
          R</label
        >
        <label title="Points per row">
          ×<select
            [value]="rowTicks()"
            (change)="setRowTicks($any($event.target).value)"
            data-testid="ladder-zoom"
          >
            @for (z of zooms; track z) {
              <option [value]="z">{{ z }}</option>
            }
          </select>
        </label>
        <label
          ><input
            type="checkbox"
            [checked]="autoCentre()"
            (change)="autoCentre.set($any($event.target).checked)"
          />
          auto</label
        >
        <button
          type="button"
          (click)="recentre()"
          title="Re-centre on the market (C)"
          data-testid="ladder-recentre"
        >
          ⌖
        </button>
      </div>
      @if (!permitted()) {
        <p class="lp-warn">
          You can watch the ladder; trading from it needs the access.trader permission.
        </p>
      }
      @if (hint(); as h) {
        <p class="lp-hint" data-testid="ladder-hint">{{ h }}</p>
      }
    </div>

    <div
      #grid
      class="lp-grid"
      tabindex="0"
      role="grid"
      aria-label="Price ladder"
      (wheel)="onWheel($event)"
      (keydown)="onKey($event)"
      (pointerup)="onDrop($event)"
      (pointerleave)="cancelDrag()"
      data-testid="ladder-grid"
    >
      <div class="lp-row lp-colhead" role="row">
        <span>Buy</span><span>Bid</span><span>Price</span><span>Ask</span><span>Sell</span
        ><span>Ticks</span>
      </div>
      @for (r of rows(); track r.index) {
        <div
          class="lp-row"
          role="row"
          [attr.data-index]="r.index"
          [class.best-bid]="r.bestBid"
          [class.best-ask]="r.bestAsk"
          [class.spread]="r.inSpread"
          [class.leg]="ocoFirst()?.price === r.price"
        >
          <span class="lp-mine">
            @for (o of r.buys; track o.id + (o.isSignal ? 's' : 'o')) {
              <i
                class="chip buy"
                [class.signal]="o.isSignal"
                [class.oco]="o.ocoGroupId !== null"
                [title]="chipTitle(o)"
                (pointerdown)="startDrag($event, o)"
                >{{ o.lots ?? '·' }}{{ o.ocoGroupId !== null ? ' ⇄' : ''
                }}<button
                  type="button"
                  class="x"
                  (pointerdown)="$event.stopPropagation()"
                  (click)="askCancel(o)"
                  [attr.aria-label]="'Cancel ' + chipTitle(o)"
                >
                  ×
                </button></i
              >
            }
          </span>
          <span
            class="lp-cell bid"
            role="gridcell"
            tabindex="-1"
            (click)="onCell($event, 'bid', r)"
            (keydown.enter)="onCellKey($event, 'bid', r)"
            [attr.data-testid]="'bid-' + r.index"
          >
            <i class="bar" [style.width.%]="r.bidShare * 100"></i
            >{{ r.bidSize ? units(r.bidSize) : '' }}
          </span>
          <span class="lp-price" [class.avg]="r.positions.length > 0">
            {{ r.price | number: fmt() }}
            @for (p of r.positions; track $index) {
              <small class="avg-tag" [class.long]="p.direction === 'Buy'"
                >{{ p.direction === 'Buy' ? 'L' : 'S' }} {{ p.lots }}</small
              >
            }
          </span>
          <span
            class="lp-cell ask"
            role="gridcell"
            tabindex="-1"
            (click)="onCell($event, 'ask', r)"
            (keydown.enter)="onCellKey($event, 'ask', r)"
            [attr.data-testid]="'ask-' + r.index"
          >
            <i class="bar" [style.width.%]="r.askShare * 100"></i
            >{{ r.askSize ? units(r.askSize) : '' }}
          </span>
          <span class="lp-mine">
            @for (o of r.sells; track o.id + (o.isSignal ? 's' : 'o')) {
              <i
                class="chip sell"
                [class.signal]="o.isSignal"
                [class.oco]="o.ocoGroupId !== null"
                [title]="chipTitle(o)"
                (pointerdown)="startDrag($event, o)"
                >{{ o.lots ?? '·' }}{{ o.ocoGroupId !== null ? ' ⇄' : ''
                }}<button
                  type="button"
                  class="x"
                  (pointerdown)="$event.stopPropagation()"
                  (click)="askCancel(o)"
                  [attr.aria-label]="'Cancel ' + chipTitle(o)"
                >
                  ×
                </button></i
              >
            }
          </span>
          <span class="lp-vol"
            ><i class="bar" [style.width.%]="r.tickShare * 100"></i>{{ r.ticks || '' }}</span
          >
        </div>
      }
    </div>
    <p class="lp-foot">
      Ticks = {{ tickNote() }}. Bid column: buy limit (Shift: sell stop) · Ask column: sell limit
      (Shift: buy stop) · drag a chip to move it · × cancels.
    </p>

    @if (action(); as a) {
      <div
        class="lp-modal"
        role="dialog"
        aria-modal="true"
        appModalA11y
        (dismiss)="closeAction()"
        data-testid="ladder-dialog"
      >
        <div class="lp-dialog">
          @switch (a.type) {
            @case ('place') {
              <h3>
                {{ a.request.mode }} {{ a.request.direction }} {{ a.intent?.kind ?? 'market' }}
                {{ symbol() }}
              </h3>
              <p>
                @if (a.request.entryPrice !== null) {
                  At {{ a.request.entryPrice | number: fmt() }} ·
                }
                SL
                {{ a.request.stopLoss === null ? 'none' : (a.request.stopLoss | number: fmt()) }} ·
                TP
                {{
                  a.request.takeProfit === null ? 'none' : (a.request.takeProfit | number: fmt())
                }}
              </p>
              @if (a.preview; as p) {
                <p class="lp-facts">
                  {{ p.lotsAfterRiskCheck ?? p.lots ?? '—' }} lots · risk
                  {{ p.riskMoney === null ? '—' : (p.riskMoney | number: '1.2-2') }}
                  {{ p.account.currency }}
                  @if (p.rewardRisk !== null) {
                    · {{ p.rewardRisk | number: '1.2-2' }}R
                  }
                  · {{ p.account.accountType }} account {{ p.account.accountId }}
                </p>
                <ul class="lp-gates">
                  @for (g of p.gates; track g.key) {
                    @if (!g.passed) {
                      <li [class.fail]="g.blocking">
                        {{ g.blocking ? '✕' : '!' }} {{ g.name }}: {{ g.detail }}
                      </li>
                    }
                  }
                </ul>
              }
            }
            @case ('oco') {
              <h3>Live OCO pair · {{ symbol() }}</h3>
              @for (leg of a.legs; track $index) {
                <p>
                  Leg {{ $index + 1 }}: {{ leg.direction }} at
                  {{ leg.entryPrice | number: fmt() }} · SL
                  {{ leg.stopLoss | number: fmt() }}
                  @if (a.previews[$index]; as p) {
                    · {{ p.lotsAfterRiskCheck ?? p.lots ?? '—' }} lots
                    @if (!p.canSubmit) {
                      <span class="fail">— {{ p.refusedReason }}</span>
                    }
                  }
                </p>
              }
              <p class="lp-note">When one leg fills, the engine cancels the other.</p>
            }
            @case ('move') {
              <h3>Move the working order</h3>
              <p>
                {{ a.order.direction }} {{ a.order.kind }} {{ a.order.lots }}:
                {{ a.order.price | number: fmt() }} →
                <strong>{{ a.to | number: fmt() }}</strong> (stop and target move with it)
              </p>
              @if (a.preview; as p) {
                <p class="lp-facts">
                  Stop {{ p.stopDistancePips | number: '1.1-1' }} pips ({{
                    p.stopDistanceAtr | number: '1.2-2'
                  }}
                  ATR)
                </p>
                @if (!p.canApply) {
                  <p class="fail">{{ p.refusedReason }}</p>
                }
              }
            }
            @case ('cancel') {
              <h3>
                {{
                  a.order.ocoGroupId !== null ? 'Cancel the OCO pair' : 'Cancel the working order'
                }}
              </h3>
              <p>
                {{ a.order.direction }} {{ a.order.kind }} at {{ a.order.price | number: fmt() }}
                @if (a.order.ocoGroupId !== null) {
                  — and the other leg of pair #{{ a.order.ocoGroupId }} (a filled leg stays).
                }
              </p>
            }
            @case ('arm') {
              <h3>Arm one-click trading?</h3>
              <p class="fail">
                Until you disarm it (or reload the page), every click on this ladder sends a LIVE
                order on account
                {{ accountLabel() }} for {{ symbol() }} without asking. The engine still checks
                every order.
              </p>
            }
          }
          @if (actionError(); as e) {
            <p class="fail" data-testid="ladder-dialog-error">{{ e }}</p>
          }
          @if (busy()) {
            <p class="lp-note">Checking with the engine…</p>
          }
          <div class="lp-actions">
            <button type="button" data-autofocus (click)="closeAction()">Back</button>
            <button
              type="button"
              class="apply"
              [disabled]="!canConfirm()"
              (click)="confirm()"
              data-testid="ladder-confirm"
            >
              {{ confirmLabel() }}
            </button>
          </div>
        </div>
      </div>
    }
  `,
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        font-size: 11px;
        min-height: 0;
      }
      .lp-head {
        padding: 0 8px 4px;
      }
      .lp-note,
      .lp-foot {
        margin: 0 0 4px;
        color: var(--tv-muted, #787b86);
        font-size: 10px;
      }
      .lp-foot {
        padding: 4px 8px;
      }
      .lp-warn {
        margin: 2px 0;
        color: #f9a825;
      }
      .lp-hint {
        margin: 2px 0;
        color: #f23645;
      }
      .lp-controls {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        align-items: center;
        margin-bottom: 4px;
      }
      .lp-controls select,
      .lp-controls input[type='number'] {
        font: inherit;
        max-width: 140px;
      }
      .lp-small input[type='number'] {
        width: 44px;
      }
      .lp-controls button {
        font: inherit;
        padding: 2px 6px;
        border: 1px solid var(--tv-line, #e0e3eb);
        border-radius: 3px;
        background: transparent;
        color: inherit;
        cursor: pointer;
      }
      .lp-controls button.on {
        background: rgba(156, 39, 176, 0.18);
        border-color: #9c27b0;
      }
      .lp-controls button:disabled {
        opacity: 0.45;
        cursor: default;
      }
      .lp-mkt.buy {
        color: #089981;
      }
      .lp-mkt.sell {
        color: #f23645;
      }
      .lp-armed {
        background: #f23645 !important;
        color: #fff !important;
        font-weight: 700;
        border-color: #f23645 !important;
      }
      .sr {
        position: absolute;
        width: 1px;
        height: 1px;
        overflow: hidden;
        clip: rect(0 0 0 0);
      }
      .lp-grid {
        flex: 1;
        min-height: 0;
        overflow: hidden;
        outline: none;
        font-variant-numeric: tabular-nums;
        user-select: none;
      }
      .lp-grid:focus-visible {
        box-shadow: inset 0 0 0 1px #2962ff;
      }
      .lp-row {
        display: grid;
        grid-template-columns: 1fr 1.1fr 1.3fr 1.1fr 1fr 0.8fr;
        height: 17px;
        line-height: 17px;
        border-bottom: 1px solid rgba(120, 123, 134, 0.08);
      }
      .lp-colhead {
        color: var(--tv-muted, #787b86);
        font-size: 10px;
        text-align: center;
      }
      .lp-cell,
      .lp-vol {
        position: relative;
        text-align: right;
        padding: 0 3px;
        cursor: pointer;
      }
      .lp-vol {
        cursor: default;
        color: var(--tv-muted, #787b86);
      }
      .lp-cell:hover {
        outline: 1px solid #2962ff;
      }
      .bar {
        position: absolute;
        top: 1px;
        bottom: 1px;
        right: 0;
        opacity: 0.2;
        pointer-events: none;
      }
      .bid .bar {
        background: #089981;
      }
      .ask .bar {
        background: #f23645;
      }
      .lp-vol .bar {
        background: #787b86;
      }
      .lp-price {
        text-align: center;
      }
      .best-bid .bid,
      .best-bid .lp-price {
        background: rgba(8, 153, 129, 0.16);
      }
      .best-ask .ask,
      .best-ask .lp-price {
        background: rgba(242, 54, 69, 0.16);
      }
      .spread .lp-price {
        color: var(--tv-muted, #787b86);
      }
      .leg .lp-price {
        outline: 1px dashed #9c27b0;
      }
      .avg .lp-price,
      .lp-price.avg {
        font-weight: 700;
      }
      .avg-tag {
        margin-left: 2px;
        color: #f23645;
      }
      .avg-tag.long {
        color: #089981;
      }
      .lp-mine {
        display: flex;
        gap: 2px;
        justify-content: center;
        overflow: hidden;
      }
      .chip {
        font-style: normal;
        padding: 0 3px;
        border-radius: 2px;
        cursor: grab;
        color: #fff;
        white-space: nowrap;
      }
      .chip.buy {
        background: #089981;
      }
      .chip.sell {
        background: #f23645;
      }
      .chip.signal {
        opacity: 0.6;
        cursor: default;
      }
      .chip.oco {
        box-shadow: 0 0 0 1px #9c27b0;
      }
      .chip .x {
        margin-left: 2px;
        padding: 0;
        border: 0;
        background: transparent;
        color: inherit;
        font: inherit;
        cursor: pointer;
      }
      .lp-modal {
        position: fixed;
        inset: 0;
        z-index: 50;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(0, 0, 0, 0.35);
      }
      .lp-dialog {
        max-width: 380px;
        padding: 12px 14px;
        border: 1px solid var(--border-1, #363a45);
        border-radius: 6px;
        background: var(--surface-1, #1e222d);
        color: var(--text-1, #d1d4dc);
        font-size: 12px;
      }
      .lp-dialog h3 {
        margin: 0 0 6px;
        font-size: 13px;
      }
      .lp-gates {
        list-style: none;
        padding: 0;
        margin: 4px 0;
      }
      .fail {
        color: #ef5350;
      }
      .lp-actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 8px;
      }
      .apply {
        background: #2962ff;
        color: #fff;
        border: 0;
        border-radius: 4px;
        padding: 4px 12px;
      }
      .apply:disabled {
        opacity: 0.45;
      }
    `,
  ],
})
export class LadderPanelComponent {
  private readonly stream = inject(MarketDataStreamService);
  private readonly liveDepth = inject(LiveDepthService);
  private readonly mdApi = inject(MarketDataApiService);
  private readonly panels = inject(ChartPanelsService);
  private readonly trading = inject(ManualTradingService);
  private readonly scope = inject(AccountScopeService);
  private readonly auth = inject(AuthService);
  private readonly notify = inject(NotificationService);
  private readonly arming = inject(LadderArmingService);
  private readonly zone = inject(NgZone);
  private readonly destroyRef = inject(DestroyRef);

  readonly symbol = input.required<string>();
  readonly digits = input<number>(5);

  readonly zooms = [1, 2, 5, 10, 25, 50];

  // ── Settings ──────────────────────────────────────────────────────────────
  readonly accountId = signal<number | null>(null);
  readonly mode = signal<TicketMode>('Paper');
  readonly stopAtr = signal(DEFAULT_STOP_ATR);
  readonly targetR = signal(DEFAULT_TARGET_R);
  readonly rowTicks = signal(1);
  readonly autoCentre = signal(true);
  readonly centre = signal<number | null>(null);

  // ── State ─────────────────────────────────────────────────────────────────
  /** The shared market-data hub watch (ticks + book) and the shared live depth (stream-first, 1.5 s poll fallback). */
  private readonly md = signal<MdWatch | null>(null);
  private readonly depth = signal<LiveDepth | null>(null);
  /** The source whose book is shown (its ticks feed the session tick count). */
  private shownSource: string | null = null;
  readonly strip = signal<AccountStrip | null>(null);
  readonly ocoGroups = signal<OcoGroup[]>([]);
  readonly ocoMode = signal(false);
  readonly ocoFirst = signal<LadderIntent | null>(null);
  readonly hint = signal<string | null>(null);
  readonly action = signal<LadderAction | null>(null);
  readonly actionError = signal<string | null>(null);
  readonly busy = signal(false);
  private readonly tickCounts = new Map<number, number>();
  readonly tickNote = signal('tick count per price since the panel opened');
  private atr: { key: string; value: number; at: number } | null = null;
  private drag: { order: LadderOrder } | null = null;

  private readonly gridEl = viewChild<ElementRef<HTMLElement>>('grid');

  readonly accounts = computed(() => {
    const live = this.scope.liveAccounts();
    return live.length > 0 ? live : this.scope.accounts();
  });
  readonly accountLabel = computed(() => {
    const a = this.accounts().find((x) => x.id === this.accountId());
    return a ? `${a.accountName || a.accountId} (${a.accountType})` : '—';
  });
  readonly fmt = computed(() => `1.${this.digits()}-${this.digits()}`);
  private readonly venueBus = inject(VenueTicketBus);
  /** The symbol's exchange-traded instrument, or null for every MT5 symbol (today's ladder, unchanged). */
  readonly venue = computed(() => venueInstrumentFor(this.symbol()));
  readonly venueUnit = computed(() => unitWord(this.venue()?.quantityUnit));
  readonly rowSize = computed(() => {
    const v = this.venue();
    return v && v.tickSize > 0 ? v.tickSize * this.rowTicks() : pointSize(this.digits()) * this.rowTicks();
  });
  /**
   * The ladder's market: the shared hub's freshest book (every change) while the hub delivers one, else the shared
   * live-depth poll (its own fallback while the hub is not delivering), else nothing. Re-read at the hub's ≤ 4 Hz.
   */
  readonly view = computed<LadderView>(() => {
    const md = this.md();
    const depth = this.depth();
    md?.version();
    depth?.snapshot();
    if (!md || !depth) return NO_VIEW;
    const s = this.stream.usable() ? pickBookStream(md.streams(), null, Date.now()) : null;
    if (s) {
      const last = s.ticks.last();
      const quote =
        last && last.t >= s.book.t
          ? { bid: last.bid, ask: last.ask }
          : { bid: s.book.bestBid(), ask: s.book.bestAsk() };
      return { mode: 'stream', sourceId: s.sourceId, book: s.book, quote };
    }
    const snap = depth.snapshot();
    if (snap) {
      const d = parseDepth(snap, 50);
      return {
        mode: depth.via() === 'stream' ? 'stream' : 'poll',
        sourceId: snap.sourceId ?? null,
        book: {
          bids: new Map(d.bids.map((l) => [l.price, l.volume] as [number, number])),
          asks: new Map(d.asks.map((l) => [l.price, l.volume] as [number, number])),
        },
        quote: { bid: d.bids[0]?.price ?? null, ask: d.asks[0]?.price ?? null },
      };
    }
    const state = md.status().state;
    return {
      ...NO_VIEW,
      mode: state === 'connecting' || state === 'reconnecting' ? 'connecting' : 'none',
    };
  });

  /**
   * "Not entitled" in the engine's words: the hub's refusal or revocation (through the shared entitlement-refusal
   * helper), the polled read's `-403-entitlement`, or — before anything is asked — `md/entitlements/me` saying the
   * broker DOM feed is not licensed.
   */
  /** "Delayed 15 min" when the organisation's licence for this feed is delayed-only (engine WS8 8.3). */
  readonly delayedCaption = computed<string | null>(
    () => this.md()?.status().delayedCaption ?? null,
  );

  readonly notEntitled = computed<string | null>(() => {
    const st = this.md()?.status();
    if (st?.notEntitled) return st.notEntitled;
    const err = this.depth()?.error() ?? null;
    if (err && /entitled/i.test(err)) return err;
    if (this.stream.entitlements.isEntitled('broker-dom') === false)
      return "Your organisation is not entitled to the broker DOM feed ('broker-dom').";
    return null;
  });
  readonly permitted = computed(() => this.auth.hasPermission(Permission.AccessTrader));
  readonly armedHere = computed(() => {
    this.arming.arming();
    return this.arming.isArmedFor(this.accountId(), this.symbol());
  });
  readonly canPlace = computed(() => this.permitted() && this.accountId() !== null);
  readonly canOco = computed(() => this.canPlace() && this.mode() === 'Live');
  readonly canArm = computed(() => this.canPlace() && this.mode() === 'Live');

  readonly sourceLabel = computed(() => {
    const v = this.view();
    if (!this.md()) return '';
    const src = v.sourceId ?? 'the broker';
    switch (v.mode) {
      case 'stream':
        return `Live book from ${src} (one broker's MT5 depth, every change) — not the whole market.`;
      case 'poll':
        return `Broker depth polled every 1.5 s (the live stream is not available) — one broker's MT5 book.`;
      case 'connecting':
        return 'Connecting to the market-data stream…';
      default:
        return 'No depth for this symbol.';
    }
  });

  readonly rows = computed<LadderRow[]>(() => {
    const v = this.view();
    const book = v.book;
    const q = v.quote;
    const rowSize = this.rowSize();
    const centre = this.centre() ?? centreIndexFor(q.bid, q.ask, rowSize);
    if (centre === null) return [];
    return buildLadder(
      { rowSize, centerIndex: centre, halfRows: HALF_ROWS },
      this.digits(),
      book,
      ladderOrdersFrom(this.strip(), this.ocoGroups()),
      ladderPositionsFrom(this.strip()),
      this.tickCounts,
      pointSize(this.digits()),
    );
  });

  readonly canConfirm = computed(() => {
    const a = this.action();
    if (!a || this.busy()) return false;
    switch (a.type) {
      case 'place':
        return !!a.preview?.canSubmit;
      case 'oco':
        return a.previews.length === 2 && a.previews.every((p) => !!p?.canSubmit);
      case 'move':
        return !!a.preview?.canApply;
      default:
        return true;
    }
  });

  readonly confirmLabel = computed(() => {
    const a = this.action();
    switch (a?.type) {
      case 'place':
        return `Send ${a.request.mode.toLowerCase()} order`;
      case 'oco':
        return 'Send OCO pair';
      case 'move':
        return 'Move the order';
      case 'cancel':
        return a.order.ocoGroupId !== null ? 'Cancel the pair' : 'Cancel the order';
      case 'arm':
        return 'Arm one-click';
      default:
        return '';
    }
  });

  constructor() {
    // The feed of the symbol, while the panel is open.
    effect((onCleanup) => {
      const symbol = this.symbol();
      const md = this.stream.watch({ symbol, sources: null, kinds: ['book', 'ticks'] });
      const depth = this.liveDepth.watch(symbol);
      untracked(() => {
        this.md.set(md);
        this.depth.set(depth);
        this.shownSource = null;
        this.centre.set(null);
        this.tickCounts.clear();
        this.ocoFirst.set(null);
        void this.stream.entitlements.load();
      });
      // Ticks of the shown source (outside the zone, synchronous with the hub): the session's count per price.
      const off = md.onFrame((frame, s) => {
        if (!frame.ticks?.b?.length) return;
        if (this.shownSource !== null && s.sourceId !== this.shownSource) return;
        addTicks(this.tickCounts, frame.ticks.b, pointSize(this.digits()));
      });
      void this.loadSessionTicks(symbol, md);
      onCleanup(() => {
        off();
        md.release();
        depth.release();
      });
    });

    // Remember which source is shown (a plain field: the frame listener reads it outside Angular).
    effect(() => {
      this.shownSource = this.view().sourceId;
    });

    // Default account: the scope's single account, else the only live one. Changing it (or the symbol) disarms.
    effect(() => {
      const single = this.scope.effectiveSelectedId();
      const live = this.scope.liveAccounts();
      untracked(() => {
        if (this.accountId() !== null) return;
        if (single !== null) this.accountId.set(single);
        else if (live.length === 1) this.accountId.set(live[0].id);
      });
    });
    effect(() => {
      this.symbol();
      this.accountId();
      untracked(() => {
        const a = this.arming.arming();
        if (a && !this.arming.isArmedFor(this.accountId(), this.symbol())) this.arming.disarm();
      });
    });

    // Auto re-centre when the market leaves the middle of the view.
    effect(() => {
      const q = this.view().quote;
      if (!this.autoCentre()) return;
      untracked(() => {
        const c = this.centre();
        if (c === null) return;
        if (
          needsRecentre(
            { rowSize: this.rowSize(), centerIndex: c, halfRows: HALF_ROWS },
            q.bid,
            q.ask,
          )
        )
          this.centre.set(centreIndexFor(q.bid, q.ask, this.rowSize()));
      });
    });

    // My orders / signals / positions / OCO pairs on the symbol.
    effect((onCleanup) => {
      const symbol = this.symbol();
      const account = this.accountId();
      untracked(() => {
        this.strip.set(null);
        this.ocoGroups.set([]);
      });
      if (account === null) return;
      const read = () => void this.readOrders(symbol, account);
      read();
      const timer = this.zone.runOutsideAngular(() =>
        setInterval(() => {
          if (typeof document === 'undefined' || !document.hidden) read();
        }, ORDERS_POLL_MS),
      );
      onCleanup(() => clearInterval(timer));
    });

    this.destroyRef.onDestroy(() => (this.drag = null));
  }

  // ── Data ──────────────────────────────────────────────────────────────────

  private orderSeq = 0;
  private async readOrders(symbol: string, account: number): Promise<void> {
    const n = ++this.orderSeq;
    try {
      const [strip, oco] = await Promise.all([
        firstValueFrom(this.panels.accountStrip(symbol, [account])),
        firstValueFrom(this.trading.ocoGroups(symbol, account)).catch(() => null),
      ]);
      if (n !== this.orderSeq) return;
      this.strip.set(strip);
      this.ocoGroups.set(oco?.status && oco.data ? oco.data : []);
    } catch {
      /* the next read tries again; the ladder keeps what it showed */
    }
  }

  /** The session's ticks (since 17:00 New York) from the store, so the tick column is the session's, not the panel's. */
  private async loadSessionTicks(symbol: string, md: MdWatch): Promise<void> {
    const now = Date.now();
    const from = fxSessionStart(now);
    let ticks: { b: readonly number[] } | null = null;
    try {
      const h = await this.mdApi.history({ symbol, from, to: now, kinds: ['ticks'] });
      const sources = h.sources ?? [];
      // The source with the most ticks (the one the ladder will most likely show).
      ticks = sources.reduce<{ b: readonly number[] } | null>(
        (best, src) =>
          (src.ticks?.b?.length ?? 0) > (best?.b.length ?? 0) ? (src.ticks ?? null) : best,
        null,
      );
    } catch {
      ticks = null;
    }
    if (this.md() !== md) return;
    if (ticks?.b?.length) {
      addTicks(this.tickCounts, ticks.b, pointSize(this.digits()));
      this.tickNote.set(
        'tick count per price this session (since 17:00 New York; ticks, not traded volume)',
      );
    } else {
      this.tickNote.set(
        'tick count per price since the panel opened (the session history was not available)',
      );
    }
  }

  // ── Settings ──────────────────────────────────────────────────────────────

  setAccount(raw: string): void {
    const id = Number(raw);
    this.accountId.set(Number.isFinite(id) && id > 0 ? id : null);
  }

  setMode(mode: TicketMode): void {
    this.mode.set(mode);
    if (mode === 'Paper') {
      this.arming.disarm();
      this.ocoMode.set(false);
      this.ocoFirst.set(null);
    }
  }

  setStopAtr(raw: string): void {
    const v = Number(raw);
    if (Number.isFinite(v) && v >= 0.25) this.stopAtr.set(v);
  }

  setTargetR(raw: string): void {
    const v = Number(raw);
    if (Number.isFinite(v) && v >= 0) this.targetR.set(v);
  }

  setRowTicks(raw: string): void {
    const v = Number(raw);
    if (this.zooms.includes(v)) {
      this.rowTicks.set(v);
      this.centre.set(null);
    }
  }

  recentre(): void {
    const q = this.view().quote;
    this.centre.set(q ? centreIndexFor(q.bid, q.ask, this.rowSize()) : null);
  }

  onWheel(e: WheelEvent): void {
    e.preventDefault();
    const rows = Math.sign(e.deltaY) * (e.shiftKey ? 10 : 2);
    this.scrollRows(-rows);
  }

  onKey(e: KeyboardEvent): void {
    if (e.key === 'c' || e.key === 'C') {
      this.recentre();
      e.preventDefault();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      this.scrollRows(e.key === 'ArrowUp' ? 1 : -1);
      e.preventDefault();
    }
  }

  private scrollRows(by: number): void {
    const current = this.centre() ?? this.rows()[HALF_ROWS]?.index ?? null;
    if (current === null) return;
    this.autoCentre.set(false);
    this.centre.set(current + by);
  }

  toggleOco(): void {
    if (this.venue()) {
      this.hint.set('OCO pairs are for MT5 symbols; use the order ticket on an exchange-traded instrument.');
      return;
    }
    this.ocoMode.update((v) => !v);
    this.ocoFirst.set(null);
    this.hint.set(this.ocoMode() ? 'OCO: click the first leg’s price.' : null);
  }

  askArm(): void {
    if (!this.canArm() || this.venue()) return;
    this.openAction({ type: 'arm' });
  }

  disarm(): void {
    this.arming.disarm();
  }

  chipTitle(o: LadderOrder): string {
    const what = o.isSignal
      ? `manual signal ${o.id} (${o.status}, not placed yet)`
      : `order ${o.id} ${o.kind} ${o.status}`;
    const oco = o.ocoGroupId !== null ? ` · OCO pair #${o.ocoGroupId}` : '';
    return `${o.direction} ${what} at ${o.price}${oco}. ${o.isSignal ? '' : 'Drag to move · '}× to cancel.`;
  }

  // ── Clicks ────────────────────────────────────────────────────────────────

  async onCell(e: MouseEvent, column: LadderColumn, row: LadderRow): Promise<void> {
    this.hint.set(null);
    if (this.venue()) {
      this.openVenueTicket(column, row, e.shiftKey);
      return;
    }
    if (!this.canPlace()) {
      this.hint.set(
        this.accountId() === null
          ? 'Choose the account first.'
          : 'Trading needs the access.trader permission.',
      );
      return;
    }
    if (this.mode() !== 'Live') {
      this.hint.set(
        'Orders at a price are live only (paper tickets fill at market). Switch the ladder to Live, or use Buy/Sell MKT.',
      );
      return;
    }
    const q = this.view().quote;
    const intent = ladderIntent(column, row.price, q.bid, q.ask, e.shiftKey);
    if ('problem' in intent) {
      this.hint.set(intent.problem);
      return;
    }

    if (this.ocoMode()) {
      const first = this.ocoFirst();
      if (!first) {
        this.ocoFirst.set(intent);
        this.hint.set(
          `OCO leg 1: ${intent.direction} ${intent.kind} at ${intent.price}. Now click the other leg.`,
        );
        return;
      }
      const problem = ocoPairProblem(first, intent);
      if (problem) {
        this.hint.set(problem);
        return;
      }
      this.ocoFirst.set(null);
      this.ocoMode.set(false);
      await this.prepareOco(first, intent);
      return;
    }

    const request = await this.requestFor(intent.direction, intent.price);
    if (!request) return;
    if (this.armedHere()) {
      await this.sendPlace(request);
      return;
    }
    this.openAction({ type: 'place', request, intent, preview: null });
    await this.loadPlacePreview();
  }

  /** Enter on a focused cell = a click there (Shift+Enter = the stop modifier). */
  onCellKey(e: Event, column: LadderColumn, row: LadderRow): void {
    const k = e as KeyboardEvent;
    void this.onCell(new MouseEvent('click', { shiftKey: k.shiftKey }), column, row);
  }

  /** Exchange-traded instrument: the click becomes a prefilled venue ticket (the ladder itself sends nothing). */
  private openVenueTicket(column: LadderColumn, row: LadderRow, stop: boolean): void {
    const q = this.view().quote;
    const intent = ladderIntent(column, row.price, q.bid, q.ask, stop);
    if ('problem' in intent) {
      this.hint.set(intent.problem);
      return;
    }
    this.venueBus.open({
      symbol: this.symbol(),
      side: intent.direction,
      orderType: intent.kind === 'Stop' ? 'Stop' : 'Limit',
      price: intent.price,
    });
    this.hint.set(`Opened the order ticket: ${intent.direction} ${intent.kind} at ${intent.price}.`);
  }

  async market(direction: 'Buy' | 'Sell'): Promise<void> {
    if (this.venue()) {
      this.venueBus.open({ symbol: this.symbol(), side: direction, orderType: 'Market', price: null });
      this.hint.set(`Opened the order ticket: ${direction} at market.`);
      return;
    }
    if (!this.canPlace()) return;
    const request = await this.requestFor(direction, null);
    if (!request) return;
    if (this.armedHere() && request.mode === 'Live') {
      await this.sendPlace(request);
      return;
    }
    this.openAction({ type: 'place', request, intent: null, preview: null });
    await this.loadPlacePreview();
  }

  /** The ticket for a click: the account, the side, the price (null = market) and the default brackets from the ATR. */
  private async requestFor(
    direction: 'Buy' | 'Sell',
    price: number | null,
  ): Promise<ManualTradeRequest | null> {
    const account = this.accountId();
    if (account === null) return null;
    const mode: TicketMode = price === null ? this.mode() : 'Live';
    const base: ManualTradeRequest = {
      tradingAccountId: account,
      symbol: this.symbol(),
      direction,
      entryPrice: price,
      stopLoss: null,
      takeProfit: null,
      mode,
    };
    const q = this.view().quote;
    const entry = price ?? (direction === 'Buy' ? q?.ask : q?.bid) ?? null;
    const atr = await this.atrFor(base);
    const b =
      entry === null
        ? null
        : ladderBrackets(
            direction,
            entry,
            atr,
            { stopAtr: this.stopAtr(), targetR: this.targetR() },
            this.digits(),
          );
    if (!b) {
      this.hint.set(
        'No ATR for the default stop yet (the engine could not price the ticket) — try again in a moment.',
      );
      return null;
    }
    return { ...base, stopLoss: b.stopLoss, takeProfit: b.takeProfit };
  }

  /** The ATR the engine's preview reports for the account and symbol (cached a few minutes). */
  private async atrFor(base: ManualTradeRequest): Promise<number | null> {
    const key = `${base.tradingAccountId}:${base.symbol}`;
    if (this.atr && this.atr.key === key && Date.now() - this.atr.at < ATR_TTL_MS)
      return this.atr.value;
    try {
      const res = await firstValueFrom(
        this.trading.preview({ ...base, mode: 'Paper', entryPrice: null }),
      );
      const v = res?.data?.atr?.value ?? null;
      if (v !== null && v > 0) this.atr = { key, value: v, at: Date.now() };
      return v;
    } catch {
      return null;
    }
  }

  private async loadPlacePreview(): Promise<void> {
    const a = this.action();
    if (a?.type !== 'place') return;
    this.busy.set(true);
    try {
      const res = await firstValueFrom(this.trading.preview(a.request));
      if (this.action() !== a) return;
      if (res?.status && res.data) {
        this.action.set({ ...a, preview: res.data });
        if (!res.data.canSubmit)
          this.actionError.set(
            firstRefusal(res.data.gates)?.detail ??
              res.data.refusedReason ??
              'The engine would refuse it.',
          );
      } else this.actionError.set(res?.message || 'The engine could not check the order.');
    } catch {
      this.actionError.set('The engine did not answer the check.');
    } finally {
      this.busy.set(false);
    }
  }

  private async prepareOco(first: LadderIntent, second: LadderIntent): Promise<void> {
    const r1 = await this.requestFor(first.direction, first.price);
    const r2 = await this.requestFor(second.direction, second.price);
    if (!r1 || !r2) return;
    const legs: [ManualTradeRequest, ManualTradeRequest] = [r1, r2];
    if (this.armedHere()) {
      await this.sendOco(legs);
      return;
    }
    const action: LadderAction = { type: 'oco', legs, previews: [null, null] };
    this.openAction(action);
    this.busy.set(true);
    try {
      const previews = await Promise.all(
        legs.map((l) => firstValueFrom(this.trading.preview(l)).catch(() => null)),
      );
      if (this.action() !== action) return;
      this.action.set({ ...action, previews: previews.map((p) => (p?.status ? p.data : null)) });
      const refused = previews.findIndex((p) => !p?.status || !p.data?.canSubmit);
      if (refused >= 0)
        this.actionError.set(
          `Leg ${refused + 1} would be refused: ${previews[refused]?.data?.refusedReason ?? previews[refused]?.message ?? 'no answer'}`,
        );
    } finally {
      this.busy.set(false);
    }
  }

  // ── Working orders: drag to move, × to cancel ─────────────────────────────

  startDrag(e: PointerEvent, o: LadderOrder): void {
    if (o.isSignal || !this.auth.hasPermission(Permission.OrdersModify)) return;
    e.preventDefault();
    this.drag = { order: o };
  }

  cancelDrag(): void {
    this.drag = null;
  }

  async onDrop(e: PointerEvent): Promise<void> {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    const rowEl = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest(
      '[data-index]',
    );
    const index = rowEl ? Number(rowEl.getAttribute('data-index')) : NaN;
    if (!Number.isFinite(index)) return;
    const row = this.rows().find((r) => r.index === index);
    if (!row || rowIndex(d.order.price, this.rowSize()) === index) return;
    const q = this.view().quote;
    const problem = dropProblem(d.order, row.price, q.bid, q.ask);
    if (problem) {
      this.hint.set(problem);
      return;
    }
    if (this.armedHere()) {
      await this.sendMove(d.order, row.price);
      return;
    }
    const action: LadderAction = { type: 'move', order: d.order, to: row.price, preview: null };
    this.openAction(action);
    this.busy.set(true);
    try {
      const res = await firstValueFrom(
        this.trading.orderEntryMovePreview(
          d.order.id,
          movedLevels(d.order, row.price, this.digits()),
        ),
      );
      if (this.action() !== action) return;
      if (res?.status && res.data) this.action.set({ ...action, preview: res.data });
      else this.actionError.set(res?.message || 'The engine could not check the move.');
    } catch {
      this.actionError.set('The engine did not answer the check.');
    } finally {
      this.busy.set(false);
    }
  }

  askCancel(o: LadderOrder): void {
    const key = o.ocoGroupId !== null ? Permission.AccessTrader : Permission.OrdersCancel;
    if (!this.auth.hasPermission(key)) {
      this.hint.set(`Cancelling needs the ${key} permission.`);
      return;
    }
    if (o.isSignal && o.ocoGroupId === null) {
      this.hint.set(
        'A manual signal not placed yet is cancelled from the trade signals page (or it expires on its own).',
      );
      return;
    }
    if (this.armedHere()) {
      void this.sendCancel(o);
      return;
    }
    this.openAction({ type: 'cancel', order: o });
  }

  // ── The dialog ────────────────────────────────────────────────────────────

  private openAction(a: LadderAction): void {
    this.actionError.set(null);
    this.action.set(a);
  }

  closeAction(): void {
    if (this.busy() && this.action()?.type !== 'arm') return;
    this.action.set(null);
    this.actionError.set(null);
  }

  async confirm(): Promise<void> {
    const a = this.action();
    if (!a || !this.canConfirm()) return;
    switch (a.type) {
      case 'arm': {
        const account = this.accountId();
        if (account !== null) this.arming.arm(account, this.symbol());
        this.closeAction();
        return;
      }
      case 'place':
        await this.sendPlace(a.request);
        return;
      case 'oco':
        await this.sendOco(a.legs);
        return;
      case 'move':
        await this.sendMove(a.order, a.to);
        return;
      case 'cancel':
        await this.sendCancel(a.order);
        return;
    }
  }

  private async sendPlace(request: ManualTradeRequest): Promise<void> {
    this.busy.set(true);
    try {
      const res = await firstValueFrom(this.trading.submit(request));
      if (res?.status) {
        this.notify.success(res.data?.message || res.message || 'Sent.');
        this.closeActionNow();
        this.refreshOrders();
      } else this.fail(res?.message || 'The engine refused the order.');
    } catch {
      this.fail('The order was not sent — the engine did not answer.');
    } finally {
      this.busy.set(false);
    }
  }

  private async sendOco(legs: [ManualTradeRequest, ManualTradeRequest]): Promise<void> {
    const account = this.accountId();
    if (account === null) return;
    this.busy.set(true);
    try {
      const res = await firstValueFrom(this.trading.createOco({ accountId: account, legs }));
      if (res?.status) {
        this.notify.success(res.data?.message || res.message || 'OCO pair sent.');
        this.closeActionNow();
        this.refreshOrders();
      } else this.fail(res?.data?.message || res?.message || 'The engine refused the pair.');
    } catch {
      this.fail('The pair was not sent — the engine did not answer.');
    } finally {
      this.busy.set(false);
    }
  }

  private async sendMove(order: LadderOrder, to: number): Promise<void> {
    this.busy.set(true);
    try {
      const res = await firstValueFrom(
        this.trading.moveOrderEntry(
          order.id,
          movedLevels(order, to, this.digits()),
          newCorrelationId(),
        ),
      );
      if (res?.status) {
        this.notify.success(
          `Move of order ${order.id} to ${to} sent; the order changes when the EA confirms.`,
        );
        this.closeActionNow();
        this.refreshOrders();
      } else this.fail(res?.message || 'The engine refused the move.');
    } catch {
      this.fail('The move was not sent — the engine did not answer.');
    } finally {
      this.busy.set(false);
    }
  }

  private async sendCancel(order: LadderOrder): Promise<void> {
    this.busy.set(true);
    try {
      const res =
        order.ocoGroupId !== null
          ? await firstValueFrom(this.trading.cancelOco(order.ocoGroupId))
          : await firstValueFrom(this.trading.cancelOrder(order.id, newCorrelationId()));
      if (res?.status) {
        this.notify.success(res.message || 'Cancel sent.');
        this.closeActionNow();
        this.refreshOrders();
      } else this.fail(res?.message || 'The engine refused the cancel.');
    } catch {
      this.fail('The cancel was not sent — the engine did not answer.');
    } finally {
      this.busy.set(false);
    }
  }

  private fail(message: string): void {
    if (this.action()) this.actionError.set(message);
    else this.notify.error(message);
  }

  private closeActionNow(): void {
    this.action.set(null);
    this.actionError.set(null);
  }

  private refreshOrders(): void {
    const account = this.accountId();
    if (account !== null) void this.readOrders(this.symbol(), account);
  }

  readonly units = formatUnits;
}
