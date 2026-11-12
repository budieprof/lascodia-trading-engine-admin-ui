import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { catchError, of } from 'rxjs';
import type { EChartsOption } from 'echarts';

import { AnalysisMonitorsService } from '@core/services/analysis-monitors.service';
import { ThemeService } from '@core/theme/theme.service';
import type { AnalysisMonitorLevel } from '@core/api/api.types';
import type {
  AnalysisMonitorActivity,
  AnalysisMonitorDetail,
} from '@features/analysis-monitors/analysis-monitors.types';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { ModalA11yDirective } from '@shared/directives/modal-a11y.directive';
import {
  formatAge,
  formatCountdown,
  humanizeNote,
  levelDistance,
  lifeProgress,
  prettyJson,
} from '@features/analysis-monitors/monitor-format';

export type MonitorDrawerAction =
  | 'pause'
  | 'resume'
  | 'fire'
  | 'extend'
  | 'cancel'
  | 'duplicate'
  | 'ack'
  | 'disarm'
  | 'chart';

type Tab = 'overview' | 'timeline' | 'spec' | 'signals' | 'lineage';

/** Event kinds a marker is drawn for on the price trace, with the glyph used. */
const MARKER_KINDS: Record<string, { label: string; symbol: string }> = {
  Fired: { label: 'Fired', symbol: 'triangle' },
  Touched: { label: 'Touched', symbol: 'diamond' },
  Invalidated: { label: 'Thesis broke', symbol: 'rect' },
  Created: { label: 'Armed', symbol: 'circle' },
  Rearmed: { label: 'Re-armed', symbol: 'roundRect' },
};

const LEVEL_STYLE: Record<string, { light: string; dark: string; dash: 'solid' | 'dashed' | 'dotted' }> = {
  trigger: { light: '#2a78d6', dark: '#3987e5', dash: 'solid' },
  entry: { light: '#2a78d6', dark: '#3987e5', dash: 'dashed' },
  invalidation: { light: '#eb6834', dark: '#d95926', dash: 'solid' },
  stop: { light: '#eb6834', dark: '#d95926', dash: 'dashed' },
  target: { light: '#1baf7a', dark: '#199e70', dash: 'dashed' },
};

/**
 * One monitor in full, as a side drawer over the board.
 *
 * <p>Replaces the inline expanded row: that pushed every row below it off-screen and had room for
 * two cramped columns. The drawer keeps the board visible (so j/k can walk the list while it stays
 * open) and has room for what actually answers "why has this not fired": the price the worker saw
 * at every check plotted against the levels it is waiting at.</p>
 *
 * <p>It owns its reads (detail + a heartbeat-inclusive trace) and raises verbs to the page, which
 * holds the confirm dialog and the busy state — so a destructive action never runs from here
 * without the same confirmation as from the board.</p>
 */
