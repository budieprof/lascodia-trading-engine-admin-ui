import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { catchError, finalize, map, of } from 'rxjs';

import { EAInstancesService } from '@core/services/ea-instances.service';
import { EAAdminService } from '@core/services/ea-admin.service';
import { AuditTrailService } from '@core/services/audit-trail.service';
import { NotificationService } from '@core/notifications/notification.service';
import type {
  EABreakevenExitConfig,
  EAPendingSignalRevalConfig,
  EAFillMode,
  EAInstanceDetail,
  EAInstanceDto,
  UpdateEAConfigRequest,
} from '@core/api/api.types';
import { createPolledResource } from '@core/polling/polled-resource';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import { ProgressBarComponent } from '@shared/components/ui/progress-bar/progress-bar.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';

import { EAStatePanelComponent } from '../../components/ea-state-panel/ea-state-panel.component';
import { EAAuditTimelineComponent } from '../../components/ea-audit-timeline/ea-audit-timeline.component';
import { EAControlPanelComponent } from '../../components/ea-control-panel/ea-control-panel.component';
import { EAConfigPanelComponent } from '../../components/ea-config-panel/ea-config-panel.component';
import { EAPositionsPanelComponent } from '../../components/ea-positions-panel/ea-positions-panel.component';
import { EAPendingOrdersPanelComponent } from '../../components/ea-pending-orders-panel/ea-pending-orders-panel.component';
import { EALogsPanelComponent } from '../../components/ea-logs-panel/ea-logs-panel.component';
import { EARejectionsPanelComponent } from '../../components/ea-rejections-panel/ea-rejections-panel.component';

interface ConfigForm {
  // Per-instance safety
  maxPosPerSymbol: string;
  maxLotPerOrder: string;
  maxSpreadPoints: string;
  maxConsecLosses: string;
  consecLossPauseMin: string;
  maxDailyLossPerSymbolPct: string;
  // Global safety
  maxOpenPositions: string;
  maxDailyLossPct: string;
  maxOrdersPerMin: string;
}

