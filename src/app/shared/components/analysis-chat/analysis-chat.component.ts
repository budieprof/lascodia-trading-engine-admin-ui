import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DatePipe } from '@angular/common';
import { MarkdownPipe } from '@shared/pipes/markdown.pipe';
import {
  describeAction,
  humaniseBody,
  type ActionImpact,
} from '@shared/components/chat/action-impact';
import { MarkdownCopyDirective } from '@shared/directives/markdown-copy.directive';
import { MarketDataService } from '@core/services/market-data.service';
import { AlgoEngineerService } from '@core/services/algo-engineer.service';
import { RealtimeService } from '@core/realtime/realtime.service';
import type {
  SpotAnalysisFollowUpTurnDto,
  AnalysisMonitorDto,
  AlgoEngineerRunStateDto,
} from '@core/api/api.types';
import { EngineerRunBarComponent } from '@shared/components/engineer-chat/engineer-run-bar.component';
import { EngineerTurnComponent } from '@shared/components/engineer-chat/engineer-turn.component';
import type { ResolveApprovalOptions } from '@shared/components/engineer-chat/approval-resolution';
import { EngineerThinkingComponent } from '@shared/components/engineer-chat/engineer-thinking.component';
import {
  ENGINEER_HINTS,
  groupTurns,
  isRunLive,
  isStatus,
  latestThinkingIndex,
  reuseUnchangedItems,
  runPresence,
  type ChatItem,
} from '@shared/components/engineer-chat/engineer-turns';
import { isPinnedToBottom, jumpLabel, mergeOptimisticTurns } from './chat-live';
import { structuralEqual } from '@core/signals/structural-equal';
import {
  SpotRecChartComponent,
  type SpotRecChartRec,
} from '@shared/components/spot-rec-chart/spot-rec-chart.component';
import {
  RecFileEditorComponent,
  type RecFileOverrides,
  type RecFileSeed,
} from '@shared/components/rec-file-editor/rec-file-editor.component';

/** Day-boundary rule for the thread's date dividers — lives with the grouping that applies it. */
export { startsNewLocalDay } from '@shared/components/engineer-chat/engineer-turns';

/**
 * One-line rendering of the model's original proposal, for a rec the operator
 * edited on the way to filing. Null when the rec was filed unchanged (the engine
 * writes the block only for an edited rec) or the payload is unusable.
 */
function describeModelOriginal(
  o:
    | {
        action?: string;
        entryPrice?: number;
        stopLoss?: number | null;
        takeProfit?: number | null;
        confidence?: number;
      }
    | null
    | undefined,
): string | null {
  if (!o || typeof o.entryPrice !== 'number' || !o.action) return null;
  const fmt = (n: number | null | undefined) => (typeof n === 'number' ? String(n) : '—');
  const conf = typeof o.confidence === 'number' ? `, conf ${Math.round(o.confidence * 100)}%` : '';
  return `${o.action} @ ${fmt(o.entryPrice)}, SL ${fmt(o.stopLoss)}, TP ${fmt(o.takeProfit)}${conf}`;
}

