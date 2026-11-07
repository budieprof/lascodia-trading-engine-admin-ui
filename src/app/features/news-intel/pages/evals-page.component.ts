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
import { DatePipe } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { NewsIntelService } from '@core/services/news-intel.service';
import { AuthService } from '@core/auth/auth.service';
import { Permission } from '@core/auth/permissions.generated';
import { createPolledResource } from '@core/polling/polled-resource';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { FeatureStateComponent } from '@shared/components/feedback/feature-state.component';
import { errorText } from '@features/iam/iam.logic';
import { NewsIntelNavComponent } from '../components/news-intel-nav.component';
import {
  NiInfoComponent,
  NiKeyComponent,
  NiMeterComponent,
  NiPanelComponent,
  NiStatComponent,
} from '../components/viz/ni-primitives';
import {
  MeterPart,
  NiF1StripComponent,
  NiRunBarsComponent,
  NiStackMeterComponent,
  RunScore,
} from '../components/viz/ni-tabs-c';
import {
  EvalMetrics,
  draftCaveat,
  evalRunActive,
  fmt,
  parseEvalMetrics,
  pct,
} from '../news-intel.logic';
import {
  NEWS_CATEGORIES,
  NEWS_CERTAINTIES,
  NEWS_DIRECTIONS,
  NEWS_STANCES,
  NewsEvalRunView,
  NewsGoldEditRequest,
  NewsGoldLabelView,
  NewsGoldProvenance,
} from '../news-intel.types';

const PAGE = 50;

type Pending = { kind: 'seed' } | { kind: 'run' };

/**
 * Gold set & evals — the labelling queue the classifier is judged against (agent drafts → operator
 * confirmed / edited) and the evaluation runs that judge it (per-field accuracy / F1, run-to-run
 * agreement, triage precision / recall).
 *
 * The shipped seed is AGENT-labelled from headline + summary; every draft says so and every score
 * graded against drafts carries that caveat. Confirm / edit / seed / run need `platform.data.manage`.
 */
