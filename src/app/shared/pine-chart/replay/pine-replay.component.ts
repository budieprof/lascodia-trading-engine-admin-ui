import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { ScriptingRunService } from '../api/scripting-run.service';
import type { PineChartData } from '../model/chart-data';
import type { PineDeclaration, PineRunRequest } from '../model/pine-outputs.types';
import { REPLAY_SPEEDS, ReplaySession, type ReplayApi } from './replay-session';

/**
 * Bar Replay controls: arm, then click a bar on the chart (the host binds the chart's `barClick` to
 * `pickedBar`) or type a start bar; step 1 / 5 / 20 bars, play/pause at a speed, stop. Every frame
 * is emitted through `dataChange` as a complete chart input — bind it to the chart's `result`
 * (falling back to the normal run result when it is null) and the chart extends in place.
 */
@Component({
  selector: 'app-pine-replay',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @switch (mode()) {
      @case ('off') {
        <button
          type="button"
          class="primary"
          (click)="arm()"
          [disabled]="!request()"
          title="Replay the script bar by bar from a bar you pick"
        >
          ⏪ Bar Replay
        </button>
      }
      @case ('armed') {
        <span class="hint">Click a bar on the chart to start, or</span>
        <label class="start">
          start at bar
          <input
            type="number"
            min="0"
            [value]="typedStart() ?? ''"
            (input)="typedStart.set(+$any($event.target).value)"
            aria-label="Start bar"
          />
        </label>
        <button type="button" (click)="startAt(typedStart())" [disabled]="typedStart() === null">
          Start
        </button>
        <button type="button" (click)="disarm()">Cancel</button>
      }
      @default {
        @if (session.status() === 'playing') {
          <button type="button" class="primary" (click)="session.pause()" title="Pause">
            ❚❚ Pause
          </button>
        } @else {
          <button
            type="button"
            class="primary"
            (click)="session.play()"
            [disabled]="!canStep()"
            title="Play"
          >
            ▶ Play
          </button>
        }
        @for (n of stepSizes; track n) {
          <button
            type="button"
            (click)="session.step(n)"
            [disabled]="!canStep() || session.status() === 'playing'"
            [title]="'Step ' + n + ' bar' + (n > 1 ? 's' : '')"
          >
            +{{ n }}
          </button>
        }
        <label class="speed">
          <select
            [value]="session.speed()"
            (change)="session.setSpeed(+$any($event.target).value)"
            aria-label="Replay speed"
          >
            @for (s of speeds; track s) {
              <option [value]="s">{{ s }} bar/s</option>
            }
          </select>
        </label>
        <span class="state">
          @switch (session.status()) {
            @case ('starting') {
              Starting at bar {{ session.startBar() }}…
            }
            @case ('ended') {
              End of data · bar {{ session.barIndex() }}
            }
            @case ('error') {
              <span class="err">{{ session.error() }}</span>
            }
            @default {
              Bar {{ session.barIndex() }}
            }
          }
          @if (positionText(); as pos) {
            <span class="position" title="Strategy position after this bar">· {{ pos }}</span>
          }
        </span>
        <button type="button" (click)="stop()" title="Stop the replay and return to the full run">
          ■ Stop
        </button>
      }
    }
  `,
  styles: [
    `
      :host {
        display: inline-flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px;
        font-size: 12px;
        color: var(--text-primary, #1d1d1f);
      }
      button,
      select,
      input {
        font: inherit;
        font-size: 11px;
        padding: 2px 8px;
        border-radius: 6px;
        border: 1px solid var(--border, rgba(0, 0, 0, 0.12));
        background: var(--bg-primary, #fff);
        color: inherit;
      }
      button {
        cursor: pointer;
      }
      button:disabled {
        opacity: 0.45;
        cursor: default;
      }
      button.primary {
        border-color: var(--accent, #0071e3);
        color: var(--accent, #0071e3);
      }
      input {
        width: 76px;
      }
      .hint,
      .state {
        color: var(--text-secondary, #6e6e73);
      }
      .err {
        color: var(--loss, #d70015);
      }
    `,
  ],
})
export class PineReplayComponent implements OnDestroy {
  private readonly service = inject(ScriptingRunService);

  /** The §3 request of the run being replayed (source or strategyId, symbol, timeframe, inputs). */
  readonly request = input<PineRunRequest | null>(null);
  /** Declaration of the script (overlay / title / format for the chart). */
  readonly declaration = input<PineDeclaration | null>(null);
  /**
   * Bar clicked on the chart — pass the chart's `barClick` event object (a new object per click, so
   * picking the same bar twice still registers) or a bar_index. While armed, it starts the replay.
   */
  readonly pickedBar = input<{ barIndex: number } | number | null>(null);
  /** Transport override (tests, fixture replays); defaults to the engine's §5 endpoints. */
  readonly api = input<ReplayApi | null>(null);

  /** The accumulated replay as chart input; null when the replay stops. */
  readonly dataChange = output<PineChartData | null>();
  /** True while waiting for a bar pick (the host can show a crosshair hint). */
  readonly armedChange = output<boolean>();
  /** bar_index of the newest replayed bar. */
  readonly barChange = output<number | null>();

  protected readonly stepSizes = [1, 5, 20] as const;
  protected readonly speeds = REPLAY_SPEEDS;
  readonly session: ReplaySession;
  readonly armed = signal(false);
  readonly typedStart = signal<number | null>(null);

  readonly mode = computed<'off' | 'armed' | 'on'>(() =>
    this.session.status() !== 'idle' ? 'on' : this.armed() ? 'armed' : 'off',
  );
  /** The strategy position after the replayed bar, when the frame carries one. */
  readonly positionText = computed(() => {
    const p = this.session.position();
    if (!p) return null;
    const size = typeof p.size === 'number' ? p.size : null;
    if (size === null) return null;
    if (size === 0) return 'flat';
    const parts = [`${size > 0 ? 'long' : 'short'} ${Math.abs(size)}`];
    if (typeof p.avgPrice === 'number') parts.push(`@ ${p.avgPrice}`);
    if (typeof p.openProfit === 'number')
      parts.push(`P/L ${p.openProfit >= 0 ? '+' : ''}${p.openProfit.toFixed(2)}`);
    return parts.join(' ');
  });
  readonly canStep = computed(() => {
    const s = this.session.status();
    return s === 'ready' || s === 'playing';
  });

  constructor() {
    this.session = new ReplaySession(() => this.api() ?? this.service);
    effect(() => {
      const data = this.session.data();
      untracked(() => this.dataChange.emit(data));
    });
    effect(() => {
      const bar = this.session.barIndex();
      untracked(() => this.barChange.emit(bar));
    });
    effect(() => {
      const picked = this.pickedBar();
      const bar = picked === null ? null : typeof picked === 'number' ? picked : picked.barIndex;
      untracked(() => {
        if (bar !== null && this.armed()) this.startAt(bar);
      });
    });
  }

  ngOnDestroy(): void {
    this.session.stop();
  }

  arm(): void {
    if (!this.request()) return;
    this.armed.set(true);
    this.armedChange.emit(true);
  }

  disarm(): void {
    this.armed.set(false);
    this.armedChange.emit(false);
  }

  startAt(bar: number | null): void {
    const req = this.request();
    if (bar === null || !Number.isFinite(bar) || !req) return;
    this.disarm();
    void this.session.start(req, bar, this.declaration());
  }

  stop(): void {
    this.session.stop();
  }
}