@Component({
  selector: 'app-monitor-detail-drawer',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, DecimalPipe, RouterLink, ChartCardComponent, ModalA11yDirective],
  template: `
    <div class="scrim" (click)="closed.emit()"></div>
    <aside
      class="drawer"
      role="dialog"
      aria-modal="true"
      [attr.aria-label]="'Monitor #' + monitorId()"
      appModalA11y
      (dismiss)="closed.emit()"
    >
      @if (detail(); as det) {
        @let m = det.monitor;
        <header class="d-head">
          <div class="d-title">
            <span class="d-id mono">#{{ m.id }}</span>
            <span class="d-sym mono">{{ m.subjectLabel || m.symbol }}</span>
            <span class="d-tf">{{ m.timeframe }}</span>
            @if (m.plannedDirection) {
              <span class="pill dir" [class.buy]="m.plannedDirection === 'Buy'">{{ m.plannedDirection }}</span>
            }
            <span class="status" [attr.data-status]="m.status">{{ statusLabel(m.status) }}</span>
            <span class="spacer"></span>
            <button type="button" class="icon-btn" title="Previous monitor (k)" (click)="step.emit(-1)">↑</button>
            <button type="button" class="icon-btn" title="Next monitor (j)" (click)="step.emit(1)">↓</button>
            <button type="button" class="icon-btn" title="Close (Esc)" aria-label="Close" (click)="closed.emit()">✕</button>
          </div>
          <p class="d-intent">{{ m.intentText }}</p>

          <!-- Life bar: armed → expiry, with "now" and every fire placed on it. -->
          @if (life(); as l) {
            <div class="life" [title]="'Armed ' + (m.createdAtUtc | date: 'MMM d HH:mm' : 'UTC') + 'Z → expires ' + (m.expiresAtUtc | date: 'MMM d HH:mm' : 'UTC') + 'Z'">
              <div class="life-track">
                <div class="life-fill" [style.width.%]="l.pct" [class.ended]="!m.isLive"></div>
                @for (f of fireMarks(); track $index) {
                  <span class="life-fire" [style.left.%]="f" title="Fired"></span>
                }
              </div>
              <div class="life-legend">
                <span>armed {{ m.createdAtUtc | date: 'MMM d HH:mm' : 'UTC' }}Z</span>
                <span>
                  @if (m.isLive) {
                    <b [class.imminent]="(m.secondsToExpiry ?? 0) < 3600">{{ countdown(m.secondsToExpiry ?? 0) }}</b> left
                  } @else {
                    ended
                  }
                </span>
                <span>expires {{ m.expiresAtUtc | date: 'MMM d HH:mm' : 'UTC' }}Z</span>
              </div>
            </div>
          }

          <div class="d-actions">
            @if (m.status === 'Active') {
              <button type="button" class="btn" (click)="action.emit('pause')" [disabled]="busy()">⏸ Pause</button>
              <button type="button" class="btn" (click)="action.emit('fire')" [disabled]="busy()">⚡ Fire now</button>
            } @else if (m.status === 'Paused') {
              <button type="button" class="btn" (click)="action.emit('resume')" [disabled]="busy()">▶ Resume</button>
            }
            @if (m.status === 'Active' || m.status === 'Paused') {
              <button type="button" class="btn" (click)="action.emit('extend')" [disabled]="busy()">⏱ +6h</button>
            }
            @if (m.awaitingAckSinceUtc) {
              <button type="button" class="btn warn" (click)="action.emit('ack')" [disabled]="busy()">✓ Acknowledge</button>
            }
            <button type="button" class="btn" (click)="action.emit('duplicate')">⧉ Duplicate</button>
            @if (m.scriptSource) {
              <button type="button" class="btn" (click)="action.emit('chart')">📈 Script chart</button>
            }
            @if (m.anchorLlmInvocationId) {
              <a class="btn" [routerLink]="['/conversations']" [queryParams]="{ conversation: m.anchorLlmInvocationId }">💬 Conversation</a>
            }
            @if (m.status === 'Active' || m.status === 'Paused') {
              <button type="button" class="btn danger" (click)="action.emit('cancel')" [disabled]="busy()">✕ Cancel</button>
            }
          </div>
        </header>

        <nav class="tabs" role="tablist">
          @for (t of tabs(); track t.key) {
            <button
              type="button"
              role="tab"
              class="tab"
              [class.on]="tab() === t.key"
              [attr.aria-selected]="tab() === t.key"
              (click)="tab.set(t.key)"
            >
              {{ t.label }}
              @if (has(t.count)) {
                <span class="tab-count">{{ t.count }}</span>
              }
            </button>
          }
        </nav>

        <div class="d-body">
          @switch (tab()) {
            @case ('overview') {
              @if (m.awaitingAckSinceUtc) {
                <div class="callout warn">
                  A fire has waited for acknowledgement since
                  {{ m.awaitingAckSinceUtc | date: 'MMM d HH:mm' : 'UTC' }}Z — it keeps escalating until acknowledged.
                </div>
              }
              @if ((m.consecutiveEvalErrors ?? 0) > 0) {
                <div class="callout err">
                  The last {{ m.consecutiveEvalErrors }} evaluation{{ m.consecutiveEvalErrors === 1 ? '' : 's' }} failed;
                  past the tolerance the monitor moves to Error.
                </div>
              }
              @if (m.confirmPendingSinceUtc) {
                <div class="callout info">
                  Touched at {{ m.confirmPendingSinceUtc | date: 'HH:mm' : 'UTC' }}Z — waiting for that bar to close
                  before it decides.
                </div>
              }

              <section class="block">
                <h4>Waiting for</h4>
                <p class="lead">{{ m.triggerExplanation || m.intentText }}</p>
                @if (m.lastEvalNote) {
                  <p class="note"><span class="note-k">Last check</span> {{ humanize(m.lastEvalNote) }}</p>
                }
                @if (m.scriptSource) {
                  <p class="note">
                    <span class="note-k">Structure · step {{ m.scriptStep ?? 0 }}</span>
                    {{ m.scriptLastReading || 'waiting for the first candle close' }}
                    @if (m.scriptReadyAtUtc) {
                      <span class="pill ok">ready {{ m.scriptReadyAtUtc | date: 'MMM d HH:mm' : 'UTC' }}Z</span>
                    }
                  </p>
                }
                @if (m.invalidationExplanation) {
                  <p class="note"><span class="note-k">Called off if</span> {{ m.invalidationExplanation }}</p>
                }
              </section>

              <!-- Price ladder: where price sits among the levels the watch cares about. -->
              @if (ladder().length > 0) {
                <section class="block">
                  <h4>Levels</h4>
                  <ul class="ladder">
                    @for (r of ladder(); track r.key) {
                      <li [class.now]="r.isPrice" [attr.data-kind]="r.kind">
                        <span class="lad-kind">{{ r.label }}</span>
                        <span class="lad-price mono">{{ r.price | number: '1.2-5' }}</span>
                        <span class="lad-dist mono">{{ r.dist }}</span>
                      </li>
                    }
                  </ul>
                </section>
              }

              <section class="block">
                <div class="block-head">
                  <h4>Price at each check</h4>
                  <span class="muted small">{{ tracePoints() }} readings · markers = fires / touches / breaks · lines = levels</span>
                </div>
                <app-chart-card
                  flush
                  height="220px"
                  [loading]="traceLoading()"
                  [options]="traceOptions()"
                  [emptyMessage]="tracePoints() > 1 || traceLoading() ? null : 'No price readings recorded for this monitor.'"
                  alt="Mid price observed at each evaluation, with fires and levels"
                />
              </section>

              <section class="block">
                <h4>Facts</h4>
                <dl class="facts">
                  <dt>Mode</dt>
                  <dd>
                    {{ m.evaluationMode === 'Deterministic' ? 'Live check (every worker loop)' : 'LLM-judged' }}
                    @if (m.evaluationMode !== 'Deterministic') {
                      · every {{ age(m.minEvalIntervalSeconds ?? 0) }}
                    }
                  </dd>
                  <dt>Origin</dt>
                  <dd>{{ m.origin || 'operator' }}{{ m.createdBy ? ' · ' + m.createdBy : '' }}</dd>
                  <dt>Fires</dt>
                  <dd>
                    {{ m.triggerCount }} / {{ m.maxTriggers }} · {{ m.recurring ? 'recurring' : 'one-shot' }}
                    @if (m.lastTriggeredAtUtc) {
                      · last {{ m.lastTriggeredAtUtc | date: 'MMM d HH:mm' : 'UTC' }}Z
                    }
                  </dd>
                  <dt>Cooldown</dt>
                  <dd>
                    {{ age(m.cooldownSeconds) }}
                    @if (cooldownLeft() > 0) {
                      · <b>cooling, {{ age(cooldownLeft()) }} left</b>
                    }
                  </dd>
                  <dt>Last check</dt>
                  <dd>
                    {{ has(m.secondsSinceLastCheck) ? age(m.secondsSinceLastCheck!) + ' ago' : 'never' }}
                    @if (has(m.lastObservedPrice)) {
                      · mid <span class="mono">{{ m.lastObservedPrice | number: '1.2-5' }}</span>
                    }
                  </dd>
                  <dt>Confirms on</dt>
                  <dd>{{ m.confirmOn === 'close' ? 'bar close' : 'touch' }}</dd>
                  <dt>Price age max</dt>
                  <dd>{{ m.maxPriceAgeSeconds ? age(m.maxPriceAgeSeconds) : '—' }}</dd>
                  <dt>Delivers to</dt>
                  <dd>{{ (m.deliverTo ?? []).length ? m.deliverTo!.join(', ') : 'default' }}</dd>
                  <dt>Acknowledgement</dt>
                  <dd>
                    {{ m.requiresAck ? 'required, escalates after ' + age(m.ackEscalateAfterSeconds ?? 0) : 'not required' }}
                    @if (m.lastAckedAtUtc) {
                      · last by {{ m.lastAckedBy }} {{ m.lastAckedAtUtc | date: 'MMM d HH:mm' : 'UTC' }}Z
                    }
                  </dd>
                  <dt>History</dt>
                  <dd>{{ det.timelineTotal }} event{{ det.timelineTotal === 1 ? '' : 's' }} · {{ det.signals.length }} signal{{ det.signals.length === 1 ? '' : 's' }}</dd>
                  @if (m.monitorGroupId) {
                    <dt>Fan-out group</dt>
                    <dd class="mono small">{{ m.monitorGroupId }}</dd>
                  }
                  @if (m.ocoGroupId) {
                    <dt>OCO group</dt>
                    <dd class="mono small">{{ m.ocoGroupId }} · a fire cancels its siblings</dd>
                  }
                  @if (m.scriptAuthor) {
                    <dt>Script by</dt>
                    <dd>{{ m.scriptAuthor === 'synthesized' ? 'engine (from the trigger)' : m.scriptAuthor }}</dd>
                  }
                </dl>
              </section>

              @if ((m.llmSpendCapUsd ?? 0) > 0 || (m.llmSpendUsd ?? 0) > 0) {
                <section class="block">
                  <h4>LLM spend</h4>
                  <div class="spend">
                    <div class="spend-track">
                      <div class="spend-fill" [style.width.%]="spendPct()" [class.hot]="spendPct() > 80"></div>
                    </div>
                    <span class="mono small"
                      >\${{ m.llmSpendUsd ?? 0 | number: '1.2-2' }}
                      @if (m.llmSpendCapUsd) {
                        of \${{ m.llmSpendCapUsd | number: '1.2-2' }} cap
                      }
                    </span>
                  </div>
                </section>
              }

              @if (outcome(); as o) {
                <section class="block">
                  <h4>Outcome</h4>
                  <p class="lead">
                    <span class="pill" [class.ok]="o.verdict === 'Fired'">{{ o.verdict }}</span>
                    {{ o.note }}
                  </p>
                </section>
              }

              @if ((m.maxActionTier ?? 0) >= 2) {
                <section class="tier2" [class.live]="!m.dryRunActions">
                  <h4>Authorised to change live state</h4>
                  <p class="mono small wrap">{{ m.actionAuthorizationJson }}</p>
                  <p class="small">
                    {{ m.dryRunActions ? 'Dry-run: it reports what it would do and changes nothing.' : 'ACTING FOR REAL on every fire.' }}
                  </p>
                  <button type="button" class="btn" (click)="action.emit('disarm')" [disabled]="busy()">Disarm actions</button>
                </section>
              }
            }

            @case ('timeline') {
              <div class="tl-tools">
                <div class="chips">
                  <button type="button" class="chip" [class.on]="kindFilter() === ''" (click)="kindFilter.set('')">
                    All <span class="c">{{ timeline().length }}</span>
                  </button>
                  @for (k of timelineKinds(); track k.key) {
                    <button
                      type="button"
                      class="chip"
                      [class.on]="kindFilter() === k.key"
                      [attr.data-kind]="k.key"
                      (click)="kindFilter.set(kindFilter() === k.key ? '' : k.key)"
                    >
                      {{ k.key }} <span class="c">{{ k.count }}</span>
                    </button>
                  }
                </div>
                <label class="check">
                  <input type="checkbox" [checked]="withHeartbeats()" (change)="withHeartbeats.set(!withHeartbeats())" />
                  routine checks
                </label>
              </div>
              @if (filteredTimeline().length === 0) {
                <p class="muted small">No history recorded{{ kindFilter() ? ' of this kind' : '' }}.</p>
              } @else {
                <ol class="timeline">
                  @for (e of filteredTimeline(); track e.id; let i = $index) {
                    @if (i === 0 || dayOf(e) !== dayOf(filteredTimeline()[i - 1])) {
                      <li class="tl-day">{{ e.occurredAtUtc | date: 'EEE, MMM d' : 'UTC' }}</li>
                    }
                    <li class="tl-row" [attr.data-kind]="e.kind">
                      <span class="tl-dot" [attr.data-kind]="e.kind"></span>
                      <span class="tl-when mono">{{ e.occurredAtUtc | date: 'HH:mm:ss' : 'UTC' }}</span>
                      <span class="tl-kind" [attr.data-kind]="e.kind">{{ e.kind }}</span>
                      <span class="tl-note">
                        {{ humanize(e.note) }}
                        @if (has(e.observedMid)) {
                          <span class="muted mono"> · mid {{ e.observedMid | number: '1.2-5' }}</span>
                        }
                        @if (e.generatedSignalIds) {
                          <span class="pill ok">signals {{ e.generatedSignalIds }}</span>
                        }
                        @if (e.resultLlmInvocationId) {
                          <a [routerLink]="['/conversations']" [queryParams]="{ conversation: e.resultLlmInvocationId }">analysis #{{ e.resultLlmInvocationId }}</a>
                        }
                        @if (e.actorUserId) {
                          <span class="muted"> · by {{ e.actorUserId }}</span>
                        }
                      </span>
                    </li>
                  }
                </ol>
                @if (det.timelineTotal > timeline().length) {
                  <p class="muted small">Showing the newest {{ timeline().length }} of {{ det.timelineTotal }} events.</p>
                }
              }
            }

            @case ('spec') {
              <section class="block">
                <div class="block-head">
                  <h4>Trigger</h4>
                  <button type="button" class="link" (click)="copy(m.triggerSpecJson)">copy</button>
                </div>
                @if (m.triggerExplanation) {
                  <p class="lead">{{ m.triggerExplanation }}</p>
                }
                @for (w of m.specWarnings ?? []; track w) {
                  <p class="warn-line">⚠ {{ w }}</p>
                }
                <pre class="code">{{ pretty(m.triggerSpecJson) }}</pre>
              </section>
              @if (m.invalidationSpecJson) {
                <section class="block">
                  <div class="block-head">
                    <h4>Invalidation (thesis break)</h4>
                    <button type="button" class="link" (click)="copy(m.invalidationSpecJson)">copy</button>
                  </div>
                  @if (m.invalidationExplanation) {
                    <p class="lead">{{ m.invalidationExplanation }}</p>
                  }
                  <pre class="code">{{ pretty(m.invalidationSpecJson) }}</pre>
                </section>
              }
              <section class="block">
                <div class="block-head">
                  <h4>Action</h4>
                  <button type="button" class="link" (click)="copy(m.actionSpecJson)">copy</button>
                </div>
                <pre class="code">{{ pretty(m.actionSpecJson) }}</pre>
              </section>
              @if (m.scriptSource) {
                <section class="block">
                  <div class="block-head">
                    <h4>Pine script</h4>
                    <button type="button" class="link" (click)="copy(m.scriptSource)">copy</button>
                  </div>
                  <pre class="code tall">{{ m.scriptSource }}</pre>
                </section>
              }
            }

            @case ('signals') {
              @if (det.signals.length === 0) {
                <p class="muted small">This monitor has not filed a signal.</p>
              } @else {
                <table class="mini-table">
                  <thead>
                    <tr>
                      <th>Signal</th>
                      <th>Side</th>
                      <th>Status</th>
                      <th class="num">Entry</th>
                      <th class="num">Stop</th>
                      <th class="num">Target</th>
                      <th class="num">Filed</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (s of det.signals; track s.id) {
                      <tr>
                        <td><a [routerLink]="['/trade-signals', s.id]">#{{ s.id }}</a></td>
                        <td><span class="pill dir" [class.buy]="s.direction === 'Buy'">{{ s.direction }}</span></td>
                        <td><span class="status" [attr.data-status]="s.status">{{ s.status }}</span></td>
                        <td class="num mono">{{ has(s.entryPrice) ? (s.entryPrice | number: '1.2-5') : '—' }}</td>
                        <td class="num mono">{{ has(s.stopLoss) ? (s.stopLoss | number: '1.2-5') : '—' }}</td>
                        <td class="num mono">{{ has(s.takeProfit) ? (s.takeProfit | number: '1.2-5') : '—' }}</td>
                        <td class="num muted">{{ s.createdAtUtc | date: 'MMM d HH:mm' : 'UTC' }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              }
            }

            @case ('lineage') {
              @if (det.lineage.length === 0) {
                <p class="muted small">An original watch: no parent, no re-armed successor.</p>
              } @else {
                <ol class="chain">
                  @for (l of chain(); track l.id) {
                    <li [class.self]="l.id === m.id">
                      <span class="chain-dot"></span>
                      <button type="button" class="link mono" [disabled]="l.id === m.id" (click)="openMonitor.emit(l.id)">#{{ l.id }}</button>
                      <span class="status" [attr.data-status]="l.status">{{ statusLabel(l.status) }}</span>
                      <span class="muted small">depth {{ l.rearmDepth }} · {{ l.createdAtUtc | date: 'MMM d HH:mm' : 'UTC' }}Z</span>
                      <span class="chain-intent">{{ l.intentText }}</span>
                    </li>
                  }
                </ol>
              }
            }
          }
        </div>
      } @else if (loading()) {
        <div class="d-loading">
          <div class="sk w40"></div>
          <div class="sk w90"></div>
          <div class="sk w70"></div>
          <div class="sk h160"></div>
        </div>
      } @else {
        <div class="d-loading">
          <p class="muted">Could not load monitor #{{ monitorId() }}.</p>
          <button type="button" class="btn" (click)="closed.emit()">Close</button>
        </div>
      }
    </aside>
  `,
  styles: [
    `
      .scrim {
        position: fixed;
        inset: 0;
        z-index: 1190;
        background: var(--backdrop-scrim, rgba(0, 0, 0, 0.18));
        animation: fade 160ms ease;
      }
      .drawer {
        position: fixed;
        top: 0;
        right: 0;
        bottom: 0;
        z-index: 1200;
        width: min(720px, 100vw);
        background: var(--bg-primary);
        border-left: 1px solid var(--border);
        box-shadow: var(--shadow-lg);
        display: flex;
        flex-direction: column;
        animation: slide 200ms var(--ease-out-soft, ease-out);
      }
      @keyframes slide {
        from {
          transform: translateX(24px);
          opacity: 0;
        }
      }
      @keyframes fade {
        from {
          opacity: 0;
        }
      }
      .d-head {
        padding: var(--space-4) var(--space-5) var(--space-3);
        border-bottom: 1px solid var(--border);
      }
      .d-title {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        flex-wrap: wrap;
      }
      .d-id {
        color: var(--text-tertiary);
        font-size: var(--text-sm);
      }
      .d-sym {
        font-size: var(--text-lg);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
      }
      .d-tf {
        color: var(--text-tertiary);
        font-size: var(--text-sm);
      }
      .spacer {
        flex: 1;
      }
      .icon-btn {
        width: 28px;
        height: 28px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: transparent;
        color: var(--text-secondary);
        cursor: pointer;
      }
      .icon-btn:hover {
        background: var(--bg-secondary);
        color: var(--text-primary);
      }
      .d-intent {
        margin: var(--space-2) 0 var(--space-3);
        font-size: var(--text-sm);
        color: var(--text-secondary);
        line-height: 1.45;
      }
      .life {
        margin-bottom: var(--space-3);
      }
      .life-track {
        position: relative;
        height: 6px;
        border-radius: 3px;
        background: var(--bg-tertiary);
      }
      .life-fill {
        height: 100%;
        border-radius: 3px;
        background: var(--accent);
      }
      .life-fill.ended {
        background: var(--text-tertiary);
      }
      .life-fire {
        position: absolute;
        top: -3px;
        width: 3px;
        height: 12px;
        border-radius: 2px;
        background: var(--text-primary);
        transform: translateX(-1px);
      }
      .life-legend {
        display: flex;
        justify-content: space-between;
        margin-top: 4px;
        font-size: 11px;
        color: var(--text-tertiary);
      }
      .life-legend b {
        color: var(--text-primary);
      }
      .life-legend b.imminent {
        color: var(--tone-amber);
      }
      .d-actions {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
      }
      .btn {
        height: 30px;
        padding: 0 12px;
        display: inline-flex;
        align-items: center;
        gap: 4px;
        border-radius: var(--radius-full);
        border: 1px solid var(--border);
        background: var(--bg-secondary);
        color: var(--text-primary);
        font: inherit;
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
        cursor: pointer;
        text-decoration: none;
        white-space: nowrap;
      }
      .btn:hover:not(:disabled) {
        background: var(--bg-tertiary);
      }
      .btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .btn.danger:hover:not(:disabled) {
        color: var(--tone-red);
        border-color: var(--tone-red);
      }
      .btn.warn {
        color: var(--tone-amber);
        border-color: color-mix(in srgb, var(--tone-amber) 50%, transparent);
      }
      .tabs {
        display: flex;
        gap: 2px;
        padding: 0 var(--space-5);
        border-bottom: 1px solid var(--border);
      }
      .tab {
        padding: 10px 12px;
        border: none;
        background: none;
        font: inherit;
        font-size: var(--text-sm);
        color: var(--text-secondary);
        border-bottom: 2px solid transparent;
        margin-bottom: -1px;
        cursor: pointer;
      }
      .tab.on {
        color: var(--text-primary);
        border-bottom-color: var(--accent);
        font-weight: var(--font-medium);
      }
      .tab-count {
        margin-left: 4px;
        padding: 0 6px;
        border-radius: var(--radius-full);
        background: var(--bg-tertiary);
        font-size: 11px;
        color: var(--text-secondary);
      }
      .d-body {
        flex: 1;
        overflow-y: auto;
        padding: var(--space-4) var(--space-5) var(--space-8);
      }
      .block {
        margin-bottom: var(--space-5);
      }
      .block-head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: var(--space-2);
      }
      h4 {
        margin: 0 0 var(--space-2);
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--text-tertiary);
        font-weight: var(--font-semibold);
      }
      .lead {
        margin: 0 0 var(--space-2);
        font-size: var(--text-sm);
        color: var(--text-primary);
        line-height: 1.5;
      }
      .note {
        margin: 4px 0;
        font-size: var(--text-xs);
        color: var(--text-secondary);
        line-height: 1.5;
      }
      .note-k {
        display: inline-block;
        min-width: 92px;
        color: var(--text-tertiary);
        font-weight: var(--font-medium);
      }
      .callout {
        padding: 8px 12px;
        border-radius: var(--radius-md);
        font-size: var(--text-xs);
        margin-bottom: var(--space-3);
        border: 1px solid transparent;
      }
      .callout.warn {
        color: var(--tone-amber);
        background: color-mix(in srgb, var(--tone-amber) 10%, transparent);
        border-color: color-mix(in srgb, var(--tone-amber) 30%, transparent);
      }
      .callout.err {
        color: var(--tone-red);
        background: color-mix(in srgb, var(--tone-red) 10%, transparent);
        border-color: color-mix(in srgb, var(--tone-red) 30%, transparent);
      }
      .callout.info {
        color: var(--tone-blue);
        background: color-mix(in srgb, var(--tone-blue) 10%, transparent);
        border-color: color-mix(in srgb, var(--tone-blue) 30%, transparent);
      }
      .ladder {
        list-style: none;
        margin: 0;
        padding: 0;
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
      }
      .ladder li {
        display: grid;
        grid-template-columns: 1fr auto 140px;
        gap: var(--space-3);
        padding: 6px 12px;
        font-size: var(--text-xs);
        border-bottom: 1px solid var(--border);
        border-left: 3px solid transparent;
        color: var(--text-secondary);
      }
      .ladder li:last-child {
        border-bottom: none;
      }
      .ladder li[data-kind='trigger'],
      .ladder li[data-kind='entry'] {
        border-left-color: #2a78d6;
      }
      .ladder li[data-kind='invalidation'],
      .ladder li[data-kind='stop'] {
        border-left-color: #eb6834;
      }
      .ladder li[data-kind='target'] {
        border-left-color: #1baf7a;
      }
      .ladder li.now {
        background: var(--bg-secondary);
        color: var(--text-primary);
        font-weight: var(--font-semibold);
        border-left-color: var(--text-primary);
      }
      .lad-price,
      .lad-dist {
        text-align: right;
      }
      .lad-dist {
        color: var(--text-tertiary);
      }
      .facts {
        display: grid;
        grid-template-columns: 130px 1fr;
        gap: 5px var(--space-3);
        margin: 0;
        font-size: var(--text-xs);
      }
      .facts dt {
        color: var(--text-tertiary);
      }
      .facts dd {
        margin: 0;
        color: var(--text-primary);
      }
      .spend {
        display: flex;
        align-items: center;
        gap: var(--space-3);
      }
      .spend-track {
        flex: 1;
        height: 8px;
        border-radius: 4px;
        background: var(--bg-tertiary);
        overflow: hidden;
      }
      .spend-fill {
        height: 100%;
        background: var(--accent);
      }
      .spend-fill.hot {
        background: var(--tone-amber);
      }
      .tier2 {
        padding: 10px 12px;
        border-left: 3px solid var(--tone-amber);
        background: var(--bg-secondary);
        border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
      }
      .tier2.live {
        border-left-color: var(--tone-red);
      }
      .wrap {
        word-break: break-all;
      }
      .code {
        margin: 0;
        padding: var(--space-3);
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        font-family: var(--font-mono, ui-monospace, monospace);
        font-size: 11.5px;
        line-height: 1.5;
        overflow: auto;
        max-height: 280px;
        white-space: pre;
        color: var(--text-primary);
      }
      .code.tall {
        max-height: 460px;
      }
      .warn-line {
        margin: 2px 0 6px;
        font-size: var(--text-xs);
        color: var(--tone-amber);
      }
      .link {
        background: none;
        border: none;
        padding: 0;
        color: var(--accent);
        cursor: pointer;
        font: inherit;
        font-size: var(--text-xs);
      }
      .link:disabled {
        color: var(--text-primary);
        cursor: default;
        font-weight: var(--font-semibold);
      }
      .tl-tools {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: var(--space-3);
        margin-bottom: var(--space-3);
      }
      .chips {
        display: flex;
        gap: 4px;
        flex-wrap: wrap;
      }
      .chip {
        padding: 2px 9px;
        border-radius: var(--radius-full);
        border: 1px solid var(--border);
        background: var(--bg-secondary);
        color: var(--text-secondary);
        font: inherit;
        font-size: 11px;
        cursor: pointer;
      }
      .chip .c {
        color: var(--text-tertiary);
        margin-left: 2px;
      }
      .chip.on {
        background: var(--text-primary);
        color: var(--bg-primary);
        border-color: var(--text-primary);
      }
      .chip.on .c {
        color: inherit;
        opacity: 0.7;
      }
      .check {
        display: inline-flex;
        gap: 4px;
        align-items: center;
        font-size: 11px;
        color: var(--text-tertiary);
        white-space: nowrap;
      }
      .timeline {
        list-style: none;
        margin: 0;
        padding: 0;
        font-size: var(--text-xs);
      }
      .tl-day {
        margin: var(--space-3) 0 4px;
        font-size: 11px;
        font-weight: var(--font-semibold);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      .tl-row {
        position: relative;
        display: grid;
        grid-template-columns: 10px 62px auto 1fr;
        gap: 8px;
        align-items: baseline;
        padding: 4px 0;
        border-bottom: 1px solid var(--border);
      }
      .tl-dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: var(--text-tertiary);
        align-self: center;
      }
      .tl-when {
        color: var(--text-tertiary);
      }
      .tl-note {
        color: var(--text-secondary);
        word-break: break-word;
        line-height: 1.45;
      }
      .tl-note a {
        margin-left: 4px;
        color: var(--accent);
      }
      .tl-kind {
        padding: 0 6px;
        border-radius: var(--radius-sm);
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        white-space: nowrap;
        font-size: 11px;
      }
      [data-kind='Fired'].tl-kind,
      [data-kind='Fired'].chip:not(.on) {
        color: var(--tone-green);
        background: color-mix(in srgb, var(--tone-green) 14%, transparent);
      }
      [data-kind='Fired'].tl-dot {
        background: var(--tone-green);
      }
      [data-kind='Invalidated'].tl-kind,
      [data-kind='EvalError'].tl-kind {
        color: var(--tone-red);
        background: color-mix(in srgb, var(--tone-red) 14%, transparent);
      }
      [data-kind='Invalidated'].tl-dot,
      [data-kind='EvalError'].tl-dot {
        background: var(--tone-red);
      }
      [data-kind='Touched'].tl-kind,
      [data-kind='Rearmed'].tl-kind,
      [data-kind='ScriptStep'].tl-kind {
        color: var(--tone-blue);
        background: color-mix(in srgb, var(--tone-blue) 14%, transparent);
      }
      [data-kind='Touched'].tl-dot,
      [data-kind='Rearmed'].tl-dot,
      [data-kind='ScriptStep'].tl-dot {
        background: var(--tone-blue);
      }
      [data-kind='Suppressed'].tl-kind,
      [data-kind='RearmRefused'].tl-kind,
      [data-kind='Escalated'].tl-kind {
        color: var(--tone-amber);
        background: color-mix(in srgb, var(--tone-amber) 14%, transparent);
      }
      [data-kind='Evaluated'].tl-row {
        opacity: 0.7;
      }
      .mini-table {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-xs);
      }
      .mini-table th {
        text-align: left;
        color: var(--text-tertiary);
        font-weight: var(--font-medium);
        padding: 4px 6px;
        border-bottom: 1px solid var(--border);
      }
      .mini-table td {
        padding: 6px;
        border-bottom: 1px solid var(--border);
        color: var(--text-secondary);
      }
      .mini-table .num {
        text-align: right;
      }
      .mini-table a {
        color: var(--accent);
      }
      .chain {
        list-style: none;
        margin: 0;
        padding: 0 0 0 6px;
        border-left: 2px solid var(--border);
      }
      .chain li {
        position: relative;
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
        padding: 6px 0 6px 14px;
        font-size: var(--text-xs);
      }
      .chain-dot {
        position: absolute;
        left: -6px;
        top: 11px;
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: var(--bg-primary);
        border: 2px solid var(--text-tertiary);
      }
      .chain li.self .chain-dot {
        border-color: var(--accent);
        background: var(--accent);
      }
      .chain-intent {
        flex-basis: 100%;
        color: var(--text-secondary);
      }
      .pill {
        display: inline-block;
        padding: 0 7px;
        border-radius: var(--radius-full);
        font-size: 11px;
        font-weight: var(--font-medium);
        background: var(--bg-tertiary);
        color: var(--text-secondary);
      }
      .pill.ok {
        color: var(--tone-green);
        background: color-mix(in srgb, var(--tone-green) 14%, transparent);
      }
      .pill.dir {
        color: var(--tone-red);
        background: color-mix(in srgb, var(--tone-red) 14%, transparent);
      }
      .pill.dir.buy {
        color: var(--tone-green);
        background: color-mix(in srgb, var(--tone-green) 14%, transparent);
      }
      .status {
        display: inline-block;
        padding: 1px 8px;
        border-radius: var(--radius-full);
        font-size: 11px;
        font-weight: var(--font-medium);
        background: var(--bg-tertiary);
        color: var(--text-secondary);
      }
      .status[data-status='Active'],
      .status[data-status='Executed'] {
        color: var(--tone-green);
        background: color-mix(in srgb, var(--tone-green) 14%, transparent);
      }
      .status[data-status='Paused'] {
        color: var(--tone-amber);
        background: color-mix(in srgb, var(--tone-amber) 14%, transparent);
      }
      .status[data-status='Triggered'] {
        color: var(--tone-blue);
        background: color-mix(in srgb, var(--tone-blue) 14%, transparent);
      }
      .status[data-status='Invalidated'],
      .status[data-status='Error'],
      .status[data-status='Rejected'] {
        color: var(--tone-red);
        background: color-mix(in srgb, var(--tone-red) 14%, transparent);
      }
      .mono {
        font-family: var(--font-mono, ui-monospace, monospace);
        font-variant-numeric: tabular-nums;
      }
      .muted {
        color: var(--text-tertiary);
      }
      .small {
        font-size: var(--text-xs);
      }
      .d-loading {
        padding: var(--space-6) var(--space-5);
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .sk {
        height: 14px;
        border-radius: 6px;
        background: var(--bg-secondary);
        animation: pulse 1.2s ease-in-out infinite;
      }
      .sk.w40 {
        width: 40%;
        height: 22px;
      }
      .sk.w90 {
        width: 90%;
      }
      .sk.w70 {
        width: 70%;
      }
      .sk.h160 {
        height: 160px;
      }
      @keyframes pulse {
        50% {
          opacity: 0.5;
        }
      }
    `,
  ],
})
export class MonitorDetailDrawerComponent {
  /** Template null-check: the lint rule forbids `!= null` in templates, and `!== null` alone misses undefined. */
  protected has(v: unknown): boolean {
    return v !== null && v !== undefined;
  }