@Component({
  selector: 'app-news-evals-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    NewsIntelNavComponent,
    ConfirmDialogComponent,
    FeatureStateComponent,
    NiInfoComponent,
    NiKeyComponent,
    NiMeterComponent,
    NiPanelComponent,
    NiStatComponent,
    NiF1StripComponent,
    NiRunBarsComponent,
    NiStackMeterComponent,
  ],
  styleUrls: ['../news-intel-shared.scss'],
  template: `
    <div class="page">
      <header class="page-head">
        <div class="title">
          <h1>Gold set &amp; evaluations</h1>
          <app-ni-info
            text="A labelled sample the classifier is scored against. Prompt or model changes are judged by re-running the evaluation, not by eye. The shipped seed is agent-labelled from headline + summary — every score graded against drafts carries that caveat."
          />
        </div>
      </header>
      <app-news-intel-nav
        [showRefresh]="true"
        [refreshing]="runs.refreshing()"
        (refresh)="runs.refresh(); loadGold()"
      />

      @if (error(); as e) {
        <div class="banner error">{{ e }}</div>
      }
      @if (notice(); as n) {
        <div class="banner info">{{ n }}</div>
      }

      <!-- ── KPI strip ── -->
      <div class="ni-kpis k8">
        <app-ni-stat
          label="Gold labels"
          [value]="goldTotal()"
          [sub]="goldTotal() === '—' ? null : provSummary()"
          info="Article × exposure labels the classifier is graded against. Agent drafts await an operator's confirm or edit."
        />
        <app-ni-stat
          label="Reviewed"
          [value]="reviewedPct()"
          [sub]="reviewedSub()"
          [tone]="reviewedTone()"
          info="Share of gold labels an operator has confirmed or edited. Until this is high, scores are version-vs-version, not absolute."
        />
        <app-ni-stat label="Relevance F1" [value]="kv('rel')" [spark]="series('rel')" sparkKind="line" [sub]="kSub('rel')" info="Did the classifier keep/skip the right articles (pass 1 of the latest completed run)? Line = across runs." />
        <app-ni-stat label="Exposure F1" [value]="kv('exp')" [spark]="series('exp')" sparkKind="line" [sub]="kSub('exp')" info="Did it tag the right exposure keys (article × key pairs)?" />
        <app-ni-stat label="Category F1" [value]="kv('cat')" [spark]="series('cat')" sparkKind="line" [sub]="kSub('cat')" info="Macro F1 over event categories, on pairs where both sides labelled the key." />
        <app-ni-stat label="Direction F1" [value]="kv('dir')" [spark]="series('dir')" sparkKind="line" [sub]="kSub('dir')" info="Macro F1 over Bullish / Bearish / Neutral." />
        <app-ni-stat label="Certainty F1" [value]="kv('cer')" [spark]="series('cer')" sparkKind="line" [sub]="kSub('cer')" [tone]="rumorZero() ? 'warn' : null" info="Macro F1 over Official / Confirmed / Reported / Rumor. A Rumor F1 of 0 means rumours are weighted like reported news." />
        <app-ni-stat label="Agreement" [value]="kv('agr')" [spark]="series('agr')" sparkKind="line" [sub]="kSub('agr')" info="Run-to-run agreement when the same articles are classified twice — the classifier's own consistency ceiling." />
      </div>

      <!-- ── Scores by run | Runs ── -->
      <div class="ev-grid">
        <app-ni-panel
          title="Scores by run"
          info="One small multiple per field, oldest run left. Dashed line = 0.80; bars under it are amber. Click a bar to open that run."
        >
          <span meta>{{ completedRuns().length }} completed run(s)</span>
          @if (completedRuns().length) {
            <div class="multiples">
              @for (m of multiples(); track m.label) {
                <app-ni-run-bars
                  [label]="m.label"
                  [runs]="m.runs"
                  [selected]="detail()?.id ?? null"
                  [percent]="m.percent"
                  (pick)="openById($event)"
                />
              }
            </div>
          } @else {
            <p class="empty">No completed evaluation yet. Seed the gold set, then run one to record the baseline.</p>
          }
        </app-ni-panel>

        <app-ni-panel
          title="Runs"
          info="A run classifies the gold articles with the CURRENT configuration (one model call per batch per pass, on the classification provider's quota, shared with spot analysis) and scores it. One run at a time."
          [flush]="true"
        >
          @if (canManage()) {
            <div actions class="ni-toolbar">
              <span class="seg" role="group" aria-label="Passes">
                <button type="button" [class.on]="repeats() === 1" (click)="repeats.set(1)">1 pass</button>
                <button type="button" [class.on]="repeats() === 2" (click)="repeats.set(2)">2 · agreement</button>
              </span>
              <label class="chk"><input type="checkbox" [checked]="reviewedOnly()" (change)="reviewedOnly.set(!reviewedOnly())" /> reviewed only</label>
              <button type="button" class="btn primary" [disabled]="busy() || anyRunning()" (click)="pending.set({ kind: 'run' })">
                {{ anyRunning() ? 'Run in progress…' : 'Run evaluation' }}
              </button>
            </div>
          }
          @if (runs.value(); as list) {
            <div class="table-wrap runs-wrap">
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Started</th>
                    <th>Status</th>
                    <th class="num">Arts</th>
                    <th class="num">Rel</th>
                    <th class="num">Cat</th>
                    <th class="num">Dir</th>
                    <th class="num">Agree</th>
                  </tr>
                </thead>
                <tbody>
                  @for (r of list; track r.id) {
                    <tr class="clickable" (click)="openRun(r)" [class.sel]="detail()?.id === r.id">
                      <td class="mono">{{ r.id }}</td>
                      <td class="faint nowrap" [title]="(r.classifierModel ?? '—') + ' · ' + (r.promptVersion ?? '') + ' · triage ' + (r.triageMode ?? '—')">{{ r.startedAtUtc | date: 'MMM d HH:mm' : 'UTC' }}</td>
                      <td>
                        <span class="pill" [class.ok]="r.status === 'Completed'" [class.bad]="r.status === 'Failed' || r.status === 'Abandoned'" [class.info]="r.status === 'Running'">{{ r.status }}</span>
                      </td>
                      <td class="num" [title]="r.draftLabelCount ? r.draftLabelCount + ' unreviewed draft labels' : ''">
                        {{ r.articleCount }}@if (r.draftLabelCount) {<span class="faint">ᵈ</span>}
                      </td>
                      <td class="num">{{ f(r.relevanceF1, 2) }}</td>
                      <td class="num">{{ f(r.categoryMacroF1, 2) }}</td>
                      <td class="num">{{ f(r.directionMacroF1, 2) }}</td>
                      <td class="num">{{ p(r.runToRunAgreement) }}</td>
                    </tr>
                  } @empty {
                    <tr>
                      <td colspan="8" class="empty pad">No evaluation has run yet. Seed the gold set, then run one.</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </app-ni-panel>
      </div>

      <!-- ── Selected run ── -->
      @if (detail(); as d) {
        <app-ni-panel [title]="'Run #' + d.id" info="Pass 1 per-class F1 below (lightest = weakest, red outline = never right), then every pass's scores and the run-to-run agreement.">
          <span meta>{{ d.classifierModel ?? '—' }} · {{ d.promptVersion ?? '—' }} · triage {{ d.triageMode ?? '—' }} · {{ d.startedAtUtc | date: 'MMM d HH:mm' : 'UTC' }}</span>
          @if (d.error) {
            <div class="banner error">{{ d.error }}</div>
          }
          @if (metrics(); as m) {
            @if (caveat(); as c) {
              <div class="banner warn">{{ c }}</div>
            }
            <div class="keys-line">
              <span class="faint">{{ m.reviewedOnly ? 'reviewed labels only' : 'all labels' }} · tracked:</span>
              @for (k of m.trackedKeys; track k) {
                <app-ni-key [key]="k" [short]="true" />
              } @empty {
                <span class="faint">—</span>
              }
            </div>
            @if (m.passes[0]; as p1) {
              <div class="ni-grid-3">
                <app-ni-f1-strip label="Category" [perClass]="p1.category?.perClassF1 ?? {}" [macro]="p1.category?.macroF1 ?? null" />
                <app-ni-f1-strip label="Direction" [perClass]="p1.direction?.perClassF1 ?? {}" [macro]="p1.direction?.macroF1 ?? null" />
                <app-ni-f1-strip label="Certainty" [perClass]="p1.certainty?.perClassF1 ?? {}" [macro]="p1.certainty?.macroF1 ?? null" />
              </div>
            }
            <div class="detail-col">
              <div class="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Pass</th>
                      <th class="num">Verdicts</th>
                      <th class="num">Rel P / R / F1</th>
                      <th class="num">Exp P / R</th>
                      <th class="num">Cat acc / F1</th>
                      <th class="num">Dir acc / F1</th>
                      <th class="num">Cer acc / F1</th>
                      <th class="num">Rel MAE</th>
                      <th class="num">Stance</th>
                      <th class="num">Same-event P / R</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (ps of m.passes; track $index) {
                      <tr>
                        <td>{{ $index + 1 }}</td>
                        <td class="num">{{ ps.articlesWithVerdict }} / {{ ps.articles }}</td>
                        <td class="num">{{ f(ps.relevance?.precision, 2) }} / {{ f(ps.relevance?.recall, 2) }} / <b>{{ f(ps.relevance?.f1, 2) }}</b></td>
                        <td class="num">{{ f(ps.exposurePairs?.precision, 2) }} / {{ f(ps.exposurePairs?.recall, 2) }}</td>
                        <td class="num">{{ f(ps.category?.accuracy, 2) }} / <b>{{ f(ps.category?.macroF1, 2) }}</b></td>
                        <td class="num">{{ f(ps.direction?.accuracy, 2) }} / <b>{{ f(ps.direction?.macroF1, 2) }}</b></td>
                        <td class="num">{{ f(ps.certainty?.accuracy, 2) }} / <b>{{ f(ps.certainty?.macroF1, 2) }}</b></td>
                        <td class="num">{{ f(ps.relevanceMae, 3) }}</td>
                        <td class="num">{{ p(ps.stanceAccuracy) }}</td>
                        <td class="num">{{ f(ps.sameEventPairs?.precision, 2) }} / {{ f(ps.sameEventPairs?.recall, 2) }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
              @if (m.agreement; as a) {
                <div class="agree">
                  <div class="agree-h">Run-to-run agreement <span class="faint">· {{ a.articles }} articles</span></div>
                  @for (row of agreementRows(a); track row.k) {
                    <div class="agree-r">
                      <span>{{ row.k }}</span>
                      <app-ni-meter [value]="row.v" [label]="p(row.v)" [tone]="row.v !== null && row.v < 0.8 ? 'warn' : 'ok'" />
                    </div>
                  }
                </div>
              }
            </div>
            @if (m.triage; as t) {
              <p class="xsmall muted">
                Triage <b>{{ t.mode }}</b>: precision {{ f(t.precision, 2) }} · recall {{ f(t.recall, 2) }} · {{ t.screenedOut }} screened out
                <app-ni-info text="Leave triage Off until recall ≥ ~0.97 — a triage that drops a relevant article loses it for good." />
              </p>
            }
          } @else if (d.status === 'Running') {
            <p class="empty">Running… the page checks every 15 seconds.</p>
          } @else if (!d.error) {
            <p class="empty">No metrics recorded for this run.</p>
          }
        </app-ni-panel>
      }

      <!-- ── Gold labels ── -->
      <app-ni-panel
        title="Gold labels"
        info="Agent drafts were labelled by an agent from headline + summary and need an operator's confirmation or edit. Confirm = the draft is right; Edit = correct it (saved as Edited)."
        [flush]="true"
      >
        <span meta>{{ gold()?.total ?? 0 }} in view</span>
        <div actions class="ni-toolbar">
          <select class="sel" aria-label="Provenance" (change)="setProvenance($any($event.target).value)">
            <option value="AgentDraft" selected>Awaiting review</option>
            <option value="OperatorConfirmed">Confirmed</option>
            <option value="OperatorEdited">Edited</option>
            <option value="">All</option>
          </select>
          <input class="inp mono key-in" placeholder="Exposure key" aria-label="Exposure key" (change)="setExposure($any($event.target).value)" />
          @if (canManage()) {
            <button type="button" class="btn" [disabled]="busy()" (click)="pending.set({ kind: 'seed' })">Seed from fixture</button>
          }
        </div>
        @if (provParts().length) {
          <div class="prov"><app-ni-stack-meter [parts]="provParts()" /></div>
        }

        @if (gold(); as g) {
          @if (g.total === 0 && !provenance() && !exposure()) {
            <div class="prov">
              <app-feature-state
                kind="off"
                title="The gold set is empty"
                summary="Seed it from the shipped fixture (299 articles, agent-drafted from headline + summary). Seeding is idempotent and never overwrites a review."
                [requirements]="[{ label: 'platform.data.manage to seed', ok: canManage() }]"
              />
            </div>
          }
          <div class="table-wrap gold-wrap">
            <table class="gold">
              <thead>
                <tr>
                  <th>Article</th>
                  <th>Key</th>
                  <th>Rel?</th>
                  <th>Category</th>
                  <th>Direction</th>
                  <th>Certainty</th>
                  <th class="num">Relevance</th>
                  <th>Stance · event</th>
                  <th>Provenance</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                @for (l of g.items; track l.id) {
                  @if (editing()?.id === l.id) {
                    <tr class="row-detail">
                      <td class="art">
                        <span class="ttl">{{ l.title }}</span>
                        <span class="faint xs">{{ l.sourceName }}</span>
                      </td>
                      <td><app-ni-key [key]="l.exposureKey" /></td>
                      <td>
                        <select class="sel" (change)="patch({ relevant: $any($event.target).value === 'true' })">
                          <option value="true" [selected]="l.relevant">yes</option>
                          <option value="false" [selected]="!l.relevant">no</option>
                        </select>
                      </td>
                      <td>
                        <select class="sel" (change)="patch({ category: $any($event.target).value })">
                          @for (c of categories; track c) {
                            <option [value]="c" [selected]="c === l.category">{{ c }}</option>
                          }
                        </select>
                      </td>
                      <td>
                        <select class="sel" (change)="patch({ direction: $any($event.target).value })">
                          @for (c of directions; track c) {
                            <option [value]="c" [selected]="c === l.direction">{{ c }}</option>
                          }
                        </select>
                      </td>
                      <td>
                        <select class="sel" (change)="patch({ certainty: $any($event.target).value })">
                          @for (c of certainties; track c) {
                            <option [value]="c" [selected]="c === l.certainty">{{ c }}</option>
                          }
                        </select>
                      </td>
                      <td class="num">
                        <input class="inp num-in" type="number" min="0" max="1" step="0.05" [value]="l.relevance" (change)="patch({ relevance: +$any($event.target).value })" />
                      </td>
                      <td>
                        <div class="stack">
                          <select class="sel" (change)="patch({ stance: $any($event.target).value })">
                            @for (c of stances; track c) {
                              <option [value]="c" [selected]="c === l.stance">{{ c }}</option>
                            }
                          </select>
                          <input class="inp mono" placeholder="event key" [value]="l.eventKey ?? ''" (change)="patch({ eventKey: $any($event.target).value })" />
                        </div>
                      </td>
                      <td colspan="2">
                        <div class="stack">
                          <input class="inp" placeholder="note (optional)" [value]="l.note ?? ''" (change)="patch({ note: $any($event.target).value })" />
                          <div class="ni-toolbar">
                            <button type="button" class="btn primary" [disabled]="busy()" (click)="saveEdit(l)">Save</button>
                            <button type="button" class="btn subtle" (click)="editing.set(null)">Cancel</button>
                          </div>
                        </div>
                      </td>
                    </tr>
                  } @else {
                    <tr>
                      <td class="art">
                        <span class="ttl" [title]="l.title">{{ l.title }}</span>
                        <span class="faint xs">#{{ l.articleId }} · {{ l.sourceName }} · {{ l.firstSeenUtc | date: 'MMM d HH:mm' : 'UTC' }}</span>
                      </td>
                      <td><app-ni-key [key]="l.exposureKey" /></td>
                      <td [class.faint]="!l.relevant">{{ l.relevant ? 'yes' : 'no' }}</td>
                      <td>{{ l.category }}</td>
                      <td>
                        <span class="dir" [class.pos]="l.direction === 'Bullish'" [class.neg]="l.direction === 'Bearish'">{{ l.direction === 'Bullish' ? '▲' : l.direction === 'Bearish' ? '▼' : '●' }}</span>
                        {{ l.direction }}
                      </td>
                      <td [class.rumor]="l.certainty === 'Rumor'">{{ l.certainty }}</td>
                      <td class="num" style="min-width: 90px"><app-ni-meter [value]="l.relevance" [label]="f(l.relevance, 2)" /></td>
                      <td class="xs">
                        {{ l.stance }}
                        @if (l.eventKey) {
                          <span class="mono faint ev" [title]="l.eventKey">{{ l.eventKey }}</span>
                        }
                      </td>
                      <td>
                        <span class="pill" [class.warn]="l.provenance === 'AgentDraft'" [class.ok]="l.provenance !== 'AgentDraft'" [title]="l.labeller + ' · ' + (l.labelledAtUtc | date: 'MMM d HH:mm' : 'UTC')">{{ provLabel(l.provenance) }}</span>
                      </td>
                      <td class="num">
                        @if (canManage()) {
                          <div class="ni-toolbar acts">
                            @if (l.provenance === 'AgentDraft') {
                              <button type="button" class="btn" [disabled]="busy()" (click)="confirm(l)">Confirm</button>
                            }
                            <button type="button" class="btn subtle" (click)="startEdit(l)">Edit</button>
                          </div>
                        }
                      </td>
                    </tr>
                  }
                } @empty {
                  <tr>
                    <td colspan="10" class="empty pad">{{ provenance() === 'AgentDraft' ? 'Every draft has been reviewed.' : 'No gold label matches.' }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          @if (g.total > pageSize) {
            <div class="pager">
              <button type="button" class="btn subtle" [disabled]="skip() === 0" (click)="page(-1)">‹ Prev</button>
              <span class="xsmall muted">{{ skip() + 1 }}–{{ min(skip() + pageSize, g.total) }} of {{ g.total }}</span>
              <button type="button" class="btn subtle" [disabled]="skip() + pageSize >= g.total" (click)="page(1)">Next ›</button>
            </div>
          }
        } @else {
          <p class="empty pad">Loading…</p>
        }
      </app-ni-panel>

      <app-confirm-dialog
        [open]="pending() !== null"
        [title]="pending()?.kind === 'seed' ? 'Seed the gold set?' : 'Run an evaluation?'"
        [message]="pendingText()"
        [confirmLabel]="pending()?.kind === 'seed' ? 'Seed' : 'Run'"
        [loading]="busy()"
        (confirm)="doPending()"
        (cancelled)="pending.set(null)"
      />
    </div>
  `,
  styles: [
    `
      .ni-kpis.k8 {
        grid-template-columns: repeat(8, minmax(0, 1fr));
      }
      @media (max-width: 1320px) {
        .ni-kpis.k8 {
          grid-template-columns: repeat(auto-fit, minmax(128px, 1fr));
        }
      }
      .multiples {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 14px 18px;
        padding-top: 4px;
      }
      .chk {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        font-size: 11.5px;
        color: var(--text-secondary);
      }
      .runs-wrap {
        max-height: 260px;
      }
      .runs-wrap th:first-child,
      .runs-wrap td:first-child,
      .gold-wrap th:first-child,
      .gold-wrap td:first-child {
        padding-left: 12px;
      }
      .runs-wrap th:last-child,
      .runs-wrap td:last-child,
      .gold-wrap th:last-child,
      .gold-wrap td:last-child {
        padding-right: 12px;
      }
      .xs {
        font-size: 11px;
      }
      td.ellipsis {
        max-width: 180px;
        width: auto;
      }
      .keys-line {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 3px;
        font-size: 11px;
      }
      .ev-grid {
        display: grid;
        grid-template-columns: minmax(0, 1.45fr) minmax(0, 1fr);
        gap: var(--space-3);
        align-items: start;
      }
      @media (max-width: 1180px) {
        .ev-grid {
          grid-template-columns: minmax(0, 1fr);
        }
      }
      .nowrap {
        white-space: nowrap;
      }
      .detail-col {
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .agree {
        display: grid;
        grid-template-columns: auto repeat(4, minmax(0, 1fr));
        align-items: center;
        gap: 6px 16px;
        padding: 8px 10px;
        border-radius: 8px;
        background: var(--ni-sunken);
      }
      .agree-h {
        font-size: 11px;
        font-weight: 600;
      }
      .agree-r {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr);
        align-items: center;
        gap: 6px;
        font-size: 11px;
        color: var(--text-secondary);
      }
      .prov {
        padding: 0 12px 4px;
      }
      .key-in {
        width: 110px;
      }
      .gold-wrap {
        max-height: 640px;
      }
      .art {
        max-width: 360px;
        min-width: 220px;
      }
      .art .ttl {
        display: block;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .art .xs {
        display: block;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .ev {
        display: block;
        font-size: 10px;
        max-width: 160px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .dir {
        font-size: 9px;
        color: var(--text-tertiary);
      }
      .rumor {
        color: var(--ni-warn);
      }
      .acts {
        justify-content: flex-end;
        flex-wrap: nowrap;
      }
      .stack {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .num-in {
        width: 64px;
      }
      .pager {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 10px;
        padding: 6px;
        border-top: 1px solid var(--border);
      }
      .empty.pad {
        padding: 12px;
      }
    `,
  ],
})
export class NewsEvalsPageComponent {
  private readonly svc = inject(NewsIntelService);
  private readonly auth = inject(AuthService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly categories = NEWS_CATEGORIES;
  protected readonly directions = NEWS_DIRECTIONS;
  protected readonly certainties = NEWS_CERTAINTIES;
  protected readonly stances = NEWS_STANCES;
  protected readonly pageSize = PAGE;
  protected readonly min = Math.min;

  readonly canManage = computed(() => this.auth.hasPermission(Permission.PlatformDataManage));

  readonly runs = createPolledResource(() => this.svc.getEvalRuns(20), { intervalMs: 15_000 });
  readonly anyRunning = computed(() => (this.runs.value() ?? []).some((r) => evalRunActive(r)));
  readonly detail = signal<NewsEvalRunView | null>(null);
  readonly metrics = computed<EvalMetrics | null>(() =>
    parseEvalMetrics(this.detail()?.metricsJson),
  );
  readonly caveat = computed(() => {
    const d = this.detail();
    return d ? draftCaveat(d, this.metrics()?.draftShare ?? null) : null;
  });

  readonly provenance = signal<NewsGoldProvenance | null>('AgentDraft');
  readonly exposure = signal('');
  readonly skip = signal(0);
  readonly gold = signal<{
    total: number;
    items: NewsGoldLabelView[];
    countsByProvenance: Record<string, number>;
  } | null>(null);
  readonly provenanceCounts = computed(() =>
    Object.entries(this.gold()?.countsByProvenance ?? {}).map(([k, v]) => ({
      k: this.provLabel(k),
      v,
    })),
  );
  readonly editing = signal<NewsGoldLabelView | null>(null);
  readonly edits = signal<NewsGoldEditRequest>({});

  readonly repeats = signal(2);
  readonly reviewedOnly = signal(false);
  readonly pending = signal<Pending | null>(null);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly notice = signal<string | null>(null);

  readonly pendingText = computed(() =>
    this.pending()?.kind === 'seed'
      ? 'Applies the shipped agent-drafted fixture to articles still in the store (matched by content). Idempotent: existing rows, including every review, are kept.'
      : `Classifies the gold articles ${this.repeats()} time(s) with the current configuration${this.reviewedOnly() ? ' (reviewed labels only)' : ''}. Costs model calls on the classification provider, which spot analysis shares; bounded by NewsIntel:Eval:MaxArticles.`,
  );

  constructor() {
    this.loadGold();
    // The list is polled; an open run that changed status there (Running → Completed) is re-read
    // so its metrics appear without a click.
    effect(() => {
      const list = this.runs.value() ?? [];
      untracked(() => {
        const d = this.detail();
        const fresh = d ? list.find((r) => r.id === d.id) : undefined;
        if (d && fresh && fresh.status !== d.status) {
          this.svc
            .getEvalRun(d.id)
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe({ next: (full) => this.detail.set(full), error: () => undefined });
        }
      });
    });
  }

  loadGold(): void {
    this.svc
      .getGold({
        provenance: this.provenance(),
        exposure: this.exposure() || undefined,
        skip: this.skip(),
        take: PAGE,
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (g) => this.gold.set(g),
        error: (e) => {
          this.gold.set({ total: 0, items: [], countsByProvenance: {} });
          this.error.set(errorText(e, 'Could not load the gold set.'));
        },
      });
  }

  setProvenance(v: string): void {
    this.provenance.set(v ? (v as NewsGoldProvenance) : null);
    this.skip.set(0);
    this.loadGold();
  }

  setExposure(v: string): void {
    this.exposure.set(v.trim().toUpperCase());
    this.skip.set(0);
    this.loadGold();
  }

  page(dir: number): void {
    this.skip.set(Math.max(0, this.skip() + dir * PAGE));
    this.loadGold();
  }

  provLabel(p: string): string {
    return p === 'AgentDraft'
      ? 'Agent draft'
      : p === 'OperatorConfirmed'
        ? 'Confirmed'
        : p === 'OperatorEdited'
          ? 'Edited'
          : p;
  }

  openRun(r: NewsEvalRunView): void {
    const cached = this.runDetails().get(r.id);
    this.detail.set(cached ?? r);
    this.svc
      .getEvalRun(r.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (full) => this.detail.set(full), error: () => undefined });
  }