/** A chat-generated recommendation parsed from a "recommend" tool turn. */
interface ParsedChatRec {
  symbol: string;
  timeframe: string;
  asOfUtc: string;
  action: 'Buy' | 'Sell';
  entryPrice: number;
  /* Nullable: the engine allows a filed rec to carry no target (Tier-2 can
     supply one), and a card must still render the trade that exists. */
  stopLoss: number | null;
  takeProfit: number | null;
  confidencePct: number | null;
  riskRewardRatio: number | null;
  rationale: string;
  filedSignalId: number | null;
  /** True when the operator edited the proposal before filing it. */
  operatorModified: boolean;
  /** The operator's stated reason for the edit, when they gave one. */
  operatorNote: string | null;
  /**
   * What the model originally proposed, present only on an edited rec. The
   * top-level fields above describe what was actually FILED — a filed card must
   * show the signal that exists, not the one the model wrote — so this is what
   * keeps the model's own output visible next to it.
   */
  modelOriginal: string | null;
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
  imports: [
    MarkdownPipe,
    SpotRecChartComponent,
    RecFileEditorComponent,
    MarkdownCopyDirective,
    DatePipe,
    EngineerRunBarComponent,
    EngineerTurnComponent,
    EngineerThinkingComponent,
  ],
  template: `
    <section
      class="chat"
      appMarkdownCopy
      [class.fill]="fillHeight()"
      aria-label="Analysis follow-up chat"
    >
      @if (llmInvocationId() && showIdBar()) {
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

      @if (isEngineer()) {
        <app-engineer-run-bar
          [run]="runState()"
          [loaded]="runLoaded()"
          [stopping]="stopping()"
          [message]="stopMessage()"
          (stop)="stopRun()"
        />
      }

      @if (monitorsEnabled() && monitors().length > 0) {
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

      <div class="chat-log" #log (scroll)="onLogScroll()">
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

        @for (item of items(); track item.key; let i = $index) {
          @if (item.newDay) {
            <div class="day-sep">
              <span>{{ item.turn.createdAtUtc | date: 'EEE d MMM y' }}</span>
            </div>
          }
          @if (item.type === 'thinking') {
            <!-- The agent thinking out loud — live narration while it works, foldable once done. -->
            <div class="msg">
              <app-engineer-thinking
                [item]="item"
                [live]="narrationLive()"
                [latest]="i === latestThinkingIdx()"
                [presence]="presenceText()"
              />
              <time
                class="msg-time"
                [attr.datetime]="itemTime(item)"
                [title]="itemTime(item) | date: 'full'"
                >{{ itemTime(item) | date: timeFormat }}</time
              >
            </div>
          } @else if (isHarnessItem(item)) {
            <!-- Algo-engineer harness turns: tool strip, plan, approval, report, run notice. -->
            <div class="msg">
              <app-engineer-turn
                [item]="item"
                [resolvingId]="resolvingId()"
                [resolveError]="resolveError()"
                (resolve)="
                  resolve($event.turn, $event.confirm, {
                    reason: $event.reason,
                    amendedArgs: $event.amendedArgs,
                  })
                "
              />
              <time
                class="msg-time"
                [attr.datetime]="itemTime(item)"
                [title]="itemTime(item) | date: 'full'"
                >{{ itemTime(item) | date: timeFormat }}</time
              >
            </div>
          } @else {
            @let m = item.turn;
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
                        <span class="lvl sl">SL {{ rec.stopLoss ?? '—' }}</span>
                        <span class="lvl tp">TP {{ rec.takeProfit ?? '—' }}</span>
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
                        <div class="rec-filed">
                          ✓ Filed as signal #{{ rec.filedSignalId }}
                          @if (rec.operatorModified) {
                            <span class="rec-edited">· edited before filing</span>
                          }
                        </div>
                        @if (rec.modelOriginal; as orig) {
                          <div class="rec-original">
                            Model proposed: <span class="mono">{{ orig }}</span>
                            @if (rec.operatorNote) {
                              <span class="rec-note">— {{ rec.operatorNote }}</span>
                            }
                          </div>
                        }
                      } @else if (editingId() === m.id) {
                        <app-rec-file-editor
                          [seed]="recSeed(rec)"
                          [busy]="filingId() === m.id"
                          [error]="fileError()"
                          (filed)="fileSignal(m, $event)"
                          (cancelled)="closeEditor()"
                        />
                      } @else {
                        <div class="rec-actions">
                          <button
                            type="button"
                            class="file-signal"
                            [disabled]="filingId() !== null"
                            (click)="openEditor(m)"
                          >
                            ⚡ File as signal
                          </button>
                          <span class="rec-hint">review or adjust the levels, then file</span>
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
                      @if (impactOf(pa); as impact) {
                        <div class="impact" [attr.data-severity]="impact.severity">
                          <strong>{{ impact.verb }}</strong>
                          <span> — {{ impact.subject }}</span>
                        </div>
                      }
                      @if (pa.summary) {
                        <div class="action-summary md" [innerHTML]="pa.summary | markdown"></div>
                      }
                      @if (bodyRows(pa); as rows) {
                        @if (rows.length > 0) {
                          <dl class="impact-rows">
                            @for (row of rows; track row.label) {
                              <dt>{{ row.label }}</dt>
                              <dd>{{ row.value }}</dd>
                            }
                          </dl>
                        }
                      }
                      <details class="raw-call">
                        <summary>Raw call</summary>
                        <code class="action-call">{{ pa.method }} {{ pa.path }}</code>
                        @if (pa.body) {
                          <pre class="tool-pre">{{ pa.body }}</pre>
                        }
                      </details>
                    }
                    @if (isPendingStatus(m.actionStatus)) {
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
        }

        <!--
          The placeholder spinner is for a chat that streams NOTHING. An engineer run narrates
          into the thread instead, so once a live thinking block is on screen this would be a
          second, redundant "Thinking…" sitting under the real one.
        -->
        @if (sending() && !streamingLive()) {
          <div class="msg">
            <div class="bubble thinking"><span class="spinner"></span> Thinking…</div>
          </div>
        }

        @if (error()) {
          <div class="chat-state error">{{ error() }}</div>
        }

        @if (!loading() && messages().length === 0 && !sending() && !error() && !opener()) {
          <div class="chat-empty">{{ emptyText() }}</div>
        }

        <!-- Only while the reader has scrolled away from the bottom: the log stops following
             the stream, and this is how they get back to it. -->
        @if (!pinned()) {
          <button type="button" class="jump" (click)="jumpToLatest()">{{ jumpText() }}</button>
        }
      </div>

      @if (isEngineer()) {
        <div class="hints" role="group" aria-label="Quick replies">
          @for (h of engineerHints; track h.label) {
            <button
              type="button"
              class="hint"
              [class.hint-stop]="h.send === null"
              [disabled]="
                h.send === null ? !runLive() || stopping() : sending() || !llmInvocationId()
              "
              [title]="h.send === null ? 'Stop the running agent' : 'Send “' + h.send + '”'"
              (click)="useHint(h.send)"
            >
              {{ h.label }}
            </button>
          }
        </div>
      }

      <form class="chat-input" (submit)="send($event)">
        <textarea
          rows="2"
          [value]="question()"
          [disabled]="sending()"
          [placeholder]="composerPlaceholder()"
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
      /* "Jump to latest" — sticky to the floor of the log, so it stays reachable however far
         up the reader has scrolled. */
      .jump {
        position: sticky;
        bottom: 2px;
        align-self: center;
        z-index: 2;
        margin-top: auto;
        padding: 3px 12px;
        font: inherit;
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
        border: 1px solid var(--border);
        border-radius: var(--radius-full);
        background: var(--bg-secondary);
        color: var(--text-secondary);
        box-shadow: var(--shadow-sm, 0 1px 3px rgb(0 0 0 / 12%));
        cursor: pointer;
      }
      .jump:hover {
        border-color: var(--accent);
        color: var(--text-primary);
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
      /* Severity is the first thing read, so it carries colour and weight; the raw call
         is one disclosure away rather than the headline. */
      .impact {
        font-size: var(--text-sm);
        line-height: 1.5;
        padding: var(--space-2) var(--space-3);
        border-radius: var(--radius-sm);
        border-left: 3px solid var(--text-tertiary);
        background: var(--bg-tertiary);
        margin-bottom: var(--space-2);
      }
      .impact[data-severity='danger'] {
        border-left-color: var(--loss, #ff3b30);
        background: rgba(255, 59, 48, 0.08);
      }
      .impact[data-severity='warn'] {
        border-left-color: var(--warning, #ff9500);
        background: rgba(255, 149, 0, 0.08);
      }
      .impact[data-severity='unknown'] {
        border-left-color: var(--warning, #ff9500);
        border-left-style: dashed;
      }
      .impact-rows {
        display: grid;
        grid-template-columns: minmax(90px, auto) 1fr;
        gap: 2px var(--space-3);
        margin: 0 0 var(--space-2);
        font-size: var(--text-xs);
      }
      .impact-rows dt {
        color: var(--text-tertiary);
      }
      .impact-rows dd {
        margin: 0;
        color: var(--text-primary);
        overflow-wrap: anywhere;
      }
      .raw-call > summary {
        cursor: pointer;
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        margin-bottom: var(--space-1);
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
      .rec-edited {
        font-weight: var(--font-normal, 400);
        color: var(--warning, #b45309);
      }
      .rec-original {
        margin-top: 4px;
        font-size: var(--text-xs);
        color: var(--text-tertiary, var(--text-secondary));
      }
      .rec-original .mono {
        font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
      }
      .rec-original .rec-note {
        font-style: italic;
      }
      /* The pre-file editor replaces the action row, so it owns the same gap. */
      app-rec-file-editor {
        display: block;
        margin-top: 10px;
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
      .hints {
        display: flex;
        flex-wrap: wrap;
        gap: 5px;
        padding: 6px var(--space-2) 0;
        border-top: 1px solid var(--border);
        background: var(--bg-secondary);
      }
      .hints + .chat-input {
        border-top: none;
      }
      .hint {
        font: inherit;
        font-size: 11px;
        padding: 2px 10px;
        border-radius: var(--radius-full);
        border: 1px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-secondary);
        cursor: pointer;
      }
      .hint:hover:not(:disabled) {
        border-color: var(--accent);
        color: var(--text-primary);
      }
      .hint-stop:not(:disabled) {
        color: var(--loss);
      }
      .hint:disabled {
        opacity: 0.45;
        cursor: not-allowed;
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
  private readonly algoEngineer = inject(AlgoEngineerService);
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

  /**
   * Optional: called at send time to describe what the operator is looking at, and passed
   * with the question. The admin assistant supplies it; a spot-analysis thread has no page
   * beyond the analysis itself and leaves it null.
   */
  readonly contextProvider = input<(() => unknown | null) | null>(null);

  /**
   * Chat-created live monitors belong to a spot analysis. An assistant thread has none, so
   * it opts out rather than firing a request that can only ever return an empty list.
   */
  readonly showMonitors = input<boolean>(true);

  /** Empty-thread hint. The default speaks to a spot analysis; other hosts pass their own. */
  readonly emptyHint = input<string>(
    'Ask a follow-up about this analysis — e.g. “Why refuse the sell-stop?” or “What would flip you to a long?”',
  );

  /** Composer placeholder. */
  readonly placeholder = input<string>('Ask a follow-up question…');

  /** The "Conversation ID · copy" strip. Hosts with their own header suppress it. */
  readonly showIdBar = input<boolean>(true);

  /**
   * The conversation's Kind label (`Spot`, `Engineer`, `Wire`, …) when the host knows it. An
   * `Engineer` thread gets the algo-engineer run header, folds every tool call into a strip, uses
   * its own composer placeholder + quick replies, and never shows the spot-analysis monitors strip.
   */
  readonly kind = input<string | null>(null);

  /** True for an algo-engineer work-order conversation. */
  protected readonly isEngineer = computed(() => this.kind() === 'Engineer');

  /**
   * Monitors are shown wherever the host allows them — INCLUDING an Engineer thread. An
   * algo-engineer work order can arm the platform's long-horizon watchers, and the operator has
   * to be able to see one and cancel it from the conversation that created it. (These are not the
   * run bar's watch chips: those are short-lived, in-run waits on an engine job.)
   */
  protected readonly monitorsEnabled = computed(() => this.showMonitors());

  protected readonly composerPlaceholder = computed(() =>
    this.isEngineer()
      ? 'Message the algo-engineer — a follow-up instruction, a question, or “continue”…'
      : this.placeholder(),
  );

  protected readonly emptyText = computed(() =>
    this.isEngineer()
      ? 'The work order is starting — the plan, tool calls, approvals and findings stream in here live.'
      : this.emptyHint(),
  );

  protected readonly engineerHints = ENGINEER_HINTS;

  /**
   * The thread. Structural equality on purpose: with a streaming agent the thread is refetched
   * about once a second, and most of those refetches carry a payload identical to the one on
   * screen. On reference equality every one of them re-ran the grouping and repainted the log.
   */
  protected readonly messages = signal<SpotAnalysisFollowUpTurnDto[]>([], {
    equal: structuralEqual,
  });
  protected readonly question = signal('');
  protected readonly loading = signal(false);
  protected readonly sending = signal(false);
  protected readonly error = signal<string | null>(null);
  /** Id of the action proposal currently being confirmed/dismissed, or null. */
  protected readonly resolvingId = signal<number | null>(null);
  /** The last resolve failure, with the card it belongs to, so that card can render it itself. */
  protected readonly resolveError = signal<{ turnId: number; message: string } | null>(null);
  /** Active monitors created from this analysis (refetched on every tickle — hence structural). */
  protected readonly monitors = signal<AnalysisMonitorDto[]>([], { equal: structuralEqual });
  /** Monitor id currently being cancelled, or null. */
  protected readonly cancellingId = signal<number | null>(null);
  /** Id of the recommendation turn currently being filed as a signal, or null. */
  protected readonly filingId = signal<number | null>(null);
  /** Id of the recommendation turn whose pre-file editor is open, or null. */
  protected readonly editingId = signal<number | null>(null);
  /** Server error from the last filing attempt — rendered inside the editor. */
  protected readonly fileError = signal<string | null>(null);
  /** Brief "copied" confirmation after the operator copies the conversation id. */
  protected readonly copied = signal(false);

  /** Engineer threads: the session's latest run (null = none yet / not loaded). */
  protected readonly runState = signal<AlgoEngineerRunStateDto | null>(null, {
    equal: structuralEqual,
  });
  /** True once the first run-state fetch for the bound conversation settled. */
  protected readonly runLoaded = signal(false);
  protected readonly stopping = signal(false);
  protected readonly stopMessage = signal<{ text: string; ok: boolean } | null>(null);
  protected readonly runLive = computed(() => isRunLive(this.runState()?.status));
  /** Out-of-order guard: only the newest run-state response may land. */
  private runStateSeq = 0;

  /** The last render items handed to the template — the baseline every refresh is diffed against. */
  private prevItems: ChatItem[] = [];

  /**
   * The thread as render items — consecutive tool calls folded into one strip, thinking passages
   * folded into one block, harness turn kinds classified, day boundaries marked (against the
   * opener for the first turn, so the date is not drawn twice).
   *
   * Items the refresh did not change keep their previous object identity, so an OnPush child only
   * re-renders when its own content actually moved. Without that, a streaming run repainted every
   * card in the thread once a second.
   */
  protected readonly items = computed(() => {
    const next = groupTurns(this.messages(), this.isEngineer(), this.openerAt());
    const stable = reuseUnchangedItems(this.prevItems, next);
    this.prevItems = stable;
    return stable;
  });

  /** Index of the newest thinking block — the only one that can be the live narration. */
  protected readonly latestThinkingIdx = computed(() => latestThinkingIndex(this.items()));

  /**
   * Is anything being written right now? An Engineer thread knows from its run state; every other
   * thread that streams thoughts (the assistant, Wire) has no run bar, so an in-flight ask is the
   * liveness signal there.
   */
  protected readonly narrationLive = computed(() => this.runLive() || this.sending());

  /** True while the newest thinking block is being written into — the thread narrates itself. */
  protected readonly streamingLive = computed(
    () => this.narrationLive() && this.latestThinkingIdx() >= 0,
  );

  /** What the agent is doing right now, in words. Shared by the run bar and the live block. */
  protected readonly presence = computed(() => runPresence(this.runState()));
  protected readonly presenceText = computed(() => this.presence().text);

  /** Items rendered by `<app-engineer-turn>` rather than the chat's own bubbles and cards. */
  protected isHarnessItem(item: ChatItem): boolean {
    if (item.type === 'tools') return true;
    if (item.type !== 'turn') return false;
    return (
      item.kind === 'plan' ||
      item.kind === 'approval' ||
      item.kind === 'report' ||
      item.kind === 'notice' ||
      item.kind === 'decision'
    );
  }

  /** A strip or a thinking block is stamped with its latest turn; every other item with its own. */
  protected itemTime(item: ChatItem): string {
    return item.type === 'turn' ? item.turn.createdAtUtc : item.last.createdAtUtc;
  }

  /** Case-insensitive: the confirm buttons must not vanish because a writer spelled it `pending`. */
  protected isPendingStatus(status: string | null | undefined): boolean {
    return isStatus(status, 'Pending');
  }

  /**
   * Turn timestamps show SECONDS, not just hours and minutes. An agent run posts several
   * turns inside one minute — conversation 24272 has four between 05:56:25 and 05:56:44 —
   * so `HH:mm` would stamp them all identically and tell the reader nothing about order or
   * pace. The engine sends UTC with a `Z`, and DatePipe renders in the viewer's timezone;
   * the `title` carries the full date for anyone reconciling against an engine log.
   */
  protected readonly timeFormat = 'HH:mm:ss';

  /** Memoised parsed recommendations, keyed by turn id + payload so the chart's
   *  inputs stay reference-stable across change detection (a fresh array every
   *  CD would make the self-fetching chart re-query candles each cycle). */
  private readonly recCache = new Map<string, ParsedChatRec | null>();

  private readonly logEl = viewChild<ElementRef<HTMLDivElement>>('log');

  /** True while the log sits at (or within a few pixels of) the bottom — then it follows the stream. */
  protected readonly pinned = signal(true);
  /** Turns that arrived while the reader was scrolled away. */
  protected readonly newSince = signal(0);
  protected readonly jumpText = computed(() => jumpLabel(this.newSince()));
  private lastCount = 0;

  /** Cheap enough for a scroll handler: one layout read, and the signal only fires on a flip. */
  protected onLogScroll(): void {
    const el = this.logEl()?.nativeElement;
    if (!el) return;
    const atBottom = isPinnedToBottom(el);
    this.pinned.set(atBottom);
    if (atBottom) this.newSince.set(0);
  }

  protected jumpToLatest(): void {
    this.pinned.set(true);
    this.newSince.set(0);
    this.scrollToBottom('smooth');
  }

  private scrollToBottom(behavior: ScrollBehavior): void {
    const el = this.logEl()?.nativeElement;
    if (!el) return;
    // `scrollTo` rather than assigning scrollTop so the jump affordance can animate; the
    // follow-the-stream path stays instant, which is what makes growing text read as typing
    // instead of as a page that keeps sliding.
    if (typeof el.scrollTo === 'function') el.scrollTo({ top: el.scrollHeight, behavior });
    else el.scrollTop = el.scrollHeight; // jsdom / very old engines have no element scrollTo
  }

  /** Debounce timer coalescing a burst of realtime tickles (the agentic ask loop
   *  persists several turns in quick succession) into one silent thread refresh. */
  private liveReloadTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    // Load (or reload) the thread + monitors whenever the anchor id changes —
    // including the first render and after the operator re-runs the analysis.
    //
    // Untracked on purpose: the loaders read other signals (monitorsEnabled, isEngineer), and a
    // late-arriving conversation Kind must not re-run the clear-and-spinner thread load.
    effect(() => {
      const id = this.llmInvocationId();
      untracked(() => this.loadThread(id));
    });
    effect(() => {
      const id = this.llmInvocationId();
      const enabled = this.monitorsEnabled();
      untracked(() => (enabled ? this.loadMonitors(id) : this.monitors.set([])));
    });

    // Engineer threads: (re)load the run header whenever the conversation is bound or turns out
    // to be an Engineer one (the host may learn the Kind after the id).
    effect(() => {
      const id = this.llmInvocationId();
      const engineer = this.isEngineer();
      untracked(() => {
        this.runState.set(null);
        this.runLoaded.set(false);
        this.stopMessage.set(null);
        if (engineer && id) this.loadRunState(id);
      });
    });

    // Follow the newest turn — but ONLY while the log is already parked at the bottom.
    //
    // A streaming run rewrites its last turn about once a second. The old rule scrolled to the
    // bottom on every one of those, which meant an operator reading something further up had the
    // log yanked out from under them once a second. Now: pinned → follow; scrolled away → leave
    // the scroll position exactly where they put it and count what they are missing.
    effect(() => {
      const count = this.messages().length;
      this.sending();
      untracked(() => {
        if (this.pinned()) {
          this.newSince.set(0);
          queueMicrotask(() => this.scrollToBottom('auto'));
        } else if (count > this.lastCount) {
          this.newSince.update((n) => n + (count - this.lastCount));
        }
        this.lastCount = count;
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

  /**
   * Coalesce tickles and refresh the open thread.
   *
   * An Engineer thread refreshes even while the operator's own send is in flight: the agent
   * narrates into the thread as it works, and an `ask` that runs for minutes would otherwise
   * freeze the stream for exactly as long as the operator is waiting. The optimistic copy of
   * their message survives that refresh (`mergeOptimisticTurns`). Other chats keep the original
   * rule — they stream nothing, so a concurrent fetch would only race the send's own reload.
   */
  private scheduleLiveReload(): void {
    if (this.liveReloadTimer) clearTimeout(this.liveReloadTimer);
    this.liveReloadTimer = setTimeout(() => {
      const id = this.llmInvocationId();
      // The run header refreshes on every tickle, even mid-send: the agent's status line is
      // exactly what the operator is watching while their message is in flight.
      if (id && this.isEngineer()) this.loadRunState(id);
      if (!id || (this.sending() && !this.isEngineer())) return;
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
          // The rec cache is keyed on turn id + payload, so a rec that was stamped Filed misses
          // on its own. Clearing it here instead threw away every parse once a second, and each
          // miss hands the self-fetching rec chart a fresh input array — which made it re-query
          // candles on every tickle.
          this.messages.set(mergeOptimisticTurns(res.data, this.messages()));
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
    // A different conversation starts at its own bottom, with nothing "missed".
    this.prevItems = [];
    this.lastCount = 0;
    this.pinned.set(true);
    this.newSince.set(0);
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

    let pageContext: unknown | null = null;
    try {
      pageContext = this.contextProvider()?.() ?? null;
    } catch {
      /* describing the page must never block the question */
    }

    this.marketData.askAnalysisFollowUp(id, q, pageContext ?? undefined).subscribe({
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
  /** What this proposal will do, in the operator's terms. */
  protected impactOf(pa: { method: string; path: string }): ActionImpact {
    return describeAction(pa.method, pa.path);
  }

  /** The request body as label/value rows, so the card shows what changes rather than JSON. */
  protected bodyRows(pa: { body: string | null }): Array<{ label: string; value: string }> {
    if (!pa.body) return [];
    try {
      return humaniseBody(JSON.parse(pa.body));
    } catch {
      return [];
    }
  }

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
      // The assistant addresses operations by operationId; the spot chat's http_action
      // carries a literal method + path. Render either.
      const withOp = a as typeof a & { operationId?: string; route?: Record<string, unknown> };
      const opPath = withOp.operationId ? String(withOp.operationId).replace(/_/g, ' · ') : '';
      return {
        method: (a.method || (withOp.operationId ? '' : 'POST')).toUpperCase(),
        path: a.path || opPath,
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
   *  full refreshed thread.
   *
   *  `opts` carries the operator's reason and, on an algo-engineer approval card,
   *  their edited values. A refusal (a bad amendment, a policy block) comes back
   *  as `status:false` with a message the OPERATOR needs to read next to the card
   *  they are looking at — so it is routed there as well as to the thread's error
   *  line, and the composer that raised it is left standing with its text intact. */
  protected resolve(
    m: SpotAnalysisFollowUpTurnDto,
    confirm: boolean,
    opts?: ResolveApprovalOptions,
  ): void {
    if (this.resolvingId() !== null) return;
    const id = this.llmInvocationId();
    this.resolvingId.set(m.id);
    this.error.set(null);
    this.resolveError.set(null);
    this.marketData.resolveFollowUpAction(m.id, confirm, opts).subscribe({
      next: (res) => {
        this.resolvingId.set(null);
        if (this.llmInvocationId() !== id) return;
        if (res?.status && res.data) this.messages.set(res.data);
        else this.failResolve(m, res?.message || 'Could not resolve the action.');
        // A confirmed action may have created a monitor — refresh the strip.
        this.loadMonitors(id);
        // An approval wakes the agent's run — pick up its new status.
        if (this.isEngineer()) this.loadRunState(id);
      },
      error: (err) => {
        this.resolvingId.set(null);
        this.failResolve(m, err?.message ?? 'Action failed. Is the engine reachable?');
      },
    });
  }

  /**
   * An approval card renders its own failure, so the thread's error line stays quiet for it — the
   * same sentence in two places reads as two problems. Every other proposal has no card of its own
   * to show it on, so those keep the line.
   */
  private failResolve(m: SpotAnalysisFollowUpTurnDto, message: string): void {
    this.resolveError.set({ turnId: m.id, message });
    if (m.toolName !== 'approval') this.error.set(message);
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
        stopLoss?: number | null;
        takeProfit?: number | null;
        confidence?: number;
        riskRewardRatio?: number | null;
        rationale?: string;
        filedSignalId?: number | null;
        operatorModified?: boolean;
        operatorNote?: string | null;
        modelOriginal?: {
          action?: string;
          entryPrice?: number;
          stopLoss?: number | null;
          takeProfit?: number | null;
          confidence?: number;
          riskRewardRatio?: number | null;
        } | null;
      };
      const action = r.action === 'Buy' || r.action === 'Sell' ? r.action : null;
      // Entry is the only level a card cannot be drawn without. Requiring SL and
      // TP too meant a filed rec whose target the operator cleared fell back to
      // a raw-JSON blob — the card vanished at exactly the moment it mattered.
      if (action && r.symbol && typeof r.entryPrice === 'number') {
        parsed = {
          symbol: r.symbol,
          timeframe: r.timeframe || 'H1',
          asOfUtc: r.asOfUtc || new Date().toISOString(),
          action,
          entryPrice: r.entryPrice,
          stopLoss: typeof r.stopLoss === 'number' ? r.stopLoss : null,
          takeProfit: typeof r.takeProfit === 'number' ? r.takeProfit : null,
          // `?? 0` printed "conf 0%" for a rec that simply carried no confidence —
          // a fabricated value indistinguishable from a genuine zero. Null means unknown
          // and renders as "conf —".
          confidencePct: typeof r.confidence === 'number' ? Math.round(r.confidence * 100) : null,
          riskRewardRatio: r.riskRewardRatio ?? null,
          rationale: r.rationale || '',
          filedSignalId: r.filedSignalId ?? null,
          operatorModified: r.operatorModified === true,
          operatorNote: r.operatorNote || null,
          modelOriginal: describeModelOriginal(r.modelOriginal),
          chartRecs: [
            {
              label: `${action} ${r.symbol}`,
              action,
              entryPrice: r.entryPrice,
              stopLoss: typeof r.stopLoss === 'number' ? r.stopLoss : null,
              takeProfit: typeof r.takeProfit === 'number' ? r.takeProfit : null,
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

  /** Seed the inline editor from a parsed rec. */
  protected recSeed(rec: ParsedChatRec): RecFileSeed {
    return {
      symbol: rec.symbol,
      action: rec.action,
      entryPrice: rec.entryPrice,
      stopLoss: rec.stopLoss,
      takeProfit: rec.takeProfit,
      confidence: rec.confidencePct === null ? null : rec.confidencePct / 100,
    };
  }

  /** Open the pre-filled editor on one rec card. */
  protected openEditor(m: SpotAnalysisFollowUpTurnDto): void {
    if (this.filingId() !== null) return;
    this.fileError.set(null);
    this.editingId.set(m.id);
  }

  protected closeEditor(): void {
    if (this.filingId() !== null) return;
    this.editingId.set(null);
    this.fileError.set(null);
  }

  /** File a chat-generated recommendation as a live signal through the risk
   *  gates. `overrides` carries the operator's edits and is empty when they
   *  filed the model's values untouched; the engine returns the full refreshed
   *  thread (the rec turn comes back stamped "Filed").
   *
   *  The blind `confirm()` this used to open is gone — the editor itself is the
   *  deliberate step, and it shows the operator the exact geometry they are
   *  about to commit instead of asking them to trust a sentence. */
  protected fileSignal(m: SpotAnalysisFollowUpTurnDto, overrides: RecFileOverrides): void {
    if (this.filingId() !== null) return;
    const id = this.llmInvocationId();
    this.filingId.set(m.id);
    this.error.set(null);
    this.fileError.set(null);
    this.marketData.fileFollowUpSignal(m.id, overrides).subscribe({
      next: (res) => {
        this.filingId.set(null);
        if (this.llmInvocationId() !== id) return;
        if (res?.status && res.data) {
          this.recCache.clear(); // filed turn re-parses with its new filedSignalId
          this.editingId.set(null);
          this.messages.set(res.data);
        } else {
          // Kept on the editor, not the thread-level error strip: a rejected
          // level is something the operator fixes right here in the form.
          this.fileError.set(res?.message || 'Could not file the signal.');
        }
      },
      error: (err) => {
        this.filingId.set(null);
        this.fileError.set(err?.message ?? 'Filing failed. Is the engine reachable?');
      },
    });
  }

  /** Fetch the Engineer session's latest run for the header. A failure keeps the last state. */
  private loadRunState(sessionId: number): void {
    const seq = ++this.runStateSeq;
    this.algoEngineer.getRunState(sessionId).subscribe({
      next: (res) => {
        if (seq !== this.runStateSeq || this.llmInvocationId() !== sessionId) return;
        this.runLoaded.set(true);
        if (res?.status) this.runState.set(res.data ?? null);
      },
      error: () => {
        if (seq !== this.runStateSeq || this.llmInvocationId() !== sessionId) return;
        this.runLoaded.set(true);
      },
    });
  }

  /** Stop the Engineer session's active run. Shared by the header button and the "stop" chip. */
  protected stopRun(): void {
    const id = this.llmInvocationId();
    if (!id || this.stopping()) return;
    this.stopping.set(true);
    this.stopMessage.set(null);
    this.algoEngineer.stopRun(id).subscribe({
      next: (res) => {
        this.stopping.set(false);
        if (this.llmInvocationId() !== id) return;
        const d = res?.data;
        if (res?.status && d?.stopped) {
          this.stopMessage.set({
            text: d.message || 'Stop requested — the agent halts at its next step.',
            ok: true,
          });
        } else {
          this.stopMessage.set({
            text: d?.message || res?.message || 'Could not stop the run.',
            ok: false,
          });
        }
        this.loadRunState(id);
      },
      error: (err) => {
        this.stopping.set(false);
        if (this.llmInvocationId() !== id) return;
        this.stopMessage.set({
          text: err?.error?.message ?? err?.message ?? 'Stop failed. Is the engine reachable?',
          ok: false,
        });
      },
    });
  }

  /** A composer quick reply: `null` is the "stop" chip, anything else is sent as a message. */
  protected useHint(text: string | null): void {
    if (text === null) {
      this.stopRun();
      return;
    }
    if (this.sending()) return;
    this.question.set(text);
    this.send();
  }

  /** Load the active monitors created from this analysis. */
  private loadMonitors(llmInvocationId: number): void {
    if (!llmInvocationId) {
      this.monitors.set([]);
      return;
    }
    if (!this.monitorsEnabled()) {
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