  private readonly svc = inject(AnalysisMonitorsService);
  private readonly theme = inject(ThemeService);

  readonly monitorId = input.required<number>();
  /** Bumped by the page when a push or an action says this monitor changed. */
  readonly refreshKey = input(0);
  readonly busy = input(false);

  readonly closed = output<void>();
  readonly action = output<MonitorDrawerAction>();
  /** Open another monitor (lineage). */
  readonly openMonitor = output<number>();
  /** Walk the board: -1 previous, +1 next. */
  readonly step = output<number>();
  /** The loaded detail, so the page's verbs act on fresh data and the assistant sees what is open. */
  readonly loaded = output<AnalysisMonitorDetail>();

  protected readonly tab = signal<Tab>('overview');
  protected readonly detail = signal<AnalysisMonitorDetail | null>(null);
  protected readonly loading = signal(false);
  protected readonly withHeartbeats = signal(false);
  protected readonly kindFilter = signal('');

  /** Heartbeat-inclusive history, used only for the price trace. */
  private readonly trace = signal<AnalysisMonitorActivity[]>([]);
  protected readonly traceLoading = signal(false);

  private lastId: number | null = null;

  constructor() {
    effect(() => {
      const id = this.monitorId();
      this.refreshKey();
      const hb = this.withHeartbeats();
      untracked(() => {
        const switched = id !== this.lastId;
        this.lastId = id;
        if (switched) {
          this.detail.set(null);
          this.trace.set([]);
          this.kindFilter.set('');
        }
        this.load(id, hb, switched);
      });
    });
  }