@Component({
  selector: 'app-ea-detail-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    DecimalPipe,
    FormsModule,
    RouterLink,
    PageHeaderComponent,
    CardSkeletonComponent,
    ErrorStateComponent,
    EmptyStateComponent,
    ProgressBarComponent,
    RelativeTimePipe,
    EAStatePanelComponent,
    EAAuditTimelineComponent,
    EAControlPanelComponent,
    EAConfigPanelComponent,
    EAPositionsPanelComponent,
    EAPendingOrdersPanelComponent,
    EALogsPanelComponent,
    EARejectionsPanelComponent,
  ],
  template: `
    <div class="page">
      <app-page-header
        [title]="ea() ? 'EA · ' + ea()!.instanceId : 'EA Detail'"
        [subtitle]="ea() ? 'Trading account #' + ea()!.tradingAccountId : 'Loading…'"
      >
        @if (ea(); as eaSnap) {
          <span slot="title-after" class="version-pill mono" [title]="'EA binary version'"
            >v{{ eaSnap.eaVersion }}</span
          >
        }
        <a routerLink="/ea-instances" class="btn btn-secondary">← All EA Instances</a>
        <button
          type="button"
          class="btn btn-secondary"
          (click)="refreshAll()"
          [disabled]="anyLoading()"
        >
          @if (anyLoading()) {
            Refreshing…
          } @else {
            Refresh
          }
        </button>
      </app-page-header>

      <!--
        Always-visible loading affordance.  The per-section shimmers from the
        earlier change handle initial empty states, but real fetches resolve
        in <100ms locally and the shimmer flashes too briefly to register.
        This thin bar gives a consistent "something is happening" cue during
        any in-flight fetch (initial mount, 15s background polls, manual
        Refresh, post-command refresh).
      -->
      <ui-progress-bar [active]="anyLoading()" />

      @if (loading()) {
        <app-card-skeleton [lines]="6" />
      } @else if (resource.error()) {
        <app-error-state
          title="Could not load EA instances"
          message="Engine returned an error fetching the instance list."
          (retry)="resource.refresh()"
        />
      } @else if (!ea()) {
        <app-empty-state
          title="EA instance not found"
          description="No active EA instance matches the supplied id. The instance may have deregistered or the id is wrong."
        />
      } @else {
        <section class="overview-grid">
          <dl class="kv">
            <dt>Status</dt>
            <dd>
              <span class="status-pill" [attr.data-status]="ea()!.status">{{ ea()!.status }}</span>
              @if (ea()!.isCoordinator) {
                <span class="coord-pill">coordinator</span>
              }
            </dd>
            <dt>Instance id</dt>
            <dd class="mono">{{ ea()!.instanceId }}</dd>
            <dt>Trading account</dt>
            <dd class="mono">#{{ ea()!.tradingAccountId }}</dd>
            <dt>EA version</dt>
            <dd class="mono small">{{ ea()!.eaVersion }}</dd>
            <dt>Chart</dt>
            <dd class="mono">{{ ea()!.chartSymbol }} · {{ ea()!.chartTimeframe }}</dd>
          </dl>
          <dl class="kv">
            <dt>Last heartbeat</dt>
            <dd [title]="ea()!.lastHeartbeat | date: 'yyyy-MM-dd HH:mm:ss UTC'">
              <span [class.stale]="heartbeatStale()">
                {{ ea()!.lastHeartbeat | relativeTime }}
              </span>
            </dd>
            <dt>Registered</dt>
            <dd>{{ ea()!.registeredAt | date: 'yyyy-MM-dd HH:mm UTC' }}</dd>
            <dt>Deregistered</dt>
            <dd>
              @if (ea()!.deregisteredAt) {
                {{ ea()!.deregisteredAt | date: 'yyyy-MM-dd HH:mm UTC' }}
              } @else {
                <span class="muted">—</span>
              }
            </dd>
          </dl>
        </section>

        <!-- ── Control-panel grid ───────────────────────────────────────
             The five operator panels below (Trading, Fill mode, Breakeven
             exit, Pending-signal re-validation, Daily profit target) used
             to stack full-width.  Wrapped into a 2-up responsive grid so
             the page is denser on wide screens; collapses to 1-up below
             the min-cell width. -->
        <div class="ea-cards-grid">
          <!-- ── Trading enable / disable ─────────────────────────────────
             Operator-facing wrapper over the COMPLIANCE safety stop:
             "Disable trading" halts new order placement (open positions
             keep their trailing stops); "Enable trading" clears it.  The
             posture is read from the live-state envelope so the control
             reflects the EA's *actual* state — including auto-recovering
             stops and kill switches it can't itself clear — rather than
             just the last command we queued.  The richer per-category /
             kill-switch / flatten actions still live in Operator controls
             below. -->
          <section class="trading-control" [attr.data-state]="tradingPosture()">
            <div class="tc-info">
              <div class="tc-headline">
                <span class="tc-label">Trading</span>
                @switch (tradingPosture()) {
                  @case ('enabled') {
                    <span class="tc-pill ok">Enabled</span>
                  }
                  @case ('disabled-compliance') {
                    <span class="tc-pill bad">Disabled</span>
                  }
                  @case ('disabled-auto') {
                    <span class="tc-pill warn">Paused · {{ safetyCategory() }}</span>
                  }
                  @case ('disabled-kill') {
                    <span class="tc-pill bad">Disabled · kill switch</span>
                  }
                  @default {
                    <span class="tc-pill muted">—</span>
                  }
                }
              </div>
              <span class="tc-desc muted small">
                @switch (tradingPosture()) {
                  @case ('disabled-compliance') {
                    New orders halted by an operator safety stop. Open positions keep running.
                  }
                  @case ('disabled-auto') {
                    Auto-recovering safety stop — clears itself once its condition resolves. Manage
                    in Operator controls below.
                  }
                  @case ('disabled-kill') {
                    Kill switch is active. Release it from Operator controls below to resume.
                  }
                  @default {
                    Halt new order placement without touching open positions.
                  }
                }
              </span>
            </div>
            <div class="tc-actions">
              @if (tradingPosture() === 'disabled-compliance') {
                <button
                  type="button"
                  class="action-btn ok"
                  (click)="askEnableTrading()"
                  [disabled]="submitting()"
                >
                  Enable trading
                </button>
              } @else if (tradingPosture() === 'enabled' || tradingPosture() === 'unknown') {
                <button
                  type="button"
                  class="action-btn warn"
                  (click)="askDisableTrading()"
                  [disabled]="submitting()"
                >
                  Disable trading
                </button>
              }
            </div>
          </section>

          <!-- ── Fill mode toggle ─────────────────────────────────────────
             Per-EA execution-mode switch. Controls whether the engine emits
             the signal's structural entry price on the pending-execution
             wire payload (Limit — EA posts BUY/SELL_LIMIT at the anchor)
             or zeroes it so the EA's classifier takes its EXEC_MARKET
             escape hatch (Market — default).  Hot-reloads via
             EngineConfigCache on the EA's next poll. -->
          <section
            class="fill-mode-panel"
            [attr.data-mode]="fillModeDraft() ?? fillModeServer() ?? 'Market'"
          >
            <div class="fm-info">
              <div class="fm-headline">
                <span class="fm-label">Fill mode</span>
                @if (fillModeServer() === 'Market') {
                  <span class="fm-pill ok">Market</span>
                } @else if (fillModeServer() === 'Limit') {
                  <span class="fm-pill warn">Limit</span>
                } @else {
                  <span class="fm-pill muted">…</span>
                }
              </div>
              <span class="fm-desc muted small">
                @switch (fillModeDraft() ?? fillModeServer()) {
                  @case ('Market') {
                    Engine zeroes EntryPrice — EA fires at market on signal receipt. Recommended for
                    continuation theses.
                  }
                  @case ('Limit') {
                    Engine ships the signal anchor through — EA posts a pending limit at that price.
                    Use for fade/reversal theses.
                  }
                  @default {
                    Loading…
                  }
                }
              </span>
            </div>
            <div class="fm-actions">
              <div
                class="fm-toggle"
                role="radiogroup"
                aria-label="EA fill mode"
                [class.is-loading]="fillModeServer() === null"
              >
                <button
                  type="button"
                  role="radio"
                  class="fm-opt"
                  [class.active]="(fillModeDraft() ?? fillModeServer()) === 'Market'"
                  [attr.aria-checked]="(fillModeDraft() ?? fillModeServer()) === 'Market'"
                  [disabled]="fillModeServer() === null || savingFillMode()"
                  (click)="setFillMode('Market')"
                >
                  Market
                </button>
                <button
                  type="button"
                  role="radio"
                  class="fm-opt"
                  [class.active]="(fillModeDraft() ?? fillModeServer()) === 'Limit'"
                  [attr.aria-checked]="(fillModeDraft() ?? fillModeServer()) === 'Limit'"
                  [disabled]="fillModeServer() === null || savingFillMode()"
                  (click)="setFillMode('Limit')"
                >
                  Limit
                </button>
              </div>
              <div class="fm-status small">
                @if (savingFillMode()) {
                  <span class="muted">Saving…</span>
                } @else if (fillModeSaveError()) {
                  <span class="bad">{{ fillModeSaveError() }}</span>
                } @else if (fillModeSaved()) {
                  <span class="ok">Saved · takes effect on next EA poll</span>
                } @else if (fillModeDirty()) {
                  <span class="muted">Unsaved change</span>
                } @else {
                  <span class="muted">Default · Market</span>
                }
              </div>
              <div class="fm-buttons">
                <button
                  type="button"
                  class="btn btn-secondary"
                  (click)="resetFillMode()"
                  [disabled]="!fillModeDirty() || savingFillMode()"
                >
                  Revert
                </button>
                <button
                  type="button"
                  class="btn btn-primary"
                  (click)="saveFillMode()"
                  [disabled]="!fillModeDirty() || savingFillMode()"
                >
                  {{ savingFillMode() ? 'Saving…' : 'Save' }}
                </button>
              </div>
            </div>
          </section>

          <!-- ── Breakeven exit ────────────────────────────────────────────
             Per-account rule-based breakeven mechanics. Two independent
             toggles + their respective trigger fractions (R-units), wired
             through the engine's PositionWorker.  Defaults off — historical
             data (Apr-Jun 2026) shows salvage is net-negative across every
             reasonable threshold, so this is a deliberate opt-in lever
             rather than a default behaviour. -->
          <section
            class="be-panel"
            [attr.data-arm]="
              beDraft()?.salvageEnabled || beDraft()?.trailToBeEnabled ? 'on' : 'off'
            "
          >
            <div class="be-info">
              <div class="be-headline">
                <span class="be-label">Breakeven exit</span>
                @if (beServer() === null) {
                  <span class="be-pill muted">…</span>
                } @else if (beServer()?.salvageEnabled && beServer()?.trailToBeEnabled) {
                  <span class="be-pill warn">Salvage + Trail</span>
                } @else if (beServer()?.salvageEnabled) {
                  <span class="be-pill warn">Salvage</span>
                } @else if (beServer()?.trailToBeEnabled) {
                  <span class="be-pill warn">Trail</span>
                } @else {
                  <span class="be-pill muted">Off</span>
                }
              </div>
              <span class="be-desc muted small">
                Two mechanics, both off by default. Triggers are fractions of the position's SL
                distance (R-units). Hot-reloads on the next PositionWorker cycle.
              </span>
            </div>
            <div class="be-actions">
              @if (beDraft() !== null) {
                <!-- Salvage section -->
                <div class="be-section">
                  <label class="be-row">
                    <input
                      type="checkbox"
                      [checked]="beDraft()!.salvageEnabled"
                      [disabled]="savingBe()"
                      (change)="
                        updateBeDraft({
                          salvageEnabled: $any($event.target).checked,
                        })
                      "
                    />
                    <span class="be-section-name">Salvage exit</span>
                  </label>
                  <div class="be-fields" [class.disabled]="!beDraft()!.salvageEnabled">
                    <label class="be-field">
                      <span>MAE trigger</span>
                      <input
                        type="number"
                        step="0.05"
                        min="0.05"
                        max="1.0"
                        [value]="beDraft()!.salvageMaeTriggerR"
                        [disabled]="!beDraft()!.salvageEnabled || savingBe()"
                        (input)="
                          updateBeDraft({
                            salvageMaeTriggerR: $any($event.target).valueAsNumber,
                          })
                        "
                      />
                      <span class="be-unit">R</span>
                    </label>
                    <label class="be-field">
                      <span>Tolerance</span>
                      <input
                        type="number"
                        step="0.005"
                        min="0.005"
                        max="0.5"
                        [value]="beDraft()!.salvageToleranceR"
                        [disabled]="!beDraft()!.salvageEnabled || savingBe()"
                        (input)="
                          updateBeDraft({
                            salvageToleranceR: $any($event.target).valueAsNumber,
                          })
                        "
                      />
                      <span class="be-unit">R</span>
                    </label>
                  </div>
                  <p class="be-desc muted small">
                    Close at the live price once MAE crosses the trigger AND price returns within
                    the tolerance band around entry.
                  </p>
                </div>

                <!-- Trail to BE section -->
                <div class="be-section">
                  <label class="be-row">
                    <input
                      type="checkbox"
                      [checked]="beDraft()!.trailToBeEnabled"
                      [disabled]="savingBe()"
                      (change)="
                        updateBeDraft({
                          trailToBeEnabled: $any($event.target).checked,
                        })
                      "
                    />
                    <span class="be-section-name">Trail to breakeven</span>
                  </label>
                  <div class="be-fields" [class.disabled]="!beDraft()!.trailToBeEnabled">
                    <label class="be-field">
                      <span>MFE trigger</span>
                      <input
                        type="number"
                        step="0.05"
                        min="0.05"
                        max="2.0"
                        [value]="beDraft()!.trailToBeMfeTriggerR"
                        [disabled]="!beDraft()!.trailToBeEnabled || savingBe()"
                        (input)="
                          updateBeDraft({
                            trailToBeMfeTriggerR: $any($event.target).valueAsNumber,
                          })
                        "
                      />
                      <span class="be-unit">R</span>
                    </label>
                  </div>
                  <p class="be-desc muted small">
                    One-shot SL→entry move once MFE crosses the trigger. Subsequent reversals
                    through entry close the position at no loss.
                  </p>
                </div>

                <div class="be-status small">
                  @if (savingBe()) {
                    <span class="muted">Saving…</span>
                  } @else if (beSaveError()) {
                    <span class="bad">{{ beSaveError() }}</span>
                  } @else if (beSaved()) {
                    <span class="ok">Saved · takes effect on next PositionWorker cycle</span>
                  } @else if (beDirty()) {
                    <span class="muted">Unsaved change</span>
                  } @else {
                    <span class="muted">Default · both off</span>
                  }
                </div>
                <div class="be-buttons">
                  <button
                    type="button"
                    class="btn btn-secondary"
                    (click)="resetBe()"
                    [disabled]="!beDirty() || savingBe()"
                  >
                    Revert
                  </button>
                  <button
                    type="button"
                    class="btn btn-primary"
                    (click)="saveBe()"
                    [disabled]="!beDirty() || savingBe()"
                  >
                    {{ savingBe() ? 'Saving…' : 'Save' }}
                  </button>
                </div>
              } @else {
                <span class="muted small">Loading…</span>
              }
            </div>
          </section>

          <!-- ── Pending-signal re-validation ─────────────────────────────
             Engine-wide "park-and-revalidate" toggle for LLM signals
             whose entry is far from market at generation time (in ATR
             units). When enabled, the engine parks these signals in
             PendingReval status instead of placing stale limits; when
             price reaches the recommended entry, a fresh condensed
             LLM analysis decides whether to promote the signal (back
             to Approved with rewritten entry, fills at market) or
             kill it. The URL is per-EA for UI placement only — the
             setting is engine-wide and affects every account. -->
          <section class="be-panel" [attr.data-arm]="psrDraft()?.enabled ? 'on' : 'off'">
            <div class="be-info">
              <div class="be-headline">
                <span class="be-label">Pending-signal re-validation</span>
                <span
                  class="be-pill muted small"
                  title="Same setting affects every account on this engine."
                  >engine-wide</span
                >
                @if (psrServer() === null) {
                  <span class="be-pill muted">…</span>
                } @else if (psrServer()?.enabled) {
                  <span class="be-pill warn">Armed</span>
                } @else {
                  <span class="be-pill muted">Off</span>
                }
              </div>
              <span class="be-desc muted small">
                Park LLM recs whose entry is far from market and re-validate when price reaches it.
                Threshold is a fraction of the signal-generation ATR. Hot-reloads on the next
                gate/worker cycle. <strong>This is an engine-wide setting</strong> — flipping it
                from any EA's detail page affects every account.
              </span>
            </div>
            <div class="be-actions">
              @if (psrDraft() !== null) {
                <div class="be-section">
                  <label class="be-row">
                    <input
                      type="checkbox"
                      [checked]="psrDraft()!.enabled"
                      [disabled]="savingPsr()"
                      (change)="
                        updatePsrDraft({
                          enabled: $any($event.target).checked,
                        })
                      "
                    />
                    <span class="be-section-name">Enable park &amp; re-validate</span>
                  </label>
                  <div class="be-fields" [class.disabled]="!psrDraft()!.enabled">
                    <label class="be-field">
                      <span>ATR trigger</span>
                      <input
                        type="number"
                        step="0.1"
                        min="0.1"
                        max="3.0"
                        [value]="psrDraft()!.atrTrigger"
                        [disabled]="!psrDraft()!.enabled || savingPsr()"
                        (input)="
                          updatePsrDraft({
                            atrTrigger: $any($event.target).valueAsNumber,
                          })
                        "
                      />
                      <span class="be-unit">× ATR</span>
                    </label>
                    <label class="be-field">
                      <span>TTL</span>
                      <input
                        type="number"
                        step="1"
                        min="1"
                        max="24"
                        [value]="psrDraft()!.ttlHours"
                        [disabled]="!psrDraft()!.enabled || savingPsr()"
                        (input)="
                          updatePsrDraft({
                            ttlHours: $any($event.target).valueAsNumber,
                          })
                        "
                      />
                      <span class="be-unit">h</span>
                    </label>
                    <label class="be-field">
                      <span>Cooldown</span>
                      <input
                        type="number"
                        step="1"
                        min="1"
                        max="60"
                        [value]="psrDraft()!.cooldownMinutes"
                        [disabled]="!psrDraft()!.enabled || savingPsr()"
                        (input)="
                          updatePsrDraft({
                            cooldownMinutes: $any($event.target).valueAsNumber,
                          })
                        "
                      />
                      <span class="be-unit">min</span>
                    </label>
                    <label class="be-field">
                      <span>Max attempts</span>
                      <input
                        type="number"
                        step="1"
                        min="1"
                        max="10"
                        [value]="psrDraft()!.maxAttempts"
                        [disabled]="!psrDraft()!.enabled || savingPsr()"
                        (input)="
                          updatePsrDraft({
                            maxAttempts: $any($event.target).valueAsNumber,
                          })
                        "
                      />
                      <span class="be-unit">tries</span>
                    </label>
                  </div>
                  <p class="be-desc muted small">
                    Park if <code>|entry − live| / ATR ≥ trigger</code>. Re-validate when price
                    returns within trigger; cap retries with <em>Max attempts</em>; auto-expire
                    after <em>TTL</em>.
                  </p>
                </div>

                <div class="be-status small">
                  @if (savingPsr()) {
                    <span class="muted">Saving…</span>
                  } @else if (psrSaveError()) {
                    <span class="bad">{{ psrSaveError() }}</span>
                  } @else if (psrSaved()) {
                    <span class="ok">Saved · takes effect on next gate/worker cycle</span>
                  } @else if (psrDirty()) {
                    <span class="muted">Unsaved change</span>
                  } @else {
                    <span class="muted">Default · off</span>
                  }
                </div>
                <div class="be-buttons">
                  <button
                    type="button"
                    class="btn btn-secondary"
                    (click)="resetPsr()"
                    [disabled]="!psrDirty() || savingPsr()"
                  >
                    Revert
                  </button>
                  <button
                    type="button"
                    class="btn btn-primary"
                    (click)="savePsr()"
                    [disabled]="!psrDirty() || savingPsr()"
                  >
                    {{ savingPsr() ? 'Saving…' : 'Save' }}
                  </button>
                </div>
              } @else {
                <span class="muted small">Loading…</span>
              }
            </div>
          </section>

          <!-- ── Daily profit target ──────────────────────────────────────
             Prominent per-instance control. Reads the EA's echoed current
             target (heartbeat v8.47.210+), lets the operator set/clear it
             in one place, and badges when it's been reached today. -->
          <section class="dpt-panel" [class.is-hit]="dptHit()">
            <div class="dpt-info">
              <div class="dpt-headline">
                <span class="dpt-label">Daily profit target</span>
                @if (dptHit()) {
                  <span class="dpt-pill hit">Reached today</span>
                } @else if (dptEnabled()) {
                  <span class="dpt-pill on">Armed · {{ dptSummary() }}</span>
                } @else {
                  <span class="dpt-pill muted">Off</span>
                }
              </div>
              <span class="dpt-desc muted small">
                When this instance's daily P&amp;L (account equity vs start-of-day) reaches the
                target, the EA cancels pending orders, flattens open positions, and parks in
                SAFETY_STOP until the next trading day. Set a $ amount or a % of start-of-day equity
                (% wins if both are set). 0 disables.
              </span>
            </div>
            <div class="dpt-actions">
              <div class="dpt-inputs">
                <label class="dpt-field">
                  <span>Target ($)</span>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    inputmode="decimal"
                    [ngModel]="dptAbsDraft()"
                    (ngModelChange)="onDptAbs($event)"
                    [disabled]="savingDpt() || !dptLoaded()"
                  />
                </label>
                <label class="dpt-field">
                  <span>Target (% equity)</span>
                  <input
                    type="number"
                    min="0"
                    step="0.1"
                    inputmode="decimal"
                    [ngModel]="dptPctDraft()"
                    (ngModelChange)="onDptPct($event)"
                    [disabled]="savingDpt() || !dptLoaded()"
                  />
                </label>
              </div>
              <div class="dpt-status small">
                @if (savingDpt()) {
                  <span class="muted">Saving…</span>
                } @else if (dptSaveError()) {
                  <span class="bad">{{ dptSaveError() }}</span>
                } @else if (dptSaved()) {
                  <span class="ok">Saved · takes effect on next EA poll</span>
                } @else if (dptDirty()) {
                  <span class="muted">Unsaved change</span>
                } @else if (!dptLoaded()) {
                  <span class="muted">Loading current target…</span>
                } @else if (dptEnabled()) {
                  <span class="muted">Armed</span>
                } @else {
                  <span class="muted">Disabled</span>
                }
              </div>
              <div class="dpt-buttons">
                <button
                  type="button"
                  class="btn btn-secondary"
                  (click)="disableDpt()"
                  [disabled]="savingDpt() || !dptEnabled()"
                >
                  Disable
                </button>
                <button
                  type="button"
                  class="btn btn-secondary"
                  (click)="resetDpt()"
                  [disabled]="savingDpt() || !dptDirty()"
                >
                  Revert
                </button>
                <button
                  type="button"
                  class="btn btn-primary"
                  (click)="saveDpt()"
                  [disabled]="savingDpt() || !dptDirty()"
                >
                  {{ savingDpt() ? 'Saving…' : 'Save' }}
                </button>
              </div>
            </div>
          </section>
        </div>
        <!-- /.ea-cards-grid -->

        <!-- ── Account snapshot ─────────────────────────────────────────
             Broker-synced balance/equity/margin envelope for the EA's
             trading account.  Polled on the same cadence as the rest of
             the detail page (the EA's Phase-5 sync writes TradingAccount
             every 30s by default), so values refresh implicitly via the
             page-level polled resource. -->
        @if (account(); as acct) {
          <section class="account-block">
            <header class="account-head">
              <div class="account-title">
                <h3>Account · {{ acct.accountName }}</h3>
                <span class="account-meta mono small">
                  {{ acct.brokerName }} · {{ acct.brokerServer }} · {{ acct.accountType }} ·
                  {{ acct.marginMode }} · 1:{{ acct.leverage | number: '1.0-0' }}
                </span>
              </div>
              <div class="account-sync">
                @if (acct.isPaper) {
                  <span class="tag tag--paper">PAPER</span>
                }
                <span class="sync-ts" [title]="acct.lastSyncedAt | date: 'medium'">
                  synced {{ acct.lastSyncedAt | relativeTime }}
                </span>
              </div>
            </header>

            <!-- Primary tiles — balance, equity, free margin -->
            <div class="account-tiles">
              <div class="acct-tile">
                <div class="tile-label">Balance</div>
                <div class="tile-value mono">
                  {{ acct.balance | number: '1.2-2' }}
                  <span class="tile-ccy">{{ acct.currency }}</span>
                </div>
              </div>
              <div class="acct-tile">
                <div class="tile-label">Equity</div>
                <div
                  class="tile-value mono"
                  [class.tile-up]="acct.profit > 0"
                  [class.tile-down]="acct.profit < 0"
                >
                  {{ acct.equity | number: '1.2-2' }}
                  <span class="tile-ccy">{{ acct.currency }}</span>
                </div>
                @if (acct.profit !== 0) {
                  <div
                    class="tile-delta"
                    [class.tile-up]="acct.profit > 0"
                    [class.tile-down]="acct.profit < 0"
                  >
                    {{ acct.profit > 0 ? '+' : '' }}{{ acct.profit | number: '1.2-2' }} floating
                  </div>
                }
              </div>
              <div class="acct-tile">
                <div class="tile-label">Free margin</div>
                <div class="tile-value mono">
                  {{ acct.marginAvailable | number: '1.2-2' }}
                  <span class="tile-ccy">{{ acct.currency }}</span>
                </div>
                @if (acct.marginUsed > 0) {
                  <div class="tile-delta muted">
                    {{ marginUsedPct(acct) | number: '1.0-1' }}% used
                  </div>
                }
              </div>
              <div class="acct-tile">
                <div class="tile-label">Margin level</div>
                <div
                  class="tile-value mono"
                  [class.tile-warn]="marginLevelWarn(acct)"
                  [class.tile-down]="marginLevelDanger(acct)"
                >
                  @if (acct.marginUsed > 0) {
                    {{ acct.marginLevel | number: '1.0-1' }}%
                  } @else {
                    <span class="muted">—</span>
                  }
                </div>
                @if (acct.marginSoStopOut > 0) {
                  <div class="tile-delta muted">
                    stop-out @ {{ acct.marginSoStopOut | number: '1.0-0'
                    }}{{ acct.marginSoMode === 'Percent' ? '%' : ' ' + acct.currency }}
                  </div>
                }
              </div>
            </div>

            <!-- Secondary kv: margin used, credit, broker SO call/stop-out -->
            <dl class="account-kv">
              <dt>Margin used</dt>
              <dd class="mono">{{ acct.marginUsed | number: '1.2-2' }} {{ acct.currency }}</dd>
              <dt>Credit</dt>
              <dd class="mono">
                @if (acct.credit > 0) {
                  {{ acct.credit | number: '1.2-2' }} {{ acct.currency }}
                } @else {
                  <span class="muted">0</span>
                }
              </dd>
              <dt>Margin-call</dt>
              <dd class="mono">
                @if (acct.marginSoCall > 0) {
                  {{ acct.marginSoCall | number: '1.0-1'
                  }}{{ acct.marginSoMode === 'Percent' ? '%' : ' ' + acct.currency }}
                } @else {
                  <span class="muted">—</span>
                }
              </dd>
              <dt>Stop-out</dt>
              <dd class="mono">
                @if (acct.marginSoStopOut > 0) {
                  {{ acct.marginSoStopOut | number: '1.0-1'
                  }}{{ acct.marginSoMode === 'Percent' ? '%' : ' ' + acct.currency }}
                } @else {
                  <span class="muted">—</span>
                }
              </dd>
            </dl>
          </section>
        }

        <section class="symbols-block">
          <h3>Owned symbols</h3>
          @if (ownedSymbols().length === 0) {
            <p class="muted small">This instance owns no symbols.</p>
          } @else {
            <ul class="symbol-chips">
              @for (s of ownedSymbols(); track s) {
                <li>
                  <span class="symbol-chip mono">{{ s }}</span>
                </li>
              }
            </ul>
          }
        </section>

        <!-- Phase-1 admin: rich-state envelope visualization -->
        <app-ea-state-panel
          [state]="adminState()"
          [lastUpdated]="adminLastStateUpdatedAt()"
          [loading]="detailLoading()"
        />

        <!-- Phase-5b admin: live open positions + working orders, narrowed
             to symbols this specific EA instance owns.  Without the
             ownedSymbolsCsv input a sibling's detail page surfaces the
             parent's positions and pending orders, which mis-attributes
             P&L to the wrong instance.  See Phase-14. -->
        <app-ea-positions-panel
          [tradingAccountId]="ea()!.tradingAccountId"
          [instanceId]="ea()!.instanceId"
          [ownedSymbolsCsv]="ea()!.symbols"
        />
        <app-ea-pending-orders-panel
          [tradingAccountId]="ea()!.tradingAccountId"
          [ownedSymbolsCsv]="ea()!.symbols"
        />

        <!-- Phase-1/2/3 admin: operator control surface (9 actions, inline confirm dialogs) -->
        <app-ea-control-panel
          [instanceId]="ea()!.instanceId"
          (commandQueued)="onCommandQueued($event)"
        />

        <!-- Phase-4 admin: hot-reload input editor + read-only inspection -->
        <app-ea-config-panel
          [instanceId]="ea()!.instanceId"
          [inputs]="adminInputs()"
          [loading]="detailLoading()"
          (configPushed)="onCommandQueued('configPush')"
        />

        <!-- Logs (Phase-9) + Audit timeline (Phase-2A) side-by-side on
             wide screens; collapse to stacked below the min-cell width. -->
        <div class="ea-logs-audit-grid">
          <app-ea-logs-panel [instanceId]="ea()!.instanceId" />
          <app-ea-audit-timeline [instanceId]="ea()!.instanceId" />
        </div>
        <app-ea-rejections-panel [instanceId]="ea()!.instanceId" />

        <!--
          Phase 4d: the "Push safety config…" button is retired — all 10
          safety knobs are now covered by the new EAConfigPanel in the
          "Safety — per-instance" + "Safety — fleet" groups, which post
          the same payload through /admin/ea/{instanceId}/config.
          "Refresh symbol specs" stays — it's a coordinator-only action
          that doesn't fit the per-instance config push surface.
        -->
        <section class="actions-row">
          <button
            type="button"
            class="action-btn ok"
            (click)="askRefreshSpecs()"
            [disabled]="submitting()"
          >
            Refresh symbol specs
          </button>
        </section>
      }

      @if (askingRefresh()) {
        <div class="modal-overlay" (click)="cancelRefresh()">
          <div class="modal" (click)="$event.stopPropagation()" role="dialog" aria-modal="true">
            <header class="modal-head">
              <h2>Refresh symbol specs</h2>
              <button type="button" class="close-btn" (click)="cancelRefresh()" aria-label="Close">
                ×
              </button>
            </header>
            <p class="modal-target">
              Trading account
              <strong class="mono">#{{ ea()?.tradingAccountId }}</strong>
            </p>
            <p class="modal-desc">
              Queues a RequestBackfill command at the coordinator EA so it re-sends symbol
              specifications for every watched symbol. Use after the broker exposes a new symbol or
              after a contract-spec change.
            </p>
            <footer class="modal-foot">
              <button type="button" class="btn btn-secondary" (click)="cancelRefresh()">
                Cancel
              </button>
              <button
                type="button"
                class="btn btn-primary"
                (click)="confirmRefresh()"
                [disabled]="submitting()"
              >
                {{ submitting() ? 'Queuing…' : 'Refresh' }}
              </button>
            </footer>
          </div>
        </div>
      }

      @if (tradingActionOpen()) {
        <div class="modal-overlay" (click)="cancelTradingAction()">
          <div class="modal" (click)="$event.stopPropagation()" role="dialog" aria-modal="true">
            <header class="modal-head">
              <h2>{{ tradingIntent() === 'disable' ? 'Disable trading' : 'Enable trading' }}</h2>
              <button
                type="button"
                class="close-btn"
                (click)="cancelTradingAction()"
                aria-label="Close"
              >
                ×
              </button>
            </header>
            <p class="modal-target">
              Target <strong class="mono">{{ ea()?.instanceId }}</strong>
            </p>
            <p class="modal-desc">
              @if (tradingIntent() === 'disable') {
                Queues a COMPLIANCE safety stop — the EA halts new order placement on its next
                command poll. Open positions and their trailing stops are unaffected. Re-enable from
                this page.
              } @else {
                Clears the COMPLIANCE safety stop and returns the EA to RUNNING on its next command
                poll.
              }
            </p>
            <label class="field">
              <span>Reason {{ tradingIntent() === 'disable' ? '(required)' : '(optional)' }}</span>
              <textarea
                rows="2"
                [(ngModel)]="tradingReason"
                placeholder="What prompted this action? (audit trail)"
              ></textarea>
            </label>
            <footer class="modal-foot">
              <button type="button" class="btn btn-secondary" (click)="cancelTradingAction()">
                Cancel
              </button>
              <button
                type="button"
                class="btn btn-primary"
                (click)="confirmTradingAction()"
                [disabled]="
                  submitting() || (tradingIntent() === 'disable' && !tradingReason.trim())
                "
              >
                {{
                  submitting()
                    ? 'Queuing…'
                    : tradingIntent() === 'disable'
                      ? 'Disable trading'
                      : 'Enable trading'
                }}
              </button>
            </footer>
          </div>
        </div>
      }

      @if (configOpen()) {
        <div class="modal-overlay" (click)="cancelConfig()">
          <div
            class="modal wide"
            (click)="$event.stopPropagation()"
            role="dialog"
            aria-modal="true"
          >
            <header class="modal-head">
              <h2>Push EA safety config</h2>
              <button type="button" class="close-btn" (click)="cancelConfig()" aria-label="Close">
                ×
              </button>
            </header>
            <p class="modal-target">
              Target <strong class="mono">{{ ea()?.instanceId }}</strong>
            </p>
            <p class="modal-desc">
              Empty fields stay at the EA's current value. Hot-reloads on the next command poll.
            </p>

            <fieldset class="config-fieldset">
              <legend>Per-instance safety</legend>
              <div class="form-grid">
                <label class="field">
                  <span>Max positions per symbol</span>
                  <input type="number" min="0" step="1" [(ngModel)]="configForm.maxPosPerSymbol" />
                </label>
                <label class="field">
                  <span>Max lot per order</span>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    [(ngModel)]="configForm.maxLotPerOrder"
                  />
                </label>
                <label class="field">
                  <span>Max spread (points)</span>
                  <input type="number" min="0" step="1" [(ngModel)]="configForm.maxSpreadPoints" />
                </label>
                <label class="field">
                  <span>Max consecutive losses</span>
                  <input type="number" min="0" step="1" [(ngModel)]="configForm.maxConsecLosses" />
                </label>
                <label class="field">
                  <span>Consec-loss pause (min)</span>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    [(ngModel)]="configForm.consecLossPauseMin"
                  />
                </label>
                <label class="field">
                  <span>Max daily loss per symbol %</span>
                  <input
                    type="number"
                    min="0"
                    max="50"
                    step="0.1"
                    [(ngModel)]="configForm.maxDailyLossPerSymbolPct"
                  />
                </label>
              </div>
            </fieldset>

            <fieldset class="config-fieldset">
              <legend>Global safety</legend>
              <div class="form-grid">
                <label class="field">
                  <span>Max open positions (total)</span>
                  <input type="number" min="0" step="1" [(ngModel)]="configForm.maxOpenPositions" />
                </label>
                <label class="field">
                  <span>Max daily loss % (global)</span>
                  <input
                    type="number"
                    min="0"
                    max="50"
                    step="0.1"
                    [(ngModel)]="configForm.maxDailyLossPct"
                  />
                </label>
                <label class="field">
                  <span>Max orders / minute</span>
                  <input type="number" min="0" step="1" [(ngModel)]="configForm.maxOrdersPerMin" />
                </label>
              </div>
            </fieldset>

            <footer class="modal-foot">
              <button type="button" class="btn btn-secondary" (click)="cancelConfig()">
                Cancel
              </button>
              <button
                type="button"
                class="btn btn-primary"
                (click)="confirmConfigPush()"
                [disabled]="!hasAnyValue() || submitting()"
              >
                {{ submitting() ? 'Pushing…' : 'Push config' }}
              </button>
            </footer>
          </div>
        </div>
      }
    </div>
  `,
  styles: [
    `
      .page {
        padding: var(--space-2) 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
      }
      .overview-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
        gap: var(--space-4);
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--card-padding);
      }
      .kv {
        display: grid;
        grid-template-columns: max-content 1fr;
        gap: 8px var(--space-3);
        margin: 0;
        font-size: var(--text-sm);
      }
      .kv dt {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .kv dd {
        margin: 0;
        color: var(--text-primary);
      }
      .mono {
        font-family: var(--font-mono);
      }
      .muted {
        color: var(--text-tertiary);
      }
      .small {
        font-size: var(--text-xs);
      }
      .stale {
        color: #d70015;
      }
      .status-pill {
        font-size: var(--text-xs);
        padding: 2px 8px;
        border-radius: var(--radius-full);
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        background: rgba(0, 113, 227, 0.12);
        color: #0040dd;
      }
      .status-pill[data-status='Active'] {
        background: rgba(52, 199, 89, 0.12);
        color: #248a3d;
      }
      .status-pill[data-status='Inactive'],
      .status-pill[data-status='Stale'] {
        background: rgba(255, 149, 0, 0.12);
        color: #c93400;
      }
      .status-pill[data-status='Disconnected'],
      .status-pill[data-status='Failed'] {
        background: rgba(255, 59, 48, 0.12);
        color: #d70015;
      }
      .coord-pill {
        font-size: var(--text-xs);
        padding: 2px 6px;
        border-radius: var(--radius-sm);
        background: rgba(0, 113, 227, 0.12);
        color: #0040dd;
        margin-left: 6px;
      }
      /* ── Page-header version pill ────────────────────────────────────
         Sits next to the InstanceId in the page title so operators can
         spot which EA build is reporting without scanning the metadata
         strip. Quiet styling — slate background, monospace — so a stale
         vs. current version reads at a glance but doesn't compete with
         the status pill below. */
      .version-pill {
        font-size: var(--text-xs);
        padding: 2px 8px;
        border-radius: var(--radius-sm);
        background: var(--bg-tertiary, rgba(120, 120, 128, 0.16));
        color: var(--text-secondary);
        border: 1px solid var(--border);
        font-weight: var(--font-medium);
        letter-spacing: var(--tracking-tight);
        line-height: 1.4;
      }
      /* ── Account snapshot card ───────────────────────────────────── */
      .account-block {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--card-padding);
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .account-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: var(--space-3);
        flex-wrap: wrap;
      }
      .account-title {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .account-title h3 {
        margin: 0;
        font-size: var(--text-md);
      }
      .account-meta {
        color: var(--text-tertiary);
      }
      .account-sync {
        display: flex;
        align-items: center;
        gap: var(--space-2);
      }
      .sync-ts {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
      }
      .tag {
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        padding: 2px 8px;
        border-radius: 8px;
        font-weight: 600;
      }
      .tag--paper {
        background: rgba(175, 82, 222, 0.15);
        color: #af52de;
      }
      .account-tiles {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: var(--space-2);
      }
      .acct-tile {
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        padding: var(--space-3);
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .tile-label {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .tile-value {
        font-size: var(--text-lg);
        font-weight: 600;
        font-variant-numeric: tabular-nums;
        color: var(--text-primary);
      }
      .tile-ccy {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        font-weight: 400;
        margin-left: 4px;
      }
      .tile-delta {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
      }
      .tile-up {
        color: var(--positive, #34c759);
      }
      .tile-down {
        color: var(--loss, #ff3b30);
      }
      .tile-warn {
        color: #ff9500;
      }
      .account-kv {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: var(--space-2) var(--space-4);
        margin: 0;
        padding-top: var(--space-2);
        border-top: 1px dashed var(--border);
      }
      .account-kv dt {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        margin-bottom: 2px;
      }
      .account-kv dd {
        margin: 0;
        font-size: var(--text-sm);
        color: var(--text-primary);
      }

      .symbols-block {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--card-padding);
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
      }
      .symbols-block h3 {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .symbol-chips {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .symbol-chip {
        display: inline-block;
        padding: 4px 10px;
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-full);
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
      }
      /* ── Control-panel grid ────────────────────────────────────────
         Wraps the five operator panels (Trading, Fill mode, Breakeven
         exit, Pending-signal re-validation, DPT) into a responsive
         multi-column grid so they don't each take a full row.  Cells
         stretch to match the tallest sibling in the row (CSS Grid
         default) — sacrifices some whitespace inside short panels for
         visual uniformity across each row. */
      .ea-cards-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(440px, 1fr));
        gap: var(--space-3);
      }
      /* Ensure each child panel fills its grid cell vertically AND
         pins its content to the top — otherwise the row-flex panels'
         default align-items: center vertically centres their content
         inside the stretched card, leaving even whitespace top and
         bottom.  We want the whitespace at the bottom so the row
         reads as a clean top-aligned card grid. */
      .ea-cards-grid > section {
        height: 100%;
        align-items: flex-start;
        align-content: flex-start;
      }
      /* ── Logs + Audit timeline side-by-side ────────────────────────
         2-up grid wrapping the Phase-9 live log tail and the Phase-2A
         safety-audit timeline so they share one row instead of each
         taking full width.  Stretch heights so the two tables align;
         collapse to 1-up below 720px combined min-cell width. */
      .ea-logs-audit-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(520px, 1fr));
        gap: var(--space-3);
      }
      .ea-logs-audit-grid > * {
        min-width: 0;
      }
      /* ── Trading enable/disable control ──────────────────────────── */
      .trading-control {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-4);
        flex-wrap: wrap;
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-left-width: 3px;
        border-left-color: var(--border);
        border-radius: var(--radius-md);
        padding: var(--card-padding);
      }
      .trading-control[data-state='enabled'] {
        border-left-color: #34c759;
      }
      .trading-control[data-state='disabled-compliance'],
      .trading-control[data-state='disabled-kill'] {
        border-left-color: #ff3b30;
      }
      .trading-control[data-state='disabled-auto'] {
        border-left-color: #ff9500;
      }
      .tc-info {
        display: flex;
        flex-direction: column;
        gap: 4px;
        min-width: 240px;
      }
      .tc-headline {
        display: flex;
        align-items: center;
        gap: var(--space-2);
      }
      .tc-label {
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
      }
      .tc-pill {
        font-size: var(--text-xs);
        padding: 2px 8px;
        border-radius: var(--radius-full);
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .tc-pill.ok {
        background: rgba(52, 199, 89, 0.12);
        color: #248a3d;
      }
      .tc-pill.warn {
        background: rgba(255, 149, 0, 0.12);
        color: #c93400;
      }
      .tc-pill.bad {
        background: rgba(255, 59, 48, 0.12);
        color: #d70015;
      }
      .tc-pill.muted {
        background: rgba(0, 0, 0, 0.06);
        color: var(--text-tertiary);
      }
      .tc-desc {
        max-width: 60ch;
      }
      .tc-actions {
        display: flex;
        gap: var(--space-2);
        flex-shrink: 0;
      }
      /* ── Fill mode toggle ───────────────────────────────────────── */
      .fill-mode-panel {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-4);
        flex-wrap: wrap;
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-left-width: 3px;
        border-left-color: var(--border);
        border-radius: var(--radius-md);
        padding: var(--card-padding);
      }
      .fill-mode-panel[data-mode='Market'] {
        border-left-color: #34c759;
      }
      .fill-mode-panel[data-mode='Limit'] {
        border-left-color: #ff9500;
      }
      .fm-info {
        display: flex;
        flex-direction: column;
        gap: 4px;
        min-width: 240px;
      }
      .fm-headline {
        display: flex;
        align-items: center;
        gap: var(--space-2);
      }
      .fm-label {
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
      }
      .fm-pill {
        font-size: var(--text-xs);
        padding: 2px 8px;
        border-radius: var(--radius-full);
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .fm-pill.ok {
        background: rgba(52, 199, 89, 0.12);
        color: #248a3d;
      }
      .fm-pill.warn {
        background: rgba(255, 149, 0, 0.12);
        color: #c93400;
      }
      .fm-pill.muted {
        background: rgba(0, 0, 0, 0.06);
        color: var(--text-tertiary);
      }
      .fm-desc {
        max-width: 60ch;
      }
      .fm-actions {
        display: flex;
        flex-direction: column;
        gap: 8px;
        align-items: flex-end;
        flex-shrink: 0;
      }
      .fm-toggle {
        display: inline-flex;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        overflow: hidden;
        background: var(--bg-primary);
      }
      .fm-toggle.is-loading {
        opacity: 0.5;
      }
      .fm-opt {
        appearance: none;
        background: transparent;
        border: none;
        padding: 8px 18px;
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        color: var(--text-secondary);
        cursor: pointer;
        min-width: 80px;
      }
      .fm-opt + .fm-opt {
        border-left: 1px solid var(--border);
      }
      .fm-opt.active {
        background: var(--bg-elevated, rgba(0, 113, 227, 0.12));
        color: var(--accent-fg, #0040dd);
        font-weight: var(--font-semibold);
      }
      .fm-opt:disabled {
        cursor: not-allowed;
        opacity: 0.55;
      }
      .fm-status {
        min-height: 1.2em;
      }
      .fm-status .ok {
        color: #248a3d;
      }
      .fm-status .bad {
        color: #d70015;
      }
      .fm-buttons {
        display: flex;
        gap: var(--space-2);
      }
      /* ── Breakeven exit panel ─────────────────────────────────────── */
      .be-panel {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: var(--space-4);
        flex-wrap: wrap;
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-left-width: 3px;
        border-left-color: var(--border);
        border-radius: var(--radius-md);
        padding: var(--card-padding);
      }
      .be-panel[data-arm='on'] {
        border-left-color: #ff9500;
      }
      .be-info {
        display: flex;
        flex-direction: column;
        gap: 4px;
        min-width: 240px;
        max-width: 32ch;
      }
      .be-headline {
        display: flex;
        align-items: center;
        gap: var(--space-2);
      }
      .be-label {
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
      }
      .be-pill {
        font-size: var(--text-xs);
        padding: 2px 8px;
        border-radius: var(--radius-full);
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .be-pill.warn {
        background: rgba(255, 149, 0, 0.12);
        color: #c93400;
      }
      .be-pill.muted {
        background: rgba(0, 0, 0, 0.06);
        color: var(--text-tertiary);
      }
      .be-desc {
        max-width: 60ch;
      }
      .be-actions {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
        flex-grow: 1;
        min-width: 280px;
        max-width: 520px;
      }
      .be-section {
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: 8px 12px;
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
      }
      .be-row {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        cursor: pointer;
        user-select: none;
      }
      .be-section-name {
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
      }
      .be-fields {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-3);
        padding-left: 24px;
      }
      .be-fields.disabled {
        opacity: 0.5;
      }
      .be-field {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .be-field input {
        width: 70px;
        padding: 4px 6px;
        font-size: var(--text-sm);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-primary);
      }
      .be-field input:disabled {
        background: var(--bg-secondary);
        cursor: not-allowed;
      }
      .be-unit {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        font-weight: var(--font-medium);
      }
      .be-status {
        min-height: 1.2em;
      }
      .be-status .ok {
        color: #248a3d;
      }
      .be-status .bad {
        color: #d70015;
      }
      .be-buttons {
        display: flex;
        gap: var(--space-2);
        align-self: flex-end;
      }
      /* ── Daily profit target card ── mirrors the fill-mode panel ── */
      .dpt-panel {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-4);
        flex-wrap: wrap;
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-left-width: 3px;
        border-left-color: #34c759;
        border-radius: var(--radius-md);
        padding: var(--card-padding);
      }
      .dpt-panel.is-hit {
        border-left-color: #30b0c7;
        background: rgba(48, 176, 199, 0.06);
      }
      .dpt-info {
        display: flex;
        flex-direction: column;
        gap: 4px;
        min-width: 240px;
      }
      .dpt-headline {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        flex-wrap: wrap;
      }
      .dpt-label {
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
      }
      .dpt-pill {
        font-size: var(--text-xs);
        padding: 2px 8px;
        border-radius: var(--radius-full);
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .dpt-pill.on {
        background: rgba(52, 199, 89, 0.12);
        color: #248a3d;
        text-transform: none;
        letter-spacing: 0;
      }
      .dpt-pill.hit {
        background: rgba(48, 176, 199, 0.16);
        color: #0a7a8c;
      }
      .dpt-pill.muted {
        background: rgba(0, 0, 0, 0.06);
        color: var(--text-tertiary);
      }
      .dpt-desc {
        max-width: 62ch;
      }
      .dpt-actions {
        display: flex;
        flex-direction: column;
        gap: 8px;
        align-items: flex-end;
        flex-shrink: 0;
      }
      .dpt-inputs {
        display: flex;
        gap: var(--space-2);
        align-items: flex-end;
      }
      .dpt-field {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .dpt-field span {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        font-weight: var(--font-medium);
      }
      .dpt-field input {
        width: 130px;
        padding: 6px 10px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-sm);
        font-variant-numeric: tabular-nums;
      }
      .dpt-field input:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }
      .dpt-status {
        min-height: 1.2em;
      }
      .dpt-status .ok {
        color: #248a3d;
      }
      .dpt-status .bad {
        color: #d70015;
      }
      .dpt-buttons {
        display: flex;
        gap: var(--space-2);
      }
      .actions-row {
        display: flex;
        gap: var(--space-3);
        flex-wrap: wrap;
      }
      .action-btn {
        padding: 10px 20px;
        border-radius: var(--radius-sm);
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        cursor: pointer;
      }
      .action-btn.ok {
        color: #248a3d;
      }
      .action-btn.ok:hover:not(:disabled) {
        background: #34c759;
        color: #fff;
      }
      .action-btn.warn {
        color: #c93400;
      }
      .action-btn.warn:hover:not(:disabled) {
        background: #c93400;
        color: #fff;
      }
      .action-btn:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }
      .modal-overlay {
        position: fixed;
        inset: 0;
        background: var(--backdrop-scrim, rgba(0, 0, 0, 0.45));
        display: grid;
        place-items: center;
        z-index: 1000;
      }
      .modal {
        background: var(--bg-primary);
        border-radius: var(--radius-lg);
        box-shadow: var(--shadow-lg);
        max-width: 480px;
        width: 90%;
        padding: var(--space-5);
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .modal.wide {
        max-width: 720px;
      }
      .modal-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      .modal-head h2 {
        margin: 0;
        font-size: var(--text-lg);
        font-weight: var(--font-semibold);
      }
      .close-btn {
        background: none;
        border: none;
        font-size: 24px;
        color: var(--text-secondary);
        cursor: pointer;
      }
      .modal-target {
        margin: 0;
        font-size: var(--text-sm);
        color: var(--text-secondary);
      }
      .modal-desc {
        margin: 0;
        font-size: var(--text-sm);
        color: var(--text-primary);
      }
      .config-fieldset {
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        padding: var(--space-3);
        margin: 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .config-fieldset legend {
        padding: 0 6px;
        font-size: var(--text-xs);
        color: var(--text-secondary);
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .form-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: var(--space-3);
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .field span {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        font-weight: var(--font-medium);
      }
      .field input,
      .field textarea {
        padding: 6px 10px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-sm);
        font-variant-numeric: tabular-nums;
      }
      .field textarea {
        resize: vertical;
        min-height: 48px;
        font-family: inherit;
      }
      .modal-foot {
        display: flex;
        justify-content: flex-end;
        gap: var(--space-3);
      }
      .btn-primary {
        padding: 8px 18px;
        border-radius: var(--radius-sm);
        background: var(--accent);
        color: #fff;
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        border: none;
        cursor: pointer;
      }
      .btn-primary:disabled {
        background: var(--bg-tertiary, #d1d1d6);
        cursor: not-allowed;
      }
    `,
  ],
})
export class EaDetailPageComponent {
  private readonly service = inject(EAInstancesService);
  private readonly admin = inject(EAAdminService);
  private readonly auditTrail = inject(AuditTrailService);
  private readonly notify = inject(NotificationService);
  private readonly route = inject(ActivatedRoute);

