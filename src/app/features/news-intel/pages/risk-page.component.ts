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
import { ConfigService, isQueuedForCoolingOff } from '@core/services/config.service';
import { AuthService } from '@core/auth/auth.service';
import { Permission } from '@core/auth/permissions.generated';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { errorText } from '@features/iam/iam.logic';
import { NewsIntelNavComponent } from '../components/news-intel-nav.component';
import {
  NiInfoComponent,
  NiKeyComponent,
  NiPanelComponent,
  NiStatComponent,
} from '../components/viz/ni-primitives';
import { HBarItem, NiHBarsComponent } from '../components/viz/ni-tabs-b';
import {
  DIRECTION_MODES,
  MULTI_ASSET_MODE_KEY,
  MULTI_ASSET_MODES,
  configValue,
  directionAdvice,
  fmt,
  parseMode,
  parseMultiAssetMode,
  riskObservationKindLabel,
  signed,
} from '../news-intel.logic';
import {
  NEWS_RISK_OBSERVATION_KINDS,
  NewsConfigEntry,
  NewsEventStudyRunView,
  NewsFocusResult,
  NewsRiskObservationKind,
  NewsRiskObservationPage,
} from '../news-intel.types';

const GATE_MODE = 'NewsIntel:BreakingGate:Mode';
const STOP_MODE = 'NewsIntel:Risk:StopWidening:Mode';
const DIRECTION = 'NewsIntel:Prompt:DirectionMode';
const RISK_MODES = ['Off', 'Observe', 'Enforce'] as const;

interface ModeControl {
  key: string;
  title: string;
  /** KPI-tile label. */
  short: string;
  value: string;
  options: readonly string[];
  /** Where the write goes: the news-intel config endpoint (NewsIntel: keys) or the generic one. */
  via: 'news' | 'config';
  shippedDefault: string;
  explain: Partial<Record<string, string>>;
}

/**
 * Risk use — news as RISK rather than direction: the breaking-news gate, stop widening from the news
 * volatility forecast, the prompt's direction mode (with the event study's verdict beside it) and the
 * multi-asset calendar blackout. Every switch is confirmed and written through the engine's config
 * governance; every shipped default is today's behaviour (Observe / Off / Full).
 *
 * A live check reads `GET news-intel/focus` for one symbol and shows what the gate and the forecast
 * see right now (the `risk` block — present once the validation engine build is deployed).
 */
