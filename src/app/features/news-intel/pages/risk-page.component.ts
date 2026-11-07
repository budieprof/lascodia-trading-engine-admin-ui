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
  DIRECTION_MODES,
  MULTI_ASSET_MODE_KEY,
  MULTI_ASSET_MODES,
  configValue,
  directionAdvice,
  fmt,
  parseMode,
  parseMultiAssetMode,
  signed,
} from '../news-intel.logic';
import { NewsConfigEntry, NewsEventStudyRunView, NewsFocusResult } from '../news-intel.types';

const GATE_MODE = 'NewsIntel:BreakingGate:Mode';
const STOP_MODE = 'NewsIntel:Risk:StopWidening:Mode';
const DIRECTION = 'NewsIntel:Prompt:DirectionMode';
const RISK_MODES = ['Off', 'Observe', 'Enforce'] as const;

interface ModeControl {
  key: string;
  title: string;
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
  imports: [DatePipe, RouterLink, NewsIntelNavComponent, ConfirmDialogComponent],
  styleUrls: ['../news-intel-shared.scss'],
  template: `
    <div class="page">
      <header>
        <h1>News as risk</h1>
        <p class="muted small">
          The first efficacy read found trades that AGREED with news pressure did worse than those
          against it. Until the event study says otherwise, news is used to size and pause risk —
          not to pick a side.
        </p>
      </header>
      <app-news-intel-nav [showRefresh]="true" [refreshing]="loading()" (refresh)="load()" />

      @if (error(); as e) {
        <div class="banner error">{{ e }}</div>
      }
      @if (notice(); as n) {
        <div class="banner info">{{ n }}</div>
      }

      <section class="card">
        <h2>Direction in the prompt</h2>
        <div class="study">
          <span class="small">Latest event study:</span>
          @if (latestStudy(); as s) {
            <span
              class="pill"
              [class.ok]="s.alignmentVerdict === 'Positive'"
              [class.bad]="s.alignmentVerdict === 'Negative'"
              >{{ s.alignmentVerdict ?? 'no verdict' }}</span
            >
            @if (s.alignmentMean !== null) {
              <span class="mono xsmall">
                {{ sg(s.alignmentMean) }} ATR [{{ sg(s.alignmentCiLow) }},
                {{ sg(s.alignmentCiHigh) }}] @ {{ s.alignmentHorizonMinutes }} min · run #{{
                  s.id
                }}, {{ s.completedAtUtc | date: 'MMM d HH:mm' : 'UTC' }}</span
              >
            }
            <a class="xsmall" routerLink="/news-intel/event-study">details</a>
          } @else {
            <span class="muted xsmall">{{ studyMissing() }}</span>
          }
        </div>
        <p class="small">
          Study says: <strong>{{ advice().mode }}</strong> — {{ advice().text }}
        </p>
      </section>

      @for (c of controls(); track c.key) {
        <section class="card">
          <div class="card-head">
            <div>
              <h2>{{ c.title }}</h2>
              <code class="xsmall muted">{{ c.key }}</code>
            </div>
            <div class="modes" role="group" [attr.aria-label]="c.title">
              @for (o of c.options; track o) {
                <button
                  type="button"
                  class="btn"
                  [class.primary]="o === c.value"
                  [attr.aria-pressed]="o === c.value"
                  [disabled]="!canEdit() || busy() || o === c.value"
                  (click)="ask(c, o)"
                >
                  {{ o }}{{ o === c.shippedDefault ? ' (default)' : '' }}
                </button>
              }
            </div>
          </div>
          <p class="small">{{ c.explain[c.value] }}</p>
          @switch (c.key) {
            @case (gateKey) {
              <p class="muted xsmall">
                Fires on a story that is New, Official/Confirmed, severity ≥
                {{ cfg('NewsIntel:BreakingGate:MinSeverity', '0.7') }}, magnitude ≥
                {{ cfg('NewsIntel:BreakingGate:MinMagnitude', '0.7') }}, on a leg of |weight| ≥
                {{ cfg('NewsIntel:BreakingGate:MinLegWeight', '0.5') }}; pauses new entries for
                {{ cfg('NewsIntel:BreakingGate:PauseMinutes', '30') }} min. Open positions on the
                symbol raise an alert ({{
                  cfg('NewsIntel:BreakingGate:OpenExposureAlerts', 'true') === 'true'
                    ? 'on'
                    : 'off'
                }}) — never an automatic close. Refusals under Enforce appear on
                <a routerLink="/rejections">Rejections</a> with reason <code>news_breaking</code>;
                Observe would-blocks are logged and counted in metrics only (not exposed by the
                API).
              </p>
            }
            @case (stopKey) {
              <p class="muted xsmall">
                Widens a stop by the news volatility multiplier, capped at ×{{
                  cfg('NewsIntel:Risk:StopWidening:MaxFactor', '1.5')
                }}. It never tightens a stop and every existing cap still applies. The Observe log
                of would-be stops is in the engine log, not the API.
              </p>
            }
            @case (multiKey) {
              <p class="muted xsmall">
                Lives outside <code>NewsIntel:</code>, written through the generic engine config.
                <a routerLink="/news-intel/coverage">Which symbols it affects →</a>
              </p>
            }
          }
          @if (c.via === 'news' && !hasRow(c.key)) {
            <p class="muted xsmall">
              The engine lists no row for this key yet, so the shipped default applies. If this
              engine build does not know the key, setting it changes nothing.
            </p>
          }
        </section>
      }

      <section class="card">
        <div class="card-head">
          <div>
            <h2>Live check — what the gate and the forecast see now</h2>
            <p class="muted xsmall">Point-in-time read of one symbol through the focus service.</p>
          </div>
          <div class="filters">
            <input
              class="inp mono"
              [value]="symbol()"
              aria-label="Symbol"
              (input)="symbol.set($any($event.target).value.toUpperCase())"
              (keydown.enter)="check()"
            />
            <button type="button" class="btn" (click)="check()">Check</button>
          </div>
        </div>
        @if (focus(); as f) {
          @if (f.risk; as r) {
            <div class="tiles">
              <div class="tile">
                <span class="v">×{{ f2(r.volatility.multiplier) }}</span>
                <span class="k"
                  >expected range vs normal ({{ r.volatility.horizonMinutes }} min)</span
                >
              </div>
              <div class="tile">
                <span class="v">{{ f2(r.volatility.absolutePressure) }}</span>
                <span class="k">absolute pressure on its legs</span>
              </div>
              <div class="tile">
                <span class="v">{{ r.volatility.scheduledHighEvents }}</span>
                <span class="k">High events in horizon</span>
              </div>
              <div class="tile">
                <span class="v" [class.neg]="r.breakingStories.length > 0">{{
                  r.breakingStories.length
                }}</span>
                <span class="k">breaking stories</span>
              </div>
            </div>
            <p class="muted xsmall">Coefficients from {{ r.volatility.source }}.</p>
            @for (b of r.breakingStories; track b.articleId + b.key) {
              <div class="small">
                <span class="key">{{ b.key }}</span> {{ b.headline }}
                <span class="muted xsmall"
                  >· {{ b.category }} · {{ b.certainty }} · sev {{ f2(b.severity) }} · mag
                  {{ f2(b.magnitude) }} · paused until
                  {{ b.pauseUntilUtc | date: 'HH:mm' : 'UTC' }}Z</span
                >
              </div>
            }
            @for (e of r.scheduledEvents; track e.key + e.scheduledAtUtc) {
              <div class="xsmall">
                <span class="key">{{ e.key }}</span> {{ e.title }} ·
                {{ e.scheduledAtUtc | date: 'MMM d HH:mm' : 'UTC' }}Z · {{ e.impact }}
              </div>
            }
          } @else {
            <p class="muted small">
              This engine build returns no risk block for {{ checked() }} (the validation work is
              not deployed, or the module is off).
            </p>
          }
        } @else if (focusError(); as fe) {
          <p class="neg small">{{ fe }}</p>
        }
      </section>

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
      .modes {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
      }
      /* The option in force is disabled (nothing to change to) but must not read as unavailable. */
      .modes .btn.primary:disabled {
        opacity: 1;
        cursor: default;
      }
      .study {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-2);
        align-items: baseline;
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

  readonly canEdit = computed(() => this.auth.hasPermission(Permission.PlatformEngineManage));
  readonly advice = computed(() => directionAdvice(this.latestStudy()?.alignmentVerdict));

  readonly controls = computed((): ModeControl[] => [
    {
      key: GATE_MODE,
      title: 'Breaking-news gate',
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

  load(): void {
    this.loading.set(true);
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
