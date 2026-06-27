import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { catchError, of } from 'rxjs';

import { SpreadReactiveService } from '@core/services/spread-reactive.service';
import { createPolledResource } from '@core/polling/polled-resource';
import { ApiError } from '@core/api/api.types';
import { SpreadBaselineFloor } from '@features/spread-reactive/spread-reactive.types';

type FloorSourceFilter = 'all' | 'AutoCapture' | 'OperatorOverride';

interface OverrideDraft {
  mode: 'create' | 'edit';
  tradingAccountId: number | null;
  symbol: string;
  floorBaseline: number | null;
  note: string;
}

/**
 * Persistent-floor administration tab on the spread-reactive page.
 *
 * Shows every `SpreadBaselineFloor` row with rich filtering, surface for
 * lower-candidate progress, and per-row Override / Reset actions.  The
 * floor is the immutable anchor the worker uses for Elevated/Normal
 * classification, so this view is also the operator's escape hatch when
 * auto-capture has settled on a value that's known to be wrong (e.g.
 * captured during a thin-liquidity weekend session).
 */
@Component({
  selector: 'app-baseline-floors-tab',
  standalone: true,
  imports: [DecimalPipe, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card">
      <div class="head">
        <h2>Persistent floor baselines</h2>
        <div class="head-actions">
          <span class="muted small"
            >{{ rows().length }} row{{ rows().length === 1 ? '' : 's' }} — anchor for
            Elevated/Normal classification</span
          >
          <button type="button" class="btn ghost" (click)="floors.refresh()">
            {{ floors.loading() ? 'Refreshing…' : 'Refresh' }}
          </button>
          <button type="button" class="btn primary" (click)="openCreate()">+ New override</button>
        </div>
      </div>

      <!-- ───────── Filter bar ───────── -->
      <div class="filters">
        <label class="filter">
          <span>Account</span>
          <input
            type="number"
            min="0"
            placeholder="Any"
            [(ngModel)]="filterAccountId"
            (ngModelChange)="onFilterChange()"
          />
        </label>
        <label class="filter">
          <span>Symbol</span>
          <input
            type="text"
            placeholder="Any"
            [(ngModel)]="filterSymbol"
            (ngModelChange)="onFilterChange()"
          />
        </label>
        <label class="filter">
          <span>Source</span>
          <select [(ngModel)]="filterSource" (ngModelChange)="onFilterChange()">
            <option value="all">All</option>
            <option value="AutoCapture">Auto-capture</option>
            <option value="OperatorOverride">Operator override</option>
          </select>
        </label>
        @if (errorMessage(); as e) {
          <div class="banner error">{{ e }}</div>
        }
        @if (savedMessage(); as m) {
          <div class="banner ok">{{ m }}</div>
        }
      </div>

      <!-- ───────── Table ───────── -->
      <div class="table-wrap">
        <table class="floors-table">
          <thead>
            <tr>
              <th>Account</th>
              <th>Symbol</th>
              <th class="num">Floor</th>
              <th>Source</th>
              <th>Captured</th>
              <th class="num">Samples@floor</th>
              <th class="num">Lower candidate</th>
              <th>Candidate observed</th>
              <th>Set by</th>
              <th>Note</th>
              <th>Last updated</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            @if (rows().length === 0) {
              <tr class="empty">
                <td colspan="12" class="muted small">
                  No floor rows yet. Pairs with no floor stand down (no bumps, no reverts) until
                  auto-capture lands a value or an operator override is set.
                </td>
              </tr>
            } @else {
              @for (r of rows(); track r.id) {
                <tr>
                  <td class="mono small">{{ r.tradingAccountId }}</td>
                  <td class="mono">{{ r.symbol }}</td>
                  <td class="num mono">{{ r.floorBaseline | number: '1.5-5' }}</td>
                  <td>
                    <span class="source-pill" [class.override]="r.source === 'OperatorOverride'">
                      {{ r.source === 'OperatorOverride' ? 'Override' : 'Auto' }}
                    </span>
                  </td>
                  <td class="mono small">{{ formatTs(r.floorObservedAt) }}</td>
                  <td class="num mono">{{ r.sampleCountAtFloor }}</td>
                  <td class="num mono">
                    @if (r.lowerCandidate !== null) {
                      {{ r.lowerCandidate | number: '1.5-5' }}
                    } @else {
                      <span class="muted">—</span>
                    }
                  </td>
                  <td class="mono small">
                    @if (r.lowerCandidateObservedAt) {
                      {{ formatTs(r.lowerCandidateObservedAt) }}
                    } @else {
                      <span class="muted">—</span>
                    }
                  </td>
                  <td class="mono small">
                    @if (r.setByAdminUsername) {
                      {{ r.setByAdminUsername }}
                    } @else {
                      <span class="muted">—</span>
                    }
                  </td>
                  <td class="note">
                    @if (r.note) {
                      <span [title]="r.note">{{ r.note }}</span>
                    } @else {
                      <span class="muted">—</span>
                    }
                  </td>
                  <td class="mono small">{{ formatTs(r.lastUpdatedAt) }}</td>
                  <td class="actions-cell">
                    <button type="button" class="btn ghost xs" (click)="openEdit(r)">
                      Override
                    </button>
                    <button
                      type="button"
                      class="btn ghost xs danger"
                      (click)="confirmReset(r)"
                      [disabled]="busy()"
                    >
                      Reset
                    </button>
                  </td>
                </tr>
              }
            }
          </tbody>
        </table>
      </div>
    </section>

    <!-- ───────── Override modal ───────── -->
    @if (overrideDraft(); as d) {
      <div class="modal-backdrop" (click)="closeOverride()"></div>
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <header class="modal-head">
          <h3 id="modal-title">
            {{ d.mode === 'create' ? 'New floor override' : 'Override floor' }}
          </h3>
          <button type="button" class="modal-close" (click)="closeOverride()">×</button>
        </header>
        <div class="modal-body">
          <label class="field">
            <span>Trading account ID</span>
            <input
              type="number"
              min="1"
              step="1"
              [(ngModel)]="d.tradingAccountId"
              [disabled]="d.mode === 'edit'"
            />
          </label>
          <label class="field">
            <span>Symbol</span>
            <input
              type="text"
              [(ngModel)]="d.symbol"
              [disabled]="d.mode === 'edit'"
              placeholder="e.g. EURUSD"
            />
          </label>
          <label class="field">
            <span>Floor baseline (price units)</span>
            <input
              type="number"
              min="0"
              step="0.00001"
              [(ngModel)]="d.floorBaseline"
              placeholder="0.00010"
            />
            <small class="muted">
              The lowest stable spread you've observed for this pair, in absolute price units. Pairs
              classify as Elevated when current ≥ floor × spread-multiplier.
            </small>
          </label>
          <label class="field">
            <span>Note (optional)</span>
            <textarea
              rows="2"
              [(ngModel)]="d.note"
              placeholder="Why this value — e.g. ECN spread post-broker-switch"
            ></textarea>
          </label>
          @if (overrideError(); as e) {
            <div class="banner error">{{ e }}</div>
          }
        </div>
        <footer class="modal-foot">
          <button type="button" class="btn ghost" (click)="closeOverride()">Cancel</button>
          <button
            type="button"
            class="btn primary"
            [disabled]="!isOverrideValid(d) || busy()"
            (click)="saveOverride(d)"
          >
            {{ busy() ? 'Saving…' : 'Save override' }}
          </button>
        </footer>
      </div>
    }

    <!-- ───────── Reset confirm ───────── -->
    @if (resetTarget(); as t) {
      <div class="modal-backdrop" (click)="cancelReset()"></div>
      <div class="modal small" role="dialog" aria-modal="true" aria-labelledby="reset-title">
        <header class="modal-head">
          <h3 id="reset-title">Reset floor for {{ t.symbol }} / {{ t.tradingAccountId }}?</h3>
          <button type="button" class="modal-close" (click)="cancelReset()">×</button>
        </header>
        <div class="modal-body">
          <p class="muted">
            The pair will return to stand-down (no bumps, no reverts) until auto-capture
            re-establishes a floor or you set another override. Existing active bumps are
            <strong>not</strong> reverted by this action.
          </p>
          @if (overrideError(); as e) {
            <div class="banner error">{{ e }}</div>
          }
        </div>
        <footer class="modal-foot">
          <button type="button" class="btn ghost" (click)="cancelReset()">Cancel</button>
          <button type="button" class="btn danger" [disabled]="busy()" (click)="executeReset(t)">
            {{ busy() ? 'Clearing…' : 'Reset floor' }}
          </button>
        </footer>
      </div>
    }
  `,
  styles: [
    `
      .card {
        background: var(--bg-secondary, #fff);
        border: 1px solid var(--border, #e3e3e3);
        border-radius: var(--radius-md, 8px);
        padding: var(--card-padding, 14px 16px);
      }
      .head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
        margin-bottom: 12px;
      }
      .head h2 {
        margin: 0;
        font-size: 1.05em;
      }
      .head-actions {
        display: inline-flex;
        align-items: center;
        gap: 10px;
      }
      .muted {
        color: var(--text-secondary, #888);
      }
      .small {
        font-size: 0.85em;
      }
      .mono {
        font-family: var(--font-mono, ui-monospace, monospace);
      }
      .filters {
        display: flex;
        flex-wrap: wrap;
        gap: 12px 16px;
        align-items: flex-end;
        padding: 8px 0 14px;
        border-bottom: 1px solid var(--border, #eee);
      }
      .filter {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .filter > span {
        font-weight: 600;
        font-size: 12px;
        color: var(--text-secondary, #666);
      }
      .filter input,
      .filter select {
        padding: 6px 8px;
        border-radius: 4px;
        border: 1px solid var(--border, #ccc);
        background: var(--bg-primary, #fff);
        min-width: 140px;
      }
      .table-wrap {
        overflow-x: auto;
        margin-top: 10px;
      }
      .floors-table {
        width: 100%;
        border-collapse: collapse;
      }
      .floors-table th,
      .floors-table td {
        padding: 6px 10px;
        text-align: left;
        border-bottom: 1px solid var(--border, #eee);
        vertical-align: top;
      }
      .floors-table th {
        font-size: 12px;
        font-weight: 600;
        color: var(--text-secondary, #555);
      }
      .floors-table .num {
        text-align: right;
      }
      .floors-table .note {
        max-width: 240px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .floors-table tr.empty td {
        padding: var(--space-4, 16px);
        text-align: center;
        font-style: italic;
      }
      .source-pill {
        padding: 2px 8px;
        border-radius: 8px;
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.4px;
        background: color-mix(in srgb, #9aa0a6 22%, transparent);
        color: #555e66;
      }
      .source-pill.override {
        background: color-mix(in srgb, #0a84ff 22%, transparent);
        color: #0863c1;
      }
      .actions-cell {
        white-space: nowrap;
        text-align: right;
      }
      .actions-cell .btn + .btn {
        margin-left: 6px;
      }
      .btn {
        padding: 6px 12px;
        border-radius: 6px;
        border: 1px solid var(--border, #ccc);
        background: var(--bg-primary, #fff);
        cursor: pointer;
      }
      .btn.xs {
        padding: 3px 8px;
        font-size: 12px;
      }
      .btn.primary {
        background: var(--accent, #0a84ff);
        color: #fff;
        border-color: var(--accent, #0a84ff);
      }
      .btn.ghost {
        background: transparent;
      }
      .btn.danger {
        color: var(--loss, #c93631);
        border-color: color-mix(in srgb, var(--loss, #c93631) 40%, transparent);
      }
      .btn:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }
      .banner {
        padding: 8px 12px;
        border-radius: 6px;
        font-size: 0.9em;
        flex-basis: 100%;
      }
      .banner.error {
        background: color-mix(in srgb, var(--loss, #c93631) 12%, transparent);
        color: var(--loss, #c93631);
      }
      .banner.ok {
        background: color-mix(in srgb, var(--profit, #2c8a3f) 14%, transparent);
        color: var(--profit, #2c8a3f);
      }
      /* Modal */
      .modal-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.35);
        z-index: 100;
      }
      .modal {
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        background: var(--bg-primary, #fff);
        border: 1px solid var(--border, #ccc);
        border-radius: var(--radius-md, 8px);
        padding: 0;
        width: min(480px, 92vw);
        z-index: 101;
        display: flex;
        flex-direction: column;
        box-shadow: 0 12px 36px rgba(0, 0, 0, 0.18);
      }
      .modal.small {
        width: min(360px, 90vw);
      }
      .modal-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 16px;
        border-bottom: 1px solid var(--border, #eee);
      }
      .modal-head h3 {
        margin: 0;
        font-size: 1em;
      }
      .modal-close {
        background: transparent;
        border: 0;
        font-size: 20px;
        cursor: pointer;
        color: var(--text-secondary, #555);
        line-height: 1;
      }
      .modal-body {
        padding: 14px 16px;
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .modal-foot {
        display: flex;
        justify-content: flex-end;
        gap: 10px;
        padding: 12px 16px;
        border-top: 1px solid var(--border, #eee);
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .field > span {
        font-weight: 600;
        font-size: 0.9em;
      }
      .field input,
      .field textarea {
        padding: 6px 8px;
        border-radius: 4px;
        border: 1px solid var(--border, #ccc);
        background: var(--bg-primary, #fff);
        font-family: inherit;
      }
    `,
  ],
})
export class BaselineFloorsTabComponent {
  private readonly service = inject(SpreadReactiveService);

  protected filterAccountId: number | null = null;
  protected filterSymbol = '';
  protected filterSource: FloorSourceFilter = 'all';

  protected readonly overrideDraft = signal<OverrideDraft | null>(null);
  protected readonly resetTarget = signal<SpreadBaselineFloor | null>(null);
  protected readonly busy = signal(false);
  protected readonly errorMessage = signal<string | null>(null);
  protected readonly savedMessage = signal<string | null>(null);
  protected readonly overrideError = signal<string | null>(null);

  protected readonly floors = createPolledResource<SpreadBaselineFloor[]>(
    () => this.service.getFloors(this.buildFilters()),
    { intervalMs: 10_000 },
  );

  protected readonly rows = computed<SpreadBaselineFloor[]>(() => this.floors.value() ?? []);

  protected onFilterChange(): void {
    this.floors.refresh();
  }

  protected openCreate(): void {
    this.overrideError.set(null);
    this.overrideDraft.set({
      mode: 'create',
      tradingAccountId: null,
      symbol: '',
      floorBaseline: null,
      note: '',
    });
  }

  protected openEdit(row: SpreadBaselineFloor): void {
    this.overrideError.set(null);
    this.overrideDraft.set({
      mode: 'edit',
      tradingAccountId: row.tradingAccountId,
      symbol: row.symbol,
      floorBaseline: row.floorBaseline,
      note: row.note ?? '',
    });
  }

  protected closeOverride(): void {
    this.overrideDraft.set(null);
    this.overrideError.set(null);
  }

  protected isOverrideValid(d: OverrideDraft): boolean {
    return (
      d.tradingAccountId != null &&
      d.tradingAccountId > 0 &&
      d.symbol.trim().length > 0 &&
      d.floorBaseline != null &&
      d.floorBaseline > 0
    );
  }

  protected saveOverride(d: OverrideDraft): void {
    if (!this.isOverrideValid(d)) return;
    this.busy.set(true);
    this.overrideError.set(null);
    this.service
      .upsertFloor({
        tradingAccountId: d.tradingAccountId!,
        symbol: d.symbol.trim().toUpperCase(),
        floorBaseline: d.floorBaseline!,
        note: d.note.trim() || null,
      })
      .pipe(
        catchError((e) => {
          this.overrideError.set(this.toMessage(e));
          this.busy.set(false);
          return of(null);
        }),
      )
      .subscribe((res) => {
        this.busy.set(false);
        if (res) {
          this.overrideDraft.set(null);
          this.flashSaved(`Floor saved for ${res.symbol} / ${res.tradingAccountId}.`);
          this.floors.refresh();
        }
      });
  }

  protected confirmReset(row: SpreadBaselineFloor): void {
    this.overrideError.set(null);
    this.resetTarget.set(row);
  }

  protected cancelReset(): void {
    this.resetTarget.set(null);
    this.overrideError.set(null);
  }

  protected executeReset(row: SpreadBaselineFloor): void {
    this.busy.set(true);
    this.overrideError.set(null);
    this.service
      .resetFloor(row.tradingAccountId, row.symbol)
      .pipe(
        catchError((e) => {
          this.overrideError.set(this.toMessage(e));
          this.busy.set(false);
          return of(null);
        }),
      )
      .subscribe((res) => {
        this.busy.set(false);
        if (res !== null) {
          this.resetTarget.set(null);
          this.flashSaved(`Floor cleared for ${row.symbol} / ${row.tradingAccountId}.`);
          this.floors.refresh();
        }
      });
  }

  protected formatTs(iso: string | null | undefined): string {
    if (!iso) return '—';
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return iso;
    const d = new Date(t);
    return d.toLocaleString();
  }

  private buildFilters() {
    const filters: {
      tradingAccountId?: number;
      symbol?: string;
      source?: 'AutoCapture' | 'OperatorOverride';
    } = {};
    if (this.filterAccountId != null && this.filterAccountId > 0)
      filters.tradingAccountId = this.filterAccountId;
    if (this.filterSymbol.trim().length > 0)
      filters.symbol = this.filterSymbol.trim().toUpperCase();
    if (this.filterSource !== 'all') filters.source = this.filterSource;
    return filters;
  }

  private flashSaved(msg: string): void {
    this.savedMessage.set(msg);
    setTimeout(() => this.savedMessage.set(null), 2500);
  }

  private toMessage(e: unknown): string {
    if (e instanceof ApiError) return `${e.message} (code ${e.code})`;
    if (e instanceof HttpErrorResponse) {
      const url = e.url ? new URL(e.url).pathname : '(unknown URL)';
      return `HTTP ${e.status} ${e.statusText || ''} on ${url}`.trim();
    }
    if (e instanceof Error) return e.message;
    return 'Request failed';
  }
}
