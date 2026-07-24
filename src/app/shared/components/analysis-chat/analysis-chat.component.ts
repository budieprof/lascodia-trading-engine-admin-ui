import {
  ChangeDetectionStrategy,
  Component,
  effect,
  ElementRef,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { MarkdownPipe } from '@shared/pipes/markdown.pipe';
import { MarketDataService } from '@core/services/market-data.service';
import type { SpotAnalysisFollowUpTurnDto } from '@core/api/api.types';

/**
 * Interactive follow-up chat for an LLM spot analysis. Given the analysis's
 * `llmInvocationId`, it loads any existing conversation thread and lets the
 * operator ask free-text follow-up questions ("Why refuse the sell-stop?",
 * "What would flip you to a long?"). Each question re-prompts the deep-tier LLM
 * server-side with the ORIGINAL market snapshot + analysis + prior turns in
 * context, so answers stay grounded even though the provider keeps no session.
 *
 * Conversations are persisted per analysis (engine-side), so the thread
 * rehydrates whenever the same analysis is reopened. Non-streaming: a "Thinking…"
 * spinner shows while the reply is generated, then the full markdown answer
 * lands. Reused by the trading-chart analysis dialog and the per-tile
 * spot-analysis modal — anywhere a `MarketAnalysisResultDto` is on screen.
 */
@Component({
  selector: 'app-analysis-chat',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MarkdownPipe],
  template: `
    <section class="chat" aria-label="Analysis follow-up chat">
      <div class="chat-log" #log>
        @if (loading()) {
          <div class="chat-state"><span class="spinner"></span> Loading conversation…</div>
        }

        @for (m of messages(); track m.id ?? $index) {
          <div class="msg" [class.user]="m.role === 'User'">
            @if (m.role === 'Assistant') {
              <div class="bubble md" [innerHTML]="m.content | markdown"></div>
            } @else {
              <div class="bubble">{{ m.content }}</div>
            }
          </div>
        }

        @if (sending()) {
          <div class="msg">
            <div class="bubble thinking"><span class="spinner"></span> Thinking…</div>
          </div>
        }

        @if (error()) {
          <div class="chat-state error">{{ error() }}</div>
        }

        @if (!loading() && messages().length === 0 && !sending() && !error()) {
          <div class="chat-empty">
            Ask a follow-up about this analysis — e.g. “Why refuse the sell-stop?” or “What would
            flip you to a long?”
          </div>
        }
      </div>

      <form class="chat-input" (submit)="send($event)">
        <textarea
          rows="2"
          [value]="question()"
          [disabled]="sending()"
          placeholder="Ask a follow-up question…"
          (input)="question.set($any($event.target).value)"
          (keydown)="onKeydown($event)"
          aria-label="Follow-up question"
        ></textarea>
        <button type="submit" [disabled]="sending() || !question().trim() || !llmInvocationId()">
          {{ sending() ? 'Sending…' : 'Send' }}
        </button>
      </form>
    </section>
  `,
  styles: [
    `
      .chat {
        display: flex;
        flex-direction: column;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        overflow: hidden;
      }
      .chat-log {
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
        padding: var(--space-3);
        max-height: 320px;
        overflow-y: auto;
      }
      .chat-empty {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        line-height: 1.5;
        padding: var(--space-2) 0;
      }
      .chat-state {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: var(--text-xs);
        color: var(--text-secondary);
        padding: var(--space-1) 0;
      }
      .chat-state.error {
        color: var(--loss);
      }
      .msg {
        display: flex;
        justify-content: flex-start;
      }
      .msg.user {
        justify-content: flex-end;
      }
      .bubble {
        max-width: 85%;
        padding: 7px 11px;
        border-radius: 12px;
        font-size: var(--text-sm);
        line-height: 1.5;
        word-break: break-word;
      }
      /* Assistant bubble: neutral surface, left-aligned. */
      .msg .bubble:not(.thinking) {
        background: var(--bg-tertiary);
        color: var(--text-primary);
        border-bottom-left-radius: 4px;
      }
      /* Operator bubble: accent, right-aligned. */
      .msg.user .bubble {
        background: var(--accent);
        color: #fff;
        border-bottom-left-radius: 12px;
        border-bottom-right-radius: 4px;
        white-space: pre-wrap;
      }
      .bubble.thinking {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        color: var(--text-secondary);
        background: var(--bg-tertiary);
      }
      /* Markdown children are rendered via [innerHTML]; emulated encapsulation
         can't reach them, so keep only container-level rules here — the global
         .md styles in styles.scss handle headings/lists/etc. */
      .bubble.md {
        max-width: 92%;
      }
      .bubble.md > :first-child {
        margin-top: 0;
      }
      .bubble.md > :last-child {
        margin-bottom: 0;
      }
      .chat-input {
        display: flex;
        gap: var(--space-2);
        padding: var(--space-2);
        border-top: 1px solid var(--border);
        background: var(--bg-secondary);
      }
      .chat-input textarea {
        flex: 1;
        resize: none;
        font: inherit;
        font-size: var(--text-sm);
        padding: 6px 9px;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-primary);
      }
      .chat-input textarea:disabled {
        opacity: 0.6;
      }
      .chat-input button {
        align-self: flex-end;
        padding: 7px 14px;
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
        border: 1px solid var(--accent);
        background: var(--accent);
        color: #fff;
        border-radius: var(--radius-full);
        cursor: pointer;
      }
      .chat-input button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .spinner {
        width: 13px;
        height: 13px;
        border: 2px solid var(--border);
        border-top-color: var(--accent);
        border-radius: 50%;
        animation: chat-spin 0.6s linear infinite;
        flex: none;
      }
      @keyframes chat-spin {
        to {
          transform: rotate(360deg);
        }
      }
    `,
  ],
})
export class AnalysisChatComponent {
  private readonly marketData = inject(MarketDataService);