  protected readonly id = toSignal(
    this.route.paramMap.pipe(map((p) => Number(p.get('id')) || null)),
    { initialValue: null },
  );

  protected readonly resource = createPolledResource(
    () =>
      this.service.list().pipe(
        map((res) => res.data ?? []),
        catchError(() => of<EAInstanceDto[]>([])),
      ),
    { intervalMs: 15_000 },
  );

  protected readonly ea = computed(() => {
    const list = this.resource.value() ?? [];
    const want = this.id();
    if (want === null) return null;
    return list.find((x) => x.id === want) ?? null;
  });

  /**
   * Phase-1 admin detail poll.  The list-based `ea()` carries everything
   * the legacy view needed; the admin endpoint adds the rich-state
   * envelope and the Phase-2 LastStateUpdatedAt.  Keyed off the resolved
   * `instanceId` so it only fires once the list lookup succeeds.
   */
  protected readonly detailResource = createPolledResource(
    () => {
      const instanceId = this.ea()?.instanceId;
      if (!instanceId) {
        return of<EAInstanceDetail | null>(null);
      }
      return this.admin.getDetail(instanceId).pipe(
        map((res) => res.data ?? null),
        catchError(() => of<EAInstanceDetail | null>(null)),
      );
    },
    { intervalMs: 15_000 },
  );