@Component({
  selector: 'app-news-risk-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    RouterLink,
    NewsIntelNavComponent,
    ConfirmDialogComponent,
    NiPanelComponent,
    NiInfoComponent,
    NiStatComponent,
    NiKeyComponent,
    NiHBarsComponent,
  ],
  styleUrls: ['../news-intel-shared.scss'],
  template: `
    <div class="page">
      <header class="page-head">
        <div class="title">
          <h1>News as risk</h1>
          <span class="pill info plain">risk, not direction</span>
          <app-ni-info
            text="The first efficacy read found trades that AGREED with news pressure did worse than those against it. Until the event study says otherwise, news is used to size and pause risk — not to pick a side. Every switch below is confirmed and written through the engine's config governance; every shipped default is today's behaviour (Observe / Off / Full)."
          />
        </div>
      </header>
      <app-news-intel-nav [showRefresh]="true" [refreshing]="loading()" (refresh)="load()" />

      @if (error(); as e) {
        <div class="banner error">{{ e }}</div>
      }
      @if (notice(); as n) {
        <div class="banner info">{{ n }}</div>
      }

      <div class="ni-kpis">
        @for (c of controls(); track c.key) {
          <app-ni-stat
            [label]="c.short"
            [value]="c.value"
            [sub]="c.value === c.shippedDefault ? 'default' : 'changed from ' + c.shippedDefault"
            [tone]="c.value === 'Enforce' ? 'warn' : null"
          />
        }
        <app-ni-stat
          label="Study verdict"
          [value]="latestStudy()?.alignmentVerdict ?? '—'"
          [sub]="studySub()"
          [tone]="latestStudy()?.alignmentVerdict === 'Positive' ? 'ok' : latestStudy()?.alignmentVerdict === 'Negative' ? 'bad' : null"
          info="Event study alignment: mean signed forward return (ATR units) of trades aligned with news direction, with a bootstrap CI. Only a CI fully above zero supports signed direction in the prompt."
        />
        <app-ni-stat
          label="Observations"
          [value]="obs() ? obs()!.total + '' : '—'"
          [sub]="'last ' + obsWindowText()"
          [spark]="obsPerDay().values"
          [sparkLabels]="obsPerDay().labels"
        />
        <app-ni-stat label="Would block" [value]="modeCount('Observe')" sub="Observe · let through" />
        <app-ni-stat label="Refused" [value]="modeCount('Enforce')" sub="Enforce · blocked" [tone]="modeCountN('Enforce') ? 'warn' : null" />
      </div>

      <app-ni-panel
        title="Controls"
        [flush]="true"
        info="Each control's value in force, and the change flow: pick a mode → confirm (with a reason, required when a change loosens risk) → the engine's config governance writes it (may queue for cooling-off or send for approval)."
      >
        @if (!canEdit()) {
          <span meta>read-only — needs platform.engine.manage</span>
        }
        <div class="table-wrap">
          <table class="ctl">
            <thead>
              <tr>
                <th>Control</th>
                <th>Mode</th>
                <th>What it does now</th>
              </tr>
            </thead>
            <tbody>
              @for (c of controls(); track c.key) {
                <tr>
                  <td class="cn">
                    <span class="ct">{{ c.title }}</span>
                    <code>{{ c.key }}</code>
                  </td>
                  <td>
                    <div class="modes seg" role="group" [attr.aria-label]="c.title">
                      @for (o of c.options; track o) {
                        <button
                          type="button"
                          [class.on]="o === c.value"
                          [class.enf]="o === 'Enforce' && o === c.value"
                          [attr.aria-pressed]="o === c.value"
                          [disabled]="!canEdit() || busy() || o === c.value"
                          [title]="(c.explain[o] ?? o) + (o === c.shippedDefault ? ' (shipped default)' : '')"
                          (click)="ask(c, o)"
                        >
                          {{ o }}
                        </button>
                      }
                    </div>
                  </td>
                  <td class="ex">
                    <span>{{ c.explain[c.value] }}</span>
                    @switch (c.key) {
                      @case (gateKey) {
                        <span class="detail-line">
                          sev ≥ {{ cfg('NewsIntel:BreakingGate:MinSeverity', '0.7') }} · mag ≥
                          {{ cfg('NewsIntel:BreakingGate:MinMagnitude', '0.7') }} · leg |w| ≥
                          {{ cfg('NewsIntel:BreakingGate:MinLegWeight', '0.5') }} · pause
                          {{ cfg('NewsIntel:BreakingGate:PauseMinutes', '30') }}m · open-position alerts
                          {{ cfg('NewsIntel:BreakingGate:OpenExposureAlerts', 'true') === 'true' ? 'on' : 'off' }}
                          <app-ni-info
                            align="right"
                            text="Fires on a story that is New and Official/Confirmed, above the severity and magnitude floors, on a leg whose |weight| clears the floor; pauses new entries on the symbol. Open positions raise an alert — never an automatic close. Refusals under Enforce appear on Rejections with reason news_breaking; Observe would-blocks are recorded below."
                          />
                          <a routerLink="/rejections">Rejections →</a>
                        </span>
                      }
                      @case (stopKey) {
                        <span class="detail-line">
                          cap ×{{ cfg('NewsIntel:Risk:StopWidening:MaxFactor', '1.5') }} · never tightens
                          <app-ni-info
                            align="right"
                            text="Widens a stop by the news volatility multiplier, capped. It never tightens a stop and every existing cap still applies. Would-be stops are recorded below once wired to the observation log."
                          />
                        </span>
                      }
                      @case (directionKey) {
                        <span class="detail-line">
                          study
                          @if (latestStudy(); as st) {
                            <span class="pill plain" [class.ok]="st.alignmentVerdict === 'Positive'" [class.bad]="st.alignmentVerdict === 'Negative'">{{ st.alignmentVerdict ?? 'no verdict' }}</span>
                            @if (st.alignmentMean !== null) {
                              <span class="mono">{{ sg(st.alignmentMean) }} ATR [{{ sg(st.alignmentCiLow) }}, {{ sg(st.alignmentCiHigh) }}] @{{ st.alignmentHorizonMinutes }}m · #{{ st.id }}</span>
                            }
                          } @else {
                            <span class="faint">{{ studyMissing() }}</span>
                          }
                          → advises <b>{{ advice().mode }}</b>
                          <app-ni-info align="right" [text]="advice().text" />
                          <a routerLink="/news-intel/event-study">Study →</a>
                        </span>
                      }
                      @case (multiKey) {
                        <span class="detail-line">
                          generic engine config (outside NewsIntel:)
                          <a routerLink="/news-intel/coverage">Which symbols →</a>
                        </span>
                      }
                    }
                    @if (c.via === 'news' && !hasRow(c.key)) {
                      <span class="detail-line warn">No engine row yet — the shipped default applies; an engine that does not know the key ignores it.</span>
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      </app-ni-panel>

      <div class="ni-grid-main">
        <app-ni-panel
          title="Recorded observations"
          data-testid="risk-observations"
          info="Every news-as-risk decision the engine took on a live entry: what a gate in Observe WOULD have refused (entry allowed) and what one in Enforce did refuse. One row per symbol, key and event per window — per-tick re-checks are not repeated. Backtests are never recorded."
          [flush]="true"
        >
          <div actions class="filters">
            <select class="sel" aria-label="Kind" (change)="setObsKind($any($event.target).value)">
              <option value="">All kinds</option>
              @for (k of obsKinds; track k) {
                <option [value]="k">{{ kindLabel(k) }}</option>
              }
            </select>
            <span class="seg" role="group" aria-label="Window">
              @for (d of [1, 7, 30]; track d) {
                <button type="button" [class.on]="obsDays() === d" (click)="setObsDays(d + '')">{{ d === 1 ? '24h' : d + 'd' }}</button>
              }
            </span>
            <input class="inp mono sym" placeholder="Symbol" aria-label="Observation symbol" (change)="setObsSymbol($any($event.target).value)" />
          </div>
          @if (obs(); as o) {
            <div class="obs-top">
              <div>
                <h3>By kind</h3>
                <app-ni-hbars [items]="obsKindBars()" emptyText="Nothing recorded." style="--lab-w: 170px" />
              </div>
              <div>
                <h3>Top symbols</h3>
                @if (o.counts.length) {
                  <div class="legs">
                    @for (c of o.counts.slice(0, 24); track c.kind + c.symbol + c.mode) {
                      <span
                        class="key sym-chip"
                        [class.enf]="c.mode === 'Enforce'"
                        [title]="kindLabel(c.kind) + ' · ' + c.mode + ' · last ' + (c.lastObservedAtUtc | date: 'MMM d HH:mm' : 'UTC') + 'Z'"
                        >{{ c.symbol }} <b>{{ c.count }}</b></span
                      >
                    }
                  </div>
                } @else {
                  <p class="empty">No symbol yet.</p>
                }
              </div>
            </div>
            <div class="table-wrap obs-table">
              <table>
                <thead>
                  <tr>
                    <th class="num">When</th>
                    <th>Kind</th>
                    <th>Mode</th>
                    <th>Symbol · key</th>
                    <th>What</th>
                  </tr>
                </thead>
                <tbody>
                  @for (i of o.items; track i.id) {
                    <tr>
                      <td class="num faint" [title]="(i.observedAtUtc | date: 'MMM d HH:mm' : 'UTC') + 'Z'">{{ i.observedAtUtc | date: 'd MMM HH:mm' : 'UTC' }}</td>
                      <td class="xsmall nowrap">{{ kindLabel(i.kind) }}</td>
                      <td><span class="pill" [class.bad]="i.mode === 'Enforce'" [class.info]="i.mode === 'Observe'">{{ i.mode }}</span></td>
                      <td class="nowrap">
                        <span class="mono">{{ i.symbol }}</span>
                        @if (i.key) {
                          <app-ni-key [key]="i.key" [short]="true" />
                        }
                      </td>
                      <td class="what" [title]="(i.detail ?? i.eventRef ?? '') + (i.eventAtUtc ? ' · event at ' + (i.eventAtUtc | date: 'MMM d HH:mm' : 'UTC') + 'Z' : '')">
                        {{ i.detail ?? i.eventRef ?? '' }}
                        @if (i.eventAtUtc) {
                          <span class="faint"> · {{ i.eventAtUtc | date: 'HH:mm' : 'UTC' }}Z</span>
                        }
                      </td>
                    </tr>
                  } @empty {
                    <tr>
                      <td colspan="5" class="empty pad">Nothing recorded in this window.</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          } @else if (obsMissing()) {
            <p class="empty pad">This engine build does not record observations — would-blocks live only in the <code>trading.news_blackout.*</code> metrics and log lines.</p>
          } @else {
            <p class="empty pad">Loading…</p>
          }
        </app-ni-panel>

        <app-ni-panel
          title="Live check"
          info="Point-in-time read of one symbol through the focus service: what the breaking gate and the volatility forecast see right now."
        >
          <div actions class="filters">
            <input
              class="inp mono sym"
              [value]="symbol()"
              aria-label="Symbol"
              (input)="symbol.set($any($event.target).value.toUpperCase())"
              (keydown.enter)="check()"
            />
            <button type="button" class="btn" (click)="check()">Check</button>
          </div>
          @if (focus(); as f) {
            @if (f.risk; as r) {
              <div class="live-kpis">
                <app-ni-stat
                  label="Range"
                  [value]="'×' + f2(r.volatility.multiplier)"
                  [sub]="'vs normal · ' + r.volatility.horizonMinutes + 'm'"
                  [tone]="r.volatility.multiplier >= 1.5 ? 'warn' : null"
                />
                <app-ni-stat label="In play" [value]="f2(r.volatility.absolutePressure)" sub="abs pressure on legs" />
                <app-ni-stat label="High events" [value]="r.volatility.scheduledHighEvents" sub="in horizon" [tone]="r.volatility.scheduledHighEvents ? 'warn' : null" />
                <app-ni-stat label="Breaking" [value]="r.breakingStories.length" sub="stories pausing" [tone]="r.breakingStories.length ? 'bad' : null" />
              </div>
              <p class="faint xsmall">
                {{ checked() }} · coefficients from {{ r.volatility.source }} · pressure ×{{ f2(r.volatility.pressureCoefficient) }} · event ×{{ f2(r.volatility.eventCoefficient) }}
              </p>
              <h3>Breaking stories</h3>
              @if (r.breakingStories.length) {
                <ul class="lst">
                  @for (b of r.breakingStories; track b.articleId + b.key) {
                    <li>
                      <app-ni-key [key]="b.key" [short]="true" />
                      <span class="t" [title]="b.headline">{{ b.headline }}</span>
                      <span class="faint nowrap">{{ b.category }} · {{ b.certainty }} · sev {{ f2(b.severity) }} · mag {{ f2(b.magnitude) }}</span>
                      <span class="pill bad plain">until {{ b.pauseUntilUtc | date: 'HH:mm' : 'UTC' }}Z</span>
                    </li>
                  }
                </ul>
              } @else {
                <p class="empty">None on {{ checked() }}'s legs.</p>
              }
              <h3>Scheduled in horizon</h3>
              @if (r.scheduledEvents.length) {
                <ul class="lst">
                  @for (e of r.scheduledEvents; track e.key + e.scheduledAtUtc) {
                    <li>
                      <app-ni-key [key]="e.key" [short]="true" />
                      <span class="t" [title]="e.title">{{ e.title }}</span>
                      <span class="faint nowrap">{{ e.scheduledAtUtc | date: 'MMM d HH:mm' : 'UTC' }}Z</span>
                      <span class="pill plain" [class.warn]="e.impact === 'High'">{{ e.impact }}</span>
                    </li>
                  }
                </ul>
              } @else {
                <p class="empty">No scheduled event in the horizon.</p>
              }
            } @else {
              <p class="empty">This engine build returns no risk block for {{ checked() }} (the validation work is not deployed, or the module is off).</p>
            }
          } @else if (focusError(); as fe) {
            <p class="neg small">{{ fe }}</p>
          } @else {
            <p class="empty">Reading {{ checked() }}…</p>
          }
        </app-ni-panel>
      </div>

      <app-confirm-dialog
        [open]="pending() !== null"
        [title]="'Change ' + (pending()?.control?.title ?? '') + '?'"
        [message]="pendingText()"
        confirmLabel="Change"
        [confirmVariant]="pending()?.value === 'Enforce' ? 'destructive' : 'primary'"
        [loading]="busy()"
        (confirm)="write()"
        (cancelled)="pending.set(null)"
      >
        <label class="small reason">
          Reason (recorded; required when a change loosens risk)
          <input class="inp" [value]="reason()" (input)="reason.set($any($event.target).value)" />
        </label>
      </app-confirm-dialog>
    </div>
  `,
  styles: [
    `
      .ctl th:first-child,
      .ctl td:first-child {
        padding-left: 12px;
      }
      .ctl th:last-child,
      .ctl td:last-child {
        padding-right: 12px;
      }
      .ctl td {
        padding-top: 7px;
        padding-bottom: 7px;
        vertical-align: top;
      }
      .cn {
        width: 230px;
      }
      .ct {
        display: block;
        font-weight: 600;
        font-size: 12px;
      }
      .cn code {
        font-size: 10px;
        color: var(--text-tertiary);
      }
      .modes button {
        font-size: 11.5px;
        padding: 3px 10px;
      }
      /* The option in force is disabled (nothing to change to) but must not read as unavailable. */
      .modes button.on:disabled {
        opacity: 1;
        cursor: default;
      }
      .modes button:disabled:not(.on) {
        opacity: 0.45;
        cursor: not-allowed;
      }
      .modes button:not(:disabled):hover {
        color: var(--text-primary);
      }
      .modes button.enf {
        color: var(--ni-warn);
        font-weight: 600;
      }
      .ex {
        font-size: 12px;
        color: var(--text-secondary);
      }
      .ex > span:first-child {
        color: var(--text-primary);
      }
      .detail-line {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 4px 6px;
        margin-top: 3px;
        font-size: 11px;
        color: var(--text-tertiary);
      }
      .detail-line b {
        color: var(--text-primary);
      }
      .detail-line a {
        color: var(--accent);
        text-decoration: none;
      }
      .detail-line.warn {
        color: var(--ni-warn);
      }
      .detail-line .mono {
        font-size: 10.5px;
      }
      h3 {
        font-size: 10.5px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-tertiary);
        margin: 2px 0 4px;
      }
      .obs-top {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
        gap: 14px;
        padding: 0 12px;
      }
      .sym-chip b {
        font-weight: 600;
        margin-left: 2px;
      }
      .sym-chip.enf {
        border-color: color-mix(in oklab, var(--ni-bad) 50%, transparent);
      }
      .obs-table {
        max-height: 420px;
      }
      .obs-table th:first-child,
      .obs-table td:first-child {
        padding-left: 12px;
      }
      .obs-table th:last-child,
      .obs-table td:last-child {
        padding-right: 12px;
      }
      .nowrap app-ni-key {
        margin-left: 4px;
      }
      .what {
        max-width: 220px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .nowrap {
        white-space: nowrap;
      }
      .sym {
        width: 96px;
      }
      .live-kpis {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 6px;
      }
      .lst {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
      }
      .lst li {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr);
        gap: 2px 8px;
        align-items: center;
        padding: 4px 0;
        border-bottom: 1px dashed var(--border);
        font-size: 11.5px;
      }
      .lst li > .faint,
      .lst li > .pill {
        grid-column: 2;
        justify-self: start;
        font-size: 10.5px;
      }
      .lst .t {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .empty.pad {
        padding: 12px;
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
export class NewsRiskPageComponent {
  private readonly svc = inject(NewsIntelService);
  private readonly configs = inject(ConfigService);
  private readonly auth = inject(AuthService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly gateKey = GATE_MODE;
  protected readonly stopKey = STOP_MODE;
  protected readonly multiKey = MULTI_ASSET_MODE_KEY;
  protected readonly directionKey = DIRECTION;

  readonly entries = signal<NewsConfigEntry[]>([]);
  readonly multiMode = signal<string>('Observe');
  readonly latestStudy = signal<NewsEventStudyRunView | null>(null);
  readonly studyMissing = signal('Loading…');
  readonly loading = signal(false);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly notice = signal<string | null>(null);
  readonly pending = signal<{ control: ModeControl; value: string } | null>(null);
  readonly reason = signal('');
  readonly symbol = signal('EURUSD');
  readonly checked = signal('EURUSD');
  readonly focus = signal<NewsFocusResult | null>(null);
  readonly focusError = signal<string | null>(null);
  readonly obs = signal<NewsRiskObservationPage | null>(null);
  readonly obsMissing = signal(false);
  readonly obsKind = signal<NewsRiskObservationKind | null>(null);
  readonly obsDays = signal(7);
  readonly obsSymbol = signal('');
  protected readonly obsKinds = NEWS_RISK_OBSERVATION_KINDS;
  readonly obsCountKinds = computed(() => Object.keys(this.obs()?.countsByKind ?? {}).sort());
  kindLabel = riskObservationKindLabel;

  readonly obsKindBars = computed<HBarItem[]>(() => {
    const c = this.obs()?.countsByKind ?? {};
    return NEWS_RISK_OBSERVATION_KINDS.map((k) => ({
      label: riskObservationKindLabel(k),
      value: c[k] ?? 0,
      color: k === 'StopWidening' ? 'var(--ni-k-factor)' : k === 'BreakingGate' ? 'var(--ni-k-crypto)' : 'var(--ni-k-commodity)',
    })).filter((x) => x.value > 0);
  });

  /** Observations per UTC day across the window (from the listed items, newest 200). */
  readonly obsPerDay = computed(() => {
    const items = this.obs()?.items ?? [];
    const days = Math.max(1, this.obsDays());
    const values: number[] = [];
    const labels: string[] = [];
    const today = Date.parse(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today - i * 86_400_000).toISOString().slice(0, 10);
      labels.push(d.slice(5));
      values.push(items.filter((x) => x.observedAtUtc.slice(0, 10) === d).length);
    }
    return { values: days > 1 ? values : null, labels };
  });

  readonly obsWindowText = computed(() => (this.obsDays() === 1 ? '24 h' : `${this.obsDays()} days`));

  readonly studySub = computed(() => {
    const s = this.latestStudy();
    if (!s) return this.studyMissing() || null;
    if (s.alignmentMean === null) return `run #${s.id}`;
    return `${signed(s.alignmentMean)} ATR [${signed(s.alignmentCiLow)}, ${signed(s.alignmentCiHigh)}]`;
  });

  modeCountN(mode: string): number {
    return (this.obs()?.counts ?? []).filter((c) => c.mode === mode).reduce((s, c) => s + c.count, 0);
  }
  modeCount(mode: string): string {
    return this.obs() ? String(this.modeCountN(mode)) : '—';
  }

  readonly canEdit = computed(() => this.auth.hasPermission(Permission.PlatformEngineManage));
  readonly advice = computed(() => directionAdvice(this.latestStudy()?.alignmentVerdict));

  readonly controls = computed((): ModeControl[] => [
    {
      key: GATE_MODE,
      title: 'Breaking-news gate',
      short: 'Breaking gate',
      value: parseMode(configValue(this.entries(), GATE_MODE), RISK_MODES, 'Observe'),
      options: RISK_MODES,
      via: 'news',
      shippedDefault: 'Observe',
      explain: {
        Off: 'Off — breaking stories neither pause entries nor are recorded.',
        Observe: 'Observe — a would-be pause is logged and counted; entries still go through.',
        Enforce:
          'Enforce — new entries on the affected symbol are refused for the pause window (Tier-1, reason news_breaking).',
      },
    },
    {
      key: STOP_MODE,
      title: 'Stop widening from news volatility',
      short: 'Stop widening',
      value: parseMode(configValue(this.entries(), STOP_MODE), RISK_MODES, 'Off'),
      options: RISK_MODES,
      via: 'news',
      shippedDefault: 'Off',
      explain: {
        Off: 'Off — stops are sized exactly as today.',
        Observe: 'Observe — the widened stop is computed and logged; the order keeps today’s stop.',
        Enforce:
          'Enforce — stops are widened by the news volatility multiplier (never tightened, capped).',
      },
    },
    {
      key: DIRECTION,
      title: 'Direction mode (spot-analysis prompt)',
      short: 'Direction',
      value: parseMode(configValue(this.entries(), DIRECTION), DIRECTION_MODES, 'Full'),
      options: DIRECTION_MODES,
      via: 'news',
      shippedDefault: 'Full',
      explain: {
        Full: 'Full — the prompt shows signed news bias, exactly as today.',
        RiskOnly:
          'RiskOnly — the prompt shows absolute pressure, the volatility multiplier, breaking stories and scheduled events, not the signed bias, and says direction is unvalidated.',
        Auto: 'Auto — RiskOnly unless the latest event study’s alignment verdict is significantly positive.',
      },
    },
    {
      key: MULTI_ASSET_MODE_KEY,
      title: 'Multi-asset calendar blackout',
      short: 'Blackout',
      value: this.multiMode(),
      options: MULTI_ASSET_MODES,
      via: 'config',
      shippedDefault: 'Observe',
      explain: {
        Off: 'Off — scheduled market events and the added calendar keys are ignored (FX/metal legacy blackout unchanged).',
        Observe:
          'Observe — High-impact events on the added keys are recorded as "would block"; entries go through.',
        Enforce:
          'Enforce — High-impact events on indices, stocks, energy and crypto calendar keys refuse new entries (earnings, EIA, OPEC+, promoted CB decisions).',
      },
    },
  ]);

  readonly pendingText = computed(() => {
    const p = this.pending();
    if (!p) return '';
    return `${p.control.key}: ${p.control.value} → ${p.value}. ${p.control.explain[p.value] ?? ''} Written through the engine's config governance and recorded in the history.`;
  });

  constructor() {
    this.load();
    this.check();
  }

  setObsKind(v: string): void {
    this.obsKind.set(v ? (v as NewsRiskObservationKind) : null);
    this.loadObservations();
  }

  setObsDays(v: string): void {
    this.obsDays.set(Number(v) || 7);
    this.loadObservations();
  }

  setObsSymbol(v: string): void {
    this.obsSymbol.set(v.trim().toUpperCase());
    this.loadObservations();
  }

  loadObservations(): void {
    const from = new Date(Date.now() - this.obsDays() * 24 * 3600_000).toISOString();
    this.svc
      .getRiskObservations({
        kind: this.obsKind(),
        symbol: this.obsSymbol() || null,
        fromUtc: from,
        take: 200,
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (o) => {
          this.obs.set(o);
          this.obsMissing.set(false);
        },
        error: () => {
          this.obs.set(null);
          this.obsMissing.set(true);
        },
      });
  }

  load(): void {
    this.loading.set(true);
    this.loadObservations();
    this.svc
      .getConfig()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (e) => {
          this.entries.set(e);
          this.loading.set(false);
        },
        error: (e) => {
          this.loading.set(false);
          this.error.set(errorText(e, 'Could not load the module configuration.'));
        },
      });
    this.configs
      .getByKey(MULTI_ASSET_MODE_KEY, { silent: true })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => this.multiMode.set(parseMultiAssetMode(r.data?.value)),
        error: () => this.multiMode.set('Observe'),
      });
    this.svc
      .getEventStudyRuns(10)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (runs) => {
          const done = runs.find((r) => r.status === 'Completed') ?? null;
          this.latestStudy.set(done);
          this.studyMissing.set(done ? '' : 'No completed study yet.');
        },
        error: (e) =>
          this.studyMissing.set(
            (e as { status?: number })?.status === 404
              ? 'This engine has no event study yet (validation work not deployed).'
              : 'Could not read the event study.',
          ),
      });
  }

  cfg(key: string, fallback: string): string {
    return configValue(this.entries(), key) ?? fallback;
  }

  hasRow(key: string): boolean {
    return this.entries().some((e) => e.key === key);
  }

  ask(control: ModeControl, value: string): void {
    this.reason.set('');
    this.pending.set({ control, value });
  }

  write(): void {
    const p = this.pending();
    if (!p) return;
    this.busy.set(true);
    this.error.set(null);
    const done = (msg: string) => {
      this.busy.set(false);
      this.pending.set(null);
      this.notice.set(msg);
      this.load();
    };
    const fail = (e: unknown) => {
      this.busy.set(false);
      this.pending.set(null);
      if (/-202-approval/.test(JSON.stringify(e ?? {})))
        this.notice.set(`${p.control.key}: sent for approval.`);
      else this.error.set(errorText(e, 'The change was not saved.'));
    };
    if (p.control.via === 'news') {
      this.svc
        .saveConfig([{ key: p.control.key, value: p.value, dataType: 'String' }], {
          reason: this.reason() || undefined,
        })
        .subscribe({ next: (m) => done(m.join(' · ') || 'Saved.'), error: fail });
      return;
    }
    this.configs
      .upsert({
        key: p.control.key,
        value: p.value,
        dataType: 'String',
        isHotReloadable: true,
        reason: this.reason() || null,
      })
      .subscribe({
        next: (res) => {
          if (!res.status) {
            if (res.responseCode === '-202-approval') done(`${p.control.key}: sent for approval.`);
            else fail({ message: res.message || 'The change was refused.' });
            return;
          }
          done(
            isQueuedForCoolingOff(res)
              ? `${p.control.key}: queued for cooling-off.`
              : `${p.control.key} saved.`,
          );
        },
        error: fail,
      });
  }

  check(): void {
    const s = this.symbol().trim();
    if (!s) return;
    this.checked.set(s);
    this.focusError.set(null);
    this.svc
      .getFocus(s, undefined, { silent: true })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (f) => this.focus.set(f),
        error: (e) => {
          this.focus.set(null);
          this.focusError.set(errorText(e, `Could not read ${s}.`));
        },
      });
  }

  f2(v: number | null | undefined): string {
    return fmt(v, 2);
  }

  sg(v: number | null | undefined): string {
    return signed(v);
  }
}