  confirm(l: NewsGoldLabelView): void {
    this.busy.set(true);
    this.svc.confirmGold(l.id).subscribe({
      next: () => {
        this.busy.set(false);
        this.notice.set(`Label #${l.id} confirmed.`);
        this.loadGold();
      },
      error: (e) => {
        this.busy.set(false);
        this.error.set(errorText(e, 'Could not confirm the label.'));
      },
    });
  }

  startEdit(l: NewsGoldLabelView): void {
    this.editing.set(l);
    this.edits.set({});
  }

  patch(p: NewsGoldEditRequest): void {
    this.edits.update((e) => ({ ...e, ...p }));
  }

  saveEdit(l: NewsGoldLabelView): void {
    this.busy.set(true);
    this.svc.editGold(l.id, this.edits()).subscribe({
      next: (prov) => {
        this.busy.set(false);
        this.editing.set(null);
        this.notice.set(`Label #${l.id} saved as ${this.provLabel(prov)}.`);
        this.loadGold();
      },
      error: (e) => {
        this.busy.set(false);
        this.error.set(errorText(e, 'Could not save the label.'));
      },
    });
  }

  doPending(): void {
    const p = this.pending();
    if (!p) return;
    this.busy.set(true);
    this.error.set(null);
    if (p.kind === 'seed') {
      this.svc.seedGold().subscribe({
        next: (r) => {
          this.busy.set(false);
          this.pending.set(null);
          this.notice.set(`Seeded: ${JSON.stringify(r)}`);
          this.loadGold();
        },
        error: (e) => {
          this.busy.set(false);
          this.pending.set(null);
          this.error.set(errorText(e, 'Seeding failed.'));
        },
      });
      return;
    }
    this.svc.runEval({ repeats: this.repeats(), reviewedOnly: this.reviewedOnly() }).subscribe({
      next: (run) => {
        this.busy.set(false);
        this.pending.set(null);
        this.notice.set(`Evaluation run #${run.id} started.`);
        this.detail.set(run);
        this.runs.refresh();
      },
      error: (e) => {
        this.busy.set(false);
        this.pending.set(null);
        this.error.set(errorText(e, 'The evaluation was not started.'));
      },
    });
  }

