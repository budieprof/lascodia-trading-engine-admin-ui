import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';

import { RecMonitorDto, recFormatPrice, recPrettyJson } from '../../trade-recommendations.types';

/**
 * One monitor armed to file the card (or, for a monitor-review card, the monitor that wrote it):
 * what it watches for, what it will do, where it stands, and every notable event it logged.
 * Routine evaluations are counted and only the latest few are listed.
 */
@Component({
  selector: 'app-rec-monitor',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, DecimalPipe, RouterLink],
  styleUrls: ['../../rec-shared.scss'],
  template: `
    @let m = monitor();
    <article class="mon">
      <header class="mon-head">
        <div class="mon-title">
          <a
            class="pill pill--link mono"
            [routerLink]="['/analysis-monitors']"
            [queryParams]="{ focus: m.id }"
          >
            Monitor #{{ m.id }} ↗
          </a>
          <span class="pill" [class]="'pill pill--' + statusTone()">{{ m.status }}</span>
          @if (role()) {
            <span class="pill">{{ role() }}</span>
          }
          <span class="pill">{{ m.evaluationMode }}</span>
          @if (m.ocoGroupId) {
            <span class="pill pill--warn mono" title="One-cancels-other group"
              >OCO {{ m.ocoGroupId }}</span
            >
          }
          @if (m.dryRunActions) {
            <span class="pill pill--warn">Dry run</span>
          }
        </div>
        <span class="muted small">
          {{ m.origin }}{{ m.createdBy ? ' · ' + m.createdBy : '' }} · armed
          {{ m.createdAtUtc | date: 'MMM d, HH:mm' : 'UTC' }} UTC
        </span>
      </header>

      <p class="prose intent">{{ m.intentText }}</p>

      <dl class="kv">
        <dt>Expires</dt>
        <dd>{{ m.expiresAtUtc | date: 'MMM d, HH:mm' : 'UTC' }} UTC</dd>
        <dt>Triggers</dt>
        <dd class="mono">
          {{ m.triggerCount }} / {{ m.maxTriggers }}{{ m.recurring ? ' · recurring' : '' }}
        </dd>
        @if (m.confirmOn) {
          <dt>Confirm on</dt>
          <dd>
            {{ m.confirmOn }}
            @if (m.confirmPendingSinceUtc) {
              <span class="muted"
                >— pending since {{ m.confirmPendingSinceUtc | date: 'MMM d, HH:mm' : 'UTC' }}</span
              >
            }
          </dd>
        }
        @if (m.lastCheckedAtUtc) {
          <dt>Last checked</dt>
          <dd>
            {{ m.lastCheckedAtUtc | date: 'MMM d, HH:mm:ss' : 'UTC' }} UTC
            @if (m.lastObservedPrice !== null) {
              <span class="mono muted">@ {{ price(m.lastObservedPrice) }}</span>
            }
          </dd>
        }
        @if (m.lastTriggeredAtUtc) {
          <dt>Last fired</dt>
          <dd>{{ m.lastTriggeredAtUtc | date: 'MMM d, HH:mm:ss' : 'UTC' }} UTC</dd>
        }
        @if (m.planTargetPrice !== null) {
          <dt>Plan target</dt>
          <dd class="mono">{{ price(m.planTargetPrice) }}</dd>
        }
        @if (m.lastEvalNote) {
          <dt>Last note</dt>
          <dd>{{ m.lastEvalNote }}</dd>
        }
        @if (m.scriptLastReading) {
          <dt>Script reading</dt>
          <dd class="mono">{{ m.scriptLastReading }}</dd>
        }
        @if (m.llmSpendUsd > 0) {
          <dt>LLM spend</dt>
          <dd class="mono">\${{ m.llmSpendUsd | number: '1.2-4' }}</dd>
        }
        @if (m.anchorLlmInvocationId) {
          <dt>Conversation</dt>
          <dd>
            <a
              class="pill pill--link"
              [routerLink]="['/conversations']"
              [queryParams]="{ conversation: m.anchorLlmInvocationId }"
            >
              #{{ m.anchorLlmInvocationId }} ↗
            </a>
          </dd>
        }
      </dl>

      <div class="specs">
        <details>
          <summary>Trigger</summary>
          <pre class="code">{{ pretty(m.triggerSpecJson) }}</pre>
        </details>
        <details>
          <summary>Actions</summary>
          <pre class="code">{{ pretty(m.actionSpecJson) }}</pre>
        </details>
        @if (m.invalidationSpecJson) {
          <details>
            <summary>Invalidation</summary>
            <pre class="code">{{ pretty(m.invalidationSpecJson) }}</pre>
          </details>
        }
        @if (m.scriptSource) {
          <details>
            <summary>Structure script</summary>
            <pre class="code">{{ m.scriptSource }}</pre>
          </details>
        }
        @if (m.outcomeJson) {
          <details>
            <summary>Outcome</summary>
            <pre class="code">{{ pretty(m.outcomeJson) }}</pre>
          </details>
        }
      </div>

      <div class="events">
        <div class="events-head">
          <h3>Events</h3>
          <label class="muted small">
            <input
              type="checkbox"
              [checked]="showEvaluations()"
              (change)="showEvaluations.set(!showEvaluations())"
            />
            Show routine evaluations ({{ m.evaluatedCount
            }}{{ m.evaluatedCount > evaluationsShown() ? ', latest ' + evaluationsShown() : '' }})
          </label>
        </div>
        @if (events().length === 0) {
          <p class="empty-line">No events.</p>
        } @else {
          <div class="table-wrap">
            <table class="grid">
              <thead>
                <tr>
                  <th>When (UTC)</th>
                  <th>Kind</th>
                  <th>Note</th>
                  <th>Path</th>
                  <th>Spread</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                @for (e of events(); track e.id) {
                  <tr [class.fired]="e.fired">
                    <td class="mono nowrap">
                      {{ e.occurredAtUtc | date: 'MMM d, HH:mm:ss' : 'UTC' }}
                    </td>
                    <td>
                      <span class="pill" [class]="'pill pill--' + eventTone(e.kind)">{{
                        e.kind
                      }}</span>
                    </td>
                    <td class="note">
                      {{ e.note ?? '' }}
                      @if (e.statusAfter) {
                        <span class="muted"> → {{ e.statusAfter }}</span>
                      }
                      @if (e.actorUserId) {
                        <span class="muted"> · by {{ e.actorUserId }}</span>
                      }
                    </td>
                    <td class="muted">{{ e.evaluationPath ?? '' }}</td>
                    <td class="mono">
                      {{
                        e.observedSpreadPips !== null
                          ? (e.observedSpreadPips | number: '1.1-1')
                          : ''
                      }}
                    </td>
                    <td class="nowrap">
                      @if (e.resultLlmInvocationId) {
                        <a
                          [routerLink]="['/conversations']"
                          [queryParams]="{ conversation: e.resultLlmInvocationId }"
                        >
                          #{{ e.resultLlmInvocationId }}
                        </a>
                      }
                      @if (e.generatedSignalIds) {
                        <span class="mono"> ⚡ {{ e.generatedSignalIds }}</span>
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      </div>
    </article>
  `,
  styles: [
    `
      .mon {
        display: flex;
        flex-direction: column;
        gap: 10px;
        padding: var(--space-3);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        background: var(--bg-primary);
      }
      .mon-head {
        display: flex;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: 6px;
        align-items: center;
      }
      .mon-title {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        align-items: center;
      }
      .small {
        font-size: 12px;
      }
      .intent {
        font-style: italic;
      }
      .specs {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      details summary {
        cursor: pointer;
        font-size: var(--text-sm);
        color: var(--accent);
        margin-bottom: 4px;
      }
      .events-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        flex-wrap: wrap;
        gap: 6px;
        margin-bottom: 6px;
      }
      .events-head h3 {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .nowrap {
        white-space: nowrap;
      }
      .note {
        min-width: 220px;
        overflow-wrap: anywhere;
      }
      tr.fired td {
        background: rgba(52, 199, 89, 0.06);
      }
    `,
  ],
})
export class RecMonitorComponent {
  readonly monitor = input.required<RecMonitorDto>();
  readonly symbol = input<string>('');
  /** "Origin" for the monitor that wrote a monitor-review card. */
  readonly role = input<string | null>(null);

  readonly showEvaluations = signal(false);

  readonly evaluationsShown = computed(
    () => this.monitor().events.filter((e) => e.kind === 'Evaluated').length,
  );

  readonly events = computed(() =>
    this.showEvaluations()
      ? this.monitor().events
      : this.monitor().events.filter((e) => e.kind !== 'Evaluated'),
  );

  readonly statusTone = computed(() => {
    switch (this.monitor().status) {
      case 'Active':
        return 'info';
      case 'Triggered':
        return 'good';
      case 'Invalidated':
      case 'Error':
        return 'bad';
      case 'Cancelled':
      case 'Expired':
      case 'Paused':
        return 'warn';
      default:
        return 'neutral';
    }
  });

  eventTone(kind: string): string {
    switch (kind) {
      case 'Fired':
        return 'good';
      case 'Invalidated':
      case 'Error':
        return 'bad';
      case 'Cancelled':
      case 'Expired':
        return 'warn';
      case 'Created':
      case 'Updated':
      case 'Extended':
        return 'info';
      default:
        return 'neutral';
    }
  }

  price(v: number | null): string {
    return recFormatPrice(this.symbol() || this.monitor().symbol, v);
  }

  pretty(s: string | null): string {
    return recPrettyJson(s);
  }
}
