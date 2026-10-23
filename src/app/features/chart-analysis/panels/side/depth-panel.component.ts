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

import { formatUnits, parseDepth, snapshotAgeSeconds } from './depth';
import type { OrderBookSnapshot } from './chart-panels.types';
import { ChartFlowService } from '../../orderflow/chart-flow.service';
import { formatUtcShort } from '../../orderflow/canvas-text';
import { LiveDepthService } from '../../orderflow/live-depth.service';
import { bookAtHead, type BookAtHead } from '../../orderflow/orderflow-replay';

/** While replay plays, the book at the head is read at most this often (the newest head wins). */
const REPLAY_READ_MS = 400;

/**
 * Broker depth (SP-I9): the market depth (DOM) one broker's MT5 terminal shows for the symbol, as the EA reports it
 * about once a second (`market-data/order-book/latest`). It is labelled as what it is — one broker's book, not the
 * interbank market — with the reporting EA and the snapshot's age. Polled while open and the tab is visible (the
 * shared 1.5 s poll the chart's heatmap also reads).
 *
 * In Bar Replay (OF-5, `asOfUtc` set) it shows the book as it was at the replay head instead
 * (`market-data/order-book/recent?AsOfUtc=`), says so, and never shows a book captured after the head.
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
    @if (asOfUtc(); as head) {
      <p class="dp-replay" data-testid="depth-replay-label">Replay — book at {{ utc(head) }}</p>
      @if (replayNote(); as n) {
        <p class="dp-note">{{ n }}</p>
      }
    }
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
        @if (asOfUtc() === null) {
          EA {{ shortInstance() }} · {{ age() === null ? '' : age() + ' s old' }}
          @if ((age() ?? 0) > 30) {
            <b class="dp-stale">— stale</b>
          }
        } @else {
          EA {{ shortInstance() }} · captured {{ utc(capturedMs()) }}
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
      .dp-replay {
        margin: 0 10px 6px;
        padding: 3px 6px;
        border-radius: 3px;
        background: rgba(41, 98, 255, 0.12);
        color: #2962ff;
        font-size: 11px;
        font-weight: 600;
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
  private readonly liveDepth = inject(LiveDepthService);
  private readonly flow = inject(ChartFlowService);

  readonly symbol = input.required<string>();
  readonly digits = input<number>(5);
  /** Bar Replay's head (UTC ms): show the book as of then; null = the live book. */
  readonly asOfUtc = input<number | null>(null);

  private readonly replayBook = signal<BookAtHead | null>(null);
  private readonly replayError = signal<string | null>(null);
  private readonly live = signal<{
    snapshot: () => OrderBookSnapshot | null;
    error: () => string | null;
    readAt: () => number;
  } | null>(null);

  readonly snapshot = computed<OrderBookSnapshot | null>(() => {
    if (this.asOfUtc() !== null) {
      const b = this.replayBook();
      return b?.kind === 'book' ? b.snapshot : null;
    }
    return this.live()?.snapshot() ?? null;
  });
  readonly error = computed<string | null>(() => {
    const head = this.asOfUtc();
    if (head === null) return this.live()?.error() ?? null;
    if (this.replayError()) return this.replayError();
    const b = this.replayBook();
    if (b?.kind === 'none') return `No broker depth stored for ${this.symbol()} at or before ${this.utc(head)} (order books are kept 7 days).`;
    if (b?.kind === 'future')
      return 'The engine answered with a book captured after the replay head, so none is shown (it did not apply the point-in-time filter).';
    return null;
  });
  /** How far the replay book is behind the head, when it is more than a few minutes. */
  readonly replayNote = computed(() => {
    const b = this.replayBook();
    if (b?.kind !== 'book' || !b.stale) return null;
    return `The nearest earlier book is ${Math.round(b.ageMs / 60_000)} min older than the head.`;
  });
  readonly capturedMs = computed(() => Date.parse(this.snapshot()?.capturedAt ?? '') || 0);

  readonly ladder = computed(() => parseDepth(this.snapshot()));
  /** Asks with the best one at the bottom, next to the spread, as a DOM ladder reads. */
  readonly asksTopDown = computed(() => [...this.ladder().asks].reverse());
  readonly age = computed(() => {
    const s = this.snapshot();
    return s ? snapshotAgeSeconds(s.capturedAt, this.live()?.readAt() ?? Date.now()) : null;
  });
  readonly shortInstance = computed(() => {
    const id = this.snapshot()?.instanceId ?? '';
    return id.length > 18 ? `${id.slice(0, 10)}…${id.slice(-6)}` : id;
  });
  readonly units = formatUnits;
  readonly utc = formatUtcShort;
  private seq = 0;
  private replayTimer: ReturnType<typeof setTimeout> | undefined;
  private lastReplayRead = 0;

  constructor() {
    // Live: the shared poll, while open and not in replay.
    effect((onCleanup) => {
      const symbol = this.symbol();
      if (this.asOfUtc() !== null) return;
      const watch = this.liveDepth.watch(symbol);
      untracked(() => this.live.set(watch));
      onCleanup(() => {
        watch.release();
        this.live.set(null);
      });
    });
    // Replay: the book at the head, read at most every 400 ms while the head moves (the newest head wins).
    effect(() => {
      const symbol = this.symbol();
      const head = this.asOfUtc();
      untracked(() => {
        clearTimeout(this.replayTimer);
        if (head === null) {
          this.seq++;
          this.replayBook.set(null);
          this.replayError.set(null);
          return;
        }
        const wait = Math.max(0, REPLAY_READ_MS - (Date.now() - this.lastReplayRead));
        this.replayTimer = setTimeout(() => void this.readAt(symbol, head), wait);
      });
    });
    inject(DestroyRef).onDestroy(() => {
      this.seq++;
      clearTimeout(this.replayTimer);
    });
  }

  private async readAt(symbol: string, head: number): Promise<void> {
    const n = ++this.seq;
    this.lastReplayRead = Date.now();
    try {
      const snap = await this.flow.bookAsOf(symbol, head);
      if (n !== this.seq) return;
      this.replayBook.set(bookAtHead(snap, head));
      this.replayError.set(null);
    } catch {
      if (n !== this.seq) return;
      this.replayBook.set(null);
      this.replayError.set(`The book at the replay head could not be read for ${symbol}.`);
    }
  }
}