  private load(id: number, heartbeats: boolean, withTrace: boolean): void {
    this.loading.set(true);
    this.svc
      .getDetail(id, heartbeats, 300)
      .pipe(catchError(() => of(null)))
      .subscribe((res) => {
        if (this.monitorId() !== id) return;
        this.loading.set(false);
        const d = res?.status && res.data ? res.data : null;
        this.detail.set(d);
        if (d) this.loaded.emit(d);
      });
    // The trace reloads on every refresh too: a new check is a new point.
    this.traceLoading.set(withTrace);
    this.svc
      .getDetail(id, true, 1000)
      .pipe(catchError(() => of(null)))
      .subscribe((res) => {
        if (this.monitorId() !== id) return;
        this.traceLoading.set(false);
        this.trace.set(res?.status && res.data ? res.data.timeline : []);
      });
  }

  // ── Derived ───────────────────────────────────────────────────────────────

  protected readonly tabs = computed(() => {
    const d = this.detail();
    return [
      { key: 'overview' as Tab, label: 'Overview', count: null },
      { key: 'timeline' as Tab, label: 'Timeline', count: d?.timelineTotal ?? null },
      { key: 'spec' as Tab, label: 'Spec', count: null },
      { key: 'signals' as Tab, label: 'Signals', count: d?.signals.length ?? null },
      { key: 'lineage' as Tab, label: 'Lineage', count: d?.lineage.length ?? null },
    ];
  });

