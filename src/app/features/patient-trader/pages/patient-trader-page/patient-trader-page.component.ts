import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';

import { PatientTraderService } from '@core/services/patient-trader.service';
import { AuthService } from '@core/auth/auth.service';
import { Permission } from '@core/auth/permissions.generated';
import { CurrencyPairsService } from '@core/services/currency-pairs.service';
import { createPolledResource } from '@core/polling/polled-resource';
import type { PatientTraderConfig } from '@features/patient-trader/patient-trader.types';
import {
  PlanFilters,
  boardQuery,
  filtersFromParams,
  filtersToParams,
  isConfigDirty,
  newlyLiveMarkets,
  toSavePayload,
  withInstructionShown,
} from '@features/patient-trader/patient-trader.logic';
import { HasUnsavedChanges, warnBeforeUnload } from '@features/scripting/shared/unsaved-changes';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import {
  ConfigPatch,
  PtConfigFormComponent,
} from '../../components/pt-config-form/pt-config-form.component';
import { PtHealthStripComponent } from '../../components/pt-health-strip/pt-health-strip.component';
import { PtPlansTableComponent } from '../../components/pt-plans-table/pt-plans-table.component';
import { PtResultsPanelComponent } from '../../components/pt-results-panel/pt-results-panel.component';
import { PtStatusStripComponent } from '../../components/pt-status-strip/pt-status-strip.component';
import { PtViewsPanelComponent } from '../../components/pt-views-panel/pt-views-panel.component';

/** Rows per page of the plans table. */
const PLAN_PAGE_SIZE = 50;

/**
 * Patient Trader cockpit — is it running, how is it doing, what does it think, and what has it
 * planned or passed on.
 *
 * A thin container: it owns the data (board, health, config), the editable draft with its dirty
 * check and save flow, and the URL state (`?oco=` and the plan filters). Each panel is its own
 * component under `../../components/`.
 */
