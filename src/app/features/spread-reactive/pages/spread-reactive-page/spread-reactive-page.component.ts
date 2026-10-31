import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { ActivatedRoute } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { catchError, of } from 'rxjs';

import { SpreadReactiveService } from '@core/services/spread-reactive.service';
import { createPolledResource } from '@core/polling/polled-resource';
import { ApiError } from '@core/api/api.types';
import {
  SpreadCondition,
  SpreadReactiveConfig,
  SpreadStateEntry,
} from '@features/spread-reactive/spread-reactive.types';
import { SlAuditPageComponent } from '@features/sl-audit/pages/sl-audit-page/sl-audit-page.component';
import { BaselineFloorsTabComponent } from '@features/spread-reactive/components/baseline-floors-tab/baseline-floors-tab.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { RefreshButtonComponent } from '@shared/components/refresh-button/refresh-button.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';

/**
 * Spread-reactive subsystem: config + live state dashboard.
 *
 * The subsystem watches per-`(TradingAccount, Symbol)` spread, widens
 * SL away from the noise band when spread spikes (NY close, news,
 * weekend gaps), and reverts when spread normalises.  Off by default —
 * the master toggle is the panic-on, not just a UI hint.
 *
 * <p>The status section polls `/spread-reactive/state` every 5s and
 * shows the current condition per (account, symbol) so the operator
 * can see at a glance whether bumps are currently active anywhere.</p>
 */
