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

        <!-- Phase-9 admin: live WARN/ERROR log tail forwarded from the EA -->
        <app-ea-logs-panel [instanceId]="ea()!.instanceId" />

        <!-- Phase-2A admin: per-instance safety-audit timeline -->
        <app-ea-audit-timeline [instanceId]="ea()!.instanceId" />
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