  f(v: number | null | undefined, d = 3): string {
    return fmt(v, d);
  }

  p(v: number | null | undefined): string {
    return pct(v);
  }

  perClass(m: Record<string, number>): { k: string; v: number }[] {
    return Object.entries(m)
      .map(([k, v]) => ({ k, v }))
      .sort((a, b) => a.v - b.v);
  }

  // ── Dense redesign: per-run details (metrics live only on the single-run read), KPIs, multiples ──

  /** Full rows (with MetricsJson) of completed runs, fetched once each. */
  readonly runDetails = signal<ReadonlyMap<number, NewsEvalRunView>>(new Map());
  private readonly fetching = new Set<number>();

  readonly completedRuns = computed(() =>
    [...(this.runs.value() ?? [])].filter((r) => r.status === 'Completed').sort((a, b) => a.id - b.id),
  );

  private metricsOf(id: number): EvalMetrics | null {
    return parseEvalMetrics(this.runDetails().get(id)?.metricsJson);
  }

  private readonly fields: Record<string, (r: NewsEvalRunView) => number | null> = {
    rel: (r) => this.metricsOf(r.id)?.passes[0]?.relevance?.f1 ?? r.relevanceF1,
    exp: (r) => this.metricsOf(r.id)?.passes[0]?.exposurePairs?.f1 ?? null,
    cat: (r) => this.metricsOf(r.id)?.passes[0]?.category?.macroF1 ?? r.categoryMacroF1,
    dir: (r) => this.metricsOf(r.id)?.passes[0]?.direction?.macroF1 ?? r.directionMacroF1,
    cer: (r) => this.metricsOf(r.id)?.passes[0]?.certainty?.macroF1 ?? null,
    agr: (r) => this.metricsOf(r.id)?.agreement?.overall ?? r.runToRunAgreement,
  };

