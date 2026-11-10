import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';

import type { SpotAnalysisFollowUpTurnDto } from '@core/api/api.types';
import { MarketDataService } from '@core/services/market-data.service';

import {
  ACK_LABEL,
  batchNeedsAck,
  batchResultRows,
  batchSummary,
  batchableCards,
  cardTitle,
  errorEnvelope,
  provenanceOf,
  type BatchResultRow,
} from './card-safety';
import { preflightBadgeOf, replayLineOf } from './preflight-badge';

interface PreviewRow {
  id: number;
  title: string;
  preflight: string | null;
  preflightTone: string;
  outside: string | null;
  needsAck: boolean;
}

/**
 * "Review all N" — when two or more approval cards in the thread are waiting, one bar that lists
 * them with their pre-check and outside-text state and decides them together
 * (`POST market-data/analyze/follow-up/resolve-batch`, stopping at the first failure). Approve all
 * needs the outside-text tick when any card requires it. The engine answers with a result per card
 * and the refreshed thread, which is handed back to the host.
 */
@Component({
  selector: 'app-batch-review',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (cards().length >= 2 || results().length > 0) {
      <section class="batch" aria-label="Review waiting approval cards together">
        <header>
          @if (cards().length >= 2) {
            <strong>{{ cards().length }} changes are waiting for your approval</strong>
            <button
              type="button"
              class="link"
              (click)="open.set(!open())"
              [attr.aria-expanded]="open()"
            >
              {{ open() ? 'Hide' : 'Review all ' + cards().length }}
            </button>
          } @else {
            <strong>Decided together</strong>
          }
          @if (results().length > 0) {
            <button type="button" class="link" (click)="results.set([])">Clear results</button>
          }
        </header>

        @if (open() && cards().length >= 2) {
          <ol class="list">
            @for (r of preview(); track r.id) {
              <li>
                <span class="title">{{ r.title }}</span>
                <span class="tags">
                  @if (r.preflight) {
                    <span class="tag" [attr.data-tone]="r.preflightTone">{{ r.preflight }}</span>
                  }
                  @if (r.outside) {
                    <span class="tag" data-tone="warn" [title]="r.outside"
                      >⚠ outside text{{ r.needsAck ? ' · needs the check' : '' }}</span
                    >
                  }
                </span>
              </li>
            }
          </ol>
          @if (needsAck()) {
            <label class="ack">
              <input
                type="checkbox"
                [checked]="ack()"
                (change)="ack.set($any($event.target).checked)"
              />
              <span>{{ ackLabel }} (for every card above)</span>
            </label>
          }
          <p class="muted">Approved in the order shown; if one fails, the rest are not run.</p>
          <div class="actions">
            <button
              type="button"
              class="confirm"
              [disabled]="busy() || disabled() || (needsAck() && !ack())"
              (click)="decide(true)"
            >
              {{
                busy() && deciding() === 'approve' ? 'Running…' : 'Approve all ' + cards().length
              }}
            </button>
            <button
              type="button"
              class="dismiss"
              [disabled]="busy() || disabled()"
              (click)="decide(false)"
            >
              {{ busy() && deciding() === 'dismiss' ? 'Dismissing…' : 'Dismiss all' }}
            </button>
          </div>
        }

        @if (error(); as e) {
          <p class="bad" role="alert">{{ e }}</p>
        }
        @if (results().length > 0) {
          <div class="results" role="status">
            <p class="summary">{{ summary() }}</p>
            <ul>
              @for (r of results(); track r.turnId) {
                <li [attr.data-tone]="r.tone">
                  <strong>{{ r.title }}</strong> — {{ r.text }}
                </li>
              }
            </ul>
          </div>
        }
      </section>
    }
  `,
  styles: [
    `
      .batch {
        margin: var(--space-2) 0;
        padding: var(--space-2) var(--space-3);
        border: 1px solid color-mix(in srgb, var(--accent) 40%, var(--border));
        border-radius: var(--radius-md);
        background: color-mix(in srgb, var(--accent) 5%, var(--bg-secondary));
        font-size: var(--text-sm);
      }
      header {
        display: flex;
        flex-wrap: wrap;
        gap: 4px 12px;
        align-items: baseline;
      }
      .link {
        border: none;
        background: none;
        color: var(--accent);
        cursor: pointer;
        padding: 0;
        font-size: var(--text-sm);
      }
      .list {
        margin: var(--space-2) 0;
        padding-left: 20px;
        display: grid;
        gap: 4px;
      }
      .title {
        margin-right: 8px;
      }
      .tags {
        display: inline-flex;
        flex-wrap: wrap;
        gap: 4px;
      }
      .tag {
        font-size: var(--text-xs);
        padding: 0 6px;
        border-radius: 8px;
        border: 1px solid var(--border);
        color: var(--text-secondary);
      }
      .tag[data-tone='pass'] {
        color: var(--profit);
      }
      .tag[data-tone='warn'] {
        color: var(--warning);
      }
      .tag[data-tone='fail'] {
        color: var(--loss);
      }
      .ack {
        display: flex;
        gap: 6px;
        align-items: flex-start;
        cursor: pointer;
        font-size: var(--text-xs);
      }
      .muted {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
        margin: 4px 0;
      }
      .actions {
        display: flex;
        gap: 8px;
      }
      .actions button {
        border-radius: var(--radius-sm);
        padding: 4px 12px;
        font-size: var(--text-sm);
        cursor: pointer;
        border: 1px solid var(--border);
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }
      .actions .confirm {
        background: var(--accent);
        border-color: var(--accent);
        color: var(--accent-contrast, #fff);
      }
      .actions button:disabled {
        opacity: 0.55;
        cursor: default;
      }
      .bad {
        color: var(--loss);
        margin: 6px 0 0;
      }
      .results {
        margin-top: var(--space-2);
      }
      .summary {
        margin: 0 0 4px;
        font-weight: var(--font-semibold);
      }
      .results ul {
        margin: 0;
        padding-left: 18px;
        font-size: var(--text-xs);
      }
      .results li[data-tone='good'] strong {
        color: var(--profit);
      }
      .results li[data-tone='bad'] strong {
        color: var(--loss);
      }
      .results li[data-tone='warn'] strong {
        color: var(--warning);
      }
    `,
  ],
})
export class BatchReviewComponent {
  private readonly marketData = inject(MarketDataService);

  readonly turns = input.required<readonly SpotAnalysisFollowUpTurnDto[]>();
  /** The host is busy with a single card (or the thread is not ours to decide). */
  readonly disabled = input(false);
  readonly threadChanged = output<SpotAnalysisFollowUpTurnDto[]>();

  protected readonly ackLabel = ACK_LABEL;
  protected readonly open = signal(false);
  protected readonly ack = signal(false);
  protected readonly busy = signal(false);
  protected readonly deciding = signal<'approve' | 'dismiss' | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly results = signal<BatchResultRow[]>([]);

  protected readonly cards = computed(() => batchableCards(this.turns()));
  protected readonly needsAck = computed(() => batchNeedsAck(this.cards()));
  protected readonly summary = computed(() => batchSummary(this.results()));

  protected readonly preview = computed<PreviewRow[]>(() =>
    this.cards().map((c) => {
      const pf = preflightBadgeOf(c.toolName, c.toolArgsJson);
      const rp = replayLineOf(c.toolArgsJson);
      const pv = provenanceOf(c.toolArgsJson);
      return {
        id: c.id,
        title: cardTitle(c),
        preflight: pf
          ? pf.label +
            (rp
              ? ` · replay ${rp.outcome === 'passed' ? '✓' : rp.outcome === 'blocked' ? '✕' : '–'}`
              : '')
          : null,
        preflightTone: pf?.tone ?? 'neutral',
        outside: pv ? pv.title : null,
        needsAck: pv?.requiresAck === true,
      };
    }),
  );

  protected decide(confirm: boolean): void {
    const cards = this.cards();
    if (this.busy() || cards.length < 2) return;
    if (confirm && this.needsAck() && !this.ack()) return;
    this.busy.set(true);
    this.deciding.set(confirm ? 'approve' : 'dismiss');
    this.error.set(null);
    this.marketData
      .resolveFollowUpBatch({
        turnIds: cards.map((c) => c.id),
        confirm,
        acknowledgeUntrusted: confirm && this.ack() ? true : undefined,
        stopOnFailure: true,
      })
      .subscribe({
        next: (res) => {
          this.busy.set(false);
          this.deciding.set(null);
          if (res?.status && res.data) {
            this.results.set(batchResultRows(res.data.results, cards));
            this.ack.set(false);
            if (Array.isArray(res.data.thread) && res.data.thread.length)
              this.threadChanged.emit(res.data.thread);
          } else {
            this.error.set(res?.message || 'The engine did not decide the cards.');
          }
        },
        error: (err: unknown) => {
          this.busy.set(false);
          this.deciding.set(null);
          const e = errorEnvelope(err);
          this.error.set(e.message || 'The cards could not be sent. Is the engine reachable?');
        },
      });
  }
}
