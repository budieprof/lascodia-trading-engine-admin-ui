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
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DatePipe } from '@angular/common';
import { MarkdownPipe } from '@shared/pipes/markdown.pipe';
import { MarkdownCopyDirective } from '@shared/directives/markdown-copy.directive';
import { MarketDataService } from '@core/services/market-data.service';
import { RealtimeService } from '@core/realtime/realtime.service';
import type { SpotAnalysisFollowUpTurnDto, AnalysisMonitorDto } from '@core/api/api.types';
import {
  SpotRecChartComponent,
  type SpotRecChartRec,
} from '@shared/components/spot-rec-chart/spot-rec-chart.component';

/**
 * Whether a turn opens a new calendar day and so needs a date divider above it.
 *
 * Exported separately from the component so the boundary rule can be tested directly,
 * without a TestBed. The comparison is in the VIEWER's timezone, matching what DatePipe
 * renders beside each turn: comparing the UTC dates instead would draw the divider in the
 * wrong place for anyone whose local midnight is not UTC midnight — which is everyone here,
 * the engine stores UTC and the operator reads BST.
 */
export function startsNewLocalDay(
  currentIso: string | null | undefined,
  previousIso: string | null | undefined,
): boolean {
  if (!currentIso) return false;
  // The first turn always carries the date: the reader has no earlier row to infer it from.
  if (!previousIso) return true;
  return new Date(currentIso).toDateString() !== new Date(previousIso).toDateString();
}

