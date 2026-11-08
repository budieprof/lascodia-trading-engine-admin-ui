import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { catchError, finalize, map, of } from 'rxjs';

import { EAInstancesService } from '@core/services/ea-instances.service';
import { EAAdminService } from '@core/services/ea-admin.service';
import { AuditTrailService } from '@core/services/audit-trail.service';
import { NotificationService } from '@core/notifications/notification.service';
import type {
  EABreakevenExitConfig,
  EAFillMode,
  EAFleetItem,
  EAInstanceDetail,
  EAInstanceDto,
} from '@core/api/api.types';
import { createPolledResource } from '@core/polling/polled-resource';
import { ModalA11yDirective } from '@shared/directives/modal-a11y.directive';
import { RefreshButtonComponent } from '@shared/components/refresh-button/refresh-button.component';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import { ProgressBarComponent } from '@shared/components/ui/progress-bar/progress-bar.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';
import { PageContextService } from '@core/assistant/page-context.service';

import { EAStatePanelComponent } from '../../components/ea-state-panel/ea-state-panel.component';
import { EAAuditTimelineComponent } from '../../components/ea-audit-timeline/ea-audit-timeline.component';
import { EAControlPanelComponent } from '../../components/ea-control-panel/ea-control-panel.component';
import { EAConfigPanelComponent } from '../../components/ea-config-panel/ea-config-panel.component';
import { EaConfigProfilePanelComponent } from '../../components/ea-config-profile-panel/ea-config-profile-panel.component';
import { EAPositionsPanelComponent } from '../../components/ea-positions-panel/ea-positions-panel.component';
import { EAPendingOrdersPanelComponent } from '../../components/ea-pending-orders-panel/ea-pending-orders-panel.component';
import { EALogsPanelComponent } from '../../components/ea-logs-panel/ea-logs-panel.component';
import { EARejectionsPanelComponent } from '../../components/ea-rejections-panel/ea-rejections-panel.component';
import { FLEET_STATUS_LABELS, fleetStatusOf } from '../../current-fleet';
import { EaOpsService } from '../../selfheal/ea-ops.service';
import { EaHealthCardComponent } from '../../selfheal/ea-health-card.component';
import { EaActionResultsComponent } from '../../selfheal/ea-action-results.component';
import { EaTerminalCardComponent } from '../../selfheal/ea-terminal-card.component';
import { EaDiagnosticsComponent } from '../../selfheal/ea-diagnostics.component';
import { EaCommandHistoryComponent } from '../../selfheal/ea-command-history.component';
import { EaHealTimelineComponent } from '../../selfheal/ea-heal-timeline.component';
import { EaHostLogsComponent } from '../../selfheal/ea-host-logs.component';
import { heartbeatFreshness } from '../../selfheal/selfheal.logic';

/**
 * The instance this page shows. `id` is the numeric row id, known only for Active instances (the
 * engine's live list carries it; the admin fleet list — the only source that includes Disconnected
 * and ShuttingDown instances — does not). Every admin endpoint is keyed by `instanceId`, so the page
 * works without it; only the audit entries' numeric entityId falls back.
 */
type EAView = Omit<EAInstanceDto, 'id'> & { id: number | null };

/** Fleet rows carry `id` from the 2026-10-19 engine on (`EAFleetItem.id`); older engines omit it. */
type FleetRow = EAFleetItem & { id?: number | null };