  protected readonly timeline = computed(() => this.detail()?.timeline ?? []);

  protected readonly timelineKinds = computed(() => {
    const counts = new Map<string, number>();
    for (const e of this.timeline()) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
    return [...counts.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);
  });

  protected readonly filteredTimeline = computed(() => {
    const k = this.kindFilter();
    return k ? this.timeline().filter((e) => e.kind === k) : this.timeline();
  });

  protected readonly life = computed(() => {
    const m = this.detail()?.monitor;
    return m ? { pct: lifeProgress(m) * 100 } : null;
  });

  /** Fire positions on the life bar, from the heartbeat-inclusive trace (which carries every fire). */
  protected readonly fireMarks = computed(() => {
    const m = this.detail()?.monitor;
    if (!m) return [];
    const a = Date.parse(m.createdAtUtc + (m.createdAtUtc.endsWith('Z') ? '' : 'Z'));
    const b = Date.parse(m.expiresAtUtc + (m.expiresAtUtc.endsWith('Z') ? '' : 'Z'));
    const src = this.trace().length ? this.trace() : this.timeline();
    return src
      .filter((e) => e.fired)
      .map((e) => {
        const t = Date.parse(e.occurredAtUtc + (e.occurredAtUtc.endsWith('Z') ? '' : 'Z'));
        return Math.min(100, Math.max(0, ((t - a) / Math.max(1, b - a)) * 100));
      });
  });