  protected readonly adminState = computed(() => this.detailResource.value()?.state ?? null);
  protected readonly adminLastStateUpdatedAt = computed(
    () => this.detailResource.value()?.lastStateUpdatedAt ?? null,
  );
  /**
   * Account snapshot from the admin detail endpoint — TradingAccount's
   * latest broker-synced balance / equity / margin envelope.  Null in the
   * brief gap between page load and the first detailResource tick, and
   * also when the EA hasn't yet pushed a /trading-account/sync (e.g.
   * during the first ~5s after an EA registers).
   */
  protected readonly account = computed(() => this.detailResource.value()?.account ?? null);
  /** Phase-4: the inputs sub-object the EA emits inside the rich-state envelope. */
  protected readonly adminInputs = computed(() => this.adminState()?.inputs ?? null);

  /** Active safety-stop category from the live-state envelope (null / 'NONE' = not stopped). */
  protected readonly safetyCategory = computed(() => this.adminState()?.safetyStopCategory ?? null);

  /**
   * Operator-facing trading posture, derived from the live-state envelope so
   * the toggle reflects the EA's real state rather than the last command we
   * sent:
   *   - 'enabled'              — running; "Disable trading" available.
   *   - 'disabled-compliance'  — operator COMPLIANCE safety stop; this page can
   *                              clear it via "Enable trading".
   *   - 'disabled-auto'        — INFRA/DAILY_RESET/CAS_EXHAUSTION stop; clears
   *                              itself, so no manual toggle (managed below).
   *   - 'disabled-kill'        — kill switch active; release lives in Operator
   *                              controls, not here.
   *   - 'unknown'              — no envelope yet; still allow Disable since
   *                              forceSafetyStop is valid regardless.
   */
  protected readonly tradingPosture = computed<
    'enabled' | 'disabled-compliance' | 'disabled-auto' | 'disabled-kill' | 'unknown'
  >(() => {
    const st = this.adminState();
    if (!st) return 'unknown';
    if (st.killSwitchActive) return 'disabled-kill';
    const cat = st.safetyStopCategory;
    if (cat && cat !== 'NONE') {
      return cat === 'COMPLIANCE' ? 'disabled-compliance' : 'disabled-auto';
    }
    return 'enabled';
  });