@Component({
  selector: 'app-ea-detail-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  // One results tray + settled stream for every panel on this page.
  providers: [EaOpsService],
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
    EaConfigProfilePanelComponent,
    EAPositionsPanelComponent,
    EAPendingOrdersPanelComponent,
    EALogsPanelComponent,
    EARejectionsPanelComponent,
    ModalA11yDirective,
    RefreshButtonComponent,
    EaHealthCardComponent,
    EaActionResultsComponent,
    EaTerminalCardComponent,
    EaDiagnosticsComponent,
    EaCommandHistoryComponent,
    EaHealTimelineComponent,
    EaHostLogsComponent,
  ],
  template: `
    <div class="page">
      <app-page-header
        [title]="ea() ? 'EA · ' + ea()!.instanceId : 'EA Detail'"
        [subtitle]="
          ea() ? 'Trading account #' + ea()!.tradingAccountId : loading() ? 'Loading…' : ''
        "
      >
        @if (ea(); as eaSnap) {
          <span slot="title-after" class="version-pill mono" [title]="'EA binary version'"
            >v{{ eaSnap.eaVersion }}</span
          >
        }
        <a routerLink="/ea-instances" class="btn btn-secondary">← All EA Instances</a>
        @if (ea()) {
          <!-- Coordinator-only maintenance action; lives with the other
               page-level actions rather than as a lone button at the foot
               of a 3,000px page. -->
          <button
            type="button"
            class="btn btn-secondary"
            (click)="askRefreshSpecs()"
            [disabled]="submitting()"
          >
            Refresh symbol specs
          </button>
        }
        <!-- Shared button: it owns the "my click is in flight" state. Bound to the resources'
             first-load flag, the old one never changed on a click (the review saw no effect). -->
        <app-refresh-button [refreshing]="anyRefreshing()" (refresh)="refreshAll()" />
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
      } @else if (loadFailed()) {
        <app-error-state
          title="Could not load EA instances"
          message="Engine returned an error fetching the instance list."
          (retry)="refreshAll()"
        />
      } @else if (!ea()) {
        <app-empty-state title="EA instance not found" [description]="notFoundMessage()" />
      } @else {
        <!-- Self-heal: the engine's verdict first, then the outcome of whatever the operator just did. -->
        <app-ea-health-card
          [instanceId]="ea()!.instanceId"
          [diag]="adminState()?.diag ?? null"
          [refreshTick]="refreshTick()"
        />
        <app-ea-action-results />
        @if (ea()!.status !== 'Active') {
          <!-- A Disconnected / ShuttingDown / Deregistered instance is shown as a record, not as
               a live EA: commands queued below wait for a heartbeat that may never come. -->
          <p class="inactive-banner" role="status">
            <strong>{{ fleetStatusLabel() }}</strong>
            — last heartbeat {{ ea()!.lastHeartbeat | relativeTime }}. Commands queued from this
            page wait until this instance polls again; if it was replaced by a newer registration
            they will never run.
          </p>
        }
        <!-- Registration facts on one strip: label over value, one row on a wide screen. -->
        <dl class="facts-strip" aria-label="Instance facts">
          <div class="fact">
            <dt>Status</dt>
            <dd>
              <span class="status-pill" [attr.data-status]="ea()!.status">{{
                fleetStatusLabel()
              }}</span>
              <!-- The engine never clears the flag when an EA goes quiet: only a live one
                   coordinates (the rule Fleet Health and the engine's fleet summary use). -->
              @if (ea()!.isCoordinator && ea()!.status === 'Active') {
                <span class="coord-pill">coordinator</span>
              }
            </dd>
          </div>
          <div class="fact">
            <dt>Last heartbeat</dt>
            <dd [title]="ea()!.lastHeartbeat | date: 'yyyy-MM-dd HH:mm:ss UTC'">
              <span [class.stale]="heartbeatStale()">
                {{ ea()!.lastHeartbeat | relativeTime }}
              </span>
            </dd>
          </div>
          <div class="fact">
            <dt>Trading account</dt>
            <dd class="mono">#{{ ea()!.tradingAccountId }}</dd>
          </div>
          <div class="fact">
            <dt>Chart</dt>
            <dd class="mono">{{ ea()!.chartSymbol }} · {{ ea()!.chartTimeframe }}</dd>
          </div>
          <div class="fact">
            <dt>EA version</dt>
            <dd class="mono">{{ ea()!.eaVersion }}</dd>
          </div>
          <div class="fact">
            <dt>Registered</dt>
            <dd class="num">{{ ea()!.registeredAt | date: 'yyyy-MM-dd HH:mm' }} UTC</dd>
          </div>
          <div class="fact">
            <dt>Deregistered</dt>
            <dd class="num">
              @if (ea()!.deregisteredAt) {
                {{ ea()!.deregisteredAt | date: 'yyyy-MM-dd HH:mm' }} UTC
              } @else {
                <span class="muted">—</span>
              }
            </dd>
          </div>
          <div class="fact fact-wide">
            <dt>Instance id</dt>
            <dd class="mono">{{ ea()!.instanceId }}</dd>
          </div>
        </dl>
        @if (freshness().stale) {
          <p class="stale-note" role="status">
            The EA has not reported since its last heartbeat — everything below is the last known
            state.
          </p>
        }

        <!-- Jump links: the page runs ~11,000px; each button scrolls to its section. -->
        <nav class="jump" aria-label="Sections on this page">
          <span class="jump-label">Jump to</span>
          @for (s of sections; track s.id) {
            <button type="button" (click)="jumpTo(s.id)">{{ s.label }}</button>
          }
        </nav>

        <!-- Self-heal: the terminal (host supervisor) and the EA's own diagnostics. -->
        <h2 class="section-title" id="sec-terminal">
          Terminal &amp; diagnostics
          <span class="section-hint"
            >The MT5 terminal on its host, and the EA's own self-checks</span
          >
        </h2>
        <div class="ea-selfheal-grid">
          <app-ea-terminal-card [instanceId]="ea()!.instanceId" [refreshTick]="refreshTick()" />
          <app-ea-diagnostics
            [diag]="adminState()?.diag ?? null"
            [stale]="freshness().stale"
            [staleLabel]="freshness().label"
            [nowMs]="now()"
          />
        </div>

        <h2 class="section-title" id="sec-trading">
          Trading &amp; execution settings
          <span class="section-hint"
            >Saved per account; the EA picks changes up on its next poll</span
          >
        </h2>
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
                  Auto-recovering safety stop — clears itself once its condition resolves. Manage in
                  Operator controls below.
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
        <!-- ── Control-panel grid ───────────────────────────────────────
             The four operator panels below (Trading, Fill mode, Breakeven
             exit, Daily profit target) used to stack full-width.  Wrapped
             into a 2-up responsive grid so the page is denser on wide
             screens; collapses to 1-up below the min-cell width. -->
        <div class="ea-cards-grid">
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
              <div class="set-foot">
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
            </div>
          </section>

          <!-- ── Spread pad toggle ────────────────────────────────────────
             Per-account opt-out for SpreadPadder (bid-anchored exit sync:
             entry never moves; shorts SL/TP + floor, pending longs TP −
             floor). AND-ed under the hood with the engine-wide
             SpreadReactive:Pad:Enabled master — either off skips the pad
             for this account. Hot-reloads via EngineConfigCache on the
             next pad evaluation. -->
          <section
            class="fill-mode-panel"
            [attr.data-mode]="
              (spreadPadDraft() ?? spreadPadServer()) === null
                ? null
                : (spreadPadDraft() ?? spreadPadServer())
                  ? 'On'
                  : 'Off'
            "
          >
            <div class="fm-info">
              <div class="fm-headline">
                <span class="fm-label">Spread pad</span>
                @if (spreadPadServer() === true) {
                  <span class="fm-pill ok">On</span>
                } @else if (spreadPadServer() === false) {
                  <!-- Off is the default, not a warning — same muted pill the
                       breakeven and profit-target cards use for their off state. -->
                  <span class="fm-pill muted">Off</span>
                } @else {
                  <span class="fm-pill muted">…</span>
                }
              </div>
              <span class="fm-desc muted small">
                @if ((spreadPadDraft() ?? spreadPadServer()) === true) {
                  Sync pad: exits are shifted by the per-(account, symbol) floor so they trigger
                  when the CHART (bid) touches the analyser's levels — shorts get SL &amp; TP lifted
                  (no more spread-spike stop-outs), pending longs get TP lowered. Entry is never
                  moved. Engine-wide master must also be on for the pad to fire.
                } @else if ((spreadPadDraft() ?? spreadPadServer()) === false) {
                  Padding disabled for this account — exits reach the broker at the analyser's
                  original levels, so short SL/TP will trigger a full spread early (ask-triggered).
                } @else {
                  Loading…
                }
              </span>
            </div>
            <div class="fm-actions">
              <div
                class="fm-toggle"
                role="radiogroup"
                aria-label="Spread pad enabled"
                [class.is-loading]="spreadPadServer() === null"
              >
                <button
                  type="button"
                  role="radio"
                  class="fm-opt"
                  [class.active]="(spreadPadDraft() ?? spreadPadServer()) === true"
                  [attr.aria-checked]="(spreadPadDraft() ?? spreadPadServer()) === true"
                  [disabled]="spreadPadServer() === null || savingSpreadPad()"
                  (click)="setSpreadPad(true)"
                >
                  On
                </button>
                <button
                  type="button"
                  role="radio"
                  class="fm-opt"
                  [class.active]="(spreadPadDraft() ?? spreadPadServer()) === false"
                  [attr.aria-checked]="(spreadPadDraft() ?? spreadPadServer()) === false"
                  [disabled]="spreadPadServer() === null || savingSpreadPad()"
                  (click)="setSpreadPad(false)"
                >
                  Off
                </button>
              </div>
              @if (spreadPadMultiplierServer() !== null) {
                <div class="fm-multiplier">
                  <label class="fm-mult-label">
                    <span class="fm-mult-name">Floor multiplier</span>
                    <input
                      class="fm-mult-input"
                      type="number"
                      min="1"
                      max="10"
                      step="0.1"
                      [value]="spreadPadMultiplierDraft() ?? spreadPadMultiplierServer()"
                      [disabled]="savingSpreadPad()"
                      (input)="setSpreadPadMultiplier($any($event.target).value)"
                    />
                  </label>
                  <span class="muted small fm-mult-hint">
                    Effective pad = floor × multiplier. Engine-wide default
                    <strong>{{ spreadPadEngineWideMultiplier() ?? 1 }}</strong
                    >; this account currently
                    @if (spreadPadMultiplierIsOverridden()) {
                      <strong>overrides</strong> the default at
                      <strong>{{ spreadPadMultiplierServer() }}</strong
                      >.
                    } @else {
                      <strong>inherits</strong> the default. Saving a value here writes a
                      per-account override.
                    }
                    Floor captures the calm spread (≈p50); spikes hit 2-3× on real brokers, so raise
                    to 2.5-3.5 on live broker accounts so short stops stay clear of upper-tail
                    spread.
                  </span>
                </div>
              }
              <div class="set-foot">
                <div class="fm-status small">
                  @if (savingSpreadPad()) {
                    <span class="muted">Saving…</span>
                  } @else if (spreadPadSaveError()) {
                    <span class="bad">{{ spreadPadSaveError() }}</span>
                  } @else if (spreadPadSaved()) {
                    <span class="ok">Saved · takes effect on next pad evaluation</span>
                  } @else if (spreadPadDirty()) {
                    <span class="muted">Unsaved change</span>
                  } @else {
                    <span class="muted">Default · Off</span>
                  }
                </div>
                <div class="fm-buttons">
                  <button
                    type="button"
                    class="btn btn-secondary"
                    (click)="resetSpreadPad()"
                    [disabled]="!spreadPadDirty() || savingSpreadPad()"
                  >
                    Revert
                  </button>
                  <button
                    type="button"
                    class="btn btn-primary"
                    (click)="saveSpreadPad()"
                    [disabled]="!spreadPadDirty() || savingSpreadPad()"
                  >
                    {{ savingSpreadPad() ? 'Saving…' : 'Save' }}
                  </button>
                </div>
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

                <div class="set-foot">
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
              <div class="set-foot">
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
            </div>
          </section>
        </div>
        <!-- /.ea-cards-grid -->

        <h2 class="section-title" id="sec-account">
          Account
          <span class="section-hint"
            >Broker-synced balance, margin and the symbols this instance owns</span
          >
        </h2>
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
              <div class="acct-tile" [class.pos]="acct.profit > 0" [class.neg]="acct.profit < 0">
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
              <div
                class="acct-tile"
                [class.warn]="marginLevelWarn(acct)"
                [class.neg]="marginLevelDanger(acct)"
              >
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

            <!-- Secondary kv: margin used, credit, broker SO call/stop-out.
                 Each label/value pair is one grid item, so a wrap can never
                 separate a label from its value (it used to drop the
                 margin-call figure onto the next row on its own). -->
            <dl class="account-kv">
              <div class="kv-pair">
                <dt>Margin used</dt>
                <dd class="mono">{{ acct.marginUsed | number: '1.2-2' }} {{ acct.currency }}</dd>
              </div>
              <div class="kv-pair">
                <dt>Credit</dt>
                <dd class="mono">
                  @if (acct.credit > 0) {
                    {{ acct.credit | number: '1.2-2' }} {{ acct.currency }}
                  } @else {
                    <span class="muted">0.00 {{ acct.currency }}</span>
                  }
                </dd>
              </div>
              <div class="kv-pair">
                <dt>Margin call</dt>
                <dd class="mono">
                  @if (acct.marginSoCall > 0) {
                    {{ acct.marginSoCall | number: '1.0-1'
                    }}{{ acct.marginSoMode === 'Percent' ? '%' : ' ' + acct.currency }}
                  } @else {
                    <span class="muted">—</span>
                  }
                </dd>
              </div>
              <div class="kv-pair">
                <dt>Stop-out</dt>
                <dd class="mono">
                  @if (acct.marginSoStopOut > 0) {
                    {{ acct.marginSoStopOut | number: '1.0-1'
                    }}{{ acct.marginSoMode === 'Percent' ? '%' : ' ' + acct.currency }}
                  } @else {
                    <span class="muted">—</span>
                  }
                </dd>
              </div>
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

        <h2 class="section-title" id="sec-state">
          Live state &amp; positions
          <span class="section-hint"
            >What the EA reported in its latest heartbeat, and what it holds</span
          >
        </h2>
        <!-- Phase-1 admin: rich-state envelope visualization -->
        <app-ea-state-panel
          [state]="adminState()"
          [lastUpdated]="adminLastStateUpdatedAt()"
          [loading]="detailLoading()"
          [currency]="account()?.currency ?? null"
          [stale]="freshness().stale && !!adminState()"
          [staleLabel]="freshnessTitle()"
        />

        <!-- Phase-5b admin: live open positions + working orders, narrowed
             to symbols this specific EA instance owns.  Without the
             ownedSymbolsCsv input a sibling's detail page surfaces the
             parent's positions and pending orders, which mis-attributes
             P&L to the wrong instance.  See Phase-14. -->
        <!-- Open positions + Pending orders side-by-side on wide screens;
             collapse to stacked below the min-cell width. -->
        <div class="ea-positions-orders-grid">
          <app-ea-positions-panel
            [tradingAccountId]="ea()!.tradingAccountId"
            [instanceId]="ea()!.instanceId"
            [ownedSymbolsCsv]="ea()!.symbols"
            [reportedOpenCount]="adminState()?.positionCount ?? null"
          />
          <app-ea-pending-orders-panel
            [tradingAccountId]="ea()!.tradingAccountId"
            [ownedSymbolsCsv]="ea()!.symbols"
          />
        </div>

        <h2 class="section-title" id="sec-commands">
          Commands
          <span class="section-hint"
            >Safety and maintenance commands, and what the EA answered</span
          >
        </h2>
        <!-- Phase-1/2/3 admin: operator control surface (9 actions, inline confirm dialogs) -->
        <app-ea-control-panel
          [instanceId]="ea()!.instanceId"
          (commandQueued)="onCommandQueued($event)"
        />

        <app-ea-command-history [instanceId]="ea()!.instanceId" [refreshTick]="refreshTick()" />

        <h2 class="section-title" id="sec-config">
          EA inputs &amp; profiles
          <span class="section-hint"
            >Change this EA's inputs, or capture and apply saved profiles</span
          >
        </h2>
        <!-- Phase-4 admin: hot-reload input editor + read-only inspection -->
        <app-ea-config-panel
          [instanceId]="ea()!.instanceId"
          [inputs]="adminInputs()"
          [loading]="detailLoading()"
          [restartReady]="adminState()?.diag?.restartTemplateSeeded ?? null"
          (configPushed)="onCommandQueued('configPush')"
        />

        <!-- Named config profiles: capture this instance's effective config,
             or apply a saved one. Exists because instance config previously
             lived only as EA runtime state, which made fleet drift invisible. -->
        <app-ea-config-profile-panel
          [instanceId]="ea()!.instanceId"
          (profileApplied)="onCommandQueued('configPush')"
        />

        <h2 class="section-title" id="sec-logs">
          Logs &amp; history
          <span class="section-hint"
            >EA log tail, safety audit, host logs, auto-heal and rejected signals</span
          >
        </h2>
        <!-- Logs (Phase-9) + Audit timeline (Phase-2A) side-by-side on
             wide screens; collapse to stacked below the min-cell width. -->
        <div class="ea-logs-audit-grid" id="ea-logs">
          <app-ea-logs-panel [instanceId]="ea()!.instanceId" />
          <app-ea-audit-timeline [instanceId]="ea()!.instanceId" />
        </div>
        <div class="ea-logs-audit-grid">
          <app-ea-host-logs [instanceId]="ea()!.instanceId" />
          <app-ea-heal-timeline [instanceId]="ea()!.instanceId" [refreshTick]="refreshTick()" />
        </div>
        <app-ea-rejections-panel [instanceId]="ea()!.instanceId" />
      }

      @if (askingRefresh()) {
        <div class="modal-overlay" (click)="cancelRefresh()">
          <div
            class="modal"
            (click)="$event.stopPropagation()"
            role="dialog"
            aria-modal="true"
            appModalA11y
            (dismiss)="cancelRefresh()"
          >
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
              <button
                type="button"
                class="btn btn-secondary"
                (click)="cancelRefresh()"
                data-autofocus
              >
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
          <div
            class="modal"
            (click)="$event.stopPropagation()"
            role="dialog"
            aria-modal="true"
            appModalA11y
            (dismiss)="cancelTradingAction()"
          >
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
              <button
                type="button"
                class="btn btn-secondary"
                (click)="cancelTradingAction()"
                data-autofocus
              >
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
    </div>
  `,
  styleUrl: './ea-detail-page.component.scss',
})
export class EaDetailPageComponent {
  private readonly service = inject(EAInstancesService);
  private readonly admin = inject(EAAdminService);
  private readonly auditTrail = inject(AuditTrailService);
  private readonly notify = inject(NotificationService);
  private readonly route = inject(ActivatedRoute);