  protected readonly cooldownLeft = computed(() => {
    const u = this.detail()?.monitor.cooldownUntilUtc;
    if (!u) return 0;
    return Math.max(0, (Date.parse(u + (u.endsWith('Z') ? '' : 'Z')) - Date.now()) / 1000);
  });

  protected readonly spendPct = computed(() => {
    const m = this.detail()?.monitor;
    if (!m?.llmSpendCapUsd) return 0;
    return Math.min(100, ((m.llmSpendUsd ?? 0) / m.llmSpendCapUsd) * 100);
  });

  protected readonly outcome = computed(() => {
    const json = this.detail()?.monitor.outcomeJson;
    if (!json) return null;
    try {
      const o = JSON.parse(json) as { verdict?: string; note?: string };
      return o.verdict ? { verdict: o.verdict, note: o.note ?? '' } : null;
    } catch {
      return null;
    }
  });

  /** Lineage, oldest first, with this monitor placed in it. */
  protected readonly chain = computed(() => {
    const d = this.detail();
    if (!d) return [];
    const self = {
      id: d.monitor.id,
      status: d.monitor.status,
      intentText: d.monitor.intentText,
      rearmDepth: d.monitor.rearmDepth ?? 0,
      createdAtUtc: d.monitor.createdAtUtc,
      relation: 'self',
    };
    return [...d.lineage.filter((l) => l.relation === 'parent'), self, ...d.lineage.filter((l) => l.relation === 'successor')];
  });

