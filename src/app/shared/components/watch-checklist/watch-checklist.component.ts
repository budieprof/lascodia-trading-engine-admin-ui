import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';

import { RecWatchChecklistDto, RecWatchStepDto } from './watch-checklist.types';

/**
 * Everything that has to happen before a monitor files its card, in order, with the steps already met ticked —
 * built by the engine from the watch's script, trigger and invalidation. Used on the recommendation page (one per
 * monitor armed to file the card) and in the monitors page's detail drawer.
 */
@Component({
  selector: 'app-watch-checklist',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, RouterLink],
  template: `
    @let c = checklist();
    <div class="wc" [class]="'wc wc--' + c.state">
      <header class="wc-head">
        <div class="wc-title">
          <span class="wc-name">{{ c.title }}</span>
          <span class="muted small">
            judged on {{ c.judgedOn }}
            @if (monitorId(); as id) {
              ·
              <a [routerLink]="['/analysis-monitors']" [queryParams]="{ focus: id }"
                >monitor #{{ id }}</a
              >
            }
          </span>
        </div>
        <div class="wc-score">
          <span class="wc-count mono"
            ><b>{{ c.done }}</b
            ><span class="muted">/{{ c.total }}</span></span
          >
          <span class="pill" [class]="'pill pill--' + stateTone()">{{ stateLabel() }}</span>
        </div>
      </header>

      <div
        class="wc-bar"
        role="progressbar"
        [attr.aria-valuenow]="c.done"
        [attr.aria-valuemax]="c.total"
        [attr.aria-label]="c.done + ' of ' + c.total + ' steps met'"
      >
        @for (s of c.steps; track s.number) {
          <span
            class="seg"
            [class]="'seg seg--' + s.status"
            [title]="s.number + '. ' + s.title"
          ></span>
        }
      </div>

      @if (c.stateNote) {
        <p class="wc-note" [class]="'wc-note wc-note--' + c.state">{{ c.stateNote }}</p>
      }

      <ol class="steps">
        @for (s of c.steps; track s.number; let last = $last) {
          <li class="step" [class]="'step step--' + s.status" [class.step--last]="last">
            <div class="rail">
              <span class="node" [attr.aria-label]="statusLabel(s)">
                @switch (s.status) {
                  @case ('done') {
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M3.5 8.5l3 3 6-7" />
                    </svg>
                  }
                  @case ('failed') {
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
                    </svg>
                  }
                  @case ('stopped') {
                    <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 8h6" /></svg>
                  }
                  @default {
                    <span class="num">{{ s.number }}</span>
                  }
                }
              </span>
              @if (!last) {
                <span class="line"></span>
              }
            </div>

            <div class="body">
              <div class="row">
                <span class="title">{{ s.title }}</span>
                @if (s.status === 'current') {
                  <span class="now"><span class="dot"></span>Waiting now</span>
                }
              </div>
              @if (s.detail) {
                <div class="detail">{{ s.detail }}</div>
              }
              <div class="chips">
                <span class="lane" [class]="'lane lane--' + s.lane">
                  @switch (s.lane) {
                    @case ('live') {
                      <svg viewBox="0 0 16 16" aria-hidden="true">
                        <path d="M9 1.5L3.5 9H8l-1 5.5L12.5 7H8z" />
                      </svg>
                      Live price
                    }
                    @case ('file') {
                      <svg viewBox="0 0 16 16" aria-hidden="true">
                        <path d="M3 8.5l3 3 7-7" />
                      </svg>
                      Engine action
                    }
                    @default {
                      <svg viewBox="0 0 16 16" aria-hidden="true">
                        <path d="M8 1.5v3M8 11.5v3M5.5 4.5h5v7h-5z" />
                      </svg>
                      Candle close
                    }
                  }
                </span>
                @for (r of s.rules; track r) {
                  <span class="rule">{{ r }}</span>
                }
              </div>
              @if (s.status === 'done' && s.doneAtUtc) {
                <div class="met">
                  @if (s.lane === 'candle') {
                    Met on the {{ s.doneAtUtc | date: 'MMM d, HH:mm' : 'UTC' }} UTC candle
                    @if (s.doneClose !== null) {
                      · closed <span class="mono">{{ price(s.doneClose) }}</span>
                    }
                  } @else {
                    Happened {{ s.doneAtUtc | date: 'MMM d, HH:mm:ss' : 'UTC' }} UTC
                  }
                </div>
              }
              @if (s.status === 'current' && s.lane === 'live' && hasPrice()) {
                <div class="met muted">
                  Last price <span class="mono">{{ price(lastPrice()) }}</span>
                  @if (lastCheckedAtUtc()) {
                    at {{ lastCheckedAtUtc() | date: 'HH:mm' : 'UTC' }} UTC
                  }
                </div>
              }
            </div>
          </li>
        }
      </ol>

      @if (c.guards.length > 0) {
        <div class="guards">
          <div class="guards-head">
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M8 1.5l5.5 2v4c0 3.3-2.3 6-5.5 7-3.2-1-5.5-3.7-5.5-7v-4z" />
            </svg>
            Calls it off
          </div>
          <ul>
            @for (g of c.guards; track g.text + g.scope) {
              <li [class.off]="!g.active && live()">
                <span class="g-dot" [class]="'g-dot g-dot--' + g.lane"></span>
                <span class="g-text">{{ g.text }}</span>
                <span class="g-scope">
                  {{ g.scope }}
                  @if (live()) {
                    {{ g.active ? '· in force' : '· not yet' }}
                  }
                </span>
              </li>
            }
          </ul>
        </div>
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-variant-numeric: tabular-nums;
      }
      .muted {
        color: var(--text-secondary);
      }
      .pill {
        display: inline-flex;
        align-items: center;
        font-size: 11px;
        font-weight: var(--font-semibold);
        padding: 2px 8px;
        border-radius: 999px;
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        line-height: 1.5;
        white-space: nowrap;
      }
      .pill--good {
        background: rgba(52, 199, 89, 0.15);
        color: var(--profit);
      }
      .pill--bad {
        background: rgba(255, 59, 48, 0.15);
        color: var(--loss);
      }
      .pill--warn {
        background: rgba(255, 149, 0, 0.16);
        color: var(--warning);
      }
      .pill--info {
        background: rgba(0, 113, 227, 0.12);
        color: var(--accent);
      }
      .small {
        font-size: 12px;
      }
      .wc {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .wc-head {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: var(--space-3);
        flex-wrap: wrap;
      }
      .wc-title {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
      }
      .wc-name {
        font-size: 15px;
        font-weight: var(--font-semibold);
      }
      .wc-title a {
        color: var(--accent);
        text-decoration: none;
      }
      .wc-title a:hover {
        text-decoration: underline;
      }
      .wc-score {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .wc-count {
        font-size: 20px;
        line-height: 1;
      }
      .wc-count b {
        font-weight: var(--font-semibold);
      }

      /* Segmented progress */
      .wc-bar {
        display: flex;
        gap: 4px;
      }
      .seg {
        flex: 1;
        height: 6px;
        border-radius: 999px;
        background: var(--bg-tertiary);
        transition: background 0.3s ease;
      }
      .seg--done {
        background: var(--profit);
      }
      .seg--current {
        background: linear-gradient(90deg, var(--accent), rgba(0, 113, 227, 0.25));
        background-size: 200% 100%;
        animation: wc-flow 1.8s linear infinite;
      }
      .seg--failed {
        background: var(--loss);
      }
      .seg--stopped {
        background: var(--warning);
      }
      @keyframes wc-flow {
        from {
          background-position: 100% 0;
        }
        to {
          background-position: -100% 0;
        }
      }

      .wc-note {
        margin: 0;
        font-size: 13px;
        padding: 8px 12px;
        border-radius: var(--radius-md);
        background: rgba(0, 113, 227, 0.07);
        color: var(--text-primary);
      }
      .wc-note--fired {
        background: rgba(52, 199, 89, 0.1);
      }
      .wc-note--broken,
      .wc-note--error {
        background: rgba(255, 59, 48, 0.08);
      }
      .wc-note--expired,
      .wc-note--cancelled,
      .wc-note--paused {
        background: rgba(255, 149, 0, 0.1);
      }

      /* Stepper */
      .steps {
        list-style: none;
        margin: 0;
        padding: 0;
      }
      .step {
        display: grid;
        grid-template-columns: 28px minmax(0, 1fr);
        gap: 12px;
      }
      .rail {
        display: flex;
        flex-direction: column;
        align-items: center;
      }
      .node {
        width: 26px;
        height: 26px;
        border-radius: 50%;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex: none;
        border: 2px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-secondary);
        font-size: 12px;
        font-weight: var(--font-semibold);
        transition: all 0.2s ease;
      }
      .node svg {
        width: 14px;
        height: 14px;
        fill: none;
        stroke: currentColor;
        stroke-width: 2.2;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
      .line {
        flex: 1;
        width: 2px;
        min-height: 14px;
        margin: 3px 0;
        border-radius: 2px;
        background: var(--border);
      }
      .step--done .node {
        background: var(--profit);
        border-color: var(--profit);
        color: #fff;
      }
      .step--done .line {
        background: var(--profit);
      }
      .step--current .node {
        border-color: var(--accent);
        color: var(--accent);
        box-shadow: 0 0 0 4px rgba(0, 113, 227, 0.14);
        animation: wc-pulse 2s ease-in-out infinite;
      }
      .step--failed .node {
        background: var(--loss);
        border-color: var(--loss);
        color: #fff;
      }
      .step--stopped .node {
        background: var(--warning);
        border-color: var(--warning);
        color: #fff;
      }
      .step--pending .body {
        opacity: 0.72;
      }
      @keyframes wc-pulse {
        0%,
        100% {
          box-shadow: 0 0 0 4px rgba(0, 113, 227, 0.14);
        }
        50% {
          box-shadow: 0 0 0 7px rgba(0, 113, 227, 0.05);
        }
      }

      .body {
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding: 2px 0 18px;
        min-width: 0;
      }
      .step--last .body {
        padding-bottom: 2px;
      }
      .step--current .body {
        background: rgba(0, 113, 227, 0.05);
        border-radius: var(--radius-md);
        padding: 8px 10px;
        margin: -6px 0 12px -4px;
      }
      .row {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }
      .title {
        font-size: 14px;
        font-weight: var(--font-semibold);
        color: var(--text-primary);
      }
      .step--done .title {
        color: var(--text-primary);
      }
      .now {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        font-size: 11px;
        font-weight: var(--font-semibold);
        color: var(--accent);
      }
      .now .dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(--accent);
        animation: wc-blink 1.4s ease-in-out infinite;
      }
      @keyframes wc-blink {
        50% {
          opacity: 0.25;
        }
      }
      .detail {
        font-size: 12.5px;
        color: var(--text-secondary);
        line-height: 1.45;
      }
      .chips {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-top: 2px;
      }
      .lane,
      .rule {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        font-size: 10.5px;
        font-weight: var(--font-semibold);
        padding: 1px 7px;
        border-radius: 999px;
        line-height: 1.6;
        white-space: nowrap;
      }
      .lane svg {
        width: 11px;
        height: 11px;
        fill: none;
        stroke: currentColor;
        stroke-width: 1.6;
        stroke-linejoin: round;
        stroke-linecap: round;
      }
      .lane--candle {
        background: var(--bg-tertiary);
        color: var(--text-secondary);
      }
      .lane--live {
        background: rgba(255, 149, 0, 0.14);
        color: var(--warning);
      }
      .lane--live svg {
        fill: currentColor;
        stroke: none;
      }
      .lane--file {
        background: rgba(0, 113, 227, 0.12);
        color: var(--accent);
      }
      .rule {
        border: 1px dashed var(--border);
        color: var(--text-secondary);
        font-weight: normal;
      }
      .met {
        font-size: 12px;
        color: var(--profit);
      }
      .met.muted {
        color: var(--text-secondary);
      }

      /* Guards */
      .guards {
        border-top: 1px solid var(--border);
        padding-top: var(--space-3);
      }
      .guards-head {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 11px;
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-secondary);
        margin-bottom: 8px;
      }
      .guards-head svg {
        width: 13px;
        height: 13px;
        fill: none;
        stroke: currentColor;
        stroke-width: 1.6;
        stroke-linejoin: round;
      }
      .guards ul {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .guards li {
        display: grid;
        grid-template-columns: 10px minmax(0, 1fr) auto;
        align-items: baseline;
        gap: 8px;
        font-size: 12.5px;
      }
      .guards li.off {
        opacity: 0.5;
      }
      .g-dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: var(--loss);
        align-self: center;
      }
      .g-dot--time {
        background: var(--text-tertiary);
      }
      .g-dot--live {
        background: var(--warning);
      }
      .g-scope {
        font-size: 11px;
        color: var(--text-secondary);
        white-space: nowrap;
      }
      @media (max-width: 640px) {
        .guards li {
          grid-template-columns: 10px minmax(0, 1fr);
        }
        .g-scope {
          grid-column: 2;
          white-space: normal;
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .seg--current,
        .step--current .node,
        .now .dot {
          animation: none;
        }
      }
    `,
  ],
})
export class WatchChecklistComponent {
  readonly checklist = input.required<RecWatchChecklistDto>();
  readonly symbol = input<string>('');
  /** Links to the monitor on the monitors page; leave unset where the page is already that monitor. */
  readonly monitorId = input<number | null>(null);
  /** The monitor's last observed price, shown under a live-price step that is waiting. */
  readonly lastPrice = input<number | null | undefined>(null);
  readonly lastCheckedAtUtc = input<string | null | undefined>(null);
  readonly hasPrice = computed(() => typeof this.lastPrice() === 'number');