  /**
   * The route key is either the numeric row id (the list and broker pages link by it, and old
   * bookmarks carry it) or the `instanceId` — the engine's notification feed links
   * `/ea-instances/{InstanceId}` for every "EA disconnected" / "EA error" item. The page used to
   * parse it with Number(), so every one of those links landed on "not found".
   */
  protected readonly routeKey = toSignal(
    this.route.paramMap.pipe(map((p) => (p.get('id') ?? '').trim())),
    { initialValue: '' },
  );
  private readonly numericId = computed(() => {
    const key = this.routeKey();
    return /^\d+$/.test(key) ? Number(key) : null;
  });
  /** Numeric row id when known (every instance on a current engine), else what the route carried. */
  protected readonly id = computed(
    () => this.ea()?.id ?? this.detailResource.value()?.id ?? this.numericId(),
  );

  /** `/ea-instances/:id/logs` — the notification feed's EA-error link — scrolls to the logs. */
  private readonly focusLogs = this.route.snapshot.data['focus'] === 'logs';
  private logsFocused = false;

  private readonly pageContext = inject(PageContextService);
  private readonly ops = inject(EaOpsService);

  /** In-page jump links, in page order (ids are the section headings in the template). */
  protected readonly sections = [
    { id: 'sec-terminal', label: 'Terminal' },
    { id: 'sec-trading', label: 'Trading settings' },
    { id: 'sec-account', label: 'Account' },
    { id: 'sec-state', label: 'Live state & positions' },
    { id: 'sec-commands', label: 'Commands' },
    { id: 'sec-config', label: 'Inputs & profiles' },
    { id: 'sec-logs', label: 'Logs & history' },
  ] as const;

