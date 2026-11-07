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
  NiDbarComponent,
  NiInfoComponent,
  NiMeterComponent,
  NiPanelComponent,
  NiStatComponent,
} from '../components/viz/ni-primitives';
import { ForestRow, NiForestComponent } from '../components/viz/ni-tabs-c';
import { compact as compactNum } from '../components/viz/ni-viz';
import {
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
    NiDbarComponent,
    NiInfoComponent,
    NiMeterComponent,
    NiPanelComponent,
    NiStatComponent,
    NiForestComponent,
  ],
  styleUrls: ['../news-intel-shared.scss'],
  template: `
    <div class="page">
      <header class="page-head">
        <div class="title">
          <h1>Event study</h1>
          <app-ni-info
            text="What the market did after news, measured point-in-time: forward returns start at the first candle close AFTER the engine first saw the article, in ATR(14, H1) units, signed by label direction × leg sign. Positive = the price moved the way the label said."
          />
          @if (detail(); as d) {
            <span class="pill" [class.ok]="d.run.alignmentVerdict === 'Positive'" [class.bad]="d.run.alignmentVerdict === 'Negative'" [class.warn]="d.run.alignmentVerdict === 'Inconclusive'">
              run #{{ d.run.id }} · {{ d.run.alignmentVerdict ?? d.run.status }}
            </span>
          }
        </div>
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
        @if (detail(); as d) {
          @if (d.run.error) {
            <div class="banner error">Run #{{ d.run.id }} failed: {{ d.run.error }}</div>
          }
          <!-- ── KPI strip ── -->
          <div class="ni-kpis k8">
            <app-ni-stat
              label="Verdict"
              [value]="d.run.alignmentVerdict ?? '—'"
              [sub]="d.run.alignmentHorizonMinutes ? 'news alignment @ ' + d.run.alignmentHorizonMinutes + 'm' : null"
              [tone]="d.run.alignmentVerdict === 'Positive' ? 'ok' : d.run.alignmentVerdict === 'Negative' ? 'bad' : d.run.alignmentVerdict ? 'warn' : null"
              info="Positive = trading WITH the label beat zero (CI above 0). Inconclusive = the CI spans zero — no proven edge from news direction. Drives DirectionMode=Auto."
            />
            <app-ni-stat label="Effect" [value]="sg(d.run.alignmentMean)" unit="ATR" [sub]="'CI ' + sg(d.run.alignmentCiLow) + ' … ' + sg(d.run.alignmentCiHigh)" info="Mean signed forward return of all labels at the verdict horizon, with its cluster-robust 95% CI." />
            <app-ni-stat label="Hit rate" [value]="p(allRow()?.hitRate)" [sub]="'all labels @ ' + horizon() + 'm'" info="Share of observations where price moved the way the label said (50% = coin flip)." />
            <app-ni-stat label="Observations" [value]="compact(d.run.observations)" [sub]="compact(d.run.labelsConsidered) + ' labels'" info="Label × symbol × horizon observations measured; labels = article × exposure labels first seen in the window." />
            <app-ni-stat label="Symbols" [value]="coverage().measured + '/' + coverage().total" [sub]="coverage().skipped + ' without candles'" [tone]="coverage().skipped ? 'warn' : null" info="Symbols with M5/M1 candles to measure against. A symbol without candles is skipped, not counted as zero." />
            <app-ni-stat label="Window" [value]="(d.run.fromUtc | date: 'MMM d' : 'UTC') + ' →'" [sub]="(d.run.toUtc | date: 'MMM d' : 'UTC') + ' · ' + (d.run.trigger ?? '')" info="Labels first seen in this window were studied." />
            <app-ni-stat label="Best term IC" [value]="bestTerm()?.value ?? '—'" [sub]="bestTerm()?.name ?? null" info="The weight term whose rank IC vs signed forward return is largest in magnitude at this horizon. |IC| < 0.03 is noise." />
            <app-ni-stat label="Lineage" [value]="d.run.lineageFilter || 'all'" [sub]="d.run.paramsFingerprint ?? null" info="Prompt lineage studied (labels from different prompt versions are never pooled) and the weight-params fingerprint." />
          </div>

          <!-- ── Forest | horizons + term ICs ── -->
          <div class="ni-grid-main">
            <app-ni-panel
              title="Effect by group"
              info="Mean signed forward return (dot, sized by n) with its 95% cluster-robust CI (resampled by story/day). Green = CI above zero (helps), red = below (hurts), grey = spans zero, faded = under 30 observations (not evidence)."
            >
              <div actions class="ni-toolbar">
                <span class="seg" role="tablist" aria-label="Group by">
                  @for (dm of mainDims(); track dm) {
                    <button type="button" [class.on]="dm === dimension()" (click)="dimension.set(dm)">{{ dimLabel(dm) }}</button>
                  }
                </span>
                @if (otherDims().length) {
                  <select class="sel" aria-label="More groupings" (change)="dimension.set($any($event.target).value)">
                    <option value="" disabled [selected]="!otherDims().includes(dimension())">more…</option>
                    @for (dm of otherDims(); track dm) {
                      <option [value]="dm" [selected]="dm === dimension()">{{ dimLabel(dm) }}</option>
                    }
                  </select>
                }
                <span class="seg" role="tablist" aria-label="Horizon">
                  @for (h of horizons(); track h) {
                    <button type="button" [class.on]="h === horizon()" (click)="horizon.set(h)">{{ h }}m</button>
                  }
                </span>
              </div>
              <app-ni-forest [rows]="forestRows()" [dimLabel]="dimLabel(dimension())" />
              <div class="legend-line">
                <span><i class="dotk pos"></i>helps</span>
                <span><i class="dotk neg"></i>hurts</span>
                <span><i class="dotk"></i>no effect shown</span>
                <span><i class="dotk thin"></i>too few (&lt;30)</span>
                <span class="faint">dot area ∝ n · {{ forestRows().length }} groups</span>
              </div>
            </app-ni-panel>

            <div class="ni-stack">
              <app-ni-panel title="All labels by horizon" info="The pooled effect at each horizon. A real edge shows a CI clear of zero that holds or grows with the horizon.">
                <app-ni-forest [rows]="horizonRows()" dimLabel="horizon" [compact]="true" />
              </app-ni-panel>
              <app-ni-panel
                title="Weight terms · rank IC"
                info="Does a bigger term (severity, reliability, certainty, novelty, decay…) go with a bigger move in the labelled direction? Bar = rank IC at the selected horizon (scale ±0.1); near zero means the term is not earning its place."
              >
                <span meta>{{ horizon() }}m</span>
                <div class="ics">
                  @for (r of termRows(); track r.dimension + r.bucket) {
                    <div class="ic" [title]="(r.bucket || r.dimension) + ': IC ' + sg(r.mean) + ' CI [' + sg(r.ciLow) + ', ' + sg(r.ciHigh) + '] n ' + r.n">
                      <span class="icn">{{ r.bucket || r.dimension }}</span>
                      <app-ni-dbar [value]="r.mean" [max]="0.1" [digits]="3" />
                    </div>
                  } @empty {
                    <p class="empty">No term ICs at this horizon.</p>
                  }
                </div>
              </app-ni-panel>
            </div>
          </div>

          <!-- ── Recommended severities ── -->
          <app-ni-panel
            title="Recommended severities"
            [info]="'Shrunk toward today’s values by sample size; a category with too little data keeps its current severity. Applying writes ' + severityKey + ' through the normal config governance — a loosening change needs a reason and may be queued for cooling-off.'"
            [flush]="true"
          >
            <span meta>{{ changedCount() }} of {{ diff().length }} change · Δ scale ±{{ deltaMax().toFixed(2) }}</span>
            @if (canApply() && changedCount() > 0) {
              <button actions type="button" class="btn primary" [disabled]="busy()" (click)="confirmApply.set(true)">
                Apply via governance ({{ changedCount() }})
              </button>
            }
            @if (recError(); as re) {
              <p class="empty pad">{{ re }}</p>
            }
            <div class="table-wrap sev-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Category</th>
                    <th class="num">Current</th>
                    <th></th>
                    <th class="num">Recommended</th>
                    <th>Δ</th>
                    <th class="num">n / clusters</th>
                    <th>Basis</th>
                  </tr>
                </thead>
                <tbody>
                  @for (r of diff(); track r.category) {
                    <tr [class.unchanged]="!r.changed">
                      <td>{{ r.category }}</td>
                      <td class="num">{{ f(r.current, 2) }}</td>
                      <td class="arrow faint">→</td>
                      <td class="num"><b>{{ f(r.recommended, 2) }}</b></td>
                      <td style="min-width: 170px">
                        @if (r.changed) {
                          <app-ni-dbar [value]="r.delta" [max]="deltaMax()" [digits]="2" />
                        } @else {
                          <span class="faint xs">kept</span>
                        }
                      </td>
                      <td class="num faint">{{ meta(r.category) }}</td>
                      <td class="xs faint ellipsis" [title]="basis(r.category)">{{ basis(r.category) }}</td>
                    </tr>
                  } @empty {
                    <tr>
                      <td colspan="7" class="empty pad">No recommendation for this run.</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </app-ni-panel>

          <!-- ── Coverage & calibration ── -->
          <div class="ni-grid-2">
            <app-ni-panel title="Candle coverage" info="What could be measured: per symbol, the bars available and how many label observations were measured or skipped (no entry bar / no ATR). Raw JSON below." [flush]="true">
              <span meta>{{ coverage().measured }} of {{ coverage().total }} symbols measured</span>
              <div class="table-wrap cov-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Symbol</th>
                      <th>TF</th>
                      <th class="num">Bars</th>
                      <th>Measured</th>
                      <th class="num">Skipped</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (c of coverage().rows; track c.symbol + c.timeframe) {
                      <tr [class.unchanged]="!c.measured">
                        <td class="mono">{{ c.symbol }}</td>
                        <td class="faint">{{ c.timeframe }}</td>
                        <td class="num">{{ compact(c.bars) }}</td>
                        <td style="min-width: 120px"><app-ni-meter [value]="c.share" [label]="compact(c.measured)" [tone]="c.measured ? 'ok' : 'muted'" /></td>
                        <td class="num faint">{{ compact(c.skipped) }}</td>
                      </tr>
                    } @empty {
                      <tr><td colspan="5" class="empty pad">No coverage recorded.</td></tr>
                    }
                  </tbody>
                </table>
              </div>
            </app-ni-panel>
            <div class="ni-stack">
              <app-ni-panel title="Volatility calibration" info="Realised range vs normal, by how much news was in play. The risk forecast's expected-range multiplier is read from this table when Risk:Vol:Source = LatestStudy.">
                <span meta>{{ vol() ? vol()!.horizon + 'm · baseline ' + f(vol()!.baseline, 3) : '' }}</span>
                @if (vol(); as v) {
                  <div class="vol">
                    @for (b of v.bands; track b.band) {
                      <div class="vb" [title]="b.band + ': n ' + b.n + ', mean ratio ' + f(b.ratio, 3) + ', multiplier ×' + f(b.mult, 2)">
                        <span class="vbl">{{ b.band }}</span>
                        <app-ni-meter [value]="b.mult / v.maxMult" [label]="'×' + f(b.mult, 2)" />
                        <span class="faint num">{{ compact(b.n) }}</span>
                      </div>
                    }
                  </div>
                } @else {
                  <p class="empty">No calibration recorded.</p>
                }
                <a class="lnk" routerLink="/news-intel/risk">How these feed the risk settings →</a>
              </app-ni-panel>
              <app-ni-panel title="Raw" info="Exactly as the engine recorded them.">
                @for (blk of rawBlocks(); track blk.title) {
                  <details>
                    <summary class="xsmall">{{ blk.title }}</summary>
                    <pre class="raw">{{ blk.body }}</pre>
                  </details>
                }
              </app-ni-panel>
            </div>
          </div>
        }

        <!-- ── Runs ── -->
        <app-ni-panel title="Runs" info="The nightly worker runs one; 'Run study' starts one now (read-only over labels and candles, no model calls)." [flush]="true">
          @if (canRun()) {
            <div actions class="ni-toolbar">
              <span class="seg" role="group" aria-label="Window">
                @for (w of [14, 30, 45]; track w) {
                  <button type="button" [class.on]="windowDays() === w" (click)="windowDays.set(w)">{{ w }}d</button>
                }
              </span>
              <button type="button" class="btn primary" [disabled]="busy() || anyRunning()" (click)="confirmRun.set(true)">
                {{ anyRunning() ? 'Run in progress…' : 'Run study' }}
              </button>
            </div>
          }
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Started</th>
                  <th>Status</th>
                  <th>Window</th>
                  <th>Lineage</th>
                  <th class="num">Labels</th>
                  <th class="num">Obs.</th>
                  <th>Verdict</th>
                  <th class="num">Effect [CI] ATR</th>
                </tr>
              </thead>
              <tbody>
                @for (r of runs(); track r.id) {
                  <tr class="clickable" (click)="open(r)" [class.sel]="detail()?.run?.id === r.id">
                    <td class="mono">{{ r.id }}</td>
                    <td class="faint">{{ r.startedAtUtc | date: 'MMM d HH:mm' : 'UTC' }} · {{ r.trigger }}</td>
                    <td>
                      <span class="pill" [class.ok]="r.status === 'Completed'" [class.bad]="r.status === 'Failed'" [class.info]="r.status === 'Running'">{{ r.status }}</span>
                    </td>
                    <td class="faint">{{ r.fromUtc | date: 'MMM d' : 'UTC' }} → {{ r.toUtc | date: 'MMM d' : 'UTC' }}</td>
                    <td class="mono xs">{{ r.lineageFilter || 'each lineage' }}</td>
                    <td class="num">{{ compact(r.labelsConsidered) }}</td>
                    <td class="num">{{ compact(r.observations) }}</td>
                    <td>
                      <span class="pill" [class.ok]="r.alignmentVerdict === 'Positive'" [class.bad]="r.alignmentVerdict === 'Negative'" [class.warn]="r.alignmentVerdict === 'Inconclusive'">{{ r.alignmentVerdict ?? '—' }}</span>
                    </td>
                    <td class="num">
                      @if (r.alignmentMean !== null) {
                        {{ sg(r.alignmentMean) }} <span class="faint">[{{ sg(r.alignmentCiLow) }}, {{ sg(r.alignmentCiHigh) }}] @ {{ r.alignmentHorizonMinutes }}m</span>
                      } @else {
                        —
                      }
                    </td>
                  </tr>
                } @empty {
                  <tr>
                    <td colspan="9" class="empty pad">No study has run yet. The nightly worker runs one; "Run study" starts one now.</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </app-ni-panel>
      }

      <app-confirm-dialog
        [open]="confirmRun()"
        title="Run the event study?"
        [message]="'Reads ' + windowDays() + ' days of labels and candles (research process, read-only) and stores the aggregates. No model calls.'"
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
          <input class="inp" [value]="reason()" (input)="reason.set($any($event.target).value)" placeholder="e.g. event study #12, 30 days" />
        </label>
      </app-confirm-dialog>
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
      .legend-line {
        display: flex;
        flex-wrap: wrap;
        gap: 4px 12px;
        font-size: 10.5px;
        color: var(--text-secondary);
      }
      .legend-line span {
        display: inline-flex;
        align-items: center;
        gap: 4px;
      }
      .dotk {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--text-secondary);
      }
      .dotk.pos {
        background: var(--ni-up);
      }
      .dotk.neg {
        background: var(--ni-down);
      }
      .dotk.thin {
        opacity: 0.35;
      }
      .ics {
        display: flex;
        flex-direction: column;
        gap: 3px;
      }
      .ic {
        display: grid;
        grid-template-columns: 116px minmax(0, 1fr);
        align-items: center;
        gap: 8px;
        font-size: 11.5px;
      }
      .icn {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--text-secondary);
      }
      .sev-wrap {
        max-height: 520px;
      }
      .sev-wrap th:first-child,
      .sev-wrap td:first-child,
      .cov-wrap th:first-child,
      .cov-wrap td:first-child,
      app-ni-panel table th:first-child,
      app-ni-panel table td:first-child {
        padding-left: 12px;
      }
      .arrow {
        width: 14px;
        text-align: center;
        padding: 0;
      }
      tr.unchanged td {
        color: var(--text-tertiary);
      }
      td.ellipsis {
        max-width: 220px;
        width: auto;
      }
      .xs {
        font-size: 11px;
      }
      .cov-wrap {
        max-height: 420px;
      }
      .vol {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .vb {
        display: grid;
        grid-template-columns: 92px minmax(0, 1fr) 40px;
        align-items: center;
        gap: 8px;
        font-size: 11.5px;
      }
      .vbl {
        color: var(--text-secondary);
        white-space: nowrap;
      }
      .lnk {
        font-size: 11px;
        color: var(--accent);
        text-decoration: none;
      }
      .raw {
        max-height: 240px;
        overflow: auto;
        font-size: 10.5px;
        background: var(--ni-sunken);
        padding: 8px;
        border-radius: 6px;
        white-space: pre-wrap;
        margin: 4px 0 0;
      }
      .reason {
        display: flex;
        flex-direction: column;
        gap: 4px;
        margin-top: var(--space-2);
      }
      .empty.pad {
        padding: 12px;
      }
    `,
  ],
})
export class NewsEventStudyPageComponent {
  private readonly svc = inject(NewsIntelService);
  private readonly auth = inject(AuthService);
  private readonly destroyRef = inject(DestroyRef);

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

