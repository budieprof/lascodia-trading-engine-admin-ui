import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  input,
  output,
  signal,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import type { AlgoEngineerRunStateDto } from '@core/api/api.types';
import {
  formatElapsed,
  formatUsd,
  isRunLive,
  parseCapabilities,
  parseWatches,
  runElapsedMs,
  runStatusLabel,
  runStatusTone,
} from './engineer-turns';

/**
 * Header for an algo-engineer conversation: what the agent is doing right now.
 *
 * Presentational — the chat owns the run-state fetch (it already refetches on every
 * `analysisConversationChanged` tickle) and the Stop call, so the composer's "stop" chip and this
 * button share one code path. The only state kept here is the local clock that makes the elapsed
 * time tick while a run is Working.
 */
@Component({
  selector: 'app-engineer-run-bar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe],
  template: `
    <div class="bar" [attr.data-tone]="tone()">
      <div class="row">
        <span class="pill" [attr.data-tone]="tone()" [title]="pillTitle()">
          <span class="dot"></span>{{ label() }}
        </span>
        @if (run(); as r) {
          <span class="stat" title="Steps used of this run's step limit"
            >{{ r.steps }}<span class="of">/{{ r.maxSteps }}</span> steps</span
          >
          <span class="stat" title="Spend this run, against its budget"
            >{{ usd(r.costUsd) }}
            @if (r.budgetUsd > 0) {
              <span class="of">of {{ usd(r.budgetUsd) }}</span>
            }
          </span>
          <span class="stat mono" [title]="'Started ' + (r.startedAtUtc | date: 'medium')">{{
            elapsed()
          }}</span>
          @if (r.runCount > 1) {
            <span class="stat of" title="Every run of this conversation"
              >session {{ usd(r.sessionCostUsd) }} · {{ r.runCount }} runs</span
            >
          }
          <button
            type="button"
            class="stop"
            [disabled]="!canStop() || stopping()"
            [title]="canStop() ? 'Stop the running agent' : 'No active run to stop'"
            (click)="stop.emit()"
          >
            {{ stopping() ? 'Stopping…' : '■ Stop' }}
          </button>
        } @else if (loaded()) {
          <span class="stat of">No run recorded for this conversation yet</span>
        }
      </div>

      @if (run(); as r) {
        @if (r.activity && live()) {
          <div class="activity" [title]="r.activity">{{ r.activity }}</div>
        } @else if (r.stopReason && !live()) {
          <div class="activity reason" [title]="r.stopReason">{{ r.stopReason }}</div>
        } @else if (r.activity) {
          <div class="activity" [title]="r.activity">{{ r.activity }}</div>
        }
        @if (capabilities().length > 0 || watches().length > 0) {
          <div class="chips">
            @for (c of capabilities(); track c.label) {
              <span
                class="chip"
                [class.off]="!c.on"
                [class.ro]="c.label === 'Read-only'"
                [title]="c.title"
                >{{ c.label }}</span
              >
            }
            @for (w of watches(); track w.id) {
              <span class="chip watch" [title]="w.title || w.label"
                >👁 {{ w.label }}
                @if (w.nextCheckAtUtc) {
                  <span class="of">· {{ w.nextCheckAtUtc | date: 'HH:mm' }}</span>
                }
              </span>
            }
          </div>
        }
      }

      @if (message(); as m) {
        <div class="msg" [class.err]="!m.ok">{{ m.text }}</div>
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
        --eng-ok: color-mix(in srgb, var(--profit) 72%, var(--text-primary));
        --eng-warn: color-mix(in srgb, var(--warning) 78%, var(--text-primary));
        --eng-bad: color-mix(in srgb, var(--loss) 82%, var(--text-primary));
      }
      .bar {
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding: 7px var(--space-3);
        border-bottom: 1px solid var(--border);
        background: var(--bg-secondary);
        font-size: var(--text-xs);
      }
      .row {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 6px 12px;
      }
      .pill {
        --tone: var(--text-tertiary);
        display: inline-flex;
        align-items: center;
        gap: 6px;
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
        --tone: var(--eng-warn);
      }
      .pill[data-tone='watching'],
      .pill[data-tone='done'] {
        --tone: var(--eng-ok);
      }
      .pill[data-tone='failed'] {
        --tone: var(--eng-bad);
      }
      .dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: var(--tone);
        flex: none;
      }
      .pill[data-tone='working'] .dot {
        animation: rb-pulse 1.2s ease-in-out infinite;
      }
      @keyframes rb-pulse {
        0%,
        100% {
          opacity: 1;
          box-shadow: 0 0 0 0 color-mix(in srgb, var(--tone) 55%, transparent);
        }
        50% {
          opacity: 0.55;
          box-shadow: 0 0 0 4px transparent;
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .pill[data-tone='working'] .dot {
          animation: none;
        }
      }
      .stat {
        color: var(--text-primary);
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }
      .of {
        color: var(--text-tertiary);
      }
      .mono {
        font-family: var(--font-mono, monospace);
      }
      .stop {
        margin-left: auto;
        font: inherit;
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
        padding: 3px 11px;
        border-radius: var(--radius-full);
        border: 1px solid var(--eng-bad);
        background: transparent;
        color: var(--eng-bad);
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
      .activity.reason {
        font-style: italic;
      }
      .chips {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
      }
      .chip {
        padding: 1px 7px;
        border-radius: var(--radius-full);
        border: 1px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-secondary);
        font-size: 10px;
        white-space: nowrap;
      }
      .chip.off {
        color: var(--text-tertiary);
        text-decoration: line-through;
        opacity: 0.75;
      }
      .chip.ro {
        border-color: color-mix(in srgb, var(--accent) 40%, transparent);
        color: var(--accent);
        font-weight: var(--font-semibold);
      }
      .chip.watch {
        border-color: color-mix(in srgb, var(--profit) 35%, transparent);
        color: var(--eng-ok);
      }
      .msg {
        color: var(--text-secondary);
      }
      .msg.err {
        color: var(--eng-bad);
      }
    `,
  ],
})
export class EngineerRunBarComponent {
  /** The session's latest run, or null when it has none (or it has not loaded). */
  readonly run = input<AlgoEngineerRunStateDto | null>(null);
  /** True once the first run-state fetch settled — distinguishes "no run" from "loading". */
  readonly loaded = input<boolean>(false);
  readonly stopping = input<boolean>(false);
  /** Outcome of the last Stop, shown under the bar. */
  readonly message = input<{ text: string; ok: boolean } | null>(null);

