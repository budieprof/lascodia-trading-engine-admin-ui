import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { RealtimeService } from '@core/realtime/realtime.service';
import { MarketDataService } from '@core/services/market-data.service';

import {
  elapsedText,
  progressLine,
  progressVisible,
  reduceProgress,
  type AssistantProgressEvent,
  type ProgressState,
} from './assistant-progress';

/**
 * The live status line of a long assistant question, where the "Thinking…" placeholder used to
 * sit: what it is doing now (the engine's `message`), the tools of this round as chips, the
 * elapsed time, and whether the quick model is answering or the question was handed to the main
 * model. Fed by the `assistantProgress` realtime event (filtered by conversation) and, when a
 * thread is (re)opened, by the `progress` snapshot. With no progress known it falls back to
 * the plain "Thinking…" line while the host says work is running.
 */
@Component({
  selector: 'app-assistant-progress',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (line(); as l) {
      <div class="prog" role="status" aria-live="polite">
        @if (!waiting()) {
          <span class="spinner" aria-hidden="true"></span>
        }
        <span class="text">{{ l.text }}</span>
        @for (t of l.tools; track $index) {
          <span class="chip">{{ t }}</span>
        }
        <span class="meta">
          @if (elapsed()) {
            {{ elapsed() }}
          }
          @if (l.round) {
            · round {{ l.round }}
          }
          @if (l.modelNote) {
            · {{ l.modelNote }}
          }
        </span>
      </div>
    } @else if (live()) {
      <div class="prog" role="status">
        <span class="spinner" aria-hidden="true"></span>
        <span class="text">Thinking…</span>
        @if (elapsed()) {
          <span class="meta">{{ elapsed() }}</span>
        }
      </div>
    }
  `,
  styles: [
    `
      .prog {
        display: inline-flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 4px 8px;
        padding: 8px 12px;
        border-radius: var(--radius-lg, 12px);
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        font-size: var(--text-sm);
        max-width: 100%;
      }
      .text {
        color: var(--text-primary);
      }
      .chip {
        font-size: var(--text-xs);
        padding: 0 7px;
        border-radius: 8px;
        border: 1px solid var(--border);
        background: var(--bg-secondary);
      }
      .meta {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        font-variant-numeric: tabular-nums;
      }
      .spinner {
        width: 10px;
        height: 10px;
        border: 2px solid var(--border);
        border-top-color: var(--accent);
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
      }
      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }
    `,
  ],
})
export class AssistantProgressComponent {
  private readonly realtime = inject(RealtimeService);
  private readonly marketData = inject(MarketDataService);

  /** The open conversation's anchor id. */
  readonly llmInvocationId = input<number | null>(null);
  /** The host knows a question is running (its own send / resolve, or the agent run). */
  readonly live = input(false);
  /** When the running question was asked (the newest User turn), for the elapsed time. */
  readonly startedAtUtc = input<string | null>(null);
  /** Whether the engine's progress line is showing (so the host can show it while it is idle). */
  readonly shown = output<boolean>();

  private readonly state = signal<ProgressState | null>(null);
  private readonly now = signal(Date.now());
  private seq = 0;

  protected readonly line = computed(() => {
    const s = this.state();
    return s && progressVisible(s, this.now()) ? progressLine(s.event) : null;
  });
  protected readonly waiting = computed(() => this.state()?.event.phase === 'waiting');

  protected readonly elapsed = computed(() => {
    const s = this.state();
    if (!s && !this.live()) return '';
    const asked = Date.parse(this.startedAtUtc() ?? '');
    const from = Number.isFinite(asked) ? asked : (s?.firstSeenMs ?? null);
    return elapsedText(from, this.now());
  });

  constructor() {
    this.realtime.connect();
    this.realtime
      .on<AssistantProgressEvent>('assistantProgress')
      .pipe(takeUntilDestroyed())
      .subscribe((ev) =>
        this.state.update((s) => reduceProgress(s, ev, this.llmInvocationId(), Date.now())),
      );

    // A new conversation: drop the old line and ask whether a question is still running there.
    effect(() => {
      const id = this.llmInvocationId();
      untracked(() => {
        this.state.set(null);
        if (id) this.fetchSnapshot(id);
      });
    });

    // The host finished its own request: re-read once, so a line the "done" event missed clears.
    effect(() => {
      const live = this.live();
      const id = untracked(() => this.llmInvocationId());
      if (!live && id && untracked(() => this.state()) !== null)
        untracked(() => this.fetchSnapshot(id));
    });

    effect(() => {
      const on = this.line() !== null;
      untracked(() => this.shown.emit(on));
    });

    const timer = setInterval(() => {
      if (this.state() || this.live()) this.now.set(Date.now());
    }, 1000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  private fetchSnapshot(id: number): void {
    const seq = ++this.seq;
    this.marketData.analysisProgress(id).subscribe({
      next: (res) => {
        if (seq !== this.seq || this.llmInvocationId() !== id) return;
        const snap = res?.status ? res.data : null;
        if (!snap || typeof snap !== 'object' || Array.isArray(snap) || !snap.phase) {
          this.state.set(null);
          return;
        }
        this.state.set(reduceProgress(null, { ...snap, llmInvocationId: id }, id, Date.now()));
      },
      // An engine without the endpoint simply has no snapshot: the plain line stays.
      error: () => undefined,
    });
  }
}
