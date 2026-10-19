import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { DatePipe, DecimalPipe, Location, PercentPipe } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { toSignal, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subscription, auditTime, filter, interval, map } from 'rxjs';

import { TradeRecommendationsService } from '@core/services/trade-recommendations.service';
import { LlmService } from '@core/services/llm.service';
import { NotificationService } from '@core/notifications/notification.service';
import { RealtimeService, RealtimeEventName } from '@core/realtime/realtime.service';
import type { LlmInvocationDetailDto } from '@core/api/api.types';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import {
  SpotRecChartComponent,
  SpotRecChartLevel,
  SpotRecChartMarker,
  SpotRecChartRec,
} from '@shared/components/spot-rec-chart/spot-rec-chart.component';
import { MarkdownPipe } from '@shared/pipes/markdown.pipe';
import { RecommendationCardComponent } from '../../components/recommendation-card/recommendation-card.component';
import { RecMonitorComponent } from '../../components/rec-monitor/rec-monitor.component';
import { RecExecutionComponent } from '../../components/rec-execution/rec-execution.component';
import { RecTimelineComponent } from '../../components/rec-timeline/rec-timeline.component';
import {
  REC_SOURCE_LABELS,
  TradeRecommendationDetailDto,
  recFormatPrice,
  recOutcomeView,
  recParseJson,
  recPips,
  recPrettyJson,
  recSplitReason,
  recTriggerText,
} from '../../trade-recommendations.types';

/** The `recommend` tool's arguments as the analyst wrote them. Every field is optional. */
interface RecommendArgs {
  entryBasis?: string;
  stopBasis?: string;
  targetBasis?: string;
  invalidation?: string | number | { price?: number; note?: string; reason?: string };
  invalidationPrice?: number;
  conviction?: string;
  orderType?: string;
  /** `trigger` is prose OR the monitor spec DSL object — render it with recTriggerText. */
  watch?: { trigger?: unknown; confirmOn?: string; expiresInHours?: number; [k: string]: unknown };
  oco?: string | boolean | Record<string, unknown>;
  [k: string]: unknown;
}

const REFRESH_ON: readonly RealtimeEventName[] = [
  'tradeSignalCreated',
  'orderCreated',
  'orderFilled',
  'positionOpened',
  'positionClosed',
  'analysisMonitorFired',
  'analysisMonitorChanged',
  'analysisMonitorInvalidated',
];

/**
 * Everything about one recommendation card on one page: the trade on a chart, why the analyst
 * wrote it (and in what words, in reply to what), why it is in its status, the plan it mirrors,
 * every monitor armed to file it and what each did, its OCO partners and the other cards from the
 * same analysis, what it became at the broker, and the timeline across all of it.
 */