  /**
   * detailResource's fetcher reads `this.ea()?.instanceId` — but on initial
   * page mount the fleet-list resource hasn't returned yet, so the first
   * fire sees ea()=null and returns `of(null)`.  Without this effect we'd
   * then wait the full 15-second poll cycle before refetching, during which
   * the panels show the "no envelope yet" empty state even though the
   * envelope is sitting in the database.  Watching ea() and refresh()-ing
   * the moment its instanceId resolves closes the gap.  Tracks the last
   * fetched instanceId so a second fire on the same id doesn't re-poll.
   */
  private lastFetchedInstanceId: string | null = null;
  private readonly _refreshOnEa = effect(() => {
    const id = this.ea()?.instanceId ?? null;
    if (id && id !== this.lastFetchedInstanceId) {
      this.lastFetchedInstanceId = id;
      this.detailResource.refresh();
    }
  });

  /**
   * Triggered by the control panel after a successful command queue.  Both
   * resources are refreshed so the state envelope reflects the new posture
   * within a cycle, and the timeline picks up the audit entry the command
   * handler emitted.
   */
  protected onCommandQueued(_actionKey: string): void {
    this.resource.refresh();
    this.detailResource.refresh();
  }

  protected readonly loading = computed(
    () => this.resource.loading() && (this.resource.value() ?? null) === null,
  );