/** A chat-generated recommendation parsed from a "recommend" tool turn. */
interface ParsedChatRec {
  symbol: string;
  timeframe: string;
  asOfUtc: string;
  action: 'Buy' | 'Sell';
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  confidencePct: number | null;
  riskRewardRatio: number | null;
  rationale: string;
  filedSignalId: number | null;
  chartRecs: SpotRecChartRec[];
}

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
  imports: [MarkdownPipe, SpotRecChartComponent, MarkdownCopyDirective, DatePipe],
  template: `
    <section
      class="chat"
      appMarkdownCopy
      [class.fill]="fillHeight()"
      aria-label="Analysis follow-up chat"
    >
      @if (llmInvocationId()) {
        <div class="chat-idbar">
          <span class="idbar-label">Conversation ID</span>
          <button
            type="button"
            class="idbar-id"
            (click)="copyId()"
            [title]="
              copied()
                ? 'Copied to clipboard'
                : 'Click to copy — share this to have a conversation reviewed'
            "
          >
            <span class="idbar-hash">#{{ llmInvocationId() }}</span>
            <span class="idbar-copy">{{ copied() ? '✓ copied' : '⧉ copy' }}</span>
          </button>
        </div>
      }

      @if (monitors().length > 0) {
        <div class="monitors">
          <div class="monitors-head">👁 Active monitors ({{ monitors().length }})</div>
          @for (mon of monitors(); track mon.id) {
            <div class="monitor">
              <div class="monitor-text">
                <span class="monitor-intent-line">
                  @if (mon.origin === 'hunter') {
                    <span class="hunter-badge" title="Armed by the SpotSweep patient hunter"
                      >hunter</span
                    >
                    @if (mon.plannedDirection) {
                      <span
                        class="mon-dir"
                        [class.buy]="mon.plannedDirection === 'Buy'"
                        [class.sell]="mon.plannedDirection === 'Sell'"
                        >{{ mon.plannedDirection }}</span
                      >
                    }
                  }
                  <span class="monitor-intent" [title]="mon.intentText">{{ mon.intentText }}</span>
                </span>
                <span class="monitor-meta">
                  {{ mon.symbol }} {{ mon.timeframe }} ·
                  {{ mon.evaluationMode === 'LlmAssisted' ? 'LLM-judged' : 'live check' }} ·
                  {{ mon.recurring ? 'recurring' : 'one-shot' }} · fired {{ mon.triggerCount }}/{{
                    mon.maxTriggers
                  }}
                  @if (mon.lastEvalNote) {
                    ·
                    <span class="monitor-note" [title]="mon.lastEvalNote">{{
                      mon.lastEvalNote
                    }}</span>
                  }
                </span>
              </div>
              <button
                type="button"
                class="monitor-cancel"
                [disabled]="cancellingId() === mon.id"
                (click)="cancelMonitor(mon)"
                title="Cancel this monitor"
              >
                {{ cancellingId() === mon.id ? '…' : '✕' }}
              </button>
            </div>
          }
        </div>
      }

      <div class="chat-log" #log>
        @if (loading()) {
          <div class="chat-state"><span class="spinner"></span> Loading conversation…</div>
        }

        @if (opener(); as op) {
          @if (openerAt(); as at) {
            <div class="day-sep">
              <span>{{ at | date: 'EEE d MMM y' }}</span>
            </div>
          }
          <div class="msg">
            <div class="bubble md opener" [innerHTML]="op | markdown"></div>
            @if (openerAt(); as at) {
              <time class="msg-time" [attr.datetime]="at" [title]="at | date: 'full'">{{
                at | date: timeFormat
              }}</time>
            }
          </div>
        }

        @for (m of messages(); track m.id; let i = $index) {
          @if (startsNewDay(i)) {
            <div class="day-sep">
              <span>{{ m.createdAtUtc | date: 'EEE d MMM y' }}</span>
            </div>
          }
          @switch (m.role) {
            @case ('Assistant') {
              <div class="msg">
                <div class="bubble md" [innerHTML]="m.content | markdown"></div>
                <time
                  class="msg-time"
                  [attr.datetime]="m.createdAtUtc"
                  [title]="m.createdAtUtc | date: 'full'"
                  >{{ m.createdAtUtc | date: timeFormat }}</time
                >
              </div>
            }
            @case ('User') {
              <div class="msg user">
                <div class="bubble">{{ m.content }}</div>
                <time
                  class="msg-time"
                  [attr.datetime]="m.createdAtUtc"
                  [title]="m.createdAtUtc | date: 'full'"
                  >{{ m.createdAtUtc | date: timeFormat }}</time
                >
              </div>
            }
            @case ('Tool') {
              @if (m.toolName === 'recommend' && parseRec(m); as rec) {
                <div class="msg">
                  <div class="rec-card" [attr.data-filed]="rec.filedSignalId !== null">
                    <div class="rec-head">
                      <span
                        class="rec-badge"
                        [class.buy]="rec.action === 'Buy'"
                        [class.sell]="rec.action === 'Sell'"
                        >📌 {{ rec.action }} {{ rec.symbol }} · {{ rec.timeframe }}</span
                      >
                      <span class="rec-conf"
                        >conf {{ rec.confidencePct === null ? '—' : rec.confidencePct + '%' }}
                        @if (rec.riskRewardRatio !== null) {
                          · R:R {{ rec.riskRewardRatio }}
                        }
                      </span>
                    </div>
                    <div class="rec-levels">
                      <span class="lvl entry">Entry {{ rec.entryPrice }}</span>
                      <span class="lvl sl">SL {{ rec.stopLoss }}</span>
                      <span class="lvl tp">TP {{ rec.takeProfit }}</span>
                    </div>
                    <app-spot-rec-chart
                      [symbol]="rec.symbol"
                      [timeframe]="rec.timeframe"
                      [asOfUtc]="rec.asOfUtc"
                      [recommendations]="rec.chartRecs"
                      [historyBars]="80"
                      [fullWidthLevels]="true"
                    />
                    @if (rec.rationale) {
                      <div class="rec-rationale md" [innerHTML]="rec.rationale | markdown"></div>
                    }
                    @if (rec.filedSignalId !== null) {
                      <div class="rec-filed">✓ Filed as signal #{{ rec.filedSignalId }}</div>
                    } @else {
                      <div class="rec-actions">
                        <button
                          type="button"
                          class="file-signal"
                          [disabled]="filingId() !== null"
                          (click)="fileSignal(m)"
                        >
                          {{ filingId() === m.id ? 'Filing…' : '⚡ File as signal' }}
                        </button>
                        <span class="rec-hint">passes through the risk gates</span>
                      </div>
                    }
                  </div>
                  <time
                    class="msg-time"
                    [attr.datetime]="m.createdAtUtc"
                    [title]="m.createdAtUtc | date: 'full'"
                    >{{ m.createdAtUtc | date: timeFormat }}</time
                  >
                </div>
              } @else {
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
                  <time
                    class="msg-time"
                    [attr.datetime]="m.createdAtUtc"
                    [title]="m.createdAtUtc | date: 'full'"
                    >{{ m.createdAtUtc | date: timeFormat }}</time
                  >
                </div>
              }
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
                  <!--
                    The proposal's own prose. The http_action producer puts everything in
                    toolArgsJson and leaves this empty, but the algo-engineer posts a written
                    proposal as the turn CONTENT — which used to render as nothing at all: a
                    badge, a status, and 1,168 silently discarded characters.
                  -->
                  @if (m.content) {
                    <div class="action-body md" [innerHTML]="m.content | markdown"></div>
                  }
                  @if (parseAction(m); as pa) {
                    @if (pa.summary) {
                      <div class="action-summary md" [innerHTML]="pa.summary | markdown"></div>
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
                <time
                  class="msg-time"
                  [attr.datetime]="m.createdAtUtc"
                  [title]="m.createdAtUtc | date: 'full'"
                  >{{ m.createdAtUtc | date: timeFormat }}</time
                >
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

        @if (!loading() && messages().length === 0 && !sending() && !error() && !opener()) {
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
      /* Shareable conversation id — pinned to the top of every chat so an
         operator can quote it ("take a look at #12345") for a review. */
      .chat-idbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-2);
        padding: 5px var(--space-3);
        border-bottom: 1px solid var(--border);
        background: var(--bg-secondary);
      }
      .idbar-label {
        font-size: 10px;
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-tertiary);
      }
      .idbar-id {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 2px 8px;
        border: 1px solid var(--border);
        border-radius: var(--radius-full);
        background: var(--bg-primary);
        color: var(--text-secondary);
        font-size: var(--text-xs);
        cursor: pointer;
        font-variant-numeric: tabular-nums;
      }
      .idbar-id:hover {
        border-color: var(--accent);
        color: var(--text-primary);
      }
      .idbar-hash {
        font-weight: var(--font-semibold);
        font-family: var(--font-mono, monospace);
      }
      .idbar-copy {
        font-size: 10px;
        color: var(--text-tertiary);
      }
      /* Full-page mode: fill the container; the log grows instead of capping. */
      .chat.fill {
        height: 100%;
        border: none;
        border-radius: 0;
      }
      .chat.fill .chat-log {
        flex: 1;
        max-height: none;
      }
      /* Opener (analysis brief) reads as prose, not a chat bubble. */
      .bubble.opener {
        max-width: 100%;
        background: transparent;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        padding: var(--space-3);
      }
      .chat-log {
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
        padding: var(--space-3);
        max-height: 320px;
        overflow-y: auto;
      }
      .monitors {
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding: var(--space-2) var(--space-3);
        border-bottom: 1px solid var(--border);
        background: color-mix(in srgb, var(--accent) 5%, transparent);
      }
      .monitors-head {
        font-size: 10px;
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-secondary);
      }
      .monitor {
        display: flex;
        align-items: center;
        gap: var(--space-2);
      }
      .monitor-text {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
      }
      .monitor-intent-line {
        display: flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
      }
      .monitor-intent {
        flex: 1;
        min-width: 0;
        font-size: var(--text-xs);
        color: var(--text-primary);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      /* Patient-hunter provenance badge — violet, matching the sweep cockpit. */
      .hunter-badge {
        flex: none;
        font-size: 9px;
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        padding: 1px 6px;
        border-radius: var(--radius-full);
        background: rgba(175, 82, 222, 0.16);
        color: #8944b8;
      }
      .mon-dir {
        flex: none;
        font-size: 9px;
        font-weight: var(--font-semibold);
        padding: 1px 6px;
        border-radius: var(--radius-full);
        background: var(--bg-tertiary);
        color: var(--text-secondary);
      }
      .mon-dir.buy {
        background: rgba(52, 199, 89, 0.16);
        color: var(--success, #16a34a);
      }
      .mon-dir.sell {
        background: rgba(255, 59, 48, 0.14);
        color: var(--danger, #dc2626);
      }
      .monitor-meta {
        font-size: 10px;
        color: var(--text-tertiary);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .monitor-note {
        font-style: italic;
      }
      .monitor-cancel {
        flex: none;
        width: 22px;
        height: 22px;
        border: 1px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-tertiary);
        border-radius: 50%;
        cursor: pointer;
        line-height: 1;
      }
      .monitor-cancel:hover {
        color: var(--loss);
        border-color: var(--loss);
      }
      .monitor-cancel:disabled {
        opacity: 0.5;
        cursor: not-allowed;
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
        /* Bottom-aligned so the timestamp sits on the bubble's last line, not floating
           beside a tall block of markdown. */
        align-items: flex-end;
        gap: 6px;
      }
      .msg.user {
        justify-content: flex-end;
      }
      /* Timestamps read outward from the bubble: after it for the agent, before it for the
         operator, so the column of times never cuts through the middle of the thread. */
      .msg-time {
        flex: none;
        font-size: var(--text-xs, 11px);
        font-variant-numeric: tabular-nums;
        color: var(--text-tertiary, var(--text-secondary));
        opacity: 0.75;
        padding-bottom: 2px;
        white-space: nowrap;
      }
      .msg.user .msg-time {
        order: -1;
      }
      .day-sep {
        display: flex;
        align-items: center;
        gap: 10px;
        margin: 6px 0 2px;
        color: var(--text-secondary);
        font-size: var(--text-xs, 11px);
      }
      .day-sep::before,
      .day-sep::after {
        content: '';
        flex: 1;
        border-top: 1px solid var(--border);
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
      /* ── Chat-generated recommendation card ─────────────────────────────── */
      .rec-card {
        border: 1px solid var(--accent);
        border-radius: var(--radius-lg, 10px);
        background: var(--bg-primary);
        padding: 11px 13px;
        max-width: 96%;
        box-shadow: 0 1px 3px rgb(0 0 0 / 8%);
      }
      .rec-card[data-filed='true'] {
        border-color: var(--success, #16a34a);
      }
      .rec-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        margin-bottom: 7px;
      }
      .rec-badge {
        font-weight: var(--font-semibold, 600);
        font-size: var(--text-sm);
      }
      .rec-badge.buy {
        color: var(--success, #16a34a);
      }
      .rec-badge.sell {
        color: var(--danger, #dc2626);
      }
      .rec-conf {
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .rec-levels {
        display: flex;
        flex-wrap: wrap;
        gap: 6px 12px;
        margin-bottom: 8px;
        font-size: var(--text-xs);
        font-variant-numeric: tabular-nums;
      }
      .rec-levels .lvl.entry {
        color: var(--text-primary);
      }
      .rec-levels .lvl.sl {
        color: var(--danger, #dc2626);
      }
      .rec-levels .lvl.tp {
        color: var(--success, #16a34a);
      }
      .rec-rationale {
        margin: 8px 0 0;
        font-size: var(--text-xs);
        color: var(--text-secondary);
        line-height: 1.45;
      }
      .rec-actions {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-top: 10px;
      }
      .rec-actions .file-signal {
        padding: 6px 14px;
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
        border-radius: var(--radius-full);
        border: 1px solid var(--accent);
        background: var(--accent);
        color: #fff;
        cursor: pointer;
      }
      .rec-actions .file-signal:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .rec-hint {
        font-size: var(--text-xs);
        color: var(--text-tertiary, var(--text-secondary));
      }
      .rec-filed {
        margin-top: 10px;
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
        color: var(--success, #16a34a);
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
  private readonly realtime = inject(RealtimeService);

  /** LlmInvocation id of the analysis being discussed (the thread anchor).
   *  When it changes (operator re-ran the analysis) the thread reloads. */
  readonly llmInvocationId = input.required<number>();

  /** Optional analysis brief rendered as the conversation opener (first
   *  assistant message) — used by the full-page chat so the brief + follow-ups
   *  scroll as one thread. */
  readonly opener = input<string | null>(null);

  /** When the opener was produced (the analysis's `invokedAt`), so the anchor turn carries a
   *  timestamp like every other turn. Optional: callers that pass no opener have none. */
  readonly openerAt = input<string | null>(null);

  /** When true the chat fills its container height (full-page use) instead of
   *  the default capped log height (embedded-in-modal use). */
  readonly fillHeight = input<boolean>(false);

  protected readonly messages = signal<SpotAnalysisFollowUpTurnDto[]>([]);
  protected readonly question = signal('');
  protected readonly loading = signal(false);
  protected readonly sending = signal(false);
  protected readonly error = signal<string | null>(null);
  /** Id of the action proposal currently being confirmed/dismissed, or null. */
  protected readonly resolvingId = signal<number | null>(null);
  /** Active monitors created from this analysis. */
  protected readonly monitors = signal<AnalysisMonitorDto[]>([]);
  /** Monitor id currently being cancelled, or null. */
  protected readonly cancellingId = signal<number | null>(null);
  /** Id of the recommendation turn currently being filed as a signal, or null. */
  protected readonly filingId = signal<number | null>(null);
  /** Brief "copied" confirmation after the operator copies the conversation id. */
  protected readonly copied = signal(false);

  /**
   * Turn timestamps show SECONDS, not just hours and minutes. An agent run posts several
   * turns inside one minute — conversation 24272 has four between 05:56:25 and 05:56:44 —
   * so `HH:mm` would stamp them all identically and tell the reader nothing about order or
   * pace. The engine sends UTC with a `Z`, and DatePipe renders in the viewer's timezone;
   * the `title` carries the full date for anyone reconciling against an engine log.
   */
  protected readonly timeFormat = 'HH:mm:ss';

  /**
   * True when this turn is the first of a calendar day, so the thread gets a date divider.
   * Work-order conversations are long-lived — 24272 was resumed hours later — and without
   * this a reply from a different day is indistinguishable from the one above it.
   */
  protected startsNewDay(index: number): boolean {
    const turns = this.messages();
    // The opener is the turn before the first reply. Comparing against it stops the thread
    // drawing the date twice — once over the brief, once over the answer below it.
    const previous = index === 0 ? this.openerAt() : turns[index - 1]?.createdAtUtc;
    return startsNewLocalDay(turns[index]?.createdAtUtc, previous);
  }

  /** Memoised parsed recommendations, keyed by turn id + payload so the chart's
   *  inputs stay reference-stable across change detection (a fresh array every
   *  CD would make the self-fetching chart re-query candles each cycle). */
  private readonly recCache = new Map<string, ParsedChatRec | null>();

  private readonly logEl = viewChild<ElementRef<HTMLDivElement>>('log');

  /** Debounce timer coalescing a burst of realtime tickles (the agentic ask loop
   *  persists several turns in quick succession) into one silent thread refresh. */
  private liveReloadTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    // Load (or reload) the thread + monitors whenever the anchor id changes —
    // including the first render and after the operator re-runs the analysis.
    effect(() => {
      const id = this.llmInvocationId();
      this.loadThread(id);
      this.loadMonitors(id);
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

    // Live updates: the engine tickles `analysisConversationChanged` with the
    // anchor id whenever a turn is added / resolved / filed on ANY conversation
    // (by this operator in another tab, by another operator, or by a monitor
    // firing). When it's the thread we're showing, silently refresh so new turns,
    // flipped action statuses, and filed-signal badges appear without a reload.
    this.realtime.connect();
    this.realtime
      .on<{ llmInvocationId: number }>('analysisConversationChanged')
      .pipe(takeUntilDestroyed())
      .subscribe((p) => {
        if (!p || p.llmInvocationId !== this.llmInvocationId()) return;
        this.scheduleLiveReload();
      });
  }

  /** Coalesce tickles and refresh the open thread — but never while the operator's
   *  own send is in flight (that path reloads the thread itself; a concurrent
   *  fetch would just flicker). */
  private scheduleLiveReload(): void {
    if (this.liveReloadTimer) clearTimeout(this.liveReloadTimer);
    this.liveReloadTimer = setTimeout(() => {
      const id = this.llmInvocationId();
      if (!id || this.sending()) return;
      this.refreshThreadSilently(id);
      this.loadMonitors(id);
    }, 400);
  }

  /** Refetch the thread WITHOUT the clear-and-spinner of loadThread, so a live
   *  update swaps the list in place rather than blanking the log. */
  private refreshThreadSilently(id: number): void {
    this.marketData.getAnalysisFollowUps(id).subscribe({
      next: (res) => {
        if (this.llmInvocationId() !== id) return;
        if (res?.status && res.data) {
          this.recCache.clear(); // a rec turn may have been stamped Filed
          this.messages.set(res.data);
        }
      },
      error: () => {
        /* transient — the next tickle or a manual action will refresh */
      },
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

  /** Copy the conversation id (the LlmInvocation id) to the clipboard so the
   *  operator can quote it when asking for a conversation to be reviewed. */
  protected copyId(): void {
    const id = this.llmInvocationId();
    if (!id) return;
    navigator.clipboard
      ?.writeText(String(id))
      .then(() => {
        this.copied.set(true);
        setTimeout(() => this.copied.set(false), 1500);
      })
      .catch(() => {
        /* clipboard blocked (e.g. insecure context) — the id stays visible */
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
        // A confirmed action may have created a monitor — refresh the strip.
        this.loadMonitors(id);
      },
      error: (err) => {
        this.resolvingId.set(null);
        this.error.set(err?.message ?? 'Action failed. Is the engine reachable?');
      },
    });
  }

  /** Parse a "recommend" tool turn's payload into a chart-ready recommendation.
   *  Returns null when the payload is missing/invalid so the caller falls back
   *  to the generic tool rendering. Memoised for input stability. */
  protected parseRec(m: SpotAnalysisFollowUpTurnDto): ParsedChatRec | null {
    if (m.toolName !== 'recommend' || !m.toolResultJson) return null;
    const key = `${m.id}:${m.toolResultJson}`;
    const cached = this.recCache.get(key);
    if (cached !== undefined) return cached;

    let parsed: ParsedChatRec | null = null;
    try {
      const r = JSON.parse(m.toolResultJson) as {
        symbol?: string;
        timeframe?: string;
        asOfUtc?: string;
        action?: string;
        entryPrice?: number;
        stopLoss?: number;
        takeProfit?: number;
        confidence?: number;
        riskRewardRatio?: number | null;
        rationale?: string;
        filedSignalId?: number | null;
      };
      const action = r.action === 'Buy' || r.action === 'Sell' ? r.action : null;
      if (
        action &&
        r.symbol &&
        typeof r.entryPrice === 'number' &&
        typeof r.stopLoss === 'number' &&
        typeof r.takeProfit === 'number'
      ) {
        parsed = {
          symbol: r.symbol,
          timeframe: r.timeframe || 'H1',
          asOfUtc: r.asOfUtc || new Date().toISOString(),
          action,
          entryPrice: r.entryPrice,
          stopLoss: r.stopLoss,
          takeProfit: r.takeProfit,
          // `?? 0` printed "conf 0%" for a rec that simply carried no confidence —
          // a fabricated value indistinguishable from a genuine zero. Null means unknown
          // and renders as "conf —".
          confidencePct: typeof r.confidence === 'number' ? Math.round(r.confidence * 100) : null,
          riskRewardRatio: r.riskRewardRatio ?? null,
          rationale: r.rationale || '',
          filedSignalId: r.filedSignalId ?? null,
          chartRecs: [
            {
              label: `${action} ${r.symbol}`,
              action,
              entryPrice: r.entryPrice,
              stopLoss: r.stopLoss,
              takeProfit: r.takeProfit,
            },
          ],
        };
      }
    } catch {
      parsed = null;
    }
    this.recCache.set(key, parsed);
    return parsed;
  }

  /** File a chat-generated recommendation as a live signal through the risk
   *  gates. Operator-gated by an explicit confirm; the engine returns the full
   *  refreshed thread (the rec turn comes back stamped "Filed"). */
  protected fileSignal(m: SpotAnalysisFollowUpTurnDto): void {
    if (this.filingId() !== null) return;
    if (
      !confirm(
        'File this recommendation as a live trade signal?\nIt will pass through the engine risk gates and can be executed by an EA.',
      )
    )
      return;
    const id = this.llmInvocationId();
    this.filingId.set(m.id);
    this.error.set(null);
    this.marketData.fileFollowUpSignal(m.id).subscribe({
      next: (res) => {
        this.filingId.set(null);
        if (this.llmInvocationId() !== id) return;
        if (res?.status && res.data) {
          this.recCache.clear(); // filed turn re-parses with its new filedSignalId
          this.messages.set(res.data);
        } else {
          this.error.set(res?.message || 'Could not file the signal.');
        }
      },
      error: (err) => {
        this.filingId.set(null);
        this.error.set(err?.message ?? 'Filing failed. Is the engine reachable?');
      },
    });
  }

  /** Load the active monitors created from this analysis. */
  private loadMonitors(llmInvocationId: number): void {
    if (!llmInvocationId) {
      this.monitors.set([]);
      return;
    }
    this.marketData.getAnalysisMonitors(llmInvocationId, true).subscribe({
      next: (res) => {
        if (this.llmInvocationId() !== llmInvocationId) return;
        this.monitors.set(res?.status && res.data ? res.data : []);
      },
      error: () => {
        /* non-fatal — the monitors strip just stays empty */
      },
    });
  }

  /** Cancel (deactivate) a monitor, then refresh the strip. */
  protected cancelMonitor(mon: AnalysisMonitorDto): void {
    if (this.cancellingId() !== null) return;
    const id = this.llmInvocationId();
    this.cancellingId.set(mon.id);
    this.marketData.cancelAnalysisMonitor(mon.id).subscribe({
      next: () => {
        this.cancellingId.set(null);
        this.monitors.update((list) => list.filter((x) => x.id !== mon.id));
      },
      error: () => {
        this.cancellingId.set(null);
        this.loadMonitors(id);
      },
    });
  }
}
