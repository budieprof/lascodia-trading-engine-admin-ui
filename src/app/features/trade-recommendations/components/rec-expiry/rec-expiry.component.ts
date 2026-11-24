import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';

import type { RecDeadlineDto, RecExpiryDto } from '../../trade-recommendations.types';

type Tone = 'calm' | 'soon' | 'urgent' | 'ended';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** "1d 4h", "3h 12m", "8m", "40s" — the short form for the later clocks and "ago". */
export function shortSpan(ms: number): string {
  const a = Math.abs(ms);
  if (a >= DAY) return `${Math.floor(a / DAY)}d ${Math.floor((a % DAY) / HOUR)}h`;
  if (a >= HOUR) return `${Math.floor(a / HOUR)}h ${Math.floor((a % HOUR) / MIN)}m`;
  if (a >= MIN) return `${Math.floor(a / MIN)}m`;
  return `${Math.max(0, Math.floor(a / 1000))}s`;
}

/**
 * A live countdown to the moment the recommendation stops being able to trade: the clock that runs out first, ticking
 * every second on a ring that drains from when that clock started, coloured calm → soon (under a quarter left or an
 * hour) → urgent (ten minutes); what happens at zero; and the clocks behind it. Once time has run out it says which
 * clock ended it and how long ago.
 */
@Component({
  selector: 'app-rec-expiry',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, DecimalPipe],
  template: `
    @let e = expiry();
    @let b = e.binding;
    <section class="xp" [class]="'xp xp--' + tone()" role="timer" [attr.aria-label]="ariaLabel()">
      <div class="ring" aria-hidden="true">
        <svg viewBox="0 0 44 44">
          <circle class="track" cx="22" cy="22" r="19" />
          <circle
            class="fill"
            cx="22"
            cy="22"
            r="19"
            pathLength="100"
            [attr.stroke-dasharray]="remainingPct() + ' 100'"
          />
        </svg>
        <span class="ring-ico">{{ tone() === 'ended' ? '⌛' : '⏱' }}</span>
      </div>

      <div class="main">
        <div class="eyebrow">
          @if (tone() === 'ended') {
            Expired · {{ ago() }} ago
          } @else {
            Expires in
          }
        </div>
        @if (tone() !== 'ended') {
          <div class="clock">
            @for (seg of segments(); track seg.unit) {
              <span class="seg">
                <span class="num">{{ seg.value }}</span>
                <span class="unit">{{ seg.unit }}</span>
              </span>
            }
          </div>
        }
        <div class="what">
          <strong>{{ b.title }}</strong>
          <span class="at">{{ b.atUtc | date: 'EEE MMM d, HH:mm' : 'UTC' }} UTC</span>
        </div>
        <p class="detail">{{ b.detail }}</p>
      </div>

      @if (tone() !== 'ended') {
        <div class="bar" aria-hidden="true">
          <span class="bar-fill" [style.width.%]="elapsedPct()"></span>
        </div>
        <div class="bar-legend">
          <span>{{ b.fromUtc | date: 'MMM d, HH:mm' : 'UTC' }}</span>
          <span>{{ elapsedPct() | number: '1.0-0' }}% of the {{ windowLabel() }} window used</span>
        </div>
      }

      @if (e.others.length > 0) {
        <ul class="then">
          <li class="then-head">Then</li>
          @for (o of e.others; track o.kind + (o.refId ?? '')) {
            <li [title]="o.detail">
              <span class="dot" [class]="'dot dot--' + o.kind"></span>
              {{ o.title }}
              <span class="muted">{{ relative(o) }}</span>
            </li>
          }
        </ul>
      }
    </section>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .xp {
        --tone: var(--accent);
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 6px 16px;
        padding: 14px 18px;
        border-radius: var(--radius-lg, 12px);
        border: 1px solid color-mix(in srgb, var(--tone) 35%, var(--border-color, transparent));
        background: linear-gradient(
          100deg,
          color-mix(in srgb, var(--tone) 12%, var(--bg-secondary)) 0%,
          var(--bg-secondary) 60%
        );
      }
      .xp--soon {
        --tone: var(--warning);
      }
      .xp--urgent {
        --tone: var(--loss);
      }
      .xp--ended {
        --tone: var(--text-secondary);
      }
      .ring {
        position: relative;
        width: 64px;
        height: 64px;
        grid-row: span 2;
        align-self: center;
      }
      .ring svg {
        width: 100%;
        height: 100%;
        transform: rotate(-90deg);
      }
      .track {
        fill: none;
        stroke: var(--bg-tertiary);
        stroke-width: 4;
      }
      .fill {
        fill: none;
        stroke: var(--tone);
        stroke-width: 4;
        stroke-linecap: round;
        transition:
          stroke-dasharray 0.9s linear,
          stroke 0.4s;
      }
      .ring-ico {
        position: absolute;
        inset: 0;
        display: grid;
        place-items: center;
        font-size: 20px;
      }
      .xp--urgent .ring-ico {
        animation: xp-pulse 1s ease-in-out infinite;
      }
      @keyframes xp-pulse {
        50% {
          transform: scale(1.15);
        }
      }
      .main {
        min-width: 0;
      }
      .eyebrow {
        font-size: 10.5px;
        font-weight: var(--font-semibold);
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--tone);
      }
      .clock {
        display: flex;
        align-items: baseline;
        gap: 10px;
        margin: 2px 0 4px;
      }
      .seg {
        display: inline-flex;
        align-items: baseline;
        gap: 2px;
      }
      .num {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-variant-numeric: tabular-nums;
        font-size: 30px;
        line-height: 1.1;
        font-weight: var(--font-semibold);
        color: var(--text-primary);
      }
      .unit {
        font-size: 13px;
        color: var(--text-secondary);
      }
      .what {
        display: flex;
        flex-wrap: wrap;
        align-items: baseline;
        gap: 4px 10px;
        font-size: 13px;
      }
      .at {
        font-size: 12px;
        color: var(--text-secondary);
        font-variant-numeric: tabular-nums;
      }
      .detail {
        margin: 4px 0 0;
        font-size: 12.5px;
        color: var(--text-secondary);
        max-width: 70ch;
      }
      .bar {
        grid-column: 1 / -1;
        height: 6px;
        border-radius: 999px;
        background: var(--bg-tertiary);
        overflow: hidden;
        margin-top: 8px;
      }
      .bar-fill {
        display: block;
        height: 100%;
        border-radius: inherit;
        background: linear-gradient(
          90deg,
          color-mix(in srgb, var(--tone) 55%, transparent),
          var(--tone)
        );
        transition: width 0.9s linear;
      }
      .bar-legend {
        grid-column: 1 / -1;
        display: flex;
        justify-content: space-between;
        font-size: 11px;
        color: var(--text-secondary);
        font-variant-numeric: tabular-nums;
      }
      .then {
        grid-column: 1 / -1;
        display: flex;
        flex-wrap: wrap;
        gap: 6px 16px;
        list-style: none;
        margin: 6px 0 0;
        padding: 8px 0 0;
        border-top: 1px dashed var(--border-color, var(--bg-tertiary));
        font-size: 12.5px;
      }
      .then-head {
        font-size: 10.5px;
        font-weight: var(--font-semibold);
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--text-secondary);
        align-self: center;
      }
      .then li {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: var(--text-secondary);
      }
      .dot--monitor {
        background: var(--accent);
      }
      .dot--plan {
        background: var(--warning);
      }
      .muted {
        color: var(--text-secondary);
        font-variant-numeric: tabular-nums;
      }
      @media (prefers-reduced-motion: reduce) {
        .fill,
        .bar-fill {
          transition: none;
        }
        .xp--urgent .ring-ico {
          animation: none;
        }
      }
    `,
  ],
})
export class RecExpiryComponent {
  readonly expiry = input.required<RecExpiryDto>();

