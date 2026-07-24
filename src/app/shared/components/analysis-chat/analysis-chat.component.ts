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

        @for (m of messages(); track m.id) {
          @switch (m.role) {
            @case ('Assistant') {
              <div class="msg">
                <div class="bubble md" [innerHTML]="m.content | markdown"></div>
              </div>
            }
            @case ('User') {
              <div class="msg user">
                <div class="bubble">{{ m.content }}</div>
              </div>
            }
            @case ('Tool') {
              <div class="msg">
                <details class="tool">
                  <summary>
                    🔧 {{ m.toolName }} <span class="tool-hint">pulled live data</span>
                  </summary>
                  <div class="tool-body">
                    @if (m.toolArgsJson && m.toolArgsJson !== '{}') {
                      <pre class="tool-pre">args: {{ m.toolArgsJson }}</pre>
                    }
                    <pre class="tool-pre">{{ m.toolResultJson }}</pre>
                  </div>
                </details>
              </div>
            }
            @case ('ActionProposal') {
              <div class="msg">
                <div
                  class="action-card"
                  [attr.data-status]="(m.actionStatus || 'Pending').toLowerCase()"
                >
                  <div class="action-head">
                    <span class="action-badge">⚡ Proposed action</span>
                    <span class="action-status">{{ m.actionStatus }}</span>
                  </div>
                  @if (parseAction(m); as pa) {
                    @if (pa.summary) {
                      <p class="action-summary">{{ pa.summary }}</p>
                    }
                    <code class="action-call">{{ pa.method }} {{ pa.path }}</code>
                    @if (pa.body) {
                      <pre class="tool-pre">{{ pa.body }}</pre>
                    }
                  }
                  @if (m.actionStatus === 'Pending') {
                    <div class="action-actions">
                      <button
                        type="button"
                        class="confirm"
                        [disabled]="resolvingId() !== null"
                        (click)="resolve(m, true)"
                      >
                        {{ resolvingId() === m.id ? 'Running…' : 'Confirm & run' }}
                      </button>
                      <button
                        type="button"
                        class="dismiss"
                        [disabled]="resolvingId() !== null"
                        (click)="resolve(m, false)"
                      >
                        Dismiss
                      </button>
                    </div>
                  } @else if (m.toolResultJson) {
                    <details class="tool">
                      <summary>result ({{ m.actionStatus }})</summary>
                      <pre class="tool-pre">{{ m.toolResultJson }}</pre>
                    </details>
                  }
                </div>
              </div>
            }
          }
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
      /* Tool turn — a collapsible, low-emphasis note that the model pulled data. */
      .tool {
        width: 100%;
        border: 1px dashed var(--border);
        border-radius: 8px;
        background: var(--bg-secondary);
        font-size: var(--text-xs);
      }
      .tool > summary {
        cursor: pointer;
        padding: 5px 9px;
        color: var(--text-secondary);
        list-style: none;
      }
      .tool-hint {
        color: var(--text-tertiary);
        font-size: 10px;
      }
      .tool-body {
        padding: 0 9px 8px;
      }
      .tool-pre {
        margin: 4px 0 0;
        padding: 7px 9px;
        background: var(--bg-tertiary);
        border-radius: 6px;
        font-size: 11px;
        line-height: 1.45;
        white-space: pre-wrap;
        word-break: break-word;
        max-height: 220px;
        overflow: auto;
      }
      /* Action proposal — an operator-gated card. */
      .action-card {
        width: 100%;
        border: 1px solid var(--accent);
        border-radius: 10px;
        padding: 9px 11px;
        background: color-mix(in srgb, var(--accent) 7%, transparent);
      }
      .action-card[data-status='dismissed'] {
        border-color: var(--border);
        background: var(--bg-secondary);
        opacity: 0.7;
      }
      .action-card[data-status='confirmed'] {
        border-color: #1d8a3e;
        background: rgba(29, 138, 62, 0.08);
      }
      .action-card[data-status='failed'] {
        border-color: var(--loss);
        background: color-mix(in srgb, var(--loss) 8%, transparent);
      }
      .action-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 5px;
      }
      .action-badge {
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
      }
      .action-status {
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-secondary);
      }
      .action-summary {
        margin: 0 0 6px;
        font-size: var(--text-sm);
        line-height: 1.45;
      }
      .action-call {
        display: block;
        font-family: var(--font-mono, monospace);
        font-size: 11px;
        padding: 5px 8px;
        background: var(--bg-tertiary);
        border-radius: 6px;
        word-break: break-all;
      }
      .action-actions {
        display: flex;
        gap: 8px;
        margin-top: 9px;
      }
      .action-actions button {
        padding: 6px 13px;
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
        border-radius: var(--radius-full);
        cursor: pointer;
      }
      .action-actions .confirm {
        border: 1px solid var(--accent);
        background: var(--accent);
        color: #fff;
      }
      .action-actions .dismiss {
        border: 1px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-secondary);
      }
      .action-actions button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
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
  /** Id of the action proposal currently being confirmed/dismissed, or null. */
  protected readonly resolvingId = signal<number | null>(null);

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
        if (this.llmInvocationId() !== id) {
          this.sending.set(false);
          return; // anchor changed mid-flight
        }
        if (res?.status && res.data) {
          // Reload the whole thread so any tool turns and a pending action
          // proposal appear — the ask endpoint returns only the final turn.
          this.marketData.getAnalysisFollowUps(id).subscribe({
            next: (t) => {
              this.sending.set(false);
              if (this.llmInvocationId() !== id) return;
              if (t?.status && t.data) this.messages.set(t.data);
            },
            error: () => this.sending.set(false),
          });
        } else {
          this.sending.set(false);
          this.error.set(res?.message || 'The model did not return a response. Try again.');
        }
      },
      error: (err) => {
        this.sending.set(false);
        this.error.set(err?.message ?? 'Follow-up failed. Is the engine reachable?');
      },
    });
  }

  /** Parse an ActionProposal's args JSON into a display-friendly call spec. */
  protected parseAction(
    m: SpotAnalysisFollowUpTurnDto,
  ): { method: string; path: string; body: string | null; summary: string } | null {
    if (!m.toolArgsJson) return null;
    try {
      const a = JSON.parse(m.toolArgsJson) as {
        method?: string;
        path?: string;
        summary?: string;
        body?: unknown;
      };
      return {
        method: (a.method || 'POST').toUpperCase(),
        path: a.path || '',
        summary: a.summary || '',
        body:
          a.body == null
            ? null
            : typeof a.body === 'string'
              ? a.body
              : JSON.stringify(a.body, null, 2),
      };
    } catch {
      return null;
    }
  }

  /** Confirm (execute) or dismiss a proposed action; the engine returns the
   *  full refreshed thread. */
  protected resolve(m: SpotAnalysisFollowUpTurnDto, confirm: boolean): void {
    if (this.resolvingId() !== null) return;
    const id = this.llmInvocationId();
    this.resolvingId.set(m.id);
    this.error.set(null);
    this.marketData.resolveFollowUpAction(m.id, confirm).subscribe({
      next: (res) => {
        this.resolvingId.set(null);
        if (this.llmInvocationId() !== id) return;
        if (res?.status && res.data) this.messages.set(res.data);
        else this.error.set(res?.message || 'Could not resolve the action.');
      },
      error: (err) => {
        this.resolvingId.set(null);
        this.error.set(err?.message ?? 'Action failed. Is the engine reachable?');
      },
    });
  }
}