  protected jumpTo(id: string): void {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /** Bumped by Refresh so the self-heal panels refetch with the rest of the page. */
  protected readonly refreshTick = signal(0);
  /** Page clock (5 s) for staleness wording. */
  protected readonly now = signal(Date.now());

  /**
   * Heartbeat freshness on the engine's line (120 s). When stale, every panel that shows the
   * envelope says "last known (N min ago)" instead of presenting it as the present.
   */
  protected readonly freshness = computed(() =>
    heartbeatFreshness(
      this.detailResource.value()?.lastHeartbeat ?? this.ea()?.lastHeartbeat ?? null,
      this.now(),
    ),
  );
  protected readonly freshnessTitle = computed(() => {
    const f = this.freshness();
    return f.label ? f.label.charAt(0).toUpperCase() + f.label.slice(1) : '';
  });

  constructor() {
    const clock = setInterval(() => this.now.set(Date.now()), 5000);
    inject(DestroyRef).onDestroy(() => clearInterval(clock));
    // Whatever an action changed (state, terminal, config) shows as soon as it has an outcome.
    this.ops.settled$.pipe(takeUntilDestroyed()).subscribe(() => this.onCommandQueued('settled'));
    this.pageContext.publish(() => ({
      headline: `EA instance ${this.ea()?.instanceId ?? '#' + (this.routeKey() || '?')} detail`,
      record: { kind: 'eaInstance', id: this.id() ?? 0 },
    }));
    effect(() => {
      if (!this.focusLogs || this.logsFocused || !this.ea()) return;
      this.logsFocused = true;
      // After this render pass: the logs panel is inside the @else branch that just appeared.
      setTimeout(() =>
        document.getElementById('ea-logs')?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
      );
    });
  }

  /** Live instances (`/ea/instances`, Active only). */
  protected readonly resource = createPolledResource(
    () => this.service.list().pipe(map((res) => res.data ?? [])),
    { intervalMs: 15_000 },
  );

  /**
   * Every registered instance, including Disconnected and ShuttingDown — `/ea/instances` returns
   * Active only, so an instance that dropped off (exactly the one an operator opens from a
   * "disconnected" alert) could never be shown.
   */
  private readonly fleetResource = createPolledResource(
    () => this.admin.listFleet().pipe(map((res) => (res.data ?? []) as FleetRow[])),
    { intervalMs: 15_000 },
  );

  protected readonly ea = computed<EAView | null>(() => {
    const key = this.routeKey();
    if (!key) return null;
    const num = this.numericId();
    const live = this.resource.value() ?? [];
    const fromLive =
      num !== null ? live.find((x) => x.id === num) : live.find((x) => x.instanceId === key);
    if (fromLive) return fromLive;
    const fleet = this.fleetResource.value() ?? [];
    const row =
      num !== null ? fleet.find((x) => x.id === num) : fleet.find((x) => x.instanceId === key);
    return row ? { ...row, id: row.id ?? null } : null;
  });

  protected readonly notFoundMessage = computed(() => {
    const num = this.numericId();
    if (num !== null) {
      // An engine from 2026-10-19 on reports `id` on every fleet row, so a numeric miss is a
      // real miss; an older one reports it for live instances only.
      const fleetHasIds = (this.fleetResource.value() ?? []).some((x) => x.id != null);
      return fleetHasIds
        ? `No registered EA instance has id #${num}. It may have been deleted.`
        : `No live EA instance has id #${num}. Disconnected and shut-down instances are not ` +
            `addressable by row id on this engine version (its fleet list does not report it) — ` +
            `open them from the EA Instances list, which links by instance id.`;
    }
    return `No registered EA instance is named "${this.routeKey()}". It may have been deleted.`;
  });

  /** "Deregistered" for a long-silent ShuttingDown row (see fleetStatusOf); never the raw enum. */
  protected readonly fleetStatusLabel = computed(() => {
    const ea = this.ea();
    return ea ? FLEET_STATUS_LABELS[fleetStatusOf(ea, Date.now())] : '';
  });

  /** Both lists failed and nothing resolved — an engine problem, not a missing instance. */
  protected readonly loadFailed = computed(
    () => !this.ea() && !!this.resource.error() && !!this.fleetResource.error(),
  );

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
    this.fleetResource.refresh();
    this.detailResource.refresh();
  }