  /** Guards only say "in force / not yet" while the watch can still move. */
  readonly live = computed(() => ['waiting', 'paused'].includes(this.checklist().state));

  readonly stateLabel = computed(() => {
    switch (this.checklist().state) {
      case 'fired':
        return 'Fired';
      case 'broken':
        return 'Setup broke';
      case 'expired':
        return 'Expired';
      case 'cancelled':
        return 'Cancelled';
      case 'paused':
        return 'Paused';
      case 'error':
        return 'Error';
      default:
        return 'Watching';
    }
  });

  readonly stateTone = computed(() => {
    switch (this.checklist().state) {
      case 'fired':
        return 'good';
      case 'broken':
      case 'error':
        return 'bad';
      case 'expired':
      case 'cancelled':
      case 'paused':
        return 'warn';
      default:
        return 'info';
    }
  });

  statusLabel(s: RecWatchStepDto): string {
    const word =
      s.status === 'done'
        ? 'met'
        : s.status === 'current'
          ? 'waiting now'
          : s.status === 'failed'
            ? 'failed'
            : s.status === 'stopped'
              ? 'stopped'
              : 'not yet';
    return `Step ${s.number}: ${word}`;
  }

  /** Metals 2 decimals, JPY 3, else 5 — the console's price convention. */
  price(v: number | null | undefined): string {
    if (v == null) return '—';
    const s = this.symbol().toUpperCase();
    const digits = s.startsWith('XAU') || s.startsWith('XAG') ? 2 : s.includes('JPY') ? 3 : 5;
    return v.toFixed(digits);
  }
}