  /**
   * True whenever *either* the fleet-list resource or the admin detail
   * resource has an outstanding fetch.  Drives the always-visible
   * `<ui-progress-bar>` in the page header so users get a consistent
   * "something is happening" cue — the per-section shimmers handle initial
   * empty-state, but real fetches complete in <100ms locally and the
   * shimmer flashes too briefly to perceive.  This bar pulses for every
   * 15-second background poll too, which doubles as an "auto-refresh is
   * alive" signal.
   */
  protected readonly anyLoading = computed(
    () => this.resource.loading() || this.detailResource.loading(),
  );

  /** Manual refresh — kick both resources at once instead of just the list. */
  protected refreshAll(): void {
    this.resource.refresh();
    this.detailResource.refresh();
  }

  /**
   * True while the admin detail endpoint is mid-flight and the state envelope
   * hasn't been received yet.  Passed to the child state + config panels so
   * they shimmer placeholder rows instead of the "no envelope yet" copy on
   * first paint.  After the first successful response we stay quiet on
   * subsequent polls (envelope cached and re-rendered in-place).
   *
   * The third branch covers the bridging window: the detailResource fires
   * once on mount with ea()=null and returns of(null) synchronously
   * (loading flips back to false, value stays null), then the effect above
   * triggers a refetch on the next microtask after ea() resolves.  During
   * that handful of milliseconds loading() is false and value() is null but
   * we definitely *intend* to fetch, so we still want to shimmer.
   */
  protected readonly detailLoading = computed(() => {
    const value = this.detailResource.value();
    if (value !== null) return false;
    if (this.detailResource.loading()) return true;
    return !!this.ea()?.instanceId;
  });

  protected readonly ownedSymbols = computed(() => {
    const s = this.ea()?.symbols ?? '';
    return s
      .split(/[\s,]+/)
      .map((x) => x.trim())
      .filter((x) => x.length > 0);
  });

  protected readonly heartbeatStale = computed(() => {
    const hb = this.ea()?.lastHeartbeat;
    if (!hb) return false;
    const ts = Date.parse(hb);
    if (Number.isNaN(ts)) return false;
    // 60-second heartbeat-timeout per engine docs; flag rows past 90s as stale.
    return Date.now() - ts > 90_000;
  });

  // ── Account-card helpers ─────────────────────────────────────────────
  //
  // Three small computed-style helpers consumed from the template.  Kept
  // here as plain methods (not signals) because their inputs are derived
  // from the same `acct` reference the template already destructures via
  // `@if (ea()!.account; as acct)` — no reactive boundary to cross.

  /**
   * Percent of equity locked up in current positions: marginUsed / equity.
   * Falls back to 0 when equity is non-positive (broker disconnect or
   * fully-stopped-out account) — avoids divide-by-zero rendering NaN.
   */
  protected marginUsedPct(acct: { marginUsed: number; equity: number }): number {
    if (!acct.equity || acct.equity <= 0) return 0;
    return (acct.marginUsed / acct.equity) * 100;
  }

  /**
   * "Margin level is uncomfortably close to broker stop-out" predicate.
   * Threshold = 2× the stop-out level (e.g. stop-out=50% → warn ≤100%);
   * mirrors the EA-side StopOutBufferMultiplier=2.0 safety floor convention.
   */
  protected marginLevelWarn(acct: {
    marginUsed: number;
    marginLevel: number;
    marginSoStopOut: number;
    marginSoMode: string;
  }): boolean {
    if (acct.marginUsed <= 0 || acct.marginSoMode !== 'Percent') return false;
    if (acct.marginLevel <= 0 || acct.marginSoStopOut <= 0) return false;
    const warnThreshold = acct.marginSoStopOut * 2;
    return acct.marginLevel < warnThreshold && !this.marginLevelDanger(acct);
  }

  /** "At-or-below broker stop-out level" predicate — the danger band. */
  protected marginLevelDanger(acct: {
    marginUsed: number;
    marginLevel: number;
    marginSoStopOut: number;
    marginSoMode: string;
  }): boolean {
    if (acct.marginUsed <= 0 || acct.marginSoMode !== 'Percent') return false;
    if (acct.marginLevel <= 0 || acct.marginSoStopOut <= 0) return false;
    return acct.marginLevel <= acct.marginSoStopOut;
  }

  // Refresh-symbol-specs modal -------------------------------------------
  protected readonly askingRefresh = signal(false);
  protected readonly submitting = signal(false);

  protected askRefreshSpecs(): void {
    this.askingRefresh.set(true);
  }

  protected cancelRefresh(): void {
    if (this.submitting()) return;
    this.askingRefresh.set(false);
  }

  protected confirmRefresh(): void {
    const ea = this.ea();
    if (!ea) return;
    this.submitting.set(true);
    this.service
      .refreshSymbolSpecs({ tradingAccountId: ea.tradingAccountId })
      .pipe(
        finalize(() => {
          this.submitting.set(false);
          this.askingRefresh.set(false);
          this.resource.refresh();
        }),
      )
      .subscribe({
        next: (res) => {
          if (res.status) {
            this.notify.success(`Refresh queued for trading account #${ea.tradingAccountId}.`);
            this.auditTrail
              .create({
                entityType: 'EAInstance',
                entityId: ea.id,
                decisionType: 'EARefreshSymbolSpecs',
                outcome: 'Queued',
                reason: null,
                contextJson: JSON.stringify({
                  tradingAccountId: ea.tradingAccountId,
                  instanceId: ea.instanceId,
                }),
                source: 'AdminUI',
              })
              .subscribe({ error: () => undefined });
          } else {
            this.notify.error(res.message ?? 'Refresh request failed.');
          }
        },
        error: () => this.notify.error('Refresh request failed.'),
      });
  }

  // Trading enable/disable modal -----------------------------------------
  //
  // Thin operator wrapper over the COMPLIANCE safety stop: "disable" queues
  // forceSafetyStop(COMPLIANCE) (halt new orders, positions untouched),
  // "enable" queues clearSafetyStop.  Shares the `submitting` signal with the
  // other detail-page modals — they're mutually exclusive on screen.
  protected readonly tradingActionOpen = signal(false);
  protected readonly tradingIntent = signal<'disable' | 'enable' | null>(null);
  protected tradingReason = '';

  protected askDisableTrading(): void {
    this.tradingReason = '';
    this.tradingIntent.set('disable');
    this.tradingActionOpen.set(true);
  }