@Component({
  selector: 'app-recommendation-detail-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    DecimalPipe,
    PercentPipe,
    RouterLink,
    PageHeaderComponent,
    ErrorStateComponent,
    CardSkeletonComponent,
    ConfirmDialogComponent,
    SpotRecChartComponent,
    MarkdownPipe,
    RecommendationCardComponent,
    RecMonitorComponent,
    RecExecutionComponent,
    RecTimelineComponent,
  ],
  styleUrls: ['../../rec-shared.scss', './recommendation-detail-page.component.scss'],
  template: `
    <div class="page">
      <app-page-header [title]="'Recommendation #' + (recId() ?? '—')" [subtitle]="subtitle()">
        <span slot="title-after" class="head-chips">
          @if (detail(); as d) {
            <span class="pill mono">{{ d.card.symbol }} · {{ d.card.timeframe }}</span>
            <span
              class="pill"
              [class.pill--buy]="d.card.direction === 'Buy'"
              [class.pill--sell]="d.card.direction === 'Sell'"
            >
              {{ d.card.direction === 'Buy' ? '↑' : '↓' }} {{ d.card.direction }} {{ orderKind() }}
            </span>
            <span class="pill" [class]="'pill pill--' + statusTone()">{{ d.card.status }}</span>
            <span class="pill" [class]="'pill pill--' + outcome().tone">{{ outcome().label }}</span>
          }
        </span>
        @if (detail(); as d) {
          @if (canFile()) {
            <button class="btn btn--primary" type="button" (click)="dialog.set('file')">
              File now
            </button>
          }
          @if (canArm()) {
            <button class="btn" type="button" (click)="dialog.set('arm')">Arm monitor</button>
          }
          @if (d.card.llmInvocationId) {
            <a
              class="btn"
              [routerLink]="['/conversations']"
              [queryParams]="{ conversation: d.card.llmInvocationId }"
            >
              Conversation ↗
            </a>
          }
        }
        <!-- back() returns to wherever the operator came from (a conversation,
             a monitor…), so the label says Back rather than promising the list. -->
        <button class="btn" type="button" (click)="back()" title="Back to the previous page">
          ← Back
        </button>
      </app-page-header>

      <app-confirm-dialog
        [open]="dialog() === 'file'"
        title="File this card now"
        [message]="
          'File recommendation #' +
          (recId() ?? '') +
          ' as a signal now? It goes through the normal risk gates and is refused if it is no longer the trade it was (already filed, overtaken by price, too old, or refused by a gate).'
        "
        confirmLabel="File now"
        [loading]="acting()"
        (confirm)="fileNow()"
        (cancelled)="dialog.set(null)"
      />
      <app-confirm-dialog
        [open]="dialog() === 'arm'"
        title="Arm a monitor for this card"
        message="Arm a monitor that files this card when price comes near its entry (0.5 ATR short of it by default), so it rests at the broker before the touch."
        confirmLabel="Arm monitor"
        [loading]="acting()"
        (confirm)="armMonitor()"
        (cancelled)="dialog.set(null)"
      >
        <div class="arm-opts">
          <label>
            <input
              type="radio"
              name="arm-mode"
              [checked]="armMode() === 'direct'"
              (change)="armMode.set('direct')"
            />
            <strong>Direct</strong> — file the stored card as written when price arrives.
          </label>
          <label>
            <input
              type="radio"
              name="arm-mode"
              [checked]="armMode() === 'confirm'"
              (change)="armMode.set('confirm')"
            />
            <strong>Confirm</strong> — re-check the plan with a fresh analysis first.
          </label>
          <label class="hours">
            Expires in
            <input
              type="number"
              min="1"
              max="168"
              [value]="armHours()"
              (input)="armHours.set(+$any($event.target).value || 24)"
            />
            hours
          </label>
        </div>
      </app-confirm-dialog>

      @if (recId() === null) {
        <p class="empty-line">Invalid recommendation id.</p>
      } @else if (loading()) {
        <app-card-skeleton [lines]="8" />
        <app-card-skeleton [lines]="6" />
      } @else if (error() && !detail()) {
        <app-error-state
          title="Could not load this recommendation"
          [message]="error()"
          (retry)="load()"
        />
      } @else if (detail(); as d) {
        @let c = d.card;

        <!-- Chart -->
        @if (canChart()) {
          <section class="panel">
            <div class="panel-head">
              <h2>Chart</h2>
              <span class="muted small">
                {{ c.symbol }} · {{ c.timeframe }} · written
                {{ c.createdAtUtc | date: 'MMM d, HH:mm' : 'UTC' }} UTC
              </span>
            </div>
            <app-spot-rec-chart
              [symbol]="c.symbol"
              [timeframe]="c.timeframe || 'H1'"
              [asOfUtc]="c.createdAtUtc"
              [recommendations]="chartRecs()"
              [levels]="chartLevels()"
              [fillMarker]="fillMarker()"
              [exitMarker]="exitMarker()"
              [live]="isLive()"
            />
          </section>
        }

        <div class="cols">
          <div class="col">
            <!-- The trade -->
            <section class="panel">
              <div class="panel-head">
                <h2>The trade</h2>
                <span class="muted small">{{ sourceLabel() }}</span>
              </div>
              <div class="levels">
                <div class="lvl">
                  <span class="lbl">Entry</span>
                  <span class="val mono">{{ price(c.entryPrice) }}</span>
                  <span class="sub muted">{{ orderKind() || 'Market' }} order</span>
                </div>
                <div class="lvl">
                  <span class="lbl">Stop</span>
                  <span class="val mono loss">{{ price(c.stopLoss) }}</span>
                  <span class="sub mono muted">{{ pips(c.entryPrice, c.stopLoss) }} risk</span>
                </div>
                <div class="lvl">
                  <span class="lbl">Target</span>
                  <span class="val mono profit">{{ price(c.takeProfit) }}</span>
                  <span class="sub mono muted">{{ pips(c.entryPrice, c.takeProfit) }} reward</span>
                </div>
                <div class="lvl">
                  <span class="lbl">Reward : risk</span>
                  <span class="val mono">{{
                    c.rewardRisk !== null ? (c.rewardRisk | number: '1.2-2') : '—'
                  }}</span>
                </div>
                <div class="lvl">
                  <span class="lbl">Confidence</span>
                  <span class="val mono">{{
                    c.confidence !== null ? (c.confidence | percent: '1.0-0') : '—'
                  }}</span>
                  @if (c.conviction) {
                    <span class="sub muted">{{ c.conviction }} conviction</span>
                  }
                </div>
              </div>
              <dl class="kv">
                <dt>Written</dt>
                <dd>{{ c.createdAtUtc | date: 'MMM d y, HH:mm:ss' : 'UTC' }} UTC</dd>
                <dt>Last change</dt>
                <dd>{{ c.updatedAtUtc | date: 'MMM d y, HH:mm:ss' : 'UTC' }} UTC</dd>
                <dt>Status</dt>
                <dd>
                  <span class="pill" [class]="'pill pill--' + statusTone()">{{ c.status }}</span>
                  @if (reason(); as r) {
                    <div class="reason" [class.loss]="c.status === 'Rejected'">
                      @if (r.code) {
                        <span class="code mono">{{ r.code }}</span>
                      }
                      {{ r.detail }}
                    </div>
                  }
                </dd>
                <dt>Ids</dt>
                <dd class="ids">
                  @if (c.llmInvocationId) {
                    <a
                      class="pill pill--link mono"
                      [routerLink]="['/conversations']"
                      [queryParams]="{ conversation: c.llmInvocationId }"
                      >analysis #{{ c.llmInvocationId }}</a
                    >
                  }
                  @if (c.spotAnalysisFollowUpId) {
                    <span class="pill mono">turn #{{ c.spotAnalysisFollowUpId }}</span>
                  }
                  @if (c.patientTraderPlanId) {
                    <a class="pill pill--link mono" routerLink="/patient-trader"
                      >plan #{{ c.patientTraderPlanId }}</a
                    >
                  }
                  @if (c.analysisMonitorId) {
                    <a
                      class="pill pill--link mono"
                      [routerLink]="['/analysis-monitors']"
                      [queryParams]="{ focus: c.analysisMonitorId }"
                      >origin monitor #{{ c.analysisMonitorId }}</a
                    >
                  }
                  @if (c.tradeSignalId) {
                    <a
                      class="pill pill--link mono"
                      [routerLink]="['/trade-signals', c.tradeSignalId]"
                      >signal #{{ c.tradeSignalId }}</a
                    >
                  }
                  @if (c.pendingSignalRecId) {
                    <a class="pill pill--link mono" routerLink="/pending-signal-recs"
                      >parked #{{ c.pendingSignalRecId }}</a
                    >
                  }
                  @if (c.ocoGroupId) {
                    <span class="pill pill--warn mono">OCO {{ c.ocoGroupId }}</span>
                  }
                </dd>
              </dl>
            </section>

            <!-- Why -->
            <section class="panel">
              <div class="panel-head"><h2>Why</h2></div>
              @if (c.rationale) {
                <p class="prose">{{ c.rationale }}</p>
              } @else {
                <p class="empty-line">The analysis gave no rationale.</p>
              }
              @if (args(); as a) {
                <dl class="kv working">
                  @if (a.entryBasis) {
                    <dt>Entry basis</dt>
                    <dd>{{ a.entryBasis }}</dd>
                  }
                  @if (a.stopBasis) {
                    <dt>Stop basis</dt>
                    <dd>{{ a.stopBasis }}</dd>
                  }
                  @if (a.targetBasis) {
                    <dt>Target basis</dt>
                    <dd>{{ a.targetBasis }}</dd>
                  }
                  @if (invalidationText(); as inv) {
                    <dt>Invalidation</dt>
                    <dd>{{ inv }}</dd>
                  }
                  @if (a.watch; as w) {
                    <dt>Watch</dt>
                    <dd>
                      @if (w.trigger) {
                        <div><span class="muted">trigger</span> {{ triggerText(w.trigger) }}</div>
                      }
                      @if (w.confirmOn) {
                        <div><span class="muted">confirm on</span> {{ w.confirmOn }}</div>
                      }
                      @if (w.expiresInHours) {
                        <div><span class="muted">expires in</span> {{ w.expiresInHours }}h</div>
                      }
                    </dd>
                  }
                  @if (a.oco) {
                    <dt>OCO</dt>
                    <dd class="mono">{{ ocoText() }}</dd>
                  }
                </dl>
              }
            </section>

            <!-- Patient Trader plan -->
            @if (d.plan; as p) {
              <section class="panel">
                <div class="panel-head">
                  <h2>
                    Patient Trader plan
                    <a class="pill pill--link mono" routerLink="/patient-trader">#{{ p.id }} ↗</a>
                  </h2>
                  <span class="pill">{{ p.status }}</span>
                </div>
                <p class="prose">{{ p.thesis }}</p>
                <dl class="kv">
                  <dt>Entry style</dt>
                  <dd>{{ p.entryStyle }}</dd>
                  <dt>Levels</dt>
                  <dd class="mono">
                    {{ price(p.entryPrice) }} · SL {{ price(p.stopLoss) }} · TP
                    {{ price(p.takeProfit) }}
                  </dd>
                  <dt>R:R · stop</dt>
                  <dd class="mono">
                    {{ p.rewardRisk | number: '1.2-2' }} ·
                    {{ p.stopAtrMultiple | number: '1.2-2' }}× ATR ({{ price(p.atrAtPlan) }})
                  </dd>
                  <dt>Entry basis</dt>
                  <dd>{{ p.entryBasis }}</dd>
                  <dt>Stop basis</dt>
                  <dd>{{ p.stopBasis }}</dd>
                  <dt>Target basis</dt>
                  <dd>{{ p.targetBasis }}</dd>
                  @if (p.invalidationNote || p.invalidationPrice !== null) {
                    <dt>Invalidation</dt>
                    <dd>
                      @if (p.invalidationPrice !== null) {
                        <span class="mono">{{ price(p.invalidationPrice) }}</span>
                      }
                      {{ p.invalidationNote ?? '' }}
                    </dd>
                  }
                  @if (p.preMortem) {
                    <dt>Pre-mortem</dt>
                    <dd>{{ p.preMortem }}</dd>
                  }
                  <dt>Conviction</dt>
                  <dd>
                    {{ p.conviction }} · {{ p.confidence | percent: '1.0-0'
                    }}{{ p.observeOnly ? ' · observe only' : '' }}
                  </dd>
                  @if (p.rejectionCode || p.rejectionReason) {
                    <dt>Refused</dt>
                    <dd class="loss">
                      @if (p.rejectionCode) {
                        <span class="code mono">{{ p.rejectionCode }}</span>
                      }
                      {{ p.rejectionReason ?? '' }}
                    </dd>
                  }
                  <dt>Lifecycle</dt>
                  <dd class="small">
                    drafted {{ p.createdAtUtc | date: 'MMM d, HH:mm' : 'UTC' }}
                    @if (p.armedAtUtc) {
                      · armed {{ p.armedAtUtc | date: 'MMM d, HH:mm' : 'UTC' }}
                    }
                    @if (p.filledAtUtc) {
                      · filled {{ p.filledAtUtc | date: 'MMM d, HH:mm' : 'UTC' }}
                    }
                    @if (p.settledAtUtc) {
                      · settled {{ p.settledAtUtc | date: 'MMM d, HH:mm' : 'UTC' }}
                    }
                    · expires {{ p.expiresAtUtc | date: 'MMM d, HH:mm' : 'UTC' }} UTC
                  </dd>
                </dl>
                @if (p.outcomeJson) {
                  <details>
                    <summary>Settlement</summary>
                    <pre class="code">{{ pretty(p.outcomeJson) }}</pre>
                  </details>
                }
              </section>
            }

            <!-- Conversation -->
            @if (d.question || d.answer || d.chatTurn) {
              <section class="panel">
                <div class="panel-head">
                  <h2>Conversation</h2>
                  @if (c.llmInvocationId) {
                    <a
                      class="pill pill--link"
                      [routerLink]="['/conversations']"
                      [queryParams]="{ conversation: c.llmInvocationId }"
                    >
                      Open the full conversation ↗
                    </a>
                  }
                </div>
                @if (d.question; as q) {
                  <div class="turn turn--user">
                    <div class="turn-head muted">
                      Operator · {{ q.createdAtUtc | date: 'MMM d, HH:mm' : 'UTC' }} UTC
                    </div>
                    <div class="md" [innerHTML]="q.content | markdown"></div>
                  </div>
                }
                @if (d.chatTurn; as t) {
                  <div class="turn turn--tool">
                    <div class="turn-head muted">
                      {{ t.toolName ?? t.role }} call ·
                      {{ t.createdAtUtc | date: 'MMM d, HH:mm:ss' : 'UTC' }} UTC
                      @if (t.actionStatus) {
                        · {{ t.actionStatus }}
                      }
                    </div>
                    <details>
                      <summary>Arguments the analyst sent</summary>
                      <pre class="code">{{ pretty(t.toolArgsJson) }}</pre>
                    </details>
                    @if (t.toolResultJson) {
                      <details>
                        <summary>What the engine returned</summary>
                        <pre class="code">{{ pretty(t.toolResultJson) }}</pre>
                      </details>
                    }
                  </div>
                }
                @if (d.answer; as a) {
                  <div class="turn turn--assistant">
                    <div class="turn-head muted">
                      Assistant · {{ a.createdAtUtc | date: 'MMM d, HH:mm' : 'UTC' }} UTC
                    </div>
                    <div class="md" [innerHTML]="a.content | markdown"></div>
                    @if (a.contentTruncated) {
                      <p class="muted small">Trimmed — the full answer is in the conversation.</p>
                    }
                  </div>
                }
              </section>
            }
          </div>

          <div class="col">
            <!-- Timeline -->
            <section class="panel">
              <div class="panel-head">
                <h2>Timeline</h2>
                <span class="muted small">{{ d.timeline.length }} events</span>
              </div>
              <app-rec-timeline [events]="d.timeline" />
            </section>

            <!-- Analysis -->
            @if (d.analysis; as an) {
              <section class="panel">
                <div class="panel-head">
                  <h2>Analysis #{{ an.id }}</h2>
                  <span
                    class="pill"
                    [class.pill--good]="analysisOk(an.outcome)"
                    [class.pill--bad]="!analysisOk(an.outcome)"
                    >{{ an.outcome }}</span
                  >
                </div>
                <dl class="kv">
                  <dt>Purpose</dt>
                  <dd class="mono">{{ an.purpose }}</dd>
                  <dt>Model</dt>
                  <dd>
                    {{ an.resolvedModel ?? an.model }}
                    <span class="muted"
                      >· {{ an.provider
                      }}{{
                        an.resolvedModel && an.resolvedModel !== an.model
                          ? ' · alias ' + an.model
                          : ''
                      }}</span
                    >
                  </dd>
                  @if (an.promptVersion) {
                    <dt>Prompt version</dt>
                    <dd class="mono">{{ an.promptVersion }}</dd>
                  }
                  <dt>Invoked</dt>
                  <dd>
                    {{ an.invokedAt | date: 'MMM d y, HH:mm:ss' : 'UTC' }} UTC ·
                    {{ an.latencyMs | number }} ms
                  </dd>
                  <dt>Tokens</dt>
                  <dd class="mono">
                    {{ an.tokensInput | number }} in · {{ an.tokensOutput | number }} out
                  </dd>
                  <dt>Cost</dt>
                  <dd class="mono">
                    \${{ an.costUsd | number: '1.2-4' }}
                    @if (an.followUpCalls > 0) {
                      <span class="muted"
                        >+ \${{ an.followUpCostUsd | number: '1.2-4' }} over
                        {{ an.followUpCalls }} follow-up calls</span
                      >
                    }
                  </dd>
                  @if (an.conversationTurns > 0) {
                    <dt>Conversation</dt>
                    <dd>{{ an.conversationTurns }} turns</dd>
                  }
                  @if (an.errorMessage) {
                    <dt>Error</dt>
                    <dd class="loss">{{ an.errorMessage }}</dd>
                  }
                </dl>
                <details (toggle)="onRawToggle($any($event.target).open)">
                  <summary>Raw request and response</summary>
                  @if (rawLoading()) {
                    <p class="muted small">Loading…</p>
                  } @else if (raw(); as r) {
                    <h4 class="raw-h">Request</h4>
                    <pre class="code">{{ r.requestBody ?? '(none recorded)' }}</pre>
                    <h4 class="raw-h">Response</h4>
                    <pre class="code">{{ pretty(r.responseBody) || '(none recorded)' }}</pre>
                  } @else if (rawError(); as e) {
                    <p class="loss small">{{ e }}</p>
                  }
                </details>
              </section>
            }
          </div>
        </div>

        <!-- Monitors -->
        <section class="panel">
          <div class="panel-head">
            <h2>
              Monitors
              <span class="muted count">{{ d.monitors.length + (d.originMonitor ? 1 : 0) }}</span>
            </h2>
            <span class="muted small">Every monitor armed to file this card, newest first.</span>
          </div>
          @if (d.originMonitor; as om) {
            <app-rec-monitor [monitor]="om" [symbol]="c.symbol" role="Wrote this card" />
          }
          @for (m of d.monitors; track m.id) {
            <app-rec-monitor [monitor]="m" [symbol]="c.symbol" />
          }
          @if (d.monitors.length === 0 && !d.originMonitor) {
            <p class="empty-line">No monitor was armed for this card.</p>
          }
        </section>

        <!-- OCO -->
        @if (d.ocoLegs.length > 0) {
          <section class="panel">
            <div class="panel-head">
              <h2>One-cancels-other partners</h2>
              <span class="muted small"
                >Whichever fires first files its card; the others stand down.</span
              >
            </div>
            <div class="mini-grid">
              @for (leg of d.ocoLegs; track $index) {
                <div class="leg">
                  <div class="leg-head muted small">
                    <span class="mono">{{ leg.ocoGroupId }}</span>
                    @if (leg.monitorId) {
                      ·
                      <a
                        [routerLink]="['/analysis-monitors']"
                        [queryParams]="{ focus: leg.monitorId }"
                        >monitor #{{ leg.monitorId }}</a
                      >
                      {{ leg.monitorStatus ?? '' }}
                    }
                    @if (leg.planId) {
                      · plan #{{ leg.planId }}
                    }
                  </div>
                  @if (leg.card) {
                    <app-recommendation-card [card]="leg.card" [compact]="true" />
                  } @else {
                    <p class="empty-line">No stored card on this leg.</p>
                  }
                </div>
              }
            </div>
          </section>
        }

        <!-- Execution -->
        <section class="panel">
          <div class="panel-head">
            <h2>What it became</h2>
            @if (!d.signal && !d.pendingRec) {
              <span class="muted small">Never filed as a signal.</span>
            }
          </div>
          @if (d.signal || d.pendingRec) {
            <app-rec-execution [symbol]="c.symbol" [signal]="d.signal" [pending]="d.pendingRec" />
          } @else {
            <p class="empty-line">{{ neverFiledText() }}</p>
          }
        </section>

        <!-- Siblings -->
        @if (d.siblings.length > 0) {
          <section class="panel">
            <div class="panel-head">
              <h2>
                Other cards from this analysis
                <span class="muted count">{{ d.siblings.length }}</span>
              </h2>
            </div>
            <div class="mini-grid">
              @for (s of d.siblings; track s.id) {
                <app-recommendation-card [card]="s" [compact]="true" />
              }
            </div>
          </section>
        }

        <details class="panel raw-all">
          <summary>Raw detail payload</summary>
          <button class="btn btn--sm" type="button" (click)="copyJson()">Copy JSON</button>
          <pre class="code">{{ json() }}</pre>
        </details>
      }
    </div>
  `,
})
export class RecommendationDetailPageComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly location = inject(Location);
  private readonly router = inject(Router);
  private readonly service = inject(TradeRecommendationsService);
  private readonly llm = inject(LlmService);
  private readonly notifications = inject(NotificationService);
  private readonly realtime = inject(RealtimeService, { optional: true });
  private readonly destroyRef = inject(DestroyRef);

  readonly recId = toSignal(
    this.route.paramMap.pipe(
      map((p) => {
        const n = Number(p.get('id'));
        return Number.isInteger(n) && n > 0 ? n : null;
      }),
    ),
    { initialValue: null as number | null },
  );

  readonly detail = signal<TradeRecommendationDetailDto | null>(null);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);

  readonly dialog = signal<'file' | 'arm' | null>(null);
  readonly acting = signal(false);
  readonly armMode = signal<'direct' | 'confirm'>('direct');
  readonly armHours = signal(24);

  readonly raw = signal<LlmInvocationDetailDto | null>(null);
  readonly rawLoading = signal(false);
  readonly rawError = signal<string | null>(null);

  private sub: Subscription | null = null;

  readonly card = computed(() => this.detail()?.card ?? null);

  /** A watch trigger as text — the DSL object printed "[object Object]". */
  triggerText(trigger: unknown): string {
    return recTriggerText(trigger);
  }
  readonly outcome = computed(() => recOutcomeView(this.card()?.outcome ?? ''));
  readonly sourceLabel = computed(() => {
    const c = this.card();
    return c ? (REC_SOURCE_LABELS[c.source] ?? c.source) : '';
  });
  readonly subtitle = computed(() => {
    const c = this.card();
    if (!c) return 'A trade card an analysis wrote, and everything that followed from it.';
    return `${this.sourceLabel()} card${c.analysisModel ? ' by ' + c.analysisModel : ''}, written ${new Date(
      c.createdAtUtc,
    ).toUTCString()}.`;
  });
  /** "SellLimit" → "Limit"; the direction is already shown beside it. */
  readonly orderKind = computed(() => (this.card()?.orderType ?? '').replace(/^(Buy|Sell)/, ''));

  readonly reason = computed(() => {
    const c = this.card();
    return c?.statusReason ? recSplitReason(c.statusReason) : null;
  });
  readonly statusTone = computed(() => {
    switch (this.card()?.status) {
      case 'Filed':
        return 'good';
      case 'Rejected':
        return 'bad';
      case 'Withdrawn':
      case 'Expired':
        return 'warn';
      case 'Parked':
        return 'info';
      default:
        return 'neutral';
    }
  });

  /** Filing is the engine's call (it refuses anything stale); offer it whenever nothing was filed yet. */
  readonly canFile = computed(() => {
    const c = this.card();
    return !!c && !c.tradeSignalId && ['Proposed', 'Rejected', 'Expired'].includes(c.status);
  });
  readonly canArm = computed(() => {
    const c = this.card();
    return (
      !!c &&
      !c.tradeSignalId &&
      !c.watchingMonitorId &&
      ['Proposed', 'Rejected', 'Expired'].includes(c.status)
    );
  });

  readonly args = computed<RecommendArgs | null>(() =>
    recParseJson<RecommendArgs>(this.detail()?.chatTurn?.toolArgsJson),
  );

  readonly invalidationText = computed(() => {
    const a = this.args();
    if (!a) return null;
    const inv = a.invalidation;
    const parts: string[] = [];
    if (typeof inv === 'number') parts.push(this.price(inv));
    else if (typeof inv === 'string') parts.push(inv);
    else if (inv && typeof inv === 'object') {
      if (inv.price != null) parts.push(this.price(inv.price));
      if (inv.note) parts.push(inv.note);
      if (inv.reason) parts.push(inv.reason);
    }
    if (a.invalidationPrice != null) parts.push(this.price(a.invalidationPrice));
    return parts.length ? parts.join(' — ') : null;
  });

  readonly ocoText = computed(() => {
    const o = this.args()?.oco;
    if (o == null) return '';
    return typeof o === 'object' ? JSON.stringify(o) : String(o);
  });

  readonly neverFiledText = computed(() => {
    const c = this.card();
    if (!c) return '';
    if (c.watchingMonitorId)
      return `Waiting — monitor #${c.watchingMonitorId} will file it when its condition is met.`;
    switch (c.status) {
      case 'Rejected':
        return 'A gate refused it, so no signal was created. The reason is under "The trade".';
      case 'Withdrawn':
        return 'The analyst withdrew it before it was filed.';
      case 'Expired':
        return 'It expired before it was filed.';
      default:
        return 'It has not been filed. Use "File now" or "Arm monitor" to act on it.';
    }
  });

  readonly canChart = computed(() => {
    const c = this.card();
    return !!c && !!c.symbol && c.entryPrice != null;
  });

  readonly chartRecs = computed<SpotRecChartRec[]>(() => {
    const c = this.card();
    if (!c) return [];
    return [
      {
        label: `#${c.id} ${c.direction}`,
        action: c.direction === 'Buy' ? 'Buy' : 'Sell',
        entryPrice: c.entryPrice,
        stopLoss: c.stopLoss,
        takeProfit: c.takeProfit,
      },
    ];
  });

  readonly chartLevels = computed<SpotRecChartLevel[]>(() => {
    const d = this.detail();
    const out: SpotRecChartLevel[] = [];
    const inv = d?.plan?.invalidationPrice ?? this.invalidationPriceFromArgs();
    if (inv != null) out.push({ price: inv, label: `INVALID ${this.price(inv)}`, tone: 'neutral' });
    const sig = d?.signal;
    if (
      sig?.originalTakeProfit != null &&
      sig.takeProfit != null &&
      sig.originalTakeProfit !== sig.takeProfit
    ) {
      out.push({
        price: sig.takeProfit,
        label: `SIGNAL TP ${this.price(sig.takeProfit)}`,
        tone: 'up',
        muted: true,
      });
    }
    return out;
  });

  readonly fillMarker = computed<SpotRecChartMarker | null>(() => {
    const p = this.detail()?.signal?.positions?.[0];
    return p
      ? { time: p.openedAt, price: p.averageEntryPrice, label: 'Filled', kind: 'fill' }
      : null;
  });

  readonly exitMarker = computed<SpotRecChartMarker | null>(() => {
    const p = this.detail()?.signal?.positions?.find((x) => x.closedAt && x.closePrice != null);
    if (!p || !p.closedAt || p.closePrice == null) return null;
    return {
      time: p.closedAt,
      price: p.closePrice,
      label: `Closed ${p.realizedPnL >= 0 ? '+' : ''}${p.realizedPnL.toFixed(2)}`,
      kind: p.realizedPnL >= 0 ? 'tp' : 'sl',
    };
  });

  /** Stream live prices while the card can still move: not yet acted on, or a position is open. */
  readonly isLive = computed(() => {
    const c = this.card();
    return (
      !!c &&
      (c.openPositionCount > 0 || (!c.tradeSignalId && ['Proposed', 'Parked'].includes(c.status)))
    );
  });

  readonly json = computed(() => JSON.stringify(this.detail(), null, 2));

  constructor() {
    effect(() => {
      const id = this.recId();
      untracked(() => {
        this.detail.set(null);
        this.raw.set(null);
        this.loading.set(true);
        if (id != null) this.fetch(id);
      });
    });

    interval(30_000)
      .pipe(
        filter(() => document.visibilityState === 'visible'),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => this.load());

    this.realtime?.events$
      .pipe(
        filter((m) => REFRESH_ON.includes(m.name)),
        auditTime(1_500),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => this.load());

    this.destroyRef.onDestroy(() => this.sub?.unsubscribe());
  }

  load(): void {
    const id = this.recId();
    if (id != null) this.fetch(id);
  }

  private fetch(id: number): void {
    this.sub?.unsubscribe();
    this.sub = this.service.detail(id).subscribe({
      next: (res) => {
        this.loading.set(false);
        if (res?.status && res.data) {
          this.error.set(null);
          this.detail.set(res.data);
        } else {
          this.error.set(res?.message ?? 'Recommendation not found.');
        }
      },
      error: (err) => {
        this.loading.set(false);
        this.error.set(err?.error?.message ?? err?.message ?? 'Request failed.');
      },
    });
  }

  back(): void {
    // Return to the list with its filters when we came from it; otherwise open the list fresh.
    if (window.history.length > 1) this.location.back();
    else void this.router.navigate(['/trade-recommendations']);
  }

  fileNow(): void {
    const id = this.recId();
    if (id == null) return;
    this.acting.set(true);
    this.service.file(id).subscribe({
      next: (res) => {
        this.acting.set(false);
        this.dialog.set(null);
        if (res?.status) {
          this.notifications.success(`Recommendation #${id} filed as signal #${res.data}.`);
        } else {
          this.notifications.error(res?.message ?? 'The engine refused to file it.');
        }
        this.load();
      },
      error: (err) => {
        this.acting.set(false);
        this.notifications.error(err?.error?.message ?? 'Failed to file the recommendation.');
      },
    });
  }

  armMonitor(): void {
    const id = this.recId();
    if (id == null) return;
    this.acting.set(true);
    this.service
      .armMonitor(id, { mode: this.armMode(), expiresInHours: this.armHours() })
      .subscribe({
        next: (res) => {
          this.acting.set(false);
          this.dialog.set(null);
          if (res?.status && res.data) {
            this.notifications.success(`Monitor #${res.data.id} armed for recommendation #${id}.`);
          } else {
            this.notifications.error(res?.message ?? 'The engine refused to arm a monitor.');
          }
          this.load();
        },
        error: (err) => {
          this.acting.set(false);
          this.notifications.error(err?.error?.message ?? 'Failed to arm the monitor.');
        },
      });
  }

  onRawToggle(open: boolean): void {
    const inv = this.card()?.llmInvocationId;
    if (!open || inv == null || this.raw() || this.rawLoading()) return;
    this.rawLoading.set(true);
    this.rawError.set(null);
    this.llm.invocationDetail(inv).subscribe({
      next: (res) => {
        this.rawLoading.set(false);
        if (res?.status && res.data) this.raw.set(res.data);
        else this.rawError.set(res?.message ?? 'Not available.');
      },
      error: (err) => {
        this.rawLoading.set(false);
        this.rawError.set(err?.error?.message ?? 'Failed to load the raw invocation.');
      },
    });
  }

  copyJson(): void {
    void navigator.clipboard?.writeText(this.json()).then(
      () => this.notifications.success('Copied the detail JSON.'),
      () => this.notifications.error('Could not copy to the clipboard.'),
    );
  }

  price(v: number | null | undefined): string {
    return recFormatPrice(this.card()?.symbol ?? '', v);
  }

  pips(a: number | null, b: number | null): string {
    const p = recPips(this.card()?.symbol ?? '', a, b);
    return p == null ? '—' : `${p}p`;
  }

  analysisOk(outcome: string): boolean {
    return outcome === 'Ok' || outcome === 'Success';
  }

  pretty(s: string | null | undefined): string {
    return recPrettyJson(s);
  }

  private invalidationPriceFromArgs(): number | null {
    const a = this.args();
    if (!a) return null;
    if (typeof a.invalidationPrice === 'number') return a.invalidationPrice;
    if (typeof a.invalidation === 'number') return a.invalidation;
    if (
      a.invalidation &&
      typeof a.invalidation === 'object' &&
      typeof a.invalidation.price === 'number'
    ) {
      return a.invalidation.price;
    }
    return null;
  }
}