  readonly multiples = computed(() => {
    const runs = this.completedRuns();
    const mk = (label: string, k: string, percent = false) => ({
      label,
      percent,
      runs: runs.map((r): RunScore => ({ id: r.id, value: this.fields[k](r) })),
    });
    return [
      mk('Relevance F1', 'rel'),
      mk('Exposure F1', 'exp'),
      mk('Category F1', 'cat'),
      mk('Direction F1', 'dir'),
      mk('Certainty F1', 'cer'),
      mk('Agreement', 'agr', true),
    ];
  });

  /** The run the KPI strip reads: the open one, else the latest completed. */
  private readonly kpiRun = computed(() => {
    const d = this.detail();
    if (d && d.status === 'Completed') return d;
    const done = this.completedRuns();
    return done.length ? done[done.length - 1] : null;
  });

  kv(k: string): string {
    const r = this.kpiRun();
    if (!r) return '—';
    const v = this.fields[k](r);
    return k === 'agr' ? pct(v) : fmt(v, 2);
  }
  kSub(k: string): string | null {
    const r = this.kpiRun();
    if (!r) return null;
    const done = this.completedRuns();
    const i = done.findIndex((x) => x.id === r.id);
    const prev = i > 0 ? this.fields[k](done[i - 1]) : null;
    const cur = this.fields[k](r);
    if (prev === null || cur === null) return `run #${r.id}`;
    const d = cur - prev;
    const t = k === 'agr' ? `${d >= 0 ? '+' : '−'}${Math.abs(Math.round(d * 100))}pt` : `${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(2)}`;
    return `#${r.id} · ${t} vs #${done[i - 1].id}`;
  }
  series(k: string): (number | null)[] | null {
    const done = this.completedRuns();
    return done.length > 1 ? done.map((r) => this.fields[k](r)) : null;
  }
  readonly rumorZero = computed(() => {
    const r = this.kpiRun();
    const rumor = r ? this.metricsOf(r.id)?.passes[0]?.certainty?.perClassF1?.['Rumor'] : undefined;
    return rumor === 0;
  });

