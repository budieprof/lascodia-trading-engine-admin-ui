import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { catchError, finalize, map, of } from 'rxjs';

import { EAInstancesService } from '@core/services/ea-instances.service';
import { EAAdminService } from '@core/services/ea-admin.service';
import { AuditTrailService } from '@core/services/audit-trail.service';
import { NotificationService } from '@core/notifications/notification.service';
import type { EAInstanceDetail, EAInstanceDto, UpdateEAConfigRequest } from '@core/api/api.types';
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
        [subtitle]="
          ea() ? 'Trading account #' + ea()!.tradingAccountId + ' · ' + ea()!.eaVersion : 'Loading…'
        "
      >
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
      .field input {
        padding: 6px 10px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-sm);
        font-variant-numeric: tabular-nums;
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
  /** Phase-4: the inputs sub-object the EA emits inside the rich-state envelope. */
  protected readonly adminInputs = computed(() => this.adminState()?.inputs ?? null);

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