  protected askEnableTrading(): void {
    this.tradingReason = '';
    this.tradingIntent.set('enable');
    this.tradingActionOpen.set(true);
  }

  protected cancelTradingAction(): void {
    if (this.submitting()) return;
    this.tradingActionOpen.set(false);
    this.tradingIntent.set(null);
  }

  protected confirmTradingAction(): void {
    const ea = this.ea();
    const intent = this.tradingIntent();
    if (!ea || !intent) return;
    const reason = this.tradingReason.trim() || null;
    // Reason is mandatory on disable (matches the control-panel safety-stop
    // convention); optional on the un-do.
    if (intent === 'disable' && !reason) return;

    this.submitting.set(true);
    const call =
      intent === 'disable'
        ? this.admin.forceSafetyStop(ea.instanceId, { category: 'COMPLIANCE', reason })
        : this.admin.clearSafetyStop(ea.instanceId, { reason });

    call
      .pipe(
        finalize(() => {
          this.submitting.set(false);
          this.tradingActionOpen.set(false);
          this.tradingIntent.set(null);
          this.resource.refresh();
          this.detailResource.refresh();
        }),
      )
      .subscribe({
        next: (res) => {
          if (res.status) {
            this.notify.success(
              intent === 'disable'
                ? `Trading disabled for EA ${ea.instanceId}.`
                : `Trading re-enabled for EA ${ea.instanceId}.`,
            );
            this.auditTrail
              .create({
                entityType: 'EAInstance',
                entityId: ea.id,
                decisionType: intent === 'disable' ? 'EAForceSafetyStop' : 'EAClearSafetyStop',
                outcome: 'Queued',
                reason,
                contextJson: JSON.stringify({
                  instanceId: ea.instanceId,
                  category: intent === 'disable' ? 'COMPLIANCE' : null,
                }),
                source: 'AdminUI',
              })
              .subscribe({ error: () => undefined });
          } else {
            this.notify.error(res.message ?? 'Command queue failed.');
          }
        },
        error: () => this.notify.error('Command queue failed.'),
      });
  }

  // Config-push modal ----------------------------------------------------
  protected readonly configOpen = signal(false);
  protected configForm: ConfigForm = blankConfigForm();

  protected openConfigPush(): void {
    this.configForm = blankConfigForm();
    this.configOpen.set(true);
  }

  protected cancelConfig(): void {
    if (this.submitting()) return;
    this.configOpen.set(false);
  }

  protected hasAnyValue(): boolean {
    return (Object.values(this.configForm) as string[]).some((v) => v.trim() !== '');
  }

  protected confirmConfigPush(): void {
    const ea = this.ea();
    if (!ea || !this.hasAnyValue()) return;
    this.submitting.set(true);
    const payload = buildPayload(this.configForm, ea.instanceId);
    this.service
      .updateEAConfig(payload)
      .pipe(
        finalize(() => {
          this.submitting.set(false);
          this.configOpen.set(false);
          this.resource.refresh();
        }),
      )
      .subscribe({
        next: (res) => {
          if (res.status) {
            this.notify.success(`Config push queued for EA ${ea.instanceId}.`);
            this.auditTrail
              .create({
                entityType: 'EAInstance',
                entityId: ea.id,
                decisionType: 'EAUpdateConfig',
                outcome: 'Queued',
                reason: null,
                contextJson: JSON.stringify(payload),
                source: 'AdminUI',
              })
              .subscribe({ error: () => undefined });
          } else {
            this.notify.error(res.message ?? 'Config push failed.');
          }
        },
        error: () => this.notify.error('Config push failed.'),
      });
  }

  // Fill-mode toggle -----------------------------------------------------
  //
  // Per-EA execution-mode switch (`EA:FillMode:{InstanceId}` EngineConfig
  // row).  Loaded once per resolved instanceId; subsequent saves write
  // straight back and pin the new value into `fillModeServer` so the UI
  // doesn't need a re-fetch.  Draft/server signals follow the same pattern
  // as the viability-gates Ghost-outcome panel.
  protected readonly fillModeServer = signal<EAFillMode | null>(null);
  protected readonly fillModeDraft = signal<EAFillMode | null>(null);
  protected readonly savingFillMode = signal(false);
  protected readonly fillModeSaved = signal(false);
  protected readonly fillModeSaveError = signal<string | null>(null);

  private lastFillModeInstanceId: string | null = null;
  private readonly _loadFillMode = effect(() => {
    const instanceId = this.ea()?.instanceId ?? null;
    if (!instanceId) return;
    if (instanceId === this.lastFillModeInstanceId) return;
    this.lastFillModeInstanceId = instanceId;
    this.fillModeServer.set(null);
    this.fillModeDraft.set(null);
    this.fillModeSaved.set(false);
    this.fillModeSaveError.set(null);
    this.admin
      .getFillMode(instanceId)
      .pipe(catchError(() => of(null)))
      .subscribe((res) => {
        const mode = (res?.data?.fillMode ?? 'Market') as EAFillMode;
        this.fillModeServer.set(mode);
        this.fillModeDraft.set(mode);
      });
  });

  protected fillModeDirty(): boolean {
    const s = this.fillModeServer();
    const d = this.fillModeDraft();
    return s !== null && d !== null && s !== d;
  }

  protected setFillMode(mode: EAFillMode): void {
    this.fillModeDraft.set(mode);
    this.fillModeSaved.set(false);
    this.fillModeSaveError.set(null);
  }

  protected resetFillMode(): void {
    this.fillModeDraft.set(this.fillModeServer());
    this.fillModeSaved.set(false);
    this.fillModeSaveError.set(null);
  }

  protected saveFillMode(): void {
    const ea = this.ea();
    const draft = this.fillModeDraft();
    if (!ea || !draft || draft === this.fillModeServer()) return;
    this.savingFillMode.set(true);
    this.fillModeSaveError.set(null);
    this.admin
      .updateFillMode(ea.instanceId, { fillMode: draft })
      .pipe(
        finalize(() => this.savingFillMode.set(false)),
        catchError((err) => {
          this.fillModeSaveError.set(err?.error?.message ?? 'Save failed.');
          return of(null);
        }),
      )
      .subscribe((res) => {
        if (res === null) return;
        if (!res.status) {
          this.fillModeSaveError.set(res.message ?? 'Save failed.');
          return;
        }
        this.fillModeServer.set(draft);
        this.fillModeSaved.set(true);
        this.notify.success(`Fill mode set to ${draft} for EA ${ea.instanceId}.`);
        this.auditTrail
          .create({
            entityType: 'EAInstance',
            entityId: ea.id,
            decisionType: 'EAUpdateFillMode',
            outcome: 'Saved',
            reason: null,
            contextJson: JSON.stringify({ instanceId: ea.instanceId, fillMode: draft }),
            source: 'AdminUI',
          })
          .subscribe({ error: () => undefined });
      });
  }

  // Breakeven exit ------------------------------------------------------
  //
  // Per-account rule-based BE config (5 EngineConfig rows behind a single
  // PUT).  Server signal holds the last loaded snapshot; draft holds the
  // operator's in-progress edit.  Both default to null until the first
  // load resolves, gating the form on `beDraft() !== null` in the
  // template.  Save round-trips the whole record and pins the new value
  // into `beServer` so the UI doesn't need a re-fetch.
  protected readonly beServer = signal<EABreakevenExitConfig | null>(null);
  protected readonly beDraft = signal<{
    salvageEnabled: boolean;
    salvageMaeTriggerR: number;
    salvageToleranceR: number;
    trailToBeEnabled: boolean;
    trailToBeMfeTriggerR: number;
  } | null>(null);
  protected readonly savingBe = signal(false);
  protected readonly beSaved = signal(false);
  protected readonly beSaveError = signal<string | null>(null);

  private lastBeInstanceId: string | null = null;
  private readonly _loadBe = effect(() => {
    const instanceId = this.ea()?.instanceId ?? null;
    if (!instanceId) return;
    if (instanceId === this.lastBeInstanceId) return;
    this.lastBeInstanceId = instanceId;
    this.beServer.set(null);
    this.beDraft.set(null);
    this.beSaved.set(false);
    this.beSaveError.set(null);
    this.admin
      .getBreakevenExit(instanceId)
      .pipe(catchError(() => of(null)))
      .subscribe((res) => {
        const cfg = res?.data ?? null;
        if (!cfg) return;
        this.beServer.set(cfg);
        this.beDraft.set({
          salvageEnabled: cfg.salvageEnabled,
          salvageMaeTriggerR: cfg.salvageMaeTriggerR,
          salvageToleranceR: cfg.salvageToleranceR,
          trailToBeEnabled: cfg.trailToBeEnabled,
          trailToBeMfeTriggerR: cfg.trailToBeMfeTriggerR,
        });
      });
  });

  protected beDirty(): boolean {
    const s = this.beServer();
    const d = this.beDraft();
    if (!s || !d) return false;
    return (
      s.salvageEnabled !== d.salvageEnabled ||
      s.salvageMaeTriggerR !== d.salvageMaeTriggerR ||
      s.salvageToleranceR !== d.salvageToleranceR ||
      s.trailToBeEnabled !== d.trailToBeEnabled ||
      s.trailToBeMfeTriggerR !== d.trailToBeMfeTriggerR
    );
  }

  protected updateBeDraft(patch: Partial<NonNullable<ReturnType<typeof this.beDraft>>>): void {
    const d = this.beDraft();
    if (!d) return;
    this.beDraft.set({ ...d, ...patch });
    this.beSaved.set(false);
    this.beSaveError.set(null);
  }

  protected resetBe(): void {
    const s = this.beServer();
    if (!s) return;
    this.beDraft.set({
      salvageEnabled: s.salvageEnabled,
      salvageMaeTriggerR: s.salvageMaeTriggerR,
      salvageToleranceR: s.salvageToleranceR,
      trailToBeEnabled: s.trailToBeEnabled,
      trailToBeMfeTriggerR: s.trailToBeMfeTriggerR,
    });
    this.beSaved.set(false);
    this.beSaveError.set(null);
  }

  protected saveBe(): void {
    const ea = this.ea();
    const draft = this.beDraft();
    const server = this.beServer();
    if (!ea || !draft || !server || !this.beDirty()) return;
    this.savingBe.set(true);
    this.beSaveError.set(null);
    this.admin
      .updateBreakevenExit(ea.instanceId, draft)
      .pipe(
        finalize(() => this.savingBe.set(false)),
        catchError((err) => {
          this.beSaveError.set(err?.error?.message ?? 'Save failed.');
          return of(null);
        }),
      )
      .subscribe((res) => {
        if (res === null) return;
        if (!res.status) {
          this.beSaveError.set(res.message ?? 'Save failed.');
          return;
        }
        // Optimistically pin server to draft — next page load will reconcile.
        this.beServer.set({ ...server, ...draft });
        this.beSaved.set(true);
        this.notify.success(`Breakeven exit settings saved for EA ${ea.instanceId}.`);
        this.auditTrail
          .create({
            entityType: 'EAInstance',
            entityId: ea.id,
            decisionType: 'EAUpdateBreakevenExit',
            outcome: 'Saved',
            reason: null,
            contextJson: JSON.stringify({ instanceId: ea.instanceId, ...draft }),
            source: 'AdminUI',
          })
          .subscribe({ error: () => undefined });
      });
  }