  /** Levels sorted high → low, with the last observed price slotted in where it sits. */
  protected readonly ladder = computed(() => {
    const m = this.detail()?.monitor;
    if (!m) return [];
    const levels: AnalysisMonitorLevel[] = m.levels ?? [];
    if (levels.length === 0) return [];
    const price = m.lastObservedPrice ?? null;
    const rows = levels.map((l, i) => ({
      key: `${l.kind}-${i}`,
      kind: l.kind,
      label: l.label,
      price: l.price,
      isPrice: false,
      dist: price != null ? levelDistance(price, l.price, m) : '',
    }));
    if (price != null) rows.push({ key: 'now', kind: 'now', label: 'Price now', price, isPrice: true, dist: '' });
    return rows.sort((a, b) => b.price - a.price);
  });

  protected readonly tracePoints = computed(() => this.trace().filter((e) => e.observedMid != null).length);

  protected readonly traceOptions = computed<EChartsOption>(() => {
    const m = this.detail()?.monitor;
    const dark = this.theme.theme() === 'dark';
    const ink = dark ? '#c3c2b7' : '#52514e';
    const muted = '#898781';
    const grid = dark ? '#2c2c2a' : '#e1e0d9';
    const surface = dark ? '#1a1a19' : '#fcfcfb';
    const line = dark ? '#9ec5f4' : '#256abf';
    const pts = this.trace()
      .filter((e) => e.observedMid != null)
      .map((e) => ({ t: Date.parse(e.occurredAtUtc + (e.occurredAtUtc.endsWith('Z') ? '' : 'Z')), e }))
      .sort((a, b) => a.t - b.t);
    if (!m || pts.length === 0) return {};
    const markers = Object.entries(MARKER_KINDS).map(([kind, meta]) => ({
      name: meta.label,
      type: 'scatter' as const,
      symbol: meta.symbol,
      symbolSize: 10,
      z: 6,
      itemStyle: { color: ink, borderColor: surface, borderWidth: 2 },
      data: pts.filter((p) => p.e.kind === kind).map((p) => [p.t, p.e.observedMid, p.e.note ?? '']),
    }));
    const levelLines = (m.levels ?? []).map((l) => {
      const st = LEVEL_STYLE[l.kind] ?? LEVEL_STYLE['trigger'];
      return {
        yAxis: l.price,
        name: l.label,
        lineStyle: { color: dark ? st.dark : st.light, type: st.dash, width: 1.5 },
        label: { formatter: l.label, color: ink, fontSize: 10, position: 'insideEndTop' as const },
      };
    });
    const all = [...pts.map((p) => p.e.observedMid as number), ...(m.levels ?? []).map((l) => l.price)];
    const lo = Math.min(...all);
    const hi = Math.max(...all);
    const pad = (hi - lo) * 0.08 || hi * 0.0005;
    return {
      animationDuration: 250,
      grid: { top: 26, right: 12, bottom: 24, left: 62, containLabel: false },
      legend: {
        top: 0,
        right: 0,
        itemWidth: 9,
        itemHeight: 9,
        textStyle: { color: ink, fontSize: 10 },
        data: markers.filter((s) => s.data.length > 0).map((s) => s.name),
      },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross', label: { show: false } },
        formatter: (raw) => {
          const arr = (Array.isArray(raw) ? raw : [raw]) as unknown as { seriesName?: string; data: [number, number, string] }[];
          const first = arr[0];
          if (!first) return '';
          const when = new Date(first.data[0]).toISOString().slice(5, 19).replace('T', ' ');
          const lines = arr.map(
            (p) => `${p.seriesName === 'Mid' ? 'mid' : p.seriesName}: <b>${p.data[1]}</b>${p.data[2] && p.seriesName !== 'Mid' ? '<br/><span style="opacity:.75">' + String(p.data[2]).slice(0, 120) + '</span>' : ''}`,
          );
          return `${when}Z<br/>${lines.join('<br/>')}`;
        },
      },
      xAxis: {
        type: 'time',
        axisLine: { lineStyle: { color: grid } },
        axisLabel: { color: muted, fontSize: 10, hideOverlap: true },
        splitLine: { show: false },
      },
      yAxis: {
        type: 'value',
        scale: true,
        min: lo - pad,
        max: hi + pad,
        splitLine: { lineStyle: { color: grid } },
        axisLabel: { color: muted, fontSize: 10, formatter: (v: number) => v.toFixed(hi > 50 ? 2 : 5) },
      },
      series: [
        {
          name: 'Mid',
          type: 'line',
          step: 'end',
          showSymbol: false,
          lineStyle: { width: 1.5, color: line },
          data: pts.map((p) => [p.t, p.e.observedMid, '']),
          markLine: levelLines.length ? { symbol: 'none', silent: true, data: levelLines } : undefined,
        },
        ...markers.filter((s) => s.data.length > 0),
      ],
    };
  });

  // ── Helpers ───────────────────────────────────────────────────────────────

  protected statusLabel(s: string): string {
    return s === 'Triggered' ? 'Fired' : s;
  }
  protected dayOf(e: AnalysisMonitorActivity): string {
    return e.occurredAtUtc.slice(0, 10);
  }
  protected age(s: number): string {
    return formatAge(s);
  }
  protected countdown(s: number): string {
    return formatCountdown(s);
  }
  protected humanize(n: string | null | undefined): string {
    return humanizeNote(n);
  }
  protected pretty(j: string | null | undefined): string {
    return prettyJson(j);
  }
  protected copy(text: string | null | undefined): void {
    if (text) void navigator.clipboard?.writeText(text);
  }
}