@Component({
  selector: 'app-spread-reactive-page',
  standalone: true,
  imports: [
    DecimalPipe,
    SlAuditPageComponent,
    BaselineFloorsTabComponent,
    PageHeaderComponent,
    ConfirmDialogComponent,
    RefreshButtonComponent,
    MetricCardComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <app-page-header
        title="Spread-Reactive"
        subtitle="Opt-in SL widening on broker spread spikes — protects open positions during NY close, news, and weekend gaps.  Per-account baselines so Exness Raw vs Standard vs other brokers don't share one wrong number."
      >
        @if (serverConfig(); as cfg) {
          <!-- State badge + action button are separate: the badge says what
               the subsystem IS (the server's value, never a draft), the button
               says what clicking DOES. The old green-outlined "■ Disable" read
               as "enabled and healthy". -->
          <span class="state-badge" [class.on]="cfg.enabled">
            <span class="state-dot" aria-hidden="true"></span>
            {{ cfg.enabled ? 'Enabled' : 'Disabled' }}
          </span>
          <button
            type="button"
            class="power-btn"
            [class.on]="cfg.enabled"
            [disabled]="saving()"
            (click)="confirmAction.set('toggle')"
          >
            {{ cfg.enabled ? 'Disable' : 'Enable' }}
          </button>
        }
      </app-page-header>

      @if (error(); as e) {
        <div class="banner error">{{ e }}</div>
      }
      @if (saved()) {
        <div class="banner ok">Saved.</div>
      }

      <!-- ───────── Monitoring tabs ─────────
           Two views over the live subsystem: per-pair spread state
           (the worker's own real-time read) and the SL audit feed
           (historical record of every SL move).  Tab strip auto-
           selects 'audit' when the operator lands via a drill-in
           query param (?positionId=N from the EA Positions panel). -->
      <nav class="tabs" role="tablist" aria-label="Spread-Reactive views">
        <button
          type="button"
          role="tab"
          class="tab"
          [class.active]="activeTab() === 'state'"
          [attr.aria-selected]="activeTab() === 'state'"
          (click)="selectTab('state')"
        >
          Live state
          @if (stateRows().length > 0) {
            <span class="tab-count">{{ stateRows().length }}</span>
          }
          @if (elevatedCount() > 0) {
            <span class="tab-badge elevated">{{ elevatedCount() }}</span>
          }
        </button>
        <button
          type="button"
          role="tab"
          class="tab"
          [class.active]="activeTab() === 'floors'"
          [attr.aria-selected]="activeTab() === 'floors'"
          (click)="selectTab('floors')"
        >
          Baseline floors
        </button>
        <button
          type="button"
          role="tab"
          class="tab"
          [class.active]="activeTab() === 'audit'"
          [attr.aria-selected]="activeTab() === 'audit'"
          (click)="selectTab('audit')"
        >
          SL Audit
        </button>
        <button
          type="button"
          role="tab"
          class="tab"
          [class.active]="activeTab() === 'settings'"
          [attr.aria-selected]="activeTab() === 'settings'"
          (click)="selectTab('settings')"
        >
          Settings
          @if (dirty()) {
            <span class="tab-badge dirty">unsaved</span>
          }
        </button>
      </nav>

      <!-- ───────── Live state ───────── -->
      @if (activeTab() === 'state') {
        <!-- Summary tiles: "162 pairs observed" over a wall of grey WARMING
             pills looked healthy; these say how many pairs actually have a
             floor and how many are normal / warming / elevated. -->
        @if (stateRows().length > 0) {
          <div class="sr-kpis" role="status">
            <app-metric-card
              label="Pairs tracked"
              [value]="stateRows().length"
              [dotColor]="stateSummary().withBaseline === 0 ? '#ff9500' : '#0a84ff'"
              [caption]="stateSummary().withBaseline + ' with a floor'"
            />
            <app-metric-card
              label="Normal"
              [value]="stateSummary().normal"
              [dotColor]="stateSummary().normal > 0 ? '#34c759' : ''"
              caption="spread within its floor band"
            />
            <app-metric-card
              label="Warming"
              [value]="stateSummary().warming"
              [caption]="
                stateSummary().noSample > 0
                  ? stateSummary().noSample + ' with no sample yet'
                  : 'building a baseline'
              "
            />
            <app-metric-card
              label="Elevated"
              [value]="stateSummary().elevated"
              [dotColor]="stateSummary().elevated > 0 ? '#ff3b30' : ''"
              [caption]="
                stateSummary().elevated > 0 ? 'SL widening may be active' : 'no spread spikes'
              "
            />
          </div>
        }

        <section class="card state-card">
          <div class="status-head">
            <h2>Pairs</h2>
            <span class="count-chip">{{ filteredStateRows().length }}</span>
            <span class="status-meta">
              <input
                type="search"
                class="state-filter"
                placeholder="Filter symbol / account"
                [value]="stateFilter()"
                (input)="onStateFilter($any($event.target).value)"
                aria-label="Filter live state rows"
              />
              <!-- Bound to refreshing(), not loading(): loading() is true only until the
                   first paint, so a click that fetched unchanged rows showed nothing. -->
              <app-refresh-button
                variant="outline"
                [refreshing]="state.refreshing()"
                (refresh)="state.refresh()"
              />
            </span>
          </div>

          @if (pagedStateRows().length > 0) {
            <div class="state-table-wrap">
              <table class="state-table">
                <thead>
                  <tr>
                    <th>Account</th>
                    <th>Symbol</th>
                    <!-- The engine stores the latest tick's spread on every tick but
                         re-classifies only once per worker pass, so a row could read
                         ELEVATED at 0.5 × floor (or NORMAL at 3 ×) for up to one loop.
                         The figure under the pill is the spread the verdict was decided on
                         (conditionSpread, engine 2026-10-19). -->
                    <th
                      [attr.title]="
                        'From the worker’s last evaluation (every ' +
                        (serverConfig()?.loopIntervalSeconds ?? '?') +
                        ' s); the figure under it is the spread that verdict was decided on. Spread and × floor are the latest tick, so for up to one pass they can differ.'
                      "
                    >
                      Condition
                    </th>
                    <th class="num">Spread</th>
                    <th class="num">Floor</th>
                    <th class="num">Baseline (median)</th>
                    <th class="num">× floor</th>
                    <th class="num">Samples</th>
                    <th
                      class="num"
                      [attr.title]="
                        'Consecutive samples at or below floor × revert ratio. An active bump reverts after ' +
                        (revertSamples() ?? '?') +
                        ' in a row.'
                      "
                    >
                      Calm run
                    </th>
                    <th>Last sample</th>
                  </tr>
                </thead>
                <tbody>
                  @for (r of pagedStateRows(); track r.tradingAccountId + ':' + r.symbol) {
                    <tr [class.row-elevated]="r.condition === 'Elevated'">
                      <td class="mono small dim">{{ r.tradingAccountId }}</td>
                      <td class="mono strong">{{ r.symbol }}</td>
                      <td>
                        <span
                          class="condition-pill"
                          [class.warming]="r.condition === 'Warming'"
                          [class.normal]="r.condition === 'Normal'"
                          [class.elevated]="r.condition === 'Elevated'"
                          >{{ r.condition }}</span
                        >
                        @if (r.conditionSpread !== null && r.conditionSpread !== undefined) {
                          <span class="decided-on" [attr.title]="decidedOnTitle(r)">
                            on {{ r.conditionSpread | number: '1.5-5' }}
                            @if (decidedOnRatio(r); as ratio) {
                              · {{ ratio }}×
                            }
                          </span>
                        }
                      </td>
                      <!-- A never-sampled pair carries currentSpread 0: show "—", not a
                           spread of 0.00000 and a "× floor" of 0.00 it never measured. -->
                      <td class="num mono">
                        @if (hasSample(r)) {
                          {{ r.currentSpread | number: '1.5-5' }}
                        } @else {
                          <span class="muted">—</span>
                        }
                      </td>
                      <td class="num mono">
                        @if (r.floorBaseline !== null) {
                          {{ r.floorBaseline | number: '1.5-5' }}
                          @if (r.floorSource === 'OperatorOverride') {
                            <span class="floor-source-tag" title="Operator override">OV</span>
                          }
                        } @else {
                          <span class="muted" title="No floor — pair stands down">—</span>
                        }
                      </td>
                      <td class="num mono">
                        @if (r.baseline > 0) {
                          {{ r.baseline | number: '1.5-5' }}
                        } @else {
                          <span class="muted">—</span>
                        }
                      </td>
                      <td class="num mono" [class.muted]="r.floorBaseline === null">
                        {{ ratioOf(r) }}
                      </td>
                      <td class="num mono">{{ r.sampleCount }}</td>
                      <td class="num mono">{{ r.consecutiveCalmSamples }}</td>
                      <td class="small" [class.muted]="staleRow(r)">
                        {{ sampleAge(r) }}
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          } @else if (stateRows().length === 0) {
            <!-- The store is in-memory and re-warms over ~30 s of ticks after an
                 engine restart, so an empty list is a waiting state, not an error. -->
            <div class="empty-state">
              <span class="empty-icon" aria-hidden="true">◌</span>
              <h3>No telemetry yet</h3>
              <p>
                State warms up as ticks arrive from active EA instances — typically populates within
                30 s of engine start.
              </p>
            </div>
          } @else if (stateFilter().trim()) {
            <div class="empty-state">
              <h3>No pair matches “{{ stateFilter().trim() }}”</h3>
              <p>Filter matches a symbol or a trading-account id.</p>
              <button type="button" class="btn" (click)="onStateFilter('')">Clear filter</button>
            </div>
          } @else {
            <!-- Every pair is a never-sampled one hidden behind "Show them". -->
            <div class="empty-state">
              <span class="empty-icon pulse" aria-hidden="true"></span>
              <h3>Waiting for spread samples</h3>
              <p>
                {{ unsampled().count }} pairs ({{ unsampled().symbols }} symbols on accounts
                {{ unsampled().accounts.join(', ') }}) have a floor but no spread sample yet. A pair
                appears here once its EA streams spread samples for that symbol; until then it
                stands by as Warming.
              </p>
              <button type="button" class="btn" (click)="showUnsampled.set(true); statePage.set(1)">
                Show all {{ unsampled().count }} waiting pairs
              </button>
            </div>
          }

          @if (pagedStateRows().length > 0 && unsampled().count > 0 && !stateFilter().trim()) {
            <div class="unsampled-note">
              <span class="muted small">
                @if (showUnsampled()) {
                  Including {{ unsampled().count }} pairs with no spread sample yet.
                } @else {
                  {{ unsampled().count }} more pairs ({{ unsampled().symbols }} symbols on accounts
                  {{ unsampled().accounts.join(', ') }}) have a floor but no spread sample yet:
                  their EA has not streamed that symbol since the engine started, so they stand by
                  as Warming. They are hidden here.
                }
              </span>
              <button
                type="button"
                class="btn"
                (click)="showUnsampled.set(!showUnsampled()); statePage.set(1)"
              >
                {{ showUnsampled() ? 'Hide pairs with no sample' : 'Show them' }}
              </button>
            </div>
          }
          @if (statePageCount() > 1) {
            <div class="pager">
              <span class="muted small">
                Page {{ statePage() }} of {{ statePageCount() }} ·
                {{ filteredStateRows().length }} pairs
              </span>
              <span class="pages">
                <button
                  type="button"
                  class="btn"
                  [disabled]="statePage() <= 1"
                  (click)="statePage.set(statePage() - 1)"
                >
                  ‹ Prev
                </button>
                <button
                  type="button"
                  class="btn"
                  [disabled]="statePage() >= statePageCount()"
                  (click)="statePage.set(statePage() + 1)"
                >
                  Next ›
                </button>
              </span>
            </div>
          }
        </section>
      }

      <!-- ───────── Baseline floors ───────── -->
      @if (activeTab() === 'floors') {
        <app-baseline-floors-tab />
      }

      <!-- ───────── SL Audit ─────────
           Embedded fleet-wide SL audit feed.  Drill-in via
           ?positionId=N is handled inside the component (the section
           reads ActivatedRoute.queryParamMap to pre-fill its filters).
           id="sl-audit" anchors the section for fragment-based deep
           links from the EA Positions panel. -->
      @if (activeTab() === 'audit') {
        <section class="card" id="sl-audit">
          <app-sl-audit-page />
        </section>
      }

      <!-- ───────── Settings ─────────
           Its own tab: the full form used to repeat under every
           monitoring tab, pushing Save/Reset to y≈7,600 on Live state. -->
      @if (activeTab() === 'settings' && config(); as cfg) {
        <!-- Configuration: 2x2 auto-fit grid so the 4 small panels
             share horizontal space on wide screens, stacking only
             below the per-cell minimum width.  Mirrors the EA detail
             page's logs+audit + positions+orders grid pattern. -->
        <div class="config-grid">
          <section class="card">
            <h2>Detection</h2>
            <p class="muted small">How the worker decides a pair is in elevated-spread state.</p>
            <div class="grid-2">
              <label class="field">
                <span>Baseline window (minutes)</span>
                <input
                  type="number"
                  min="1"
                  step="1"
                  [value]="cfg.baselineWindowMinutes"
                  (input)="patch({ baselineWindowMinutes: toInt($any($event.target).value, 1) })"
                />
                <small class="muted">Rolling window the worker uses for the median baseline.</small>
              </label>
              <label class="field">
                <span>Min samples before triggering</span>
                <input
                  type="number"
                  min="1"
                  step="1"
                  [value]="cfg.minSamplesBeforeTrigger"
                  (input)="patch({ minSamplesBeforeTrigger: toInt($any($event.target).value, 1) })"
                />
                <small class="muted"
                  >Warm-up gate — no bumps until this many samples collected.</small
                >
              </label>
              <label class="field">
                <span>Spread multiplier (k)</span>
                <input
                  type="number"
                  min="1"
                  step="0.1"
                  [value]="cfg.spreadMultiplier"
                  (input)="patch({ spreadMultiplier: toFloat($any($event.target).value, 1) })"
                />
                <small class="muted">
                  Condition flips to Elevated when
                  <em>current ≥ baseline × {{ cfg.spreadMultiplier | number: '1.1-2' }}</em
                  >.
                </small>
              </label>
            </div>
          </section>

          <section class="card">
            <h2>Action</h2>
            <p class="muted small">How far the SL is widened, and the hard cap.</p>
            <div class="grid-2">
              <label class="field">
                <span>Cushion multiplier</span>
                <input
                  type="number"
                  min="0"
                  step="0.1"
                  [value]="cfg.cushionMultiplier"
                  (input)="patch({ cushionMultiplier: toFloat($any($event.target).value, 0) })"
                />
                <small class="muted">
                  Bump amount =
                  <em>current_spread × {{ cfg.cushionMultiplier | number: '1.1-2' }}</em>
                  in price units.
                </small>
              </label>
              <label class="field">
                <span>Max bump distance (pips)</span>
                <input
                  type="number"
                  min="0"
                  step="1"
                  [value]="cfg.maxBumpDistancePips"
                  (input)="patch({ maxBumpDistancePips: toFloat($any($event.target).value, 0) })"
                />
                <small class="muted">
                  Hard floor — bump is clamped to this many pips × the symbol's PipSize.
                </small>
              </label>
            </div>
          </section>

          <section class="card">
            <h2>Revert</h2>
            <p class="muted small">When and how the worker restores the original SL.</p>
            <div class="grid-2">
              <label class="field">
                <span>Revert ratio</span>
                <input
                  type="number"
                  min="1"
                  step="0.1"
                  [value]="cfg.revertRatio"
                  (input)="patch({ revertRatio: toFloat($any($event.target).value, 1) })"
                />
                <small class="muted">
                  A sample counts as "calm" when
                  <em>current ≤ baseline × {{ cfg.revertRatio | number: '1.1-2' }}</em
                  >.
                </small>
              </label>
              <label class="field">
                <span>Consecutive calm samples to revert</span>
                <input
                  type="number"
                  min="1"
                  step="1"
                  [value]="cfg.consecutiveCalmSamplesToRevert"
                  (input)="
                    patch({ consecutiveCalmSamplesToRevert: toInt($any($event.target).value, 1) })
                  "
                />
                <small class="muted"
                  >Hysteresis — prevents flickering reverts when spread oscillates.</small
                >
              </label>
            </div>
          </section>

          <section class="card">
            <h2>Safety</h2>
            <p class="muted small">Watchdog + tick cadence.</p>
            <div class="grid-2">
              <label class="field">
                <span>Telemetry freshness (seconds)</span>
                <input
                  type="number"
                  min="10"
                  step="1"
                  [value]="cfg.telemetryFreshnessSeconds"
                  (input)="
                    patch({ telemetryFreshnessSeconds: toInt($any($event.target).value, 10) })
                  "
                />
                <small class="muted">
                  If no ticks arrive for this long, bump/revert decisions freeze — uncertain = stay
                  safe.
                </small>
              </label>
              <label class="field">
                <span>Loop interval (seconds)</span>
                <input
                  type="number"
                  min="2"
                  step="1"
                  [value]="cfg.loopIntervalSeconds"
                  (input)="patch({ loopIntervalSeconds: toInt($any($event.target).value, 2) })"
                />
                <small class="muted">How often the worker re-evaluates conditions.</small>
              </label>
            </div>
          </section>

          <section class="card">
            <h2>Pre-emptive widening</h2>
            <p class="muted small">
              Schedules a daily SL widening on every open position BEFORE expected spread-widening
              windows (e.g. nightly NY close, Sunday-night Monday-open gap). Bumps widen by the same
              MaxBumpDistancePips cap a reactive bump would use, then revert normally once spreads
              normalise after the protection window closes.
            </p>
            <div class="grid-2">
              <label class="field">
                <span>Pre-emption enabled</span>
                <select
                  [value]="cfg.preEmptiveEnabled ? 'true' : 'false'"
                  (change)="patch({ preEmptiveEnabled: $any($event.target).value === 'true' })"
                >
                  <option value="true">Enabled</option>
                  <option value="false">Disabled</option>
                </select>
                <small class="muted"
                  >Off → no scheduled bumps; reactive bumps still active when master switch is
                  on.</small
                >
              </label>
              <label class="field">
                <span>Trigger hour (UTC)</span>
                <input
                  type="number"
                  min="0"
                  max="23"
                  step="1"
                  [value]="cfg.preEmptiveTriggerHourUtc"
                  (input)="
                    patch({ preEmptiveTriggerHourUtc: toInt($any($event.target).value, 20) })
                  "
                />
                <small class="muted">
                  Fires once per UTC day at the start of this hour. 20 = 9pm WAT (1h before NY-close
                  widening at 10pm WAT).
                </small>
              </label>
              <label class="field">
                <span>Protection window (hours)</span>
                <input
                  type="number"
                  min="1"
                  step="1"
                  [value]="cfg.preEmptiveProtectionHours"
                  (input)="
                    patch({ preEmptiveProtectionHours: toInt($any($event.target).value, 4) })
                  "
                />
                <small class="muted">
                  How long bumps are immune from the normal hysteresis revert. Normal revert takes
                  over after this window closes.
                </small>
              </label>
              <div class="field">
                <span>Fire now</span>
                <button
                  type="button"
                  class="btn primary"
                  [disabled]="firingPreEmptive()"
                  (click)="confirmAction.set('fire')"
                >
                  {{ firingPreEmptive() ? 'Firing…' : 'Fire pre-emption now' }}
                </button>
                <small class="muted">
                  Same code path as the daily schedule. Idempotent — only acts on positions WITHOUT
                  an active bump.
                </small>
                @if (preEmptiveFireResult(); as r) {
                  <small class="banner ok small">{{ r }}</small>
                }
              </div>
            </div>
          </section>

          <section class="card">
            <h2>Signal-entry pad</h2>
            <p class="muted small">
              Direction-aware shift of signal entry/SL/TP by the persistent floor at order
              placement. Long: entry + SL move down (same risk, more reward). Short: entry + TP move
              up (smaller risk, same reward, lots resized). Order forced to Limit when applied —
              fills only on a pullback to the padded entry, otherwise expires via the normal
              signal-expiry sweep.
            </p>
            <div class="grid-2">
              <label class="field">
                <span>Pad enabled</span>
                <select
                  [value]="cfg.padEnabled ? 'true' : 'false'"
                  (change)="patch({ padEnabled: $any($event.target).value === 'true' })"
                >
                  <option value="true">Enabled</option>
                  <option value="false">Disabled (place at raw signal levels)</option>
                </select>
                <small class="muted"
                  >Off → no pad applied; orders go in at signal entry/SL/TP as before.</small
                >
              </label>
              <label class="field">
                <span>Floor multiplier</span>
                <input
                  type="number"
                  min="1"
                  max="10"
                  step="0.1"
                  [value]="cfg.padFloorMultiplier"
                  (input)="patch({ padFloorMultiplier: toFloat($any($event.target).value, 1) })"
                />
                <small class="muted">
                  Effective pad = floor × multiplier. 1.0 = legacy (pad = floor exactly). The floor
                  captures the calm-period spread (≈ p50), but spread spikes routinely hit 2-3× the
                  floor on real brokers — that's when SL gets touched even though Bid never reached
                  it. Raise to 2.5–3.5 on live broker accounts to absorb upper-tail spread.
                </small>
              </label>
            </div>
          </section>

          <section class="card">
            <h2>Floor capture</h2>
            <p class="muted small">
              How persistent floor baselines are established and promoted. Pairs without a floor
              stand down (no bumps / reverts) until one is captured or set manually on the Baseline
              floors tab.
            </p>
            <div class="grid-2">
              <label class="field">
                <span>Auto-capture enabled</span>
                <select
                  [value]="cfg.floorAutoCaptureEnabled ? 'true' : 'false'"
                  (change)="
                    patch({ floorAutoCaptureEnabled: $any($event.target).value === 'true' })
                  "
                >
                  <option value="true">Enabled</option>
                  <option value="false">Disabled (operator overrides only)</option>
                </select>
                <small class="muted"
                  >When off, only operator overrides can establish or change a floor.</small
                >
              </label>
              <label class="field">
                <span>Min calm samples to capture</span>
                <input
                  type="number"
                  min="1"
                  step="1"
                  [value]="cfg.floorMinCalmSamplesToCapture"
                  (input)="
                    patch({ floorMinCalmSamplesToCapture: toInt($any($event.target).value, 1) })
                  "
                />
                <small class="muted"
                  >Consecutive calm samples a pair must hold before its first floor (or a lower
                  candidate) is captured.</small
                >
              </label>
              <label class="field">
                <span>Promotion window (minutes)</span>
                <input
                  type="number"
                  min="1"
                  step="1"
                  [value]="cfg.floorPromotionWindowMinutes"
                  (input)="
                    patch({ floorPromotionWindowMinutes: toInt($any($event.target).value, 1) })
                  "
                />
                <small class="muted"
                  >How long a lower candidate must hold before being promoted to the active
                  floor.</small
                >
              </label>
            </div>
          </section>
        </div>

        <!-- Sticky footer: Save/Reset stay in view while the operator scrolls
             the four settings panels. -->
        <div class="actions-row" [class.dirty]="dirty()">
          <span class="muted small">
            {{ dirty() ? 'Unsaved changes' : 'All settings saved' }}
          </span>
          <button
            type="button"
            class="btn ghost"
            [disabled]="saving() || !dirty()"
            (click)="reset()"
          >
            Reset
          </button>
          <button
            type="button"
            class="btn primary"
            [disabled]="saving() || !dirty()"
            (click)="save()"
          >
            {{ saving() ? 'Saving…' : 'Save' }}
          </button>
        </div>
      } @else if (activeTab() === 'settings' && loading()) {
        <div class="muted">Loading…</div>
      } @else if (activeTab() === 'settings') {
        <!-- Never fall back to defaults on a failed read: Save / Enable would then
             write those defaults over the engine's real settings. -->
        <div class="card muted">
          Settings could not be loaded, so none are shown (saving defaults over the live values is
          exactly what that would invite).
          <button type="button" class="btn ghost" (click)="load()">Retry</button>
        </div>
      }

      <app-confirm-dialog
        [open]="confirmAction() === 'toggle'"
        [title]="serverConfig()?.enabled ? 'Disable spread-reactive?' : 'Enable spread-reactive?'"
        [message]="
          serverConfig()?.enabled
            ? 'Stops SL widening fleet-wide on the worker’s next tick. Bumps already applied stay where they are; open positions lose spread-spike protection.'
            : 'The worker starts widening (and reverting) stop-losses on live open positions on its next tick, using the current saved settings.'
        "
        [confirmLabel]="serverConfig()?.enabled ? 'Disable' : 'Enable'"
        [confirmVariant]="serverConfig()?.enabled ? 'destructive' : 'primary'"
        [loading]="saving()"
        (confirm)="toggleEnabled()"
        (cancelled)="confirmAction.set(null)"
      />
      <app-confirm-dialog
        [open]="confirmAction() === 'fire'"
        title="Fire pre-emptive widening now?"
        message="Widens the stop-loss on every open position that has no active bump, by up to the max bump distance — the same pass the daily schedule runs. Bumps revert normally once the protection window closes."
        confirmLabel="Fire now"
        confirmVariant="destructive"
        [loading]="firingPreEmptive()"
        (confirm)="firePreEmptiveNow()"
        (cancelled)="confirmAction.set(null)"
      />
    </div>
  `,
  styleUrl: './spread-reactive-page.component.scss',
})
export class SpreadReactivePageComponent {
  private readonly service = inject(SpreadReactiveService);

  protected readonly config = signal<SpreadReactiveConfig | null>(null);
  protected readonly serverConfig = signal<SpreadReactiveConfig | null>(null);
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly saved = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly firingPreEmptive = signal(false);
  protected readonly preEmptiveFireResult = signal<string | null>(null);
  /** Which consequential action is awaiting its confirm dialog. */
  protected readonly confirmAction = signal<'toggle' | 'fire' | null>(null);
  /** Calm samples the worker needs before reverting a bump (saved value). */
  protected readonly revertSamples = computed(
    () => this.serverConfig()?.consecutiveCalmSamplesToRevert ?? null,
  );

  protected readonly dirty = computed(() => {
    const c = this.config();
    const s = this.serverConfig();
    return c !== null && s !== null && JSON.stringify(c) !== JSON.stringify(s);
  });

  // Live spread-state polled from `/spread-reactive/state` every 5s.
  // In-memory store on the engine — cheap to poll, no DB round-trip.
  protected readonly state = createPolledResource<SpreadStateEntry[]>(
    () => this.service.getState(),
    { intervalMs: 5_000 },
  );
  protected readonly stateRows = computed<SpreadStateEntry[]>(() => {
    const rows = this.state.value() ?? [];
    // Surface elevated rows first, then by symbol — operator scans for trouble.
    return [...rows].sort((a, b) => {
      const ca = conditionWeight(a.condition);
      const cb = conditionWeight(b.condition);
      if (ca !== cb) return cb - ca;
      if (a.symbol !== b.symbol) return a.symbol.localeCompare(b.symbol);
      return a.tradingAccountId - b.tradingAccountId;
    });
  });
  protected readonly elevatedCount = computed(
    () => this.stateRows().filter((r) => r.condition === 'Elevated').length,
  );

  /** Counts for the summary strip above the table. */
  protected readonly stateSummary = computed(() => {
    const rows = this.stateRows();
    return {
      withBaseline: rows.filter((r) => r.floorBaseline != null && r.floorBaseline > 0).length,
      normal: rows.filter((r) => r.condition === 'Normal').length,
      warming: rows.filter((r) => r.condition === 'Warming').length,
      elevated: rows.filter((r) => r.condition === 'Elevated').length,
      noSample: rows.filter((r) => !this.hasSample(r)).length,
    };
  });

  // 162 (account, symbol) rows in one table pushed everything below it off
  // screen; filter + 50-row pages keep the section scannable.
  private static readonly STATE_PAGE_SIZE = 50;
  protected readonly stateFilter = signal('');
  protected readonly statePage = signal(1);
  /** Never-sampled pairs (a floor, no tick yet) are one summary line unless asked for (pages program). */
  protected readonly showUnsampled = signal(false);
  protected readonly unsampled = computed(() => {
    const rows = this.stateRows().filter((r) => !this.hasSample(r));
    const accounts = [...new Set(rows.map((r) => r.tradingAccountId))].sort((a, b) => a - b);
    const symbols = new Set(rows.map((r) => r.symbol)).size;
    return { count: rows.length, accounts, symbols };
  });
  protected readonly filteredStateRows = computed(() => {
    const q = this.stateFilter().trim().toUpperCase();
    if (!q)
      return this.showUnsampled()
        ? this.stateRows()
        : this.stateRows().filter((r) => this.hasSample(r));
    return this.stateRows().filter(
      (r) => r.symbol.toUpperCase().includes(q) || String(r.tradingAccountId).includes(q),
    );
  });
  protected readonly statePageCount = computed(() =>
    Math.max(
      1,
      Math.ceil(this.filteredStateRows().length / SpreadReactivePageComponent.STATE_PAGE_SIZE),
    ),
  );
  protected readonly pagedStateRows = computed(() => {
    const page = Math.min(this.statePage(), this.statePageCount());
    const start = (page - 1) * SpreadReactivePageComponent.STATE_PAGE_SIZE;
    return this.filteredStateRows().slice(
      start,
      start + SpreadReactivePageComponent.STATE_PAGE_SIZE,
    );
  });
  protected onStateFilter(value: string): void {
    this.stateFilter.set(value);
    this.statePage.set(1);
  }

  /**
   * Which of the two monitoring tabs (Live state / SL Audit) is visible.
   * Defaults to 'state' on first load; auto-flips to 'audit' when a
   * drill-in query param (positionId / source / symbol / accountId) is
   * present — operators landing from the EA Positions panel
   * `?positionId=N` link expect to see the audit pre-filtered to that
   * position without having to click the tab.
   */
  protected readonly activeTab = signal<'state' | 'floors' | 'audit' | 'settings'>('state');

  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);

  constructor() {
    this.load();
    // Clear the saved banner 2s after it appears.
    effect((onCleanup) => {
      if (this.saved()) {
        const t = setTimeout(() => this.saved.set(false), 2000);
        onCleanup(() => clearTimeout(t));
      }
    });

    // Drill-in detection: any of the SL-audit-specific query params being
    // present means the operator came from the EA Positions panel's
    // "history" link and expects the SL Audit tab to be active.
    this.route.queryParamMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((params) => {
      const drillIn =
        params.has('positionId') ||
        params.has('accountId') ||
        params.has('symbol') ||
        params.has('source');
      if (drillIn) this.activeTab.set('audit');
    });
  }

  protected selectTab(tab: 'state' | 'floors' | 'audit' | 'settings'): void {
    this.activeTab.set(tab);
  }

  /**
   * Read the saved config. A failed read leaves the form EMPTY — it used to
   * substitute the compile-time defaults (enabled: false) and present them as
   * the engine's settings, one Save / Enable away from writing them over the
   * real values.
   */
  protected load(): void {
    this.loading.set(true);
    this.error.set(null);
    this.service
      .getConfig()
      .pipe(
        catchError((e) => {
          this.error.set(this.toMessage(e));
          return of(null);
        }),
      )
      .subscribe((c) => {
        this.loading.set(false);
        if (!c) return;
        this.config.set({ ...c });
        this.serverConfig.set({ ...c });
      });
  }

  /**
   * Flip the master switch (after its confirm). Writes the SAVED config with only
   * `enabled` changed: the old path saved the whole draft, so unsaved Settings edits
   * went live with it — and on success replaced the draft, losing the rest.
   */
  protected toggleEnabled(): void {
    const s = this.serverConfig();
    if (!s || this.saving()) return;
    this.saving.set(true);
    this.error.set(null);
    this.service
      .saveConfig({ ...s, enabled: !s.enabled })
      .pipe(
        catchError((e) => {
          this.error.set(this.toMessage(e));
          return of(null);
        }),
      )
      .subscribe((res) => {
        this.saving.set(false);
        this.confirmAction.set(null);
        if (!res) return;
        this.serverConfig.set({ ...res });
        const draft = this.config();
        this.config.set(draft ? { ...draft, enabled: res.enabled } : { ...res });
        this.saved.set(true);
      });
  }

  protected patch(p: Partial<SpreadReactiveConfig>): void {
    const c = this.config();
    if (!c) return;
    this.config.set({ ...c, ...p });
  }

  protected save(): void {
    const c = this.config();
    if (!c || this.saving()) return;
    this.saving.set(true);
    this.error.set(null);
    this.service
      .saveConfig(c)
      .pipe(
        catchError((e) => {
          this.error.set(this.toMessage(e));
          this.saving.set(false);
          return of(null);
        }),
      )
      .subscribe((res) => {
        if (res) {
          this.config.set({ ...res });
          this.serverConfig.set({ ...res });
          this.saved.set(true);
        }
        this.saving.set(false);
      });
  }

  protected reset(): void {
    const s = this.serverConfig();
    if (s) this.config.set({ ...s });
  }

  protected firePreEmptiveNow(): void {
    if (this.firingPreEmptive()) return;
    this.firingPreEmptive.set(true);
    this.preEmptiveFireResult.set(null);
    this.service
      .firePreEmptiveNow()
      .pipe(
        catchError((e) => {
          this.error.set(this.toMessage(e));
          this.firingPreEmptive.set(false);
          this.confirmAction.set(null);
          return of(null);
        }),
      )
      .subscribe((bumped) => {
        this.firingPreEmptive.set(false);
        this.confirmAction.set(null);
        if (bumped !== null) {
          this.preEmptiveFireResult.set(`Fired — bumped ${bumped} position(s).`);
          setTimeout(() => this.preEmptiveFireResult.set(null), 6000);
        }
      });
  }

  // Template input coercion — Angular templates can't call the global
  // parseInt / parseFloat reliably, so expose tolerant helpers on the
  // component instance.  Both return `fallback` on NaN / non-finite input.
  protected toInt(v: unknown, fallback: number): number {
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : fallback;
  }

  protected toFloat(v: unknown, fallback: number): number {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  /** conditionSpread / floor — the ratio the verdict was made on; null without a floor. */
  protected decidedOnRatio(r: SpreadStateEntry): string | null {
    if (r.conditionSpread == null || r.floorBaseline == null || r.floorBaseline <= 0) return null;
    return (r.conditionSpread / r.floorBaseline).toFixed(2);
  }

  protected decidedOnTitle(r: SpreadStateEntry): string {
    const at = r.conditionEvaluatedAt ? new Date(r.conditionEvaluatedAt) : null;
    const when =
      at && !Number.isNaN(at.getTime())
        ? ` (sample at ${at.toISOString().slice(0, 19).replace('T', ' ')} UTC)`
        : '';
    return `The spread this ${r.condition} verdict was decided on${when}. Spread and × floor to the right are the latest tick.`;
  }

  /**
   * current / floor ratio for the table — "—" when no floor has been established,
   * or when the pair was never sampled (its currentSpread 0 printed "0.00 ×").
   */
  protected ratioOf(r: SpreadStateEntry): string {
    if (!this.hasSample(r)) return '—';
    if (r.floorBaseline == null || r.floorBaseline <= 0) return '—';
    return (r.currentSpread / r.floorBaseline).toFixed(2);
  }

  /**
   * A pair the worker has registered but never sampled carries
   * `lastSampleAt` = DateTime.MinValue / epoch zero and sampleCount 0.
   * Rendering that as a relative age produced "1065404125m 18s ago".
   */
  protected hasSample(r: SpreadStateEntry): boolean {
    if (!r.lastSampleAt || (r.sampleCount ?? 0) === 0) return false;
    const t = new Date(r.lastSampleAt).getTime();
    return Number.isFinite(t) && t > Date.UTC(2000, 0, 1);
  }

  /**
   * Rendered "last sample" age — "Xs" up to 60s, "Xm Ys" up to an hour,
   * then "Xh Ym"; "no sample yet" for never-sampled pairs.  Used to flag
   * stale rows where bumps will freeze in place (the engine applies the
   * TelemetryFreshnessSeconds gate at decision time).
   */
  protected sampleAge(r: SpreadStateEntry): string {
    if (!this.hasSample(r)) return 'no sample yet';
    const t = new Date(r.lastSampleAt).getTime();
    const diffSec = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (diffSec < 60) return `${diffSec}s ago`;
    const m = Math.floor(diffSec / 60);
    if (m < 60) {
      const s = diffSec % 60;
      return s === 0 ? `${m}m ago` : `${m}m ${s}s ago`;
    }
    const h = Math.floor(m / 60);
    if (h < 48) return `${h}h ${m % 60}m ago`;
    return `${Math.floor(h / 24)}d ago`;
  }

  /** Heuristic stale-row tag — last sample older than 2× the default freshness budget. */
  protected staleRow(r: SpreadStateEntry): boolean {
    if (!this.hasSample(r)) return true;
    return Date.now() - new Date(r.lastSampleAt).getTime() > 120 * 1_000;
  }

  private toMessage(e: unknown): string {
    // Engine envelope error — surface the response code + message verbatim.
    if (e instanceof ApiError) {
      return `${e.message} (code ${e.code})`;
    }
    // HTTP-layer error from Angular HttpClient — surface status + URL so
    // 404 / 401 / 500 are all immediately diagnosable (the previous
    // generic "Request failed" left the operator guessing).
    if (e instanceof HttpErrorResponse) {
      const url = e.url ? new URL(e.url).pathname : '(unknown URL)';
      const body =
        typeof e.error === 'string' && e.error.length > 0 && e.error.length < 240
          ? ` — ${e.error}`
          : '';
      return `HTTP ${e.status} ${e.statusText || ''} on ${url}${body}`.trim();
    }
    if (e instanceof Error) return e.message;
    return 'Request failed (unknown error type)';
  }
}

function conditionWeight(c: SpreadCondition): number {
  switch (c) {
    case 'Elevated':
      return 2;
    case 'Normal':
      return 1;
    case 'Warming':
      return 0;
  }
}