@Component({
  selector: 'app-patient-trader-page',
  standalone: true,
  imports: [
    ConfirmDialogComponent,
    PtConfigFormComponent,
    PtHealthStripComponent,
    PtPlansTableComponent,
    PtResultsPanelComponent,
    PtStatusStripComponent,
    PtViewsPanelComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <header class="page-head">
        <div>
          <h1>Patient Trader</h1>
          <p class="muted">
            Keeps a standing view of each market it follows and writes a card for each idea worth
            having, armed as a watch that files it when its price condition is met. It never manages
            a position.
          </p>
        </div>
        @if (config(); as c) {
          <div class="head-actions">
            @if (dirty()) {
              <span class="unsaved" role="status">Unsaved changes</span>
            }
            <span class="mode-badge" [class.live]="c.enabled && c.mode === 'Live'">
              {{ c.enabled ? c.mode : 'Switched off' }}
            </span>
          </div>
        }
      </header>

      <app-pt-health-strip [health]="health()" [error]="healthError()" />

      <app-pt-status-strip [board]="board()" [engine]="engine()" />

      <div class="cols">
        <div class="col">
          @if (draft(); as d) {
            <app-pt-config-form
              [draft]="d"
              [health]="health()"
              [canManage]="canManage()"
              [saving]="saving()"
              [dirty]="dirty()"
              [availableSymbols]="availableSymbols()"
              [pairsLoading]="pairsLoading()"
              [message]="saveMessage()"
              [conflict]="conflict() !== null"
              [(reason)]="reason"
              (patch)="applyPatch($event)"
              (save)="requestSave()"
              (discard)="discard()"
              (reloadCurrent)="reloadCurrent()"
            />
          } @else if (configError()) {
            <section class="card">
              <p class="muted small">Could not load the configuration.</p>
            </section>
          }
        </div>

        <div class="col">
          <app-pt-views-panel [views]="board()?.views ?? []" [symbols]="symbols()" />
          <app-pt-results-panel [symbols]="symbols()" />
        </div>
      </div>

      @if (board(); as b) {
        <app-pt-plans-table
          [plans]="b.plans"
          [total]="planTotal()"
          [pageSize]="pageSize"
          [filters]="filters()"
          [oco]="oco()"
          [codes]="rejectionCodes()"
          [symbols]="symbols()"
          (filtersChange)="setFilters($event)"
          (ocoSelect)="selectOco($event)"
        />
      }

      <app-confirm-dialog
        [open]="liveConfirm() !== null"
        title="Start filing real signals?"
        [message]="liveConfirmMessage()"
        confirmLabel="Save and go live"
        confirmVariant="destructive"
        [loading]="saving()"
        (confirm)="confirmLive()"
        (cancelled)="liveConfirm.set(null)"
      />
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
      .page-head {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: var(--space-4);
      }
      h1 {
        margin: 0;
        font-size: var(--text-xl);
        font-weight: var(--font-semibold);
      }
      .muted {
        color: var(--text-secondary);
      }
      .small {
        font-size: var(--text-xs);
      }
      .head-actions {
        display: flex;
        align-items: center;
        gap: var(--space-3);
        flex-shrink: 0;
      }
      .mode-badge,
      .unsaved {
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        padding: 4px 10px;
        border-radius: var(--radius-full);
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .mode-badge.live {
        background: color-mix(in srgb, var(--accent) 16%, transparent);
        color: var(--accent);
      }
      .unsaved {
        background: rgba(234, 179, 8, 0.15);
        color: #b45309;
      }
      .card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-4);
      }
      .cols {
        display: grid;
        /* The config column is a fixed-size form; the panels beside it are the page. */
        grid-template-columns: minmax(360px, 34%) 1fr;
        gap: var(--space-4);
        align-items: start;
      }
      .col {
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
        min-width: 0;
      }
      @media (max-width: 1000px) {
        .cols {
          grid-template-columns: 1fr;
        }
      }
    `,
  ],
})
export class PatientTraderPageComponent implements HasUnsavedChanges {
  private readonly svc = inject(PatientTraderService);
  private readonly auth = inject(AuthService);
  private readonly currencyPairs = inject(CurrencyPairsService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  /** The config PUT needs platform.engine.manage on the engine. */
  readonly canManage = computed(() => this.auth.hasPermission(Permission.PlatformEngineManage));

  protected readonly pageSize = PLAN_PAGE_SIZE;

  // ── URL state ──────────────────────────────────────────────────────────────

  /** The OCO group the plans table is narrowed to (`?oco=`), or null for the latest plans. */
  readonly oco = signal<string | null>(
    this.route.snapshot.queryParamMap.get('oco')?.trim() || null,
  );
  /** Plan filters and page (`?pstatus=&pdir=&pcode=&psym=&ppage=`). */
  readonly filters = signal<PlanFilters>(
    filtersFromParams((n) => this.route.snapshot.queryParamMap.get(n)),
  );

  // ── Data ───────────────────────────────────────────────────────────────────

  /**
   * The board is push-driven. The interval is a long fallback that only heals a missed push or a
   * reconnect gap — an interval short enough to feel live is also short enough to repaint the
   * page under an operator mid-edit.
   */
  private readonly boardResource = createPolledResource(
    () => this.svc.getBoard(boardQuery(this.filters(), PLAN_PAGE_SIZE, this.oco())),
    {
      intervalMs: 600_000,
      refreshOn: ['patientTraderChanged'],
      // A filter or group switch drops the previous plans at once rather than presenting them as
      // the new answer.
      key: () => boardQuery(this.filters(), PLAN_PAGE_SIZE, this.oco()),
    },
  );
  readonly board = this.boardResource.value;

  /** Refreshed with the board, plus a one-minute tick so "next look" and "stuck" stay current. */
  private readonly healthResource = createPolledResource(() => this.svc.getHealth(), {
    intervalMs: 60_000,
    refreshOn: ['patientTraderChanged'],
  });
  readonly health = this.healthResource.value;
  readonly healthError = this.healthResource.error;

  /**
   * Configuration never refetches on its own: it is operator-owned, so a background refetch could
   * only ever arrive while somebody is typing into the form it would replace. Fetched once, and
   * replaced explicitly after a save or a conflict reload.
   */
  private readonly configResource = createPolledResource(() => this.svc.getConfig(), {
    intervalMs: 0,
  });
  readonly configError = this.configResource.error;

  /**
   * The last config read from or written to the engine — the baseline for the dirty check and
   * the "before" of the Live check. Seeded from the first load, then replaced only by a save, a
   * discard-and-reload or a conflict reload.
   */
  private readonly loaded = signal<PatientTraderConfig | null>(null);
  readonly config = this.loaded.asReadonly();
  /** The editable copy. Immutable: every edit is a new object, so the dirty check recomputes. */
  readonly draft = signal<PatientTraderConfig | null>(null);

  /** Adopts the first loaded config as both the baseline and the editable copy, once. */
  private readonly seedDraft = effect(() => {
    const c = this.configResource.value();
    if (!c) return;
    untracked(() => {
      if (this.loaded() === null) this.adopt(c);
    });
  });

  readonly dirty = computed(() => isConfigDirty(this.loaded(), this.draft()));

  readonly engine = computed(() => this.health()?.engine ?? this.loaded()?.analysisEngine ?? null);

  /** Followed markets (persisted), for the panels' market filters. */
  readonly symbols = computed(() => {
    const set = new Set<string>();
    for (const m of this.loaded()?.markets ?? []) set.add(m.symbol.toUpperCase());
    for (const m of this.health()?.markets ?? []) set.add(m.symbol.toUpperCase());
    return [...set].sort();
  });

  /** Plans matching the filters; an engine without `totalPlans` falls back to the page size. */
  readonly planTotal = computed(() => {
    const b = this.board();
    if (!b) return 0;
    return typeof b.totalPlans === 'number' ? b.totalPlans : b.plans.length;
  });

  readonly rejectionCodes = computed(() =>
    Object.keys(this.board()?.counters.rejectedByCode ?? {}).sort(),
  );

  readonly availableSymbols = signal<string[]>([]);
  readonly pairsLoading = signal(true);

  // ── Save state ─────────────────────────────────────────────────────────────

  readonly saving = signal(false);
  readonly saveMessage = signal<string | null>(null);
  /** Set when the last save lost to someone else's: the CURRENT config, offered for reload. */
  readonly conflict = signal<PatientTraderConfig | null>(null);
  readonly reason = signal('');
  /** Markets a pending save would put into Live, while the confirmation is open. */
  readonly liveConfirm = signal<{ payload: PatientTraderConfig; markets: string[] } | null>(null);

  readonly liveConfirmMessage = computed(() => {
    const p = this.liveConfirm();
    if (!p) return '';
    const names = p.markets.join(', ');
    return (
      `Saving this puts ${p.markets.length === 1 ? 'this market' : 'these markets'} into Live: ` +
      `${names}. From then on, a card whose watch fires there files a real signal into the ` +
      `trading pipeline.`
    );
  });

  constructor() {
    this.loadCurrencyPairs();
    warnBeforeUnload(() => this.dirty());
  }

  // ── Unsaved-changes guard ──────────────────────────────────────────────────

  hasUnsavedChanges(): boolean {
    return this.dirty() && !this.saving();
  }

  unsavedChangesNote(): string {
    return 'The Patient Trader configuration has unsaved changes';
  }

  // ── Config editing ─────────────────────────────────────────────────────────

  applyPatch(patch: ConfigPatch): void {
    const d = this.draft();
    if (!d) return;
    this.draft.set({ ...d, ...patch });
  }

  discard(): void {
    const l = this.loaded();
    if (l) this.draft.set(structuredClone(l));
    this.saveMessage.set(null);
  }

  /** After a conflict: take the current settings (and their version), dropping this draft. */
  reloadCurrent(): void {
    const current = this.conflict();
    this.conflict.set(null);
    this.saveMessage.set(null);
    if (current) {
      this.adopt(current);
      return;
    }
    // The conflict carried no config: read it afresh.
    this.svc.getConfig().subscribe({
      next: (c) => this.adopt(c),
      error: () => this.saveMessage.set('Could not reload the configuration.'),
    });
  }

  requestSave(): void {
    const current = this.draft();
    if (!current || this.saving() || !this.canManage()) return;
    const payload = toSavePayload(current);
    const markets = newlyLiveMarkets(this.loaded(), payload);
    if (markets.length > 0) {
      this.liveConfirm.set({ payload, markets });
      return;
    }
    this.doSave(payload);
  }

  confirmLive(): void {
    const p = this.liveConfirm();
    if (!p) return;
    this.doSave(p.payload, () => this.liveConfirm.set(null));
  }

  private doSave(payload: PatientTraderConfig, settled?: () => void): void {
    this.saving.set(true);
    this.saveMessage.set(null);
    this.conflict.set(null);

    this.svc.saveConfig(payload, { reason: this.reason() }).subscribe({
      next: (result) => {
        this.saving.set(false);
        settled?.();
        switch (result.kind) {
          case 'saved':
            // The PERSISTED state wins — anything governance queued or refused shows as it is.
            this.adopt(result.config);
            this.saveMessage.set(result.message ?? 'Saved.');
            this.reason.set('');
            this.boardResource.refresh();
            this.healthResource.refresh();
            break;
          case 'conflict':
            // Keep the operator's draft; offer the current settings instead of overwriting them.
            this.conflict.set(result.config);
            this.saveMessage.set(result.message);
            break;
          case 'refused':
            this.saveMessage.set(result.message);
            break;
        }
      },
      error: (err: unknown) => {
        this.saving.set(false);
        settled?.();
        this.saveMessage.set(
          err instanceof Error && err.message
            ? `Save failed — ${err.message}`
            : 'Save failed — the configuration was not changed.',
        );
      },
    });
  }

  /** Makes `c` both the baseline and the editable copy. */
  private adopt(c: PatientTraderConfig): void {
    const shown = withInstructionShown(c);
    this.loaded.set(shown);
    this.draft.set(structuredClone(shown));
  }

  // ── URL state ──────────────────────────────────────────────────────────────

  /** Narrows the plans to one OCO group (null shows the latest plans again), kept in the URL. */
  selectOco(group: string | null): void {
    if (group === this.oco()) return;
    this.oco.set(group);
    this.syncUrl({ oco: group });
    this.boardResource.refresh();
  }

  setFilters(f: PlanFilters): void {
    this.filters.set(f);
    this.syncUrl(filtersToParams(f));
    this.boardResource.refresh();
  }

  private syncUrl(queryParams: Record<string, string | null>): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams,
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  /**
   * Active symbols from the currency-pair catalogue — the authority on what the engine can trade,
   * so following a market is a selection rather than a typed string.
   */
  private loadCurrencyPairs(): void {
    this.pairsLoading.set(true);
    this.currencyPairs.list({ currentPage: 1, itemCountPerPage: 500, filter: null }).subscribe({
      next: (res) => {
        const symbols = (res?.data?.data ?? [])
          .filter((p) => p.isActive && p.symbol)
          .map((p) => p.symbol!.toUpperCase())
          .filter((s, i, arr) => arr.indexOf(s) === i)
          .sort();
        this.availableSymbols.set(symbols);
        this.pairsLoading.set(false);
      },
      error: () => this.pairsLoading.set(false),
    });
  }
}