  // Pending-signal re-validation -----------------------------------------
  //
  // Per-account "park-and-revalidate" config (5 EngineConfig rows behind
  // a single PUT). Same load/save shape as the BE panel above.  This is
  // the schema-first deferral phase — operators can configure thresholds
  // now; the gate + worker that act on the config land in a follow-up.
  protected readonly psrServer = signal<EAPendingSignalRevalConfig | null>(null);
  protected readonly psrDraft = signal<{
    enabled: boolean;
    atrTrigger: number;
    ttlHours: number;
    cooldownMinutes: number;
    maxAttempts: number;
  } | null>(null);
  protected readonly savingPsr = signal(false);
  protected readonly psrSaved = signal(false);
  protected readonly psrSaveError = signal<string | null>(null);

  private lastPsrInstanceId: string | null = null;
  private readonly _loadPsr = effect(() => {
    const instanceId = this.ea()?.instanceId ?? null;
    if (!instanceId) return;
    if (instanceId === this.lastPsrInstanceId) return;
    this.lastPsrInstanceId = instanceId;
    this.psrServer.set(null);
    this.psrDraft.set(null);
    this.psrSaved.set(false);
    this.psrSaveError.set(null);
    this.admin
      .getPendingSignalReval(instanceId)
      .pipe(catchError(() => of(null)))
      .subscribe((res) => {
        const cfg = res?.data ?? null;
        if (!cfg) return;
        this.psrServer.set(cfg);
        this.psrDraft.set({
          enabled: cfg.enabled,
          atrTrigger: cfg.atrTrigger,
          ttlHours: cfg.ttlHours,
          cooldownMinutes: cfg.cooldownMinutes,
          maxAttempts: cfg.maxAttempts,
        });
      });
  });

  protected psrDirty(): boolean {
    const s = this.psrServer();
    const d = this.psrDraft();
    if (!s || !d) return false;
    return (
      s.enabled !== d.enabled ||
      s.atrTrigger !== d.atrTrigger ||
      s.ttlHours !== d.ttlHours ||
      s.cooldownMinutes !== d.cooldownMinutes ||
      s.maxAttempts !== d.maxAttempts
    );
  }

  protected updatePsrDraft(patch: Partial<NonNullable<ReturnType<typeof this.psrDraft>>>): void {
    const d = this.psrDraft();
    if (!d) return;
    this.psrDraft.set({ ...d, ...patch });
    this.psrSaved.set(false);
    this.psrSaveError.set(null);
  }

  protected resetPsr(): void {
    const s = this.psrServer();
    if (!s) return;
    this.psrDraft.set({
      enabled: s.enabled,
      atrTrigger: s.atrTrigger,
      ttlHours: s.ttlHours,
      cooldownMinutes: s.cooldownMinutes,
      maxAttempts: s.maxAttempts,
    });
    this.psrSaved.set(false);
    this.psrSaveError.set(null);
  }

  protected savePsr(): void {
    const ea = this.ea();
    const draft = this.psrDraft();
    const server = this.psrServer();
    if (!ea || !draft || !server || !this.psrDirty()) return;
    this.savingPsr.set(true);
    this.psrSaveError.set(null);
    this.admin
      .updatePendingSignalReval(ea.instanceId, draft)
      .pipe(
        finalize(() => this.savingPsr.set(false)),
        catchError((err) => {
          this.psrSaveError.set(err?.error?.message ?? 'Save failed.');
          return of(null);
        }),
      )
      .subscribe((res) => {
        if (res === null) return;
        if (!res.status) {
          this.psrSaveError.set(res.message ?? 'Save failed.');
          return;
        }
        this.psrServer.set({ ...server, ...draft });
        this.psrSaved.set(true);
        this.notify.success(`Pending-signal re-validation settings saved for EA ${ea.instanceId}.`);
        this.auditTrail
          .create({
            entityType: 'EAInstance',
            entityId: ea.id,
            decisionType: 'EAUpdatePendingSignalReval',
            outcome: 'Saved',
            reason: null,
            contextJson: JSON.stringify({ instanceId: ea.instanceId, ...draft }),
            source: 'AdminUI',
          })
          .subscribe({ error: () => undefined });
      });
  }

  // Daily profit target --------------------------------------------------
  //
  // Per-instance daily profit target ($ or % of start-of-day equity). The
  // EA echoes its currently-effective target in the heartbeat state envelope
  // (v8.47.210+); saves push through the admin per-instance config endpoint.
  // Server signals are seeded once per resolved instance from that echo and
  // then updated optimistically on save, so the 15s page poll can't clobber
  // an in-progress edit (the polled value lags the EA applying the push).
  protected readonly dptAbsServer = signal<number | null>(null);
  protected readonly dptPctServer = signal<number | null>(null);
  protected readonly dptAbsDraft = signal<number | null>(null);
  protected readonly dptPctDraft = signal<number | null>(null);
  protected readonly savingDpt = signal(false);
  protected readonly dptSaved = signal(false);
  protected readonly dptSaveError = signal<string | null>(null);
  /** True once the current target has been seeded from the EA's state echo. */
  protected readonly dptLoaded = signal(false);

  private lastDptInstanceId: string | null = null;
  private readonly _seedDpt = effect(() => {
    const instanceId = this.ea()?.instanceId ?? null;
    const state = this.adminState();
    if (!instanceId) return;
    if (instanceId !== this.lastDptInstanceId) {
      // New instance resolved — re-seed from its state on the next tick.
      this.lastDptInstanceId = instanceId;
      this.dptLoaded.set(false);
      this.dptSaved.set(false);
      this.dptSaveError.set(null);
    }
    if (this.dptLoaded()) return; // already seeded for this instance
    if (state === null) return; // wait for the first state tick
    const abs = state.dailyProfitTargetAbs ?? 0;
    const pct = state.dailyProfitTargetPct ?? 0;
    this.dptAbsServer.set(abs);
    this.dptPctServer.set(pct);
    this.dptAbsDraft.set(abs);
    this.dptPctDraft.set(pct);
    this.dptLoaded.set(true);
  });

  protected readonly dptHit = computed(() => this.adminState()?.dailyProfitTargetHit ?? false);
  protected readonly dptEnabled = computed(
    () => (this.dptAbsServer() ?? 0) > 0 || (this.dptPctServer() ?? 0) > 0,
  );

  protected dptSummary(): string {
    const pct = this.dptPctServer() ?? 0;
    const abs = this.dptAbsServer() ?? 0;
    if (pct > 0) return `${pct}% of start equity`;
    if (abs > 0) return `$${abs}`;
    return 'off';
  }

  protected dptDirty(): boolean {
    return (
      (this.dptAbsDraft() ?? 0) !== (this.dptAbsServer() ?? 0) ||
      (this.dptPctDraft() ?? 0) !== (this.dptPctServer() ?? 0)
    );
  }

  private parseDptInput(v: number | string | null): number | null {
    if (v === null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  protected onDptAbs(v: number | string | null): void {
    this.dptAbsDraft.set(this.parseDptInput(v));
    this.dptSaved.set(false);
    this.dptSaveError.set(null);
  }

  protected onDptPct(v: number | string | null): void {
    this.dptPctDraft.set(this.parseDptInput(v));
    this.dptSaved.set(false);
    this.dptSaveError.set(null);
  }

  protected resetDpt(): void {
    this.dptAbsDraft.set(this.dptAbsServer());
    this.dptPctDraft.set(this.dptPctServer());
    this.dptSaved.set(false);
    this.dptSaveError.set(null);
  }

  protected disableDpt(): void {
    this.dptAbsDraft.set(0);
    this.dptPctDraft.set(0);
    this.saveDpt();
  }

  protected saveDpt(): void {
    const ea = this.ea();
    if (!ea || !this.dptDirty()) return;
    const abs = this.dptAbsDraft() ?? 0;
    const pct = this.dptPctDraft() ?? 0;
    if (abs < 0 || pct < 0) {
      this.dptSaveError.set('Targets must be non-negative.');
      return;
    }
    this.savingDpt.set(true);
    this.dptSaveError.set(null);
    this.admin
      .updateInstanceConfig(ea.instanceId, {
        dailyProfitTargetAbs: abs,
        dailyProfitTargetPct: pct,
      })
      .pipe(
        finalize(() => this.savingDpt.set(false)),
        catchError((err) => {
          this.dptSaveError.set(err?.error?.message ?? 'Save failed.');
          return of(null);
        }),
      )
      .subscribe((res) => {
        if (res === null) return;
        if (!res.status) {
          this.dptSaveError.set(res.message ?? 'Save failed.');
          return;
        }
        // Optimistic: the EA applies on its next poll, so the live state echo
        // lags. Pin the saved values as the new baseline so the card is stable.
        this.dptAbsServer.set(abs);
        this.dptPctServer.set(pct);
        this.dptAbsDraft.set(abs);
        this.dptPctDraft.set(pct);
        this.dptSaved.set(true);
        this.notify.success(
          abs <= 0 && pct <= 0
            ? `Daily profit target disabled for EA ${ea.instanceId}.`
            : `Daily profit target updated for EA ${ea.instanceId}.`,
        );
        this.auditTrail
          .create({
            entityType: 'EAInstance',
            entityId: ea.id,
            decisionType: 'EAUpdateConfig',
            outcome: 'Queued',
            reason: null,
            contextJson: JSON.stringify({
              instanceId: ea.instanceId,
              dailyProfitTargetAbs: abs,
              dailyProfitTargetPct: pct,
            }),
            source: 'AdminUI',
          })
          .subscribe({ error: () => undefined });
      });
  }
}

function blankConfigForm(): ConfigForm {
  return {
    maxPosPerSymbol: '',
    maxLotPerOrder: '',
    maxSpreadPoints: '',
    maxConsecLosses: '',
    consecLossPauseMin: '',
    maxDailyLossPerSymbolPct: '',
    maxOpenPositions: '',
    maxDailyLossPct: '',
    maxOrdersPerMin: '',
  };
}

function buildPayload(form: ConfigForm, targetInstanceId: string): UpdateEAConfigRequest {
  const num = (s: string): number | undefined => {
    const trimmed = s.trim();
    if (trimmed === '') return undefined;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : undefined;
  };
  return {
    targetInstanceId,
    maxPosPerSymbol: num(form.maxPosPerSymbol),
    maxLotPerOrder: num(form.maxLotPerOrder),
    maxSpreadPoints: num(form.maxSpreadPoints),
    maxConsecLosses: num(form.maxConsecLosses),
    consecLossPauseMin: num(form.consecLossPauseMin),
    maxDailyLossPerSymbolPct: num(form.maxDailyLossPerSymbolPct),
    maxOpenPositions: num(form.maxOpenPositions),
    maxDailyLossPct: num(form.maxDailyLossPct),
    maxOrdersPerMin: num(form.maxOrdersPerMin),
  };
}