  // ── Dense redesign ──

  private static readonly MAIN_DIMS = ['category', 'kind', 'channel', 'certainty', 'novelty', 'storyState'];
  private static readonly DIM_LABEL: Record<string, string> = {
    category: 'Category',
    kind: 'Kind',
    channel: 'Channel',
    certainty: 'Certainty',
    novelty: 'Novelty',
    storyState: 'Story',
    liveness: 'Liveness',
    weightDecile: 'Weight decile',
    symbol: 'Symbol',
    lineage: 'Lineage',
    all: 'All',
  };
  dimLabel(d: string): string {
    return NewsEventStudyPageComponent.DIM_LABEL[d] ?? d;
  }
  readonly mainDims = computed(() =>
    NewsEventStudyPageComponent.MAIN_DIMS.filter((d) => this.dimensions().includes(d)),
  );
  readonly otherDims = computed(() =>
    this.dimensions().filter((d) => d !== 'all' && !NewsEventStudyPageComponent.MAIN_DIMS.includes(d)),
  );

  private toForest(r: NewsEventStudyResultView, bucket = r.bucket): ForestRow {
    return {
      bucket,
      n: r.n,
      clusters: r.clusters,
      mean: r.mean,
      ciLow: r.ciLow,
      ciHigh: r.ciHigh,
      hitRate: r.hitRate,
      tStat: r.tStat,
      verdict: ciVerdict(r),
    };
  }
  readonly forestRows = computed(() => this.groupRows().map((r) => this.toForest(r)));
  readonly horizonRows = computed(() =>
    this.results()
      .filter((r) => r.section === 'group' && r.dimension === 'all')
      .sort((a, b) => a.horizonMinutes - b.horizonMinutes)
      .map((r) => this.toForest(r, `${r.horizonMinutes} min`)),
  );
  readonly allRow = computed(() =>
    this.results().find((r) => r.section === 'group' && r.dimension === 'all' && r.horizonMinutes === this.horizon()) ?? null,
  );
  readonly bestTerm = computed(() => {
    const rows = [...this.termRows()].sort((a, b) => Math.abs(b.mean) - Math.abs(a.mean));
    const t = rows[0];
    return t ? { name: `${t.bucket || t.dimension} @ ${this.horizon()}m`, value: this.sg(t.mean) } : null;
  });

