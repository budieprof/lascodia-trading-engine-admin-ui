import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';

import {
  formatElapsed,
  formatUsd,
  runElapsedMs,
  runPresence,
  runStatusTone,
} from '@shared/components/engineer-chat/engineer-turns';
import { formatAge, type WorkOrderRow } from './agent-ops';

/**
 * Every work order with a live run: what it is doing, what it has spent getting there, and the way
 * to stop it.
 *
 * The activity line, the status tone and the elapsed clock are the run bar's own functions, called
 * on the same run-state row the conversation header reads — so a work order cannot read "Thinking…"
 * here and "Waiting for you" there.
 *
 * `nowMs` is passed in rather than read from the clock here: the page owns one ticking signal for
 * every row, so twenty cards do not each hold their own interval.
 */
@Component({
  selector: 'app-ops-running',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    <ul class="list">
      @for (r of rows(); track r.sessionId) {
        <li class="row" [attr.data-tone]="tone(r)">
          <div class="head">
            <span class="pill" [attr.data-tone]="tone(r)">
              <span class="dot"></span>{{ r.statusLabel }}
            </span>
            <a
              class="title"
              [routerLink]="['/conversations']"
              [queryParams]="{ conversation: r.sessionId }"
              [title]="r.title"
              >{{ r.title }}</a
            >
            <button
              type="button"
              class="stop"
              [disabled]="!r.live || stopping() === r.sessionId"
              [title]="r.live ? 'Stop this run at its next step' : 'This run is not active'"
              (click)="stop.emit(r.sessionId)"
            >
              {{ stopping() === r.sessionId ? 'Stopping…' : '■ Stop' }}
            </button>
          </div>

          <div class="activity">{{ presence(r) }}</div>

          <div class="stats">
            @if (r.run; as run) {
              <span class="stat" title="Steps used of this run's step limit"
                >{{ run.steps }}<span class="of">/{{ run.maxSteps }}</span> steps</span
              >
              <span class="stat" title="Spend this run, against its budget">
                {{ usd(run.costUsd) }}
                @if (run.budgetUsd > 0) {
                  <span class="of">of {{ usd(run.budgetUsd) }}</span>
                }
              </span>
              <span class="stat" title="How long this run has been going">{{ elapsed(r) }}</span>
              @if (run.runCount > 1) {
                <span class="stat of"
                  >session {{ usd(run.sessionCostUsd) }} · {{ run.runCount }} runs</span
                >
              }
            } @else {
              <span class="stat of">No run detail — the run-state read did not answer</span>
            }
            @if (r.approvals.length > 0) {
              <span class="stat blocked"
                >⏳ {{ r.approvals.length }} approval{{
                  r.approvals.length === 1 ? '' : 's'
                }}
                waiting</span
              >
            }
            @if (r.watches.length > 0) {
              <span class="stat of">👁 {{ r.watches.length }} watching</span>
            }
            <span class="stat of last" title="Last turn written to this conversation"
              >active {{ age(r) }} ago</span
            >
          </div>
        </li>
      }
    </ul>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
      }
      .row {
        display: flex;
        flex-direction: column;
        gap: 5px;
        padding: 10px 12px;
        border: 1px solid var(--border);
        border-radius: var(--radius-lg);
        background: var(--bg-secondary);
        font-size: var(--text-xs);
      }
      .row[data-tone='waiting'] {
        border-color: color-mix(in srgb, var(--warning) 45%, var(--border));
      }
      .head {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        min-width: 0;
      }
      .pill {
        --tone: var(--text-tertiary);
        display: inline-flex;
        align-items: center;
        gap: 6px;
        flex: none;
        padding: 2px 9px 2px 7px;
        border-radius: var(--radius-full);
        font-weight: var(--font-semibold);
        color: var(--tone);
        background: color-mix(in srgb, var(--tone) 13%, transparent);
        border: 1px solid color-mix(in srgb, var(--tone) 30%, transparent);
        white-space: nowrap;
      }
      .pill[data-tone='working'] {
        --tone: var(--accent);
      }
      .pill[data-tone='waiting'] {
        --tone: var(--warning);
      }
      .pill[data-tone='watching'] {
        --tone: var(--profit);
      }
      .pill[data-tone='stopped'],
      .pill[data-tone='failed'] {
        --tone: var(--loss);
      }
      .dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: var(--tone);
        flex: none;
      }
      .pill[data-tone='working'] .dot {
        animation: ops-pulse 1.2s ease-in-out infinite;
      }
      @keyframes ops-pulse {
        0%,
        100% {
          opacity: 1;
        }
        50% {
          opacity: 0.5;
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .pill[data-tone='working'] .dot {
          animation: none;
        }
      }
      .title {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        color: var(--text-primary);
        text-decoration: none;
      }
      .title:hover {
        color: var(--accent);
        text-decoration: underline;
      }
      .stop {
        margin-left: auto;
        flex: none;
        font: inherit;
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
        padding: 3px 11px;
        border-radius: var(--radius-full);
        border: 1px solid var(--loss);
        background: transparent;
        color: var(--loss);
        cursor: pointer;
      }
      .stop:hover:not(:disabled) {
        background: color-mix(in srgb, var(--loss) 12%, transparent);
      }
      .stop:disabled {
        opacity: 0.4;
        cursor: not-allowed;
        border-color: var(--border);
        color: var(--text-tertiary);
      }
      .activity {
        color: var(--text-secondary);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .stats {
        display: flex;
        flex-wrap: wrap;
        gap: 4px var(--space-3);
        color: var(--text-primary);
      }
      .stat {
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }
      .of {
        color: var(--text-tertiary);
      }
      .blocked {
        color: var(--warning);
        font-weight: var(--font-semibold);
      }
      .last {
        margin-left: auto;
      }
    `,
  ],
})
export class OpsRunningComponent {
  readonly rows = input.required<readonly WorkOrderRow[]>();
  /** Session id whose Stop is in flight, or null. */
  readonly stopping = input<number | null>(null);
  /** Ticks with the page's clock so the elapsed times move without a refetch. */
  readonly nowMs = input<number>(Date.now());

  readonly stop = output<number>();

  protected readonly usd = formatUsd;

  protected tone(r: WorkOrderRow): string {
    return runStatusTone(r.status);
  }

  protected presence(r: WorkOrderRow): string {
    return runPresence(r.run).text;
  }

  protected elapsed(r: WorkOrderRow): string {
    return r.run ? formatElapsed(runElapsedMs(r.run, this.nowMs())) : '';
  }

  protected age(r: WorkOrderRow): string {
    const t = Date.parse(r.lastActivityAtUtc);
    return Number.isFinite(t) ? formatAge(this.nowMs() - t) : '—';
  }
}