  /** Skeleton until the instance resolves, or until both lists have answered without it. */
  protected readonly loading = computed(
    () => !this.ea() && (this.resource.loading() || this.fleetResource.loading()),
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
    () =>
      this.resource.loading() ||
      this.resource.refreshing() ||
      this.fleetResource.refreshing() ||
      this.detailResource.loading() ||
      this.detailResource.refreshing(),
  );

  /** Any of the page's fetches in flight — what the Refresh button waits on. */
  protected readonly anyRefreshing = computed(
    () =>
      this.resource.refreshing() ||
      this.fleetResource.refreshing() ||
      this.detailResource.refreshing(),
  );

  /** Manual refresh — kick every resource at once instead of just the list. */
  protected refreshAll(): void {
    this.refreshTick.update((n) => n + 1);
    this.resource.refresh();
    this.fleetResource.refresh();
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
    return this.now() - ts > 90_000;
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
                entityId: ea.id ?? 0,
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
            const label = intent === 'disable' ? 'Disable trading' : 'Enable trading';
            if (res.data?.commandId != null) {
              this.ops.trackCommand(ea.instanceId, res.data.commandId, label);
              this.notify.info(`${label} sent — waiting for the EA's answer.`);
            } else {
              this.notify.success(`${label} queued for EA ${ea.instanceId}.`);
            }
            this.auditTrail
              .create({
                entityType: 'EAInstance',
                entityId: ea.id ?? 0,
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
            entityId: ea.id ?? 0,
            decisionType: 'EAUpdateFillMode',
            outcome: 'Saved',
            reason: null,
            contextJson: JSON.stringify({ instanceId: ea.instanceId, fillMode: draft }),
            source: 'AdminUI',
          })
          .subscribe({ error: () => undefined });
      });
  }

  // Spread-pad toggle ---------------------------------------------------
  //
  // Per-account opt-in for SpreadPadder. The engine AND-s this with the
  // engine-wide SpreadReactive:Pad:Enabled master, so this toggle is purely
  // an opt-in for an individual account (defaults to off — operator must
  // explicitly flip each account on).  Same draft/server/saving signal
  // pattern as the fill-mode card above.
  protected readonly spreadPadServer = signal<boolean | null>(null);
  protected readonly spreadPadDraft = signal<boolean | null>(null);
  protected readonly savingSpreadPad = signal(false);
  protected readonly spreadPadSaved = signal(false);
  protected readonly spreadPadSaveError = signal<string | null>(null);
  // Multiplier draft/server pair runs in parallel with the toggle so a
  // single Save round-trips both. The engine-wide default is surfaced
  // for the "default X.X" hint next to the input.
  protected readonly spreadPadMultiplierServer = signal<number | null>(null);
  protected readonly spreadPadMultiplierDraft = signal<number | null>(null);
  protected readonly spreadPadEngineWideMultiplier = signal<number | null>(null);
  protected readonly spreadPadMultiplierIsOverridden = signal<boolean>(false);

  private lastSpreadPadInstanceId: string | null = null;
  private readonly _loadSpreadPad = effect(() => {
    const instanceId = this.ea()?.instanceId ?? null;
    if (!instanceId) return;
    if (instanceId === this.lastSpreadPadInstanceId) return;
    this.lastSpreadPadInstanceId = instanceId;
    this.spreadPadServer.set(null);
    this.spreadPadDraft.set(null);
    this.spreadPadMultiplierServer.set(null);
    this.spreadPadMultiplierDraft.set(null);
    this.spreadPadEngineWideMultiplier.set(null);
    this.spreadPadMultiplierIsOverridden.set(false);
    this.spreadPadSaved.set(false);
    this.spreadPadSaveError.set(null);
    this.admin
      .getSpreadPad(instanceId)
      .pipe(catchError(() => of(null)))
      .subscribe((res) => {
        const enabled = res?.data?.enabled ?? false;
        const multiplier = res?.data?.multiplier ?? 1;
        const engineWide = res?.data?.engineWideMultiplier ?? 1;
        const overridden = res?.data?.multiplierIsOverridden ?? false;
        this.spreadPadServer.set(enabled);
        this.spreadPadDraft.set(enabled);
        this.spreadPadMultiplierServer.set(multiplier);
        this.spreadPadMultiplierDraft.set(multiplier);
        this.spreadPadEngineWideMultiplier.set(engineWide);
        this.spreadPadMultiplierIsOverridden.set(overridden);
      });
  });

  protected spreadPadDirty(): boolean {
    const s = this.spreadPadServer();
    const d = this.spreadPadDraft();
    const enabledDirty = s !== null && d !== null && s !== d;
    const ms = this.spreadPadMultiplierServer();
    const md = this.spreadPadMultiplierDraft();
    const multDirty = ms !== null && md !== null && ms !== md;
    return enabledDirty || multDirty;
  }

  protected setSpreadPad(enabled: boolean): void {
    this.spreadPadDraft.set(enabled);
    this.spreadPadSaved.set(false);
    this.spreadPadSaveError.set(null);
  }

  protected setSpreadPadMultiplier(raw: string | number): void {
    const v = typeof raw === 'number' ? raw : Number.parseFloat(String(raw));
    if (!Number.isFinite(v)) return;
    // Mirror the engine's [1.0, 10.0] clamp so the displayed value matches
    // what will be persisted; below 1 is meaningless (pad smaller than
    // calm spread is worse than no pad), above 10 is almost certainly a typo.
    const clamped = Math.max(1, Math.min(10, v));
    this.spreadPadMultiplierDraft.set(clamped);
    this.spreadPadSaved.set(false);
    this.spreadPadSaveError.set(null);
  }

  protected resetSpreadPad(): void {
    this.spreadPadDraft.set(this.spreadPadServer());
    this.spreadPadMultiplierDraft.set(this.spreadPadMultiplierServer());
    this.spreadPadSaved.set(false);
    this.spreadPadSaveError.set(null);
  }

  protected saveSpreadPad(): void {
    const ea = this.ea();
    const draft = this.spreadPadDraft();
    const multDraft = this.spreadPadMultiplierDraft();
    const multServer = this.spreadPadMultiplierServer();
    if (!ea || draft === null) return;
    if (!this.spreadPadDirty()) return;
    // Only PUT the multiplier when it actually changed — otherwise leave
    // the per-account row untouched (preserves the inherit-from-engine-wide
    // semantics for accounts that have never been overridden).
    const multiplier =
      multDraft !== null && multServer !== null && multDraft !== multServer ? multDraft : null;
    this.savingSpreadPad.set(true);
    this.spreadPadSaveError.set(null);
    this.admin
      .updateSpreadPad(ea.instanceId, { enabled: draft, multiplier })
      .pipe(
        finalize(() => this.savingSpreadPad.set(false)),
        catchError((err) => {
          this.spreadPadSaveError.set(err?.error?.message ?? 'Save failed.');
          return of(null);
        }),
      )
      .subscribe((res) => {
        if (res === null) return;
        if (!res.status) {
          this.spreadPadSaveError.set(res.message ?? 'Save failed.');
          return;
        }
        this.spreadPadServer.set(draft);
        if (multiplier !== null) {
          this.spreadPadMultiplierServer.set(multiplier);
          this.spreadPadMultiplierIsOverridden.set(true);
        }
        this.spreadPadSaved.set(true);
        this.notify.success(
          `Spread pad ${draft ? 'enabled' : 'disabled'} for EA ${ea.instanceId}` +
            (multiplier !== null ? ` (multiplier ${multiplier.toFixed(2)})` : '') +
            '.',
        );
        this.auditTrail
          .create({
            entityType: 'EAInstance',
            entityId: ea.id ?? 0,
            decisionType: 'EAUpdateSpreadPad',
            outcome: 'Saved',
            reason: null,
            contextJson: JSON.stringify({
              instanceId: ea.instanceId,
              enabled: draft,
              multiplier,
            }),
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
            entityId: ea.id ?? 0,
            decisionType: 'EAUpdateBreakevenExit',
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
            entityId: ea.id ?? 0,
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
