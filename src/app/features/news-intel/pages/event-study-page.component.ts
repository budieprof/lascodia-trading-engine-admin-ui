import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { NewsIntelService } from '@core/services/news-intel.service';
import { AuthService } from '@core/auth/auth.service';
import { Permission } from '@core/auth/permissions.generated';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { FeatureStateComponent } from '@shared/components/feedback/feature-state.component';
import { errorText } from '@features/iam/iam.logic';
import { NewsIntelNavComponent } from '../components/news-intel-nav.component';
import {
  ciGeometry,
  ciVerdict,
  configValue,
  fmt,
  mergedSeverityJson,
  parseRecommendation,
  parseSeverityMap,
  pct,
  severityDiff,
  signed,
  studyDimensions,
  studyHorizons,
  studyRows,
} from '../news-intel.logic';
import {
  NewsConfigEntry,
  NewsEventStudyDetail,
  NewsEventStudyResultView,
  NewsEventStudyRunView,
} from '../news-intel.types';

const SEVERITY_KEY = 'NewsIntel:Weight:CategorySeverityJson';
const BAR_W = 220;

/**
 * Event study — does news predict what the market did next? For every label first seen in a window,
 * the signed forward return of each exposed symbol (ATR units, signed by label direction × leg sign),
 * aggregated by category / kind / channel / certainty / novelty / story state / liveness / weight
 * decile with cluster-robust bootstrap CIs; rank ICs of every weight term; and recommended category
 * severities (shrunk toward today's by sample size).
 *
 * Applying the recommendation writes `Weight:CategorySeverityJson` through `PUT news-intel/config` —
 * the engine's ordinary config governance (audit, cooling-off for risk-loosening changes). Nothing
 * is applied automatically.
 */