  private readonly provTotals = computed(() => this.gold()?.countsByProvenance ?? {});
  readonly goldTotal = computed(() => {
    const g = this.gold();
    if (!g) return '—';
    return String(Object.values(this.provTotals()).reduce((s, v) => s + v, 0));
  });
  readonly provSummary = computed(() => {
    const c = this.provTotals();
    return `${c['AgentDraft'] ?? 0} drafts`;
  });
  private readonly reviewedShare = computed(() => {
    const c = this.provTotals();
    const total = Object.values(c).reduce((s, v) => s + v, 0);
    return total ? ((c['OperatorConfirmed'] ?? 0) + (c['OperatorEdited'] ?? 0)) / total : null;
  });
  readonly reviewedPct = computed(() => pct(this.reviewedShare()));
  readonly reviewedSub = computed(() => {
    const c = this.provTotals();
    return this.gold() ? `${c['OperatorConfirmed'] ?? 0} conf · ${c['OperatorEdited'] ?? 0} edit` : null;
  });
  readonly reviewedTone = computed<'ok' | 'warn' | null>(() => {
    const s = this.reviewedShare();
    return s === null ? null : s < 0.5 ? 'warn' : 'ok';
  });
  readonly provParts = computed<MeterPart[]>(() => {
    const c = this.provTotals();
    if (!Object.keys(c).length) return [];
    return [
      { label: 'Agent draft', value: c['AgentDraft'] ?? 0, color: 'var(--ni-warn)' },
      { label: 'Confirmed', value: c['OperatorConfirmed'] ?? 0, color: 'var(--ni-ok)' },
      { label: 'Edited', value: c['OperatorEdited'] ?? 0, color: 'var(--ni-s1)' },
    ];
  });

