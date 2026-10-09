import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { firstValueFrom } from 'rxjs';

import { ChartPanelsService } from './chart-panels.service';
import { formatUnits, parseDepth, snapshotAgeSeconds } from './depth';
import type { OrderBookSnapshot } from './chart-panels.types';

const POLL_MS = 1_500;

/**
 * Broker depth (SP-I9): the market depth (DOM) one broker's MT5 terminal shows for the symbol, as the EA reports it
 * about once a second (`market-data/order-book/latest`). It is labelled as what it is — one broker's book, not the
 * interbank market — with the reporting EA and the snapshot's age. Polled while open and the tab is visible.
 */
@Component({
  selector: 'app-depth-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DecimalPipe],
  template: `
    <p class="dp-note">
      Depth from one broker's MT5 feed — the liquidity that broker shows, not the whole market.
    </p>
    @if (error(); as e) {
      <div class="pane-empty">{{ e }}</div>
    } @else if (!snapshot()) {
      <div class="pane-empty">Loading…</div>
    } @else {
      @let d = ladder();
      @if (!d.hasLevels) {
        <p class="dp-note">This broker publishes the top of the book only.</p>
      }
      <div class="dp-ladder" role="table" aria-label="Broker depth">
        <div class="dp-row dp-head" role="row">
          <span>Price</span><span>Volume</span><span>Total</span>
        </div>
        @for (l of asksTopDown(); track l.price) {
          <div class="dp-row ask" role="row">
            <i class="dp-bar" [style.width.%]="l.share * 100"></i>
            <span class="dp-px">{{ l.price | number: '1.' + digits() + '-' + digits() }}</span>
            <span>{{ units(l.volume) }}</span>
            <span class="muted">{{ units(l.cumulative) }}</span>
          </div>
        }
        <div class="dp-spread" role="row">
          @if (d.spread !== null) {
            Spread {{ d.spread | number: '1.' + digits() + '-' + digits() }}
            @if (d.spread === 0) {
              <span class="muted">(locked book)</span>
            }
          }
          @if (d.bidShare !== null) {
            <span class="dp-imb" [title]="'Bid share of the volume shown: ' + (d.bidShare * 100 | number: '1.0-0') + '%'"
              >bids {{ d.bidShare * 100 | number: '1.0-0' }}%</span
            >
          }
        </div>
        @for (l of d.bids; track l.price) {
          <div class="dp-row bid" role="row">
            <i class="dp-bar" [style.width.%]="l.share * 100"></i>
            <span class="dp-px">{{ l.price | number: '1.' + digits() + '-' + digits() }}</span>
            <span>{{ units(l.volume) }}</span>
            <span class="muted">{{ units(l.cumulative) }}</span>
          </div>
        }
      </div>
      <div class="dp-foot muted">
        EA {{ shortInstance() }} · {{ age() === null ? '' : age() + ' s old' }}
        @if ((age() ?? 0) > 30) {
          <b class="dp-stale">— stale</b>
        }
      </div>
    }
  `,
  styles: [
    `
      :host {
        display: block;
        font-size: 12px;
      }
      /* The page's .pane-empty style does not reach inside this component (style encapsulation): the empty, loading and
         error states carry the same 10px/12px gutter here, or they sit flush against the pane's border. */
      .pane-empty {
        padding: 10px 12px;
        line-height: 1.45;
        color: var(--text-muted, #787b86);
      }
      .dp-note {
        margin: 0 10px 8px;
        color: var(--tv-muted, #787b86);
        font-size: 11px;
      }
      .dp-ladder {
        padding: 0 10px;
      }
      .dp-row {
        position: relative;
        display: grid;
        grid-template-columns: 1fr 1fr 1fr;
        gap: 6px;
        padding: 2px 4px;
        font-variant-numeric: tabular-nums;
        text-align: right;
      }
      .dp-row > span:first-of-type {
        text-align: left;
      }
      .dp-head {
        color: var(--tv-muted, #787b86);
        font-size: 11px;
      }
      .dp-bar {
        position: absolute;
        top: 1px;
        bottom: 1px;
        right: 0;
        opacity: 0.16;
        pointer-events: none;
      }
      .ask .dp-bar {
        background: #f23645;
      }
      .bid .dp-bar {
        background: #089981;
      }
      .ask .dp-px {
        color: #f23645;
      }
      .bid .dp-px {
        color: #089981;
      }
      .dp-spread {
        display: flex;
        justify-content: space-between;
        padding: 4px;
        margin: 2px 0;
        border-top: 1px solid var(--tv-line, #e0e3eb);
        border-bottom: 1px solid var(--tv-line, #e0e3eb);
        color: var(--tv-muted, #787b86);
        font-size: 11px;
      }
      .dp-foot {
        padding: 6px 10px;
        font-size: 11px;
      }
      .dp-stale {
        color: #f23645;
      }
    `,
  ],
})
export class DepthPanelComponent {
  private readonly api = inject(ChartPanelsService);

  readonly symbol = input.required<string>();
  readonly digits = input<number>(5);

  readonly snapshot = signal<OrderBookSnapshot | null>(null);
  readonly error = signal<string | null>(null);
  private readonly now = signal(Date.now());

  readonly ladder = computed(() => parseDepth(this.snapshot()));
  /** Asks with the best one at the bottom, next to the spread, as a DOM ladder reads. */
  readonly asksTopDown = computed(() => [...this.ladder().asks].reverse());
  readonly age = computed(() => {
    const s = this.snapshot();
    return s ? snapshotAgeSeconds(s.capturedAt, this.now()) : null;
  });
  readonly shortInstance = computed(() => {
    const id = this.snapshot()?.instanceId ?? '';
    return id.length > 18 ? `${id.slice(0, 10)}…${id.slice(-6)}` : id;
  });
  readonly units = formatUnits;
  private seq = 0;

  constructor() {
    effect((onCleanup) => {
      const symbol = this.symbol();
      untracked(() => {
        this.snapshot.set(null);
        this.error.set(null);
        void this.read(symbol);
      });
      const timer = setInterval(() => {
        if (document.hidden) return;
        this.now.set(Date.now());
        void this.read(symbol);
      }, POLL_MS);
      onCleanup(() => clearInterval(timer));
    });
    inject(DestroyRef).onDestroy(() => this.seq++);
  }

  private async read(symbol: string): Promise<void> {
    const n = ++this.seq;
    try {
      const snap = await firstValueFrom(this.api.orderBook(symbol));
      if (n !== this.seq) return;
      this.snapshot.set(snap);
      this.error.set(null);
    } catch {
      if (n !== this.seq) return;
      this.snapshot.set(null);
      this.error.set(
        `No depth for ${symbol}: this broker does not publish market depth for it, or no EA is streaming it.`,
      );
    }
  }
}