  private readonly now = signal(Date.now());

  constructor() {
    const t = setInterval(() => this.now.set(Date.now()), 1_000);
    inject(DestroyRef).onDestroy(() => clearInterval(t));
  }

  private readonly at = computed(() => Date.parse(this.expiry().binding.atUtc));
  private readonly from = computed(() => Date.parse(this.expiry().binding.fromUtc));
  private readonly left = computed(() => this.at() - this.now());

  readonly tone = computed<Tone>(() => {
    const left = this.left();
    if (this.expiry().state === 'ended' || left <= 0) return 'ended';
    if (left <= 10 * MIN) return 'urgent';
    if (left <= HOUR || 100 - this.elapsedPct() <= 25) return 'soon';
    return 'calm';
  });

  readonly elapsedPct = computed(() => {
    const span = this.at() - this.from();
    if (!(span > 0)) return 100;
    return Math.min(100, Math.max(0, ((this.now() - this.from()) / span) * 100));
  });

  readonly remainingPct = computed(() => (this.tone() === 'ended' ? 0 : 100 - this.elapsedPct()));

  /** Days/hours/minutes, with seconds once under a day — every unit two digits but the first. */
  readonly segments = computed(() => {
    const ms = Math.max(0, this.left());
    const d = Math.floor(ms / DAY);
    const h = Math.floor((ms % DAY) / HOUR);
    const m = Math.floor((ms % HOUR) / MIN);
    const s = Math.floor((ms % MIN) / 1000);
    const pad = (n: number) => String(n).padStart(2, '0');
    if (d > 0) {
      return [
        { value: String(d), unit: 'd' },
        { value: pad(h), unit: 'h' },
        { value: pad(m), unit: 'm' },
      ];
    }
    if (h > 0) {
      return [
        { value: String(h), unit: 'h' },
        { value: pad(m), unit: 'm' },
        { value: pad(s), unit: 's' },
      ];
    }
    return [
      { value: String(m), unit: 'm' },
      { value: pad(s), unit: 's' },
    ];
  });

  readonly windowLabel = computed(() => shortSpan(this.at() - this.from()).replace(/ 0[hm]$/, ''));

  readonly ago = computed(() => shortSpan(this.now() - this.at()));

  /** Minute-grained, so a screen reader is not re-read every second. */
  readonly ariaLabel = computed(() => {
    const b = this.expiry().binding;
    return this.tone() === 'ended'
      ? `${b.title}, ${this.ago()} ago`
      : `${b.title} in ${shortSpan(this.left())}`;
  });

  relative(o: RecDeadlineDto): string {
    const ms = Date.parse(o.atUtc) - this.now();
    return ms > 0 ? `in ${shortSpan(ms)}` : `${shortSpan(ms)} ago`;
  }
}