  readonly stop = output<void>();

  /** Local clock; only advances while the run is Working. */
  private readonly now = signal(Date.now());

  protected readonly tone = computed(() => runStatusTone(this.run()?.status));
  protected readonly label = computed(() => runStatusLabel(this.run()?.status));
  protected readonly live = computed(() => isRunLive(this.run()?.status));
  protected readonly canStop = this.live;
  protected readonly pillTitle = computed(() => {
    const r = this.run();
    if (!r) return 'No run yet';
    if ((r.status ?? '').toLowerCase() === 'stale')
      return 'The run has not reported for 15 minutes — the host may have died';
    return r.trigger ? `Run started by: ${r.trigger.replace(/_/g, ' ')}` : r.status;
  });
  protected readonly elapsed = computed(() => {
    const r = this.run();
    return r ? formatElapsed(runElapsedMs(r, this.now())) : '';
  });
  protected readonly capabilities = computed(() => parseCapabilities(this.run()?.capabilitiesJson));
  protected readonly watches = computed(() => parseWatches(this.run()?.watchesJson));

  protected readonly usd = formatUsd;

  constructor() {
    effect((onCleanup) => {
      if (this.tone() !== 'working') return;
      this.now.set(Date.now());
      const h = setInterval(() => this.now.set(Date.now()), 1000);
      onCleanup(() => clearInterval(h));
    });
  }
}
