import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { DatePipe } from '@angular/common';

import type { AnalysisMonitorActivity } from '@features/analysis-monitors/analysis-monitors.types';
import { humanizeNote } from '@features/analysis-monitors/monitor-format';

/** Activity kinds that get their own filter chip, in reading order; any others follow alphabetically. */
const KIND_ORDER = ['Fired', 'Touched', 'Invalidated', 'ScriptStep', 'Created', 'Expired', 'Cancelled', 'EvalError'];

/**
 * The fleet-wide "what just happened" feed: fires, touches, thesis breaks, expiries and operator
 * actions, grouped by UTC day and filterable by kind. Routine "checked, not met" heartbeats never
 * reach it — the engine excludes them — so a busy day still reads as a handful of events.
 */
@Component({
  selector: 'app-monitor-activity-feed',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe],
  template: `
    <section class="panel">
      <header class="panel-head">
        <h2>Recent activity</h2>
        <span class="muted small">Fires, touches, breaks, expiries and operator actions across the fleet — routine checks excluded</span>
      </header>
      <div class="chips">
        <button type="button" class="chip" [class.on]="kind() === ''" (click)="kind.set('')">
          All <span class="c">{{ activity().length }}</span>
        </button>
        @for (k of kinds(); track k.key) {
          <button type="button" class="chip" [class.on]="kind() === k.key" [attr.data-kind]="k.key" (click)="kind.set(kind() === k.key ? '' : k.key)">
            {{ k.key }} <span class="c">{{ k.count }}</span>
          </button>
        }
      </div>
      <ol class="feed">
        @for (a of visible(); track a.id; let i = $index) {
          @if (i === 0 || day(a) !== day(visible()[i - 1])) {
            <li class="feed-day">{{ a.occurredAtUtc | date: 'EEEE, MMM d' : 'UTC' }}</li>
          }
          <li class="feed-row">
            <span class="fdot" [attr.data-kind]="a.kind"></span>
            <span class="mono muted">{{ a.occurredAtUtc | date: 'HH:mm' : 'UTC' }}</span>
            <span class="kind" [attr.data-kind]="a.kind">{{ a.kind }}</span>
            <button type="button" class="link mono" (click)="openMonitor.emit(a.monitorId)">#{{ a.monitorId }}</button>
            <span class="sym mono">{{ a.symbol }}</span>
            <span class="tf">{{ a.timeframe }}</span>
            <span class="note" [title]="note(a)">{{ note(a) }}</span>
            @if (a.generatedSignalIds) {
              <span class="sig">signals {{ a.generatedSignalIds }}</span>
            }
          </li>
        }
      </ol>
      @if (filtered().length > preview) {
        <button type="button" class="link more" (click)="expanded.set(!expanded())">
          {{ expanded() ? 'Show fewer' : 'Show all ' + filtered().length + ' events' }}
        </button>
      }
    </section>
  `,
  styles: [
    `
      .panel {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-lg);
        padding: var(--space-3) var(--space-4);
      }
      .panel-head {
        display: flex;
        align-items: baseline;
        gap: var(--space-3);
        flex-wrap: wrap;
        margin-bottom: var(--space-3);
      }
      h2 {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .muted {
        color: var(--text-tertiary);
      }
      .small {
        font-size: var(--text-xs);
      }
      .mono {
        font-family: var(--font-mono, ui-monospace, monospace);
        font-variant-numeric: tabular-nums;
      }
      .chips {
        display: flex;
        gap: 4px;
        flex-wrap: wrap;
        margin-bottom: var(--space-2);
      }
      .chip {
        padding: 3px 10px;
        border-radius: var(--radius-full);
        border: 1px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-secondary);
        font: inherit;
        font-size: var(--text-xs);
        cursor: pointer;
      }
      .chip .c {
        margin-left: 3px;
        color: var(--text-tertiary);
      }
      .chip.on {
        background: var(--accent);
        border-color: var(--accent);
        color: #fff;
        font-weight: var(--font-semibold);
      }
      .chip.on .c {
        color: rgba(255, 255, 255, 0.8);
      }
      .feed {
        list-style: none;
        margin: 0;
        padding: 0;
        font-size: var(--text-xs);
      }
      .feed-day {
        margin: var(--space-3) 0 2px;
        font-size: 11px;
        font-weight: var(--font-semibold);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      .feed-day:first-child {
        margin-top: 0;
      }
      .feed-row {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 4px 0;
        border-bottom: 1px solid var(--border);
        min-width: 0;
      }
      .fdot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: var(--text-tertiary);
        flex: none;
      }
      .kind {
        padding: 0 6px;
        border-radius: var(--radius-sm);
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        white-space: nowrap;
        flex: none;
        min-width: 70px;
        text-align: center;
      }
      .sym {
        font-weight: var(--font-semibold);
        color: var(--text-primary);
      }
      .tf {
        color: var(--text-tertiary);
      }
      .note {
        flex: 1;
        min-width: 0;
        color: var(--text-secondary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .sig {
        padding: 0 6px;
        border-radius: var(--radius-sm);
        color: var(--tone-green);
        background: color-mix(in srgb, var(--tone-green) 14%, transparent);
        white-space: nowrap;
      }
      .link {
        background: none;
        border: none;
        padding: 0;
        color: var(--accent);
        cursor: pointer;
        font: inherit;
      }
      .more {
        margin-top: var(--space-2);
        font-size: var(--text-xs);
      }
      .kind[data-kind='Fired'],
      .chip[data-kind='Fired']:not(.on) {
        color: var(--tone-green);
        background: color-mix(in srgb, var(--tone-green) 14%, transparent);
      }
      .fdot[data-kind='Fired'] {
        background: var(--tone-green);
      }
      .kind[data-kind='Invalidated'],
      .kind[data-kind='EvalError'] {
        color: var(--tone-red);
        background: color-mix(in srgb, var(--tone-red) 14%, transparent);
      }
      .fdot[data-kind='Invalidated'],
      .fdot[data-kind='EvalError'] {
        background: var(--tone-red);
      }
      .kind[data-kind='Touched'],
      .kind[data-kind='ScriptStep'],
      .kind[data-kind='Rearmed'] {
        color: var(--tone-blue);
        background: color-mix(in srgb, var(--tone-blue) 14%, transparent);
      }
      .fdot[data-kind='Touched'],
      .fdot[data-kind='ScriptStep'],
      .fdot[data-kind='Rearmed'] {
        background: var(--tone-blue);
      }
      .kind[data-kind='Suppressed'],
      .kind[data-kind='RearmRefused'],
      .kind[data-kind='Escalated'] {
        color: var(--tone-amber);
        background: color-mix(in srgb, var(--tone-amber) 14%, transparent);
      }
    `,
  ],
})
export class MonitorActivityFeedComponent {
  readonly activity = input<AnalysisMonitorActivity[]>([]);
  readonly openMonitor = output<number>();

  protected readonly preview = 15;
  protected readonly expanded = signal(false);
  protected readonly kind = signal('');

  protected readonly kinds = computed(() => {
    const counts = new Map<string, number>();
    for (const a of this.activity()) counts.set(a.kind, (counts.get(a.kind) ?? 0) + 1);
    const known = KIND_ORDER.filter((k) => counts.has(k));
    const other = [...counts.keys()].filter((k) => !KIND_ORDER.includes(k)).sort();
    return [...known, ...other].map((key) => ({ key, count: counts.get(key) ?? 0 }));
  });

  protected readonly filtered = computed(() => {
    const k = this.kind();
    return k ? this.activity().filter((a) => a.kind === k) : this.activity();
  });

  protected readonly visible = computed(() => (this.expanded() ? this.filtered() : this.filtered().slice(0, this.preview)));

  protected day(a: AnalysisMonitorActivity): string {
    return a.occurredAtUtc.slice(0, 10);
  }

  protected note(a: AnalysisMonitorActivity): string {
    return humanizeNote(a.note);
  }
}