  /** LlmInvocation id of the analysis being discussed (the thread anchor).
   *  When it changes (operator re-ran the analysis) the thread reloads. */
  readonly llmInvocationId = input.required<number>();

  protected readonly messages = signal<SpotAnalysisFollowUpTurnDto[]>([]);
  protected readonly question = signal('');
  protected readonly loading = signal(false);
  protected readonly sending = signal(false);
  protected readonly error = signal<string | null>(null);

  private readonly logEl = viewChild<ElementRef<HTMLDivElement>>('log');

  constructor() {
    // Load (or reload) the thread whenever the anchor id changes — including
    // the first render and after the operator re-runs the analysis.
    effect(() => {
      const id = this.llmInvocationId();
      this.loadThread(id);
    });

    // Keep the log pinned to the latest turn as messages arrive / while thinking.
    effect(() => {
      this.messages();
      this.sending();
      queueMicrotask(() => {
        const el = this.logEl()?.nativeElement;
        if (el) el.scrollTop = el.scrollHeight;
      });
    });
  }

  private loadThread(llmInvocationId: number): void {
    this.messages.set([]);
    this.error.set(null);
    if (!llmInvocationId) return;

    this.loading.set(true);
    this.marketData.getAnalysisFollowUps(llmInvocationId).subscribe({
      next: (res) => {
        this.loading.set(false);
        // Guard against a stale response landing after the anchor changed.
        if (this.llmInvocationId() !== llmInvocationId) return;
        if (res?.status && res.data) this.messages.set(res.data);
      },
      error: () => {
        this.loading.set(false);
      },
    });
  }

  protected onKeydown(ev: KeyboardEvent): void {
    // Enter sends; Shift+Enter inserts a newline.
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      this.send();
    }
  }

  protected send(ev?: Event): void {
    ev?.preventDefault();
    const q = this.question().trim();
    const id = this.llmInvocationId();
    if (!q || this.sending() || !id) return;

    // Optimistically show the operator's question immediately.
    const optimistic: SpotAnalysisFollowUpTurnDto = {
      id: -Date.now(),
      llmInvocationId: id,
      role: 'User',
      content: q,
      createdAtUtc: new Date().toISOString(),
    };
    this.messages.update((m) => [...m, optimistic]);
    this.question.set('');
    this.sending.set(true);
    this.error.set(null);

    this.marketData.askAnalysisFollowUp(id, q).subscribe({
      next: (res) => {
        this.sending.set(false);
        if (this.llmInvocationId() !== id) return; // anchor changed mid-flight
        if (res?.status && res.data) {
          this.messages.update((m) => [...m, res.data as SpotAnalysisFollowUpTurnDto]);
        } else {
          this.error.set(res?.message || 'The model did not return a response. Try again.');
        }
      },
      error: (err) => {
        this.sending.set(false);
        this.error.set(err?.message ?? 'Follow-up failed. Is the engine reachable?');
      },
    });
  }
}
