import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { DatePipe, NgTemplateOutlet } from '@angular/common';
import { MarkdownInlinePipe, MarkdownPipe } from '@shared/pipes/markdown.pipe';
import type { SpotAnalysisFollowUpTurnDto } from '@core/api/api.types';
import {
  approvalStatus,
  isPendingAction,
  parseApproval,
  parsePlan,
  parseReport,
  parseRunNotice,
  toolStripLabel,
  type ChatItem,
} from './engineer-turns';

/**
 * Renders the algo-engineer harness turn kinds inside `<app-analysis-chat>`: the collapsed tool
 * strip, the plan card, the approval card, the work-order report and the run notice.
 *
 * A child component rather than more markup in the chat so its styles live in their own budget —
 * the chat's stylesheet is already close to the per-component limit. Resolving an approval is
 * emitted back up: the chat owns the thread and the resolve endpoint (the same one Confirm/Dismiss
 * use), so the refreshed thread lands in one place.
 */
@Component({
  selector: 'app-engineer-turn',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, NgTemplateOutlet, MarkdownPipe, MarkdownInlinePipe],
  template: `
    @let it = item();
    @if (it.type === 'tools') {
      <details class="strip" [class.has-failed]="it.failed > 0">
        <summary>
          <span class="caret" aria-hidden="true"></span>
          <span class="strip-label">🔧 {{ stripLabel() }}</span>
          @if (it.rows.length > 1) {
            <span class="strip-last" [title]="it.last.content">latest: {{ it.last.toolName }}</span>
          }
        </summary>
        <ul class="rows">
          @for (row of it.rows; track row.turn.id) {
            <li class="row" [attr.data-ok]="row.result.ok">
              @if (row.turn.toolArgsJson || row.result.raw) {
                <details>
                  <summary>
                    <ng-container
                      *ngTemplateOutlet="rowHead; context: { $implicit: row }"
                    ></ng-container>
                  </summary>
                  <div class="row-body">
                    @if (row.turn.toolArgsJson && row.turn.toolArgsJson !== '{}') {
                      <pre class="pre">args: {{ row.turn.toolArgsJson }}</pre>
                    }
                    @if (row.result.summary) {
                      <div class="row-summary">{{ row.result.summary }}</div>
                    }
                    @if (row.result.result) {
                      <pre class="pre">{{ row.result.result }}</pre>
                    } @else if (row.result.raw && row.result.ok === null) {
                      <pre class="pre">{{ row.result.raw }}</pre>
                    }
                  </div>
                </details>
              } @else {
                <div class="row-plain">
                  <ng-container
                    *ngTemplateOutlet="rowHead; context: { $implicit: row }"
                  ></ng-container>
                </div>
              }
            </li>
          }
        </ul>
      </details>
    } @else if (it.type === 'turn') {
      @switch (it.kind) {
        @case ('plan') {
          @let p = plan();
          <div class="card plan">
            <div class="head">
              <span class="badge">🗺 Plan</span>
              @if (p.total > 0) {
                <span class="meta">{{ p.done }}/{{ p.total }} done</span>
              }
            </div>
            @if (p.total > 0) {
              <div class="progress" aria-hidden="true">
                <span [style.width.%]="(p.done / p.total) * 100"></span>
              </div>
            }
            @for (b of p.blocks; track $index) {
              @if (b.type === 'md') {
                <div class="md body" [innerHTML]="b.text | markdown"></div>
              } @else {
                <ul class="tasks">
                  @for (t of b.tasks; track $index) {
                    <li [attr.data-state]="t.state" [style.padding-left.px]="t.depth * 18">
                      <span
                        class="box"
                        [attr.data-state]="t.state"
                        [attr.aria-label]="
                          t.state === 'done'
                            ? 'Done'
                            : t.state === 'doing'
                              ? 'In progress'
                              : 'To do'
                        "
                      ></span>
                      <span class="ttext" [innerHTML]="t.text | markdownInline"></span>
                    </li>
                  }
                </ul>
              }
            }
          </div>
        }
        @case ('approval') {
          @let a = approval();
          @let st = status();
          <div class="card approval" [attr.data-tone]="st.tone">
            <div class="head">
              <span class="badge">✋ {{ pending() ? 'Approval needed' : 'Approval' }}</span>
              @if (a.live) {
                <span class="chip live" title="Approving this changes something in production"
                  >Goes live</span
                >
              }
              @if (!pending()) {
                <span class="chip" [attr.data-tone]="st.tone">{{ st.label }}</span>
              }
            </div>
            @if (it.turn.content) {
              <div class="md body" [innerHTML]="it.turn.content | markdown"></div>
            }
            @if (a.verb || a.targets.length > 0 || a.sideEffect) {
              <dl class="facts">
                @if (a.verb) {
                  <dt>Action</dt>
                  <dd>
                    <strong>{{ a.verb }}</strong>
                  </dd>
                }
                @if (a.targets.length > 0) {
                  <dt>Target{{ a.targets.length === 1 ? '' : 's' }}</dt>
                  <dd class="targets">
                    @for (t of a.targets; track $index) {
                      <code>{{ t }}</code>
                    }
                  </dd>
                }
                @if (a.sideEffect) {
                  <dt>Side effect</dt>
                  <dd>{{ a.sideEffect }}</dd>
                }
              </dl>
            }
            @if (pending()) {
              <div class="actions">
                <button
                  type="button"
                  class="approve"
                  [class.danger]="a.live"
                  [disabled]="resolvingId() !== null"
                  (click)="resolve.emit({ turn: it.turn, confirm: true })"
                >
                  {{ resolvingId() === it.turn.id ? 'Sending…' : 'Approve' }}
                </button>
                <button
                  type="button"
                  class="reject"
                  [disabled]="resolvingId() !== null"
                  (click)="resolve.emit({ turn: it.turn, confirm: false })"
                >
                  Reject
                </button>
              </div>
            } @else if (a.resolvedAtUtc) {
              <div class="resolved">
                {{ st.label }} {{ a.resolvedAtUtc | date: 'MMM d, HH:mm:ss' }}
              </div>
            }
          </div>
        }
        @case ('report') {
          @let r = report();
          <div class="card report" [attr.data-outcome]="r.outcome">
            <div class="head">
              <span class="badge">📋 Work-order report</span>
              @if (r.outcome) {
                <span class="chip" [attr.data-outcome]="r.outcome">{{ r.outcome }}</span>
              }
            </div>
            @if (it.turn.content) {
              <div class="md body" [innerHTML]="it.turn.content | markdown"></div>
            }
            <div class="live-changes">
              <div class="section-title">Live changes this session</div>
              @if (r.liveChanges === null) {
                <div class="none">Not reported</div>
              } @else if (r.liveChanges.length === 0) {
                <div class="none">None</div>
              } @else {
                <ul>
                  @for (c of r.liveChanges; track $index) {
                    <li>
                      @if (c.kind) {
                        <span class="lc-kind">{{ c.kind }}</span>
                      }
                      @if (c.ref) {
                        <code>{{ c.ref }}</code>
                      }
                      <span class="lc-desc">{{ c.description }}</span>
                      @if (c.atUtc) {
                        <time class="lc-at" [attr.datetime]="c.atUtc">{{
                          c.atUtc | date: 'HH:mm'
                        }}</time>
                      }
                    </li>
                  }
                </ul>
              }
            </div>
            @if (r.nextCheck) {
              <div class="next">Next check: {{ r.nextCheck }}</div>
            }
          </div>
        }
        @case ('notice') {
          @let n = notice();
          <div class="notice" [attr.data-kind]="n.kind">
            <span class="notice-label">{{ n.label }}</span>
            @if (it.turn.content) {
              <span class="notice-text" [innerHTML]="it.turn.content | markdownInline"></span>
            }
          </div>
        }
      }
    }

    <ng-template #rowHead let-row>
      <span class="mark" [attr.data-ok]="row.result.ok">{{
        row.result.ok === false ? '✕' : row.result.ok === true ? '✓' : '•'
      }}</span>
      <code class="tname">{{ row.turn.toolName || 'tool' }}</code>
      <span class="tcontent">{{ row.turn.content || row.result.summary || '' }}</span>
    </ng-template>
  `,
  styles: [
    `
      :host {
        display: block;
        flex: 1;
        min-width: 0;
        --eng-ok: color-mix(in srgb, var(--profit) 72%, var(--text-primary));
        --eng-warn: color-mix(in srgb, var(--warning) 78%, var(--text-primary));
        --eng-bad: color-mix(in srgb, var(--loss) 82%, var(--text-primary));
      }
      /* ── Tool strip ── */
      .strip {
        border: 1px dashed var(--border);
        border-radius: 8px;
        background: var(--bg-secondary);
        font-size: var(--text-xs);
      }
      .strip.has-failed {
        border-color: color-mix(in srgb, var(--loss) 35%, var(--border));
      }
      summary {
        list-style: none;
        cursor: pointer;
      }
      summary::-webkit-details-marker {
        display: none;
      }
      .strip > summary {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 5px 9px;
        color: var(--text-secondary);
      }
      .caret {
        width: 0;
        height: 0;
        border-left: 4px solid currentColor;
        border-top: 4px solid transparent;
        border-bottom: 4px solid transparent;
        transition: transform var(--dur-fast, 0.15s);
      }
      .strip[open] > summary .caret {
        transform: rotate(90deg);
      }
      .strip-last {
        margin-left: auto;
        color: var(--text-tertiary);
        font-size: 10px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        min-width: 0;
      }
      .rows {
        list-style: none;
        margin: 0;
        padding: 0 9px 7px;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .row > details > summary,
      .row-plain {
        display: flex;
        align-items: baseline;
        gap: 7px;
        padding: 3px 4px;
        border-radius: 5px;
        min-width: 0;
      }
      .row > details > summary:hover {
        background: var(--bg-tertiary);
      }
      .mark {
        flex: none;
        width: 12px;
        text-align: center;
        font-weight: var(--font-bold);
        color: var(--text-tertiary);
      }
      .mark[data-ok='true'] {
        color: var(--eng-ok);
      }
      .mark[data-ok='false'] {
        color: var(--eng-bad);
      }
      .tname {
        flex: none;
        font-family: var(--font-mono, monospace);
        font-size: 11px;
        color: var(--text-primary);
      }
      .tcontent {
        color: var(--text-secondary);
        overflow-wrap: anywhere;
      }
      .row-body {
        padding: 0 4px 4px 23px;
      }
      .row-summary {
        margin-top: 4px;
        color: var(--text-secondary);
      }
      .pre {
        margin: 4px 0 0;
        padding: 6px 8px;
        background: var(--bg-tertiary);
        border-radius: 6px;
        font-size: 11px;
        line-height: 1.45;
        white-space: pre-wrap;
        word-break: break-word;
        max-height: 220px;
        overflow: auto;
      }
      /* ── Cards ── */
      .card {
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 9px 12px;
        background: var(--bg-primary);
        font-size: var(--text-sm);
        max-width: 96%;
      }
      .head {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 6px 8px;
        margin-bottom: 6px;
      }
      .badge {
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
      }
      .meta {
        margin-left: auto;
        font-size: var(--text-xs);
        color: var(--text-secondary);
        font-variant-numeric: tabular-nums;
      }
      .body {
        line-height: 1.5;
      }
      .chip {
        --tone: var(--text-tertiary);
        padding: 1px 8px;
        border-radius: var(--radius-full);
        font-size: 10px;
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--tone);
        background: color-mix(in srgb, var(--tone) 14%, transparent);
      }
      .chip[data-tone='ok'],
      .chip[data-outcome='done'] {
        --tone: var(--eng-ok);
      }
      .chip[data-tone='bad'],
      .chip[data-outcome='blocked'] {
        --tone: var(--eng-bad);
      }
      .chip[data-outcome='partial'] {
        --tone: var(--eng-warn);
      }
      .chip.live {
        --tone: var(--loss);
        color: #fff;
        background: var(--loss);
      }
      /* Plan */
      .plan {
        border-color: color-mix(in srgb, var(--accent) 30%, var(--border));
      }
      .progress {
        height: 3px;
        border-radius: 2px;
        background: var(--bg-tertiary);
        overflow: hidden;
        margin-bottom: 7px;
      }
      .progress > span {
        display: block;
        height: 100%;
        background: var(--eng-ok);
        transition: width var(--dur-slow, 0.3s);
      }
      .tasks {
        list-style: none;
        margin: 4px 0 6px;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 3px;
      }
      .tasks li {
        display: flex;
        align-items: baseline;
        gap: 8px;
        line-height: 1.45;
      }
      .tasks li[data-state='done'] .ttext {
        color: var(--text-tertiary);
        text-decoration: line-through;
        text-decoration-color: color-mix(in srgb, var(--text-tertiary) 60%, transparent);
      }
      .tasks li[data-state='doing'] .ttext {
        font-weight: var(--font-medium);
      }
      .box {
        position: relative;
        top: 2px;
        flex: none;
        width: 13px;
        height: 13px;
        border-radius: 4px;
        border: 1.5px solid var(--text-tertiary);
        box-sizing: border-box;
      }
      .box[data-state='done'] {
        border-color: var(--eng-ok);
        background: var(--eng-ok);
      }
      .box[data-state='done']::after {
        content: '';
        position: absolute;
        left: 3px;
        top: 0;
        width: 3px;
        height: 7px;
        border: solid var(--bg-primary);
        border-width: 0 2px 2px 0;
        transform: rotate(45deg);
      }
      .box[data-state='doing'] {
        border-color: var(--accent);
        background: linear-gradient(90deg, var(--accent) 50%, transparent 50%);
      }
      /* Approval */
      .approval {
        border-color: var(--accent);
        background: color-mix(in srgb, var(--accent) 6%, var(--bg-primary));
      }
      .approval[data-tone='ok'] {
        border-color: color-mix(in srgb, var(--profit) 50%, var(--border));
        background: var(--bg-primary);
      }
      .approval[data-tone='bad'],
      .approval[data-tone='muted'] {
        border-color: var(--border);
        background: var(--bg-secondary);
      }
      .facts {
        display: grid;
        grid-template-columns: minmax(80px, auto) 1fr;
        gap: 3px var(--space-3);
        margin: 6px 0 0;
        font-size: var(--text-xs);
      }
      .facts dt {
        color: var(--text-tertiary);
      }
      .facts dd {
        margin: 0;
        color: var(--text-primary);
        overflow-wrap: anywhere;
      }
      .targets {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
      }
      code {
        font-family: var(--font-mono, monospace);
        font-size: 11px;
        padding: 0 5px;
        border-radius: 4px;
        background: var(--bg-tertiary);
      }
      .actions {
        display: flex;
        gap: 8px;
        margin-top: 10px;
      }
      .actions button {
        font: inherit;
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
        padding: 6px 14px;
        border-radius: var(--radius-full);
        cursor: pointer;
      }
      .approve {
        border: 1px solid var(--accent);
        background: var(--accent);
        color: #fff;
      }
      .approve.danger {
        border-color: var(--loss);
        background: var(--loss);
      }
      .reject {
        border: 1px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-secondary);
      }
      .actions button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .resolved {
        margin-top: 8px;
        font-size: var(--text-xs);
        color: var(--text-tertiary);
      }
      /* Report */
      .report {
        border-color: color-mix(in srgb, var(--accent) 25%, var(--border));
        box-shadow: var(--shadow-sm);
      }
      .report[data-outcome='done'] {
        border-left: 3px solid var(--eng-ok);
      }
      .report[data-outcome='partial'] {
        border-left: 3px solid var(--eng-warn);
      }
      .report[data-outcome='blocked'] {
        border-left: 3px solid var(--eng-bad);
      }
      .live-changes {
        margin-top: 8px;
        padding: 7px 9px;
        border-radius: 8px;
        background: var(--bg-secondary);
        font-size: var(--text-xs);
      }
      .section-title {
        font-size: 10px;
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-secondary);
        margin-bottom: 4px;
      }
      .live-changes ul {
        margin: 0;
        padding-left: 16px;
        display: flex;
        flex-direction: column;
        gap: 3px;
      }
      .lc-kind {
        font-weight: var(--font-semibold);
        margin-right: 4px;
      }
      .lc-desc {
        margin-left: 4px;
        color: var(--text-secondary);
      }
      .lc-at {
        margin-left: 6px;
        color: var(--text-tertiary);
        font-variant-numeric: tabular-nums;
      }
      .none {
        color: var(--text-tertiary);
        font-style: italic;
      }
      .next {
        margin-top: 6px;
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      /* Run notice — a system line, not a bubble */
      .notice {
        display: flex;
        align-items: baseline;
        justify-content: center;
        flex-wrap: wrap;
        gap: 6px;
        padding: 3px 10px;
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        text-align: center;
      }
      .notice-label {
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        font-size: 10px;
        color: var(--text-secondary);
      }
      .notice[data-kind='failed'] .notice-label,
      .notice[data-kind='budget'] .notice-label,
      .notice[data-kind='max_steps'] .notice-label {
        color: var(--eng-bad);
      }
      .notice[data-kind='watch_fired'] .notice-label {
        color: var(--eng-ok);
      }
    `,
  ],
})
export class EngineerTurnComponent {
  readonly item = input.required<ChatItem>();
  /** Id of the proposal currently being resolved (any card), or null — disables every button. */
  readonly resolvingId = input<number | null>(null);

  readonly resolve = output<{ turn: SpotAnalysisFollowUpTurnDto; confirm: boolean }>();

  protected readonly stripLabel = computed(() => {
    const it = this.item();
    return it.type === 'tools' ? toolStripLabel(it.rows.length, it.failed) : '';
  });
  protected readonly plan = computed(() => parsePlan(this.item().turn.content));
  protected readonly approval = computed(() => parseApproval(this.item().turn));
  protected readonly status = computed(() => approvalStatus(this.item().turn.actionStatus));
  protected readonly pending = computed(() => isPendingAction(this.item().turn.actionStatus));
  protected readonly report = computed(() => parseReport(this.item().turn));
  protected readonly notice = computed(() => parseRunNotice(this.item().turn));
}