@Component({
  selector: 'app-news-event-study-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    RouterLink,
    NewsIntelNavComponent,
    ConfirmDialogComponent,
    FeatureStateComponent,
  ],
  styleUrls: ['../news-intel-shared.scss'],
  template: `
    <div class="page">
      <header>
        <h1>Event study</h1>
        <p class="muted small">
          What the market did after news, measured point-in-time: forward returns start at the first
          candle close AFTER the engine first saw the article. Positive = the price moved the way
          the label said.
        </p>
      </header>
      <app-news-intel-nav [showRefresh]="true" [refreshing]="loading()" (refresh)="loadRuns()" />

      @if (error(); as e) {
        <div class="banner error">{{ e }}</div>
      }
      @if (notice(); as n) {
        <div class="banner info">{{ n }}</div>
      }

      @if (unavailable()) {
        <app-feature-state
          kind="off"
          title="The event study is not on this engine yet"
          summary="The engine answered that it has no event-study endpoint. It ships with the news-intel validation work; this page fills in once that engine build is deployed."
          [links]="[{ label: 'Risk use', route: '/news-intel/risk' }]"
        />
      } @else {
        <section class="card">
          <div class="card-head">
            <h2>Runs</h2>
            @if (canRun()) {
              <div class="filters">
                <label class="small"
                  >Window
                  <select class="sel" (change)="windowDays.set(+$any($event.target).value)">
                    <option value="14">14 days</option>
                    <option value="30" selected>30 days</option>
                    <option value="45">45 days</option>
                  </select></label
                >
                <button
                  type="button"
                  class="btn primary"
                  [disabled]="busy() || anyRunning()"
                  (click)="confirmRun.set(true)"
                >
                  {{ anyRunning() ? 'A run is in progress' : 'Run study' }}
                </button>
              </div>
            }
          </div>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Started (UTC)</th>
                  <th>Status</th>
                  <th>Window</th>
                  <th>Lineage</th>
                  <th class="num">Labels / obs.</th>
                  <th>Alignment verdict</th>
                </tr>
              </thead>
              <tbody>
                @for (r of runs(); track r.id) {
                  <tr
                    class="clickable"
                    (click)="open(r)"
                    [class.sel-row]="detail()?.run?.id === r.id"
                  >
                    <td class="mono">{{ r.id }}</td>
                    <td class="xsmall">
                      {{ r.startedAtUtc | date: 'MMM d HH:mm' : 'UTC' }}
                      <span class="muted">{{ r.trigger }}</span>
                    </td>
                    <td>
                      <span
                        class="pill"
                        [class.ok]="r.status === 'Completed'"
                        [class.bad]="r.status === 'Failed'"
                        [class.info]="r.status === 'Running'"
                        >{{ r.status }}</span
                      >
                    </td>
                    <td class="xsmall">
                      {{ r.fromUtc | date: 'MMM d' : 'UTC' }} →
                      {{ r.toUtc | date: 'MMM d' : 'UTC' }}
                    </td>
                    <td class="mono xsmall">{{ r.lineageFilter ?? 'each lineage' }}</td>
                    <td class="num">{{ r.labelsConsidered }} / {{ r.observations }}</td>
                    <td class="small">
                      <span
                        class="pill"
                        [class.ok]="r.alignmentVerdict === 'Positive'"
                        [class.bad]="r.alignmentVerdict === 'Negative'"
                        >{{ r.alignmentVerdict ?? '—' }}</span
                      >
                      @if (r.alignmentMean !== null) {
                        <span class="mono xsmall">
                          {{ sg(r.alignmentMean) }} [{{ sg(r.alignmentCiLow) }},
                          {{ sg(r.alignmentCiHigh) }}] ATR @ {{ r.alignmentHorizonMinutes }}m</span
                        >
                      }
                    </td>
                  </tr>
                } @empty {
                  <tr>
                    <td colspan="7" class="empty">
                      No study has run yet. The nightly worker runs one; "Run study" starts one now.
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </section>

        @if (detail(); as d) {
          @if (d.run.error) {
            <div class="banner error">Run #{{ d.run.id }} failed: {{ d.run.error }}</div>
          }
          <section class="card">
            <div class="card-head">
              <div>
                <h2>Run #{{ d.run.id }} — mean signed forward return (ATR) with 95% CI</h2>
                <p class="muted xsmall">
                  CIs are cluster-robust (resampled by story/day). A bucket under 30 observations is
                  marked thin and is not evidence either way. Fingerprint
                  <code>{{ d.run.paramsFingerprint ?? '—' }}</code
                  >.
                </p>
              </div>
              <div class="filters">
                <select
                  class="sel"
                  aria-label="Group by"
                  (change)="dimension.set($any($event.target).value)"
                >
                  @for (dm of dimensions(); track dm) {
                    <option [value]="dm" [selected]="dm === dimension()">{{ dm }}</option>
                  }
                </select>
                <select
                  class="sel"
                  aria-label="Horizon"
                  (change)="horizon.set(+$any($event.target).value)"
                >
                  @for (h of horizons(); track h) {
                    <option [value]="h" [selected]="h === horizon()">{{ h }} min</option>
                  }
                </select>
              </div>
            </div>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{{ dimension() }}</th>
                    <th class="num">n / clusters</th>
                    <th class="num">Mean</th>
                    <th class="num">95% CI</th>
                    <th class="num">Hit rate</th>
                    <th class="num">t</th>
                    <th>
                      <span class="axis-lbl">← against label · 0 · with label →</span>
                    </th>
                    <th>Reading</th>
                  </tr>
                </thead>
                <tbody>
                  @for (r of groupRows(); track r.bucket) {
                    <tr>
                      <td>{{ r.bucket }}</td>
                      <td class="num">{{ r.n }} / {{ r.clusters }}</td>
                      <td class="num">{{ sg(r.mean) }}</td>
                      <td class="num">[{{ sg(r.ciLow) }}, {{ sg(r.ciHigh) }}]</td>
                      <td class="num">{{ p(r.hitRate) }}</td>
                      <td class="num">{{ f(r.tStat, 2) }}</td>
                      <td>
                        <svg
                          class="ci"
                          [attr.viewBox]="'0 0 ' + barW + ' 16'"
                          role="img"
                          [attr.aria-label]="r.bucket + ' mean ' + sg(r.mean)"
                        >
                          <title>
                            {{ r.bucket }}: mean {{ sg(r.mean) }} ATR, CI [{{ sg(r.ciLow) }},
                            {{ sg(r.ciHigh) }}], n {{ r.n }}
                          </title>
                          <line
                            class="zero"
                            [attr.x1]="geo().zero"
                            [attr.x2]="geo().zero"
                            y1="0"
                            y2="16"
                          />
                          @if (r.ciLow !== null && r.ciHigh !== null) {
                            <line
                              class="whisker"
                              [class.thin]="verdict(r) === 'thin'"
                              [attr.x1]="geo().scale(r.ciLow)"
                              [attr.x2]="geo().scale(r.ciHigh)"
                              y1="8"
                              y2="8"
                            />
                          }
                          <circle
                            class="dot"
                            [class.thin]="verdict(r) === 'thin'"
                            [attr.cx]="geo().scale(r.mean)"
                            cy="8"
                            r="4"
                          />
                        </svg>
                      </td>
                      <td class="xsmall">
                        @switch (verdict(r)) {
                          @case ('positive') {
                            <span class="pos">helps (CI &gt; 0)</span>
                          }
                          @case ('negative') {
                            <span class="neg">hurts (CI &lt; 0)</span>
                          }
                          @case ('thin') {
                            <span class="muted">too few</span>
                          }
                          @default {
                            <span class="muted">no effect shown</span>
                          }
                        }
                      </td>
                    </tr>
                  } @empty {
                    <tr>
                      <td colspan="8" class="empty">
                        No result rows for this grouping and horizon.
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </section>

          <section class="card">
            <h2>Weight terms — rank IC vs signed forward return ({{ horizon() }} min)</h2>
            <p class="muted xsmall">
              Does a bigger term (severity, reliability, certainty, novelty, decay…) go with a
              bigger move in the labelled direction? Near zero means the term is not earning its
              place.
            </p>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Term</th>
                    <th class="num">n</th>
                    <th class="num">Rank IC</th>
                    <th class="num">95% CI</th>
                  </tr>
                </thead>
                <tbody>
                  @for (r of termRows(); track r.dimension + r.bucket) {
                    <tr>
                      <td>{{ r.bucket || r.dimension }}</td>
                      <td class="num">{{ r.n }}</td>
                      <td class="num">{{ sg(r.mean) }}</td>
                      <td class="num">[{{ sg(r.ciLow) }}, {{ sg(r.ciHigh) }}]</td>
                    </tr>
                  } @empty {
                    <tr>
                      <td colspan="4" class="empty">No term ICs at this horizon.</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </section>

          <section class="card">
            <div class="card-head">
              <div>
                <h2>Recommended severities vs current</h2>
                <p class="muted xsmall">
                  Shrunk toward today's values by sample size; a category with too little data keeps
                  its current severity. Applying writes <code>{{ severityKey }}</code> through the
                  normal config governance — a loosening change needs a reason and may be queued for
                  cooling-off.
                </p>
              </div>
              @if (canApply() && changedCount() > 0) {
                <button
                  type="button"
                  class="btn primary"
                  [disabled]="busy()"
                  (click)="confirmApply.set(true)"
                >
                  Apply via governance ({{ changedCount() }})
                </button>
              }
            </div>
            @if (recError(); as re) {
              <p class="muted small">{{ re }}</p>
            }
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Category</th>
                    <th class="num">Current</th>
                    <th class="num">Recommended</th>
                    <th class="num">Δ</th>
                    <th class="num">n / clusters</th>
                    <th>Basis</th>
                  </tr>
                </thead>
                <tbody>
                  @for (r of diff(); track r.category) {
                    <tr>
                      <td>{{ r.category }}</td>
                      <td class="num">{{ f(r.current, 2) }}</td>
                      <td class="num">{{ f(r.recommended, 2) }}</td>
                      <td
                        class="num"
                        [class.pos]="(r.delta ?? 0) > 0"
                        [class.neg]="(r.delta ?? 0) < 0"
                      >
                        {{ r.changed ? sg(r.delta, 2) : '' }}
                      </td>
                      <td class="num">{{ meta(r.category) }}</td>
                      <td class="xsmall muted">{{ basis(r.category) }}</td>
                    </tr>
                  } @empty {
                    <tr>
                      <td colspan="6" class="empty">No recommendation for this run.</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </section>

          <section class="card">
            <h2>Coverage &amp; calibration</h2>
            <p class="muted xsmall">
              What could be measured (candles per symbol/timeframe) and the volatility calibration
              the risk forecast uses. Raw, as the engine recorded them.
            </p>
            @for (blk of rawBlocks(); track blk.title) {
              <details>
                <summary class="small">{{ blk.title }}</summary>
                <pre class="raw">{{ blk.body }}</pre>
              </details>
            }
            <p class="xsmall">
              <a routerLink="/news-intel/risk">How these feed the risk settings →</a>
            </p>
          </section>
        }
      }

      <app-confirm-dialog
        [open]="confirmRun()"
        title="Run the event study?"
        [message]="
          'Reads ' +
          windowDays() +
          ' days of labels and candles (research process, read-only) and stores the aggregates. No model calls.'
        "
        confirmLabel="Run"
        [loading]="busy()"
        (confirm)="run()"
        (cancelled)="confirmRun.set(false)"
      />
      <app-confirm-dialog
        [open]="confirmApply()"
        title="Apply the recommended severities?"
        [message]="applyText()"
        confirmLabel="Apply"
        [loading]="busy()"
        (confirm)="apply()"
        (cancelled)="confirmApply.set(false)"
      >
        <label class="small reason">
          Reason (required for a loosening change)
          <input
            class="inp"
            [value]="reason()"
            (input)="reason.set($any($event.target).value)"
            placeholder="e.g. event study #12, 30 days"
          />
        </label>
      </app-confirm-dialog>
    </div>
  `,
  styles: [
    `
      .sel-row td {
        background: var(--bg-tertiary);
      }
      .ci {
        width: 220px;
        height: 16px;
        display: block;
      }
      .ci .zero {
        stroke: var(--text-tertiary);
        stroke-width: 1;
      }
      .ci .whisker {
        stroke: var(--accent);
        stroke-width: 2;
        stroke-linecap: round;
      }
      .ci .dot {
        fill: var(--accent);
        stroke: var(--bg-secondary);
        stroke-width: 2;
      }
      .ci .thin {
        opacity: 0.35;
      }
      .axis-lbl {
        font-weight: var(--font-regular);
      }
      .raw {
        max-height: 260px;
        overflow: auto;
        font-size: var(--text-xs);
        background: var(--bg-primary);
        padding: var(--space-2);
        border-radius: var(--radius-sm);
        white-space: pre-wrap;
      }
      .reason {
        display: flex;
        flex-direction: column;
        gap: 4px;
        margin-top: var(--space-2);
      }
    `,
  ],
})
export class NewsEventStudyPageComponent {
  private readonly svc = inject(NewsIntelService);
  private readonly auth = inject(AuthService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly barW = BAR_W;
  protected readonly severityKey = SEVERITY_KEY;

  readonly canRun = computed(() => this.auth.hasPermission(Permission.PlatformDataManage));
  readonly canApply = computed(() => this.auth.hasPermission(Permission.PlatformEngineManage));

  readonly runs = signal<NewsEventStudyRunView[]>([]);
  readonly detail = signal<NewsEventStudyDetail | null>(null);
  readonly config = signal<NewsConfigEntry[]>([]);
  readonly recommendation = signal<ReturnType<typeof parseRecommendation>>({ rows: [] });
  readonly recError = signal<string | null>(null);
  readonly unavailable = signal(false);
  readonly loading = signal(false);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly notice = signal<string | null>(null);
  readonly dimension = signal('category');
  readonly horizon = signal(60);
  readonly windowDays = signal(30);
  readonly confirmRun = signal(false);
  readonly confirmApply = signal(false);
  readonly reason = signal('');

  readonly anyRunning = computed(() => this.runs().some((r) => r.status === 'Running'));
  readonly results = computed<NewsEventStudyResultView[]>(() => this.detail()?.results ?? []);
  readonly dimensions = computed(() => studyDimensions(this.results()));
  readonly horizons = computed(() => studyHorizons(this.results()));
  readonly groupRows = computed(() =>
    studyRows(this.results(), 'group', this.dimension(), this.horizon()),
  );
  readonly termRows = computed(() => studyRows(this.results(), 'term-ic', null, this.horizon()));
  readonly geo = computed(() => ciGeometry(this.groupRows(), BAR_W));

  readonly currentSeverities = computed(() =>
    parseSeverityMap(configValue(this.config(), SEVERITY_KEY)),
  );
  readonly recommendedMap = computed(() =>
    Object.fromEntries(this.recommendation().rows.map((r) => [r.category, r.recommended])),
  );
  readonly diff = computed(() => {
    const current = { ...this.currentSeverities() };
    // A category the live row does not list falls back to the engine default; the recommendation
    // row's own "current" says what that was.
    for (const r of this.recommendation().rows)
      if (!(r.category in current) && r.current !== null) current[r.category] = r.current;
    return severityDiff(current, this.recommendedMap());
  });
  readonly changedCount = computed(() => this.diff().filter((d) => d.changed).length);
  readonly applyText = computed(
    () =>
      `${this.changedCount()} category severit${this.changedCount() === 1 ? 'y' : 'ies'} change; every other category keeps its current value. Every news score is re-weighted on the next roll-up and the params fingerprint changes.`,
  );
  readonly rawBlocks = computed(() => {
    const r = this.detail()?.run;
    if (!r) return [];
    const pretty = (s: string | null | undefined) => {
      if (!s) return null;
      try {
        return JSON.stringify(JSON.parse(s), null, 2);
      } catch {
        return s;
      }
    };
    return [
      { title: 'Summary', body: pretty(r.summaryJson) },
      { title: 'Candle coverage', body: pretty(r.coverageJson) },
      { title: 'Volatility calibration', body: pretty(r.volCalibrationJson) },
    ].filter((b): b is { title: string; body: string } => b.body !== null);
  });

  constructor() {
    this.loadRuns();
    this.svc
      .getConfig()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (e) => this.config.set(e), error: () => this.config.set([]) });
  }

  loadRuns(): void {
    this.loading.set(true);
    this.svc
      .getEventStudyRuns(20)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (runs) => {
          this.loading.set(false);
          this.unavailable.set(false);
          this.runs.set(runs);
          const d = this.detail();
          if (d) {
            const fresh = runs.find((r) => r.id === d.run.id);
            if (fresh && fresh.status !== d.run.status) this.open(fresh, true);
          } else {
            const first = runs.find((r) => r.status === 'Completed');
            if (first) this.open(first, true);
          }
        },
        error: (e) => {
          this.loading.set(false);
          if ((e as { status?: number })?.status === 404) this.unavailable.set(true);
          else this.error.set(errorText(e, 'Could not load event-study runs.'));
        },
      });
  }

  open(r: NewsEventStudyRunView, force = false): void {
    if (!force && this.detail()?.run.id === r.id) return;
    this.detail.set({ run: r, results: [] });
    this.recommendation.set({ rows: [] });
    this.recError.set(null);
    this.svc
      .getEventStudyRun(r.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (d) => {
          this.detail.set(d);
          const dims = studyDimensions(d.results);
          if (dims.length && !dims.includes(this.dimension())) this.dimension.set(dims[0]);
          const hs = studyHorizons(d.results);
          if (hs.length && !hs.includes(this.horizon()))
            this.horizon.set(hs.includes(60) ? 60 : hs[0]);
        },
        error: (e) => this.error.set(errorText(e, `Could not load run #${r.id}.`)),
      });
    if (r.status === 'Completed') {
      this.svc
        .getRecommendedWeights(r.id)
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({
          next: (data) => this.recommendation.set(parseRecommendation(data)),
          error: (e) => this.recError.set(errorText(e, 'No recommendation for this run.')),
        });
    }
  }

  run(): void {
    this.busy.set(true);
    const to = new Date();
    const from = new Date(to.getTime() - this.windowDays() * 86_400_000);
    this.svc.runEventStudy({ fromUtc: from.toISOString(), toUtc: to.toISOString() }).subscribe({
      next: (r) => {
        this.busy.set(false);
        this.confirmRun.set(false);
        this.notice.set(`Event study #${r.id} started — refresh to follow it.`);
        this.loadRuns();
      },
      error: (e) => {
        this.busy.set(false);
        this.confirmRun.set(false);
        this.error.set(errorText(e, 'The study was not started.'));
      },
    });
  }

  apply(): void {
    this.busy.set(true);
    const value = mergedSeverityJson(this.currentSeverities(), this.recommendedMap());
    this.svc
      .saveConfig([{ key: SEVERITY_KEY, value, dataType: 'Json' }], {
        reason: this.reason() || undefined,
      })
      .subscribe({
        next: (msgs) => {
          this.busy.set(false);
          this.confirmApply.set(false);
          this.notice.set(msgs.join(' · ') || 'Saved.');
          this.svc.getConfig().subscribe({ next: (e) => this.config.set(e) });
        },
        error: (e) => {
          this.busy.set(false);
          this.confirmApply.set(false);
          if (/-202-approval/.test(JSON.stringify(e ?? {})))
            this.notice.set(`${SEVERITY_KEY}: sent for approval.`);
          else this.error.set(errorText(e, 'The change was not saved.'));
        },
      });
  }

  verdict(r: NewsEventStudyResultView): string {
    return ciVerdict(r);
  }

  meta(category: string): string {
    const r = this.recommendation().rows.find((x) => x.category === category);
    return r && r.n !== null ? `${r.n} / ${r.clusters ?? '—'}` : '—';
  }

  basis(category: string): string {
    return this.recommendation().rows.find((x) => x.category === category)?.basis ?? '';
  }

  f(v: number | null | undefined, d = 3): string {
    return fmt(v, d);
  }

  sg(v: number | null | undefined, d = 3): string {
    return signed(v, d);
  }

  p(v: number | null | undefined): string {
    return pct(v);
  }
}