  readonly deltaMax = computed(() => Math.max(0.05, ...this.diff().map((d) => Math.abs(d.delta ?? 0))));

  readonly coverage = computed(() => {
    type Cov = { symbol: string; timeframe: string; bars: number; measured: number; skippedNoEntry: number; skippedNoAtr: number };
    let raw: Cov[] = [];
    try {
      const parsed = JSON.parse(this.detail()?.run.coverageJson ?? '[]');
      if (Array.isArray(parsed)) raw = parsed as Cov[];
    } catch {
      raw = [];
    }
    const rows = raw
      .map((c) => {
        const skipped = (c.skippedNoEntry ?? 0) + (c.skippedNoAtr ?? 0);
        const measured = c.measured ?? 0;
        return {
          symbol: c.symbol,
          timeframe: c.timeframe,
          bars: c.bars ?? 0,
          measured,
          skipped,
          share: measured + skipped ? measured / (measured + skipped) : 0,
        };
      })
      .sort((a, b) => b.measured - a.measured || a.symbol.localeCompare(b.symbol));
    const measuredSymbols = rows.filter((r) => r.measured > 0).length;
    return { rows, total: rows.length, measured: measuredSymbols, skipped: rows.length - measuredSymbols };
  });

  readonly vol = computed(() => {
    try {
      const v = JSON.parse(this.detail()?.run.volCalibrationJson ?? 'null') as {
        HorizonMinutes?: number;
        Baseline?: number;
        Bands?: { Band: string; N: number; MeanRatio: number; Multiplier: number }[];
      } | null;
      if (!v || !Array.isArray(v.Bands) || !v.Bands.length) return null;
      const bands = v.Bands.map((b) => ({ band: b.Band, n: b.N, ratio: b.MeanRatio, mult: b.Multiplier }));
      return {
        horizon: v.HorizonMinutes ?? null,
        baseline: v.Baseline ?? null,
        bands,
        maxMult: Math.max(1, ...bands.map((b) => b.mult)),
      };
    } catch {
      return null;
    }
  });

  compact(n: number | null | undefined): string {
    return compactNum(n);
  }
}