  agreementRows(a: NonNullable<EvalMetrics['agreement']>): { k: string; v: number | null }[] {
    return [
      { k: 'Overall', v: a.overall },
      { k: 'Relevance', v: a.relevance },
      { k: 'Exposure set', v: a.exposureSet },
      { k: 'Category + dir', v: a.categoryAndDirection },
    ];
  }

  openById(id: number): void {
    const r = (this.runs.value() ?? []).find((x) => x.id === id);
    if (r) this.openRun(r);
  }

  private fetchDetail(id: number): void {
    if (this.fetching.has(id) || this.runDetails().has(id)) return;
    this.fetching.add(id);
    this.svc
      .getEvalRun(id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (full) => {
          const m = new Map(this.runDetails());
          m.set(id, full);
          this.runDetails.set(m);
          if (this.detail()?.id === id) this.detail.set(full);
        },
        error: () => this.fetching.delete(id),
      });
  }

  private readonly detailLoader = effect(() => {
    const done = this.completedRuns();
    untracked(() => {
      for (const r of done.slice(-12)) this.fetchDetail(r.id);
      // Open the latest completed run by default so the page reads as a report, not an index.
      if (!this.detail() && done.length) this.detail.set(this.runDetails().get(done[done.length - 1].id) ?? done[done.length - 1]);
    });
  });
}
