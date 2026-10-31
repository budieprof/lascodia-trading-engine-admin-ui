import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { LscCanDirective } from '@core/auth/can.directive';
import { NotificationService } from '@core/notifications/notification.service';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { errorText, reportable, when } from '@features/iam/iam.logic';
import { iamResource } from '@features/iam/shared/iam-resource';
import { StatTilesComponent, type StatTile } from '@features/iam/shared/stat-tiles.component';

import { VenuesApiService } from '../venues-api.service';
import {
  MARGIN_KINDS,
  MARGIN_LABELS,
  dateOnly,
  emptyMargin,
  isoMidnight,
  marginBody,
  marginFieldsFor,
  marginImportFromError,
  marginImportText,
  marginProblems,
  marginSummary,
} from '../venues.logic';
import type {
  MarginImportResult,
  MarginKind,
  MarginRequirement,
  MarginRequirementFields,
} from '../venues.types';

interface Importing {
  csv: string;
  fileName: string | null;
  reason: string;
  /** The last check (dry run) and the exact text it checked: Import is offered only for that text. */
  result: MarginImportResult | null;
  checked: string | null;
}

/** The longest file the engine takes (`MarginRequirementCsv.MaxChars`). */
const MAX_CSV_CHARS = 2_000_000;
const SHOWN_ERRORS = 50;
const SHOWN_ROWS = 20;

const PAGE_SIZE = 25;

type DetailCol = { key: keyof MarginRequirementFields; head: string; fmt?: 'pct' | 'lev' };

/** The ladder columns per margin model. */
const DETAIL_COLS: Record<MarginKind, DetailCol[]> = {
  CryptoLeverageTier: [
    { key: 'notionalFloor', head: 'Notional from' },
    { key: 'notionalCap', head: 'Notional to' },
    { key: 'maxLeverage', head: 'Max leverage', fmt: 'lev' },
    { key: 'initialMarginRate', head: 'Initial rate', fmt: 'pct' },
    { key: 'maintenanceMarginRate', head: 'Maint. rate', fmt: 'pct' },
    { key: 'maintenanceAmount', head: 'Maint. amount' },
  ],
  FuturesContract: [
    { key: 'initialMargin', head: 'Initial' },
    { key: 'maintenanceMargin', head: 'Maintenance' },
    { key: 'intradayInitialMargin', head: 'Intraday initial' },
    { key: 'intradayMaintenanceMargin', head: 'Intraday maint.' },
  ],
  Equity: [
    { key: 'initialMarginRate', head: 'Initial rate', fmt: 'pct' },
    { key: 'maintenanceMarginRate', head: 'Maintenance rate', fmt: 'pct' },
  ],
};

const numFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 });
const num = (v: number): string => numFmt.format(v);
const pct = (v: number): string => `${Math.round(v * 10000) / 100}%`;
const dayFmt = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});
const day = (iso: string): string => dayFmt.format(new Date(iso));

interface MarginGroup {
  key: string;
  symbol: string;
  venue: string;
  kind: MarginKind;
  currency: string;
  rows: MarginRequirement[];
  terms: string;
  maxLev: number | null;
  inForce: boolean;
  allDeleted: boolean;
  from: string;
  source: string;
}

function groupMargins(rows: MarginRequirement[]): MarginGroup[] {
  const map = new Map<string, MarginRequirement[]>();
  for (const m of rows) {
    const key = `${m.kind}|${m.venue}|${m.symbol}`;
    const list = map.get(key);
    if (list) list.push(m);
    else map.set(key, [m]);
  }
  const out: MarginGroup[] = [];
  for (const [key, list] of map) {
    list.sort(
      (a, b) =>
        (a.notionalFloor ?? 0) - (b.notionalFloor ?? 0) ||
        b.effectiveFromUtc.localeCompare(a.effectiveFromUtc),
    );
    const live = list.filter((m) => !m.isDeleted);
    const basis = live.length ? live : list;
    const first = basis[0];
    let terms: string;
    let maxLev: number | null = null;
    if (first.kind === 'CryptoLeverageTier') {
      const levs = basis.map((m) => m.maxLeverage ?? 0);
      const mmrs = basis.map((m) => m.maintenanceMarginRate).filter((v): v is number => v !== null);
      maxLev = Math.max(...levs) || null;
      const lo = Math.min(...mmrs);
      const hi = Math.max(...mmrs);
      terms =
        `${basis.length} tier${basis.length === 1 ? '' : 's'}` +
        (mmrs.length ? ` · MMR ${lo === hi ? pct(lo) : `${pct(lo)}–${pct(hi)}`}` : '');
    } else if (first.kind === 'FuturesContract') {
      terms = `${first.initialMargin !== null ? num(first.initialMargin) : '—'} / ${
        first.maintenanceMargin !== null ? num(first.maintenanceMargin) : '—'
      } ${first.currency} per contract`;
    } else {
      terms = `initial ${first.initialMarginRate !== null ? pct(first.initialMarginRate) : '—'} · maint. ${
        first.maintenanceMarginRate !== null ? pct(first.maintenanceMarginRate) : '—'
      }`;
    }
    out.push({
      key,
      symbol: first.symbol,
      venue: first.venue,
      kind: first.kind,
      currency: first.currency,
      rows: list,
      terms,
      maxLev,
      inForce: list.some((m) => m.inForce && !m.isDeleted),
      allDeleted: live.length === 0,
      from: basis
        .map((m) => m.effectiveFromUtc)
        .sort()
        .at(-1)!,
      source: first.source,
    });
  }
  return out.sort((a, b) => a.symbol.localeCompare(b.symbol) || a.venue.localeCompare(b.venue));
}

/** The edit form renders above the table; bring it into view when a row far down is edited. */
function revealForm(label: string): void {
  setTimeout(() =>
    document
      .querySelector(`[aria-label="${label}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
  );
}

interface Editing {
  id: number | null;
  fields: MarginRequirementFields;
  from: string;
  reason: string;
}

const KIND_LABEL: Record<MarginKind, string> = {
  FuturesContract: 'Futures (per contract)',
  CryptoLeverageTier: 'Crypto leverage tier',
  Equity: 'Equity house rate',
};

/**
 * Margin requirements (multi-asset WS7 7.10): the exchange / venue margin terms the risk models price exchange-traded
 * trades with (engine `reference/margin-requirements`) — futures initial / maintenance per contract (a contract row
 * before its root's), crypto leverage tiers, equity house rates above Reg-T. Read only while `Risk:MultiAsset:Enabled`
 * is on, never for FX / CFDs; an instrument with no row is REFUSED (fail closed), so deleting its only row stops it
 * trading. Reading `risk.read`; every change `platform.data.manage`, audited by the engine; deletes are soft.
 */
@Component({
  selector: 'app-margin-requirements-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    PageHeaderComponent,
    LscCanDirective,
    ConfirmDialogComponent,
    StatTilesComponent,
  ],
  styleUrls: ['../../iam/shared/iam-page.scss', './venue-page.scss'],
  styles: [
    `
      .chev {
        width: 28px;
        padding-right: 0 !important;
        color: var(--text-tertiary);
        font-size: 11px;
      }
      .chev span {
        display: inline-block;
        transition: transform 0.15s;
      }
      tr.open .chev span {
        transform: rotate(90deg);
      }
      tr.group {
        cursor: pointer;
      }
      tr.group:focus-visible td {
        outline: 2px solid var(--accent);
        outline-offset: -2px;
      }
      tr.open td {
        background: var(--bg-primary);
      }
      tr.ladder > td {
        padding: 0 var(--space-4) var(--space-3) 44px !important;
        background: var(--bg-primary);
      }
      .ladder-table {
        width: 100%;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        overflow: hidden;
        background: var(--bg-secondary);
      }
      .ladder-table th {
        background: var(--bg-secondary) !important;
      }
      .ladder-table td,
      .ladder-table th {
        padding-top: 7px !important;
        padding-bottom: 7px !important;
      }
      .lev {
        display: inline-block;
        min-width: 44px;
        padding: 1px 8px;
        border-radius: var(--radius-full);
        background: rgba(0, 113, 227, 0.1);
        color: var(--accent);
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        text-align: center;
      }
      .source {
        max-width: 240px;
      }
      .rule {
        margin: 0;
        padding: 0 var(--space-4) var(--space-3);
        font-size: var(--text-xs);
        color: var(--text-tertiary);
      }
    `,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Margin requirements"
        subtitle="Futures margins, crypto leverage tiers and equity house rates the multi-asset risk models use. FX / CFD margin stays the MT5 account's."
      >
        <button
          *lscCan="'platform.data.manage'"
          type="button"
          class="btn btn-secondary"
          (click)="startCreate()"
        >
          Add a row
        </button>
        <button
          *lscCan="'platform.data.manage'"
          type="button"
          class="btn btn-secondary"
          data-testid="margin-import-open"
          (click)="startImport()"
        >
          Import CSV
        </button>
        <button
          type="button"
          class="btn btn-secondary"
          (click)="rows.reload()"
          [disabled]="rows.loading()"
        >
          {{ rows.loading() ? 'Loading…' : 'Refresh' }}
        </button>
      </app-page-header>

      <app-stat-tiles [tiles]="tiles()" label="Margin requirement summary" />

      @if (editing(); as e) {
        <section class="card" aria-label="Margin requirement row">
          <header class="card-head">
            <h3>{{ e.id ? 'Edit ' + e.fields.symbol : 'New margin requirement' }}</h3>
          </header>
          <form class="card-body" (ngSubmit)="save()">
            <div class="form-grid">
              <label class="field">
                <span class="label">Kind</span>
                <select
                  class="select"
                  name="e-kind"
                  [(ngModel)]="e.fields.kind"
                  (ngModelChange)="touch()"
                  [disabled]="!!e.id"
                >
                  @for (k of kinds; track k) {
                    <option [value]="k">{{ kindLabel[k] }}</option>
                  }
                </select>
              </label>
              <label class="field">
                <span class="label">Symbol or futures root</span>
                <input
                  class="input"
                  name="e-sym"
                  maxlength="32"
                  [(ngModel)]="e.fields.symbol"
                  (ngModelChange)="touch()"
                />
              </label>
              <label class="field">
                <span class="label">Venue (empty = the instrument's exchange)</span>
                <input
                  class="input"
                  name="e-venue"
                  maxlength="32"
                  [(ngModel)]="e.fields.venue"
                  (ngModelChange)="touch()"
                />
              </label>
              <label class="field">
                <span class="label">Currency</span>
                <input
                  class="input"
                  name="e-ccy"
                  maxlength="8"
                  [(ngModel)]="e.fields.currency"
                  (ngModelChange)="touch()"
                />
              </label>
              @for (k of numericFields(); track k) {
                <label class="field">
                  <span class="label">{{ labels[k] }}</span>
                  <input
                    class="input"
                    type="number"
                    step="any"
                    [name]="'e-' + k"
                    [ngModel]="num(e.fields, k)"
                    (ngModelChange)="setNum(k, $event)"
                  />
                </label>
              }
              <label class="field">
                <span class="label">Applies from (UTC date)</span>
                <input
                  class="input"
                  type="date"
                  name="e-from"
                  [(ngModel)]="e.from"
                  (ngModelChange)="touch()"
                />
              </label>
              <label class="field">
                <span class="label">Source (exchange page, broker sheet, operator)</span>
                <input
                  class="input"
                  name="e-src"
                  maxlength="128"
                  [(ngModel)]="e.fields.source"
                  (ngModelChange)="touch()"
                />
              </label>
              <label class="field">
                <span class="label">Reason (audit log)</span>
                <input class="input" name="e-reason" maxlength="500" [(ngModel)]="e.reason" />
              </label>
            </div>
            @for (p of problems(); track p) {
              <p class="note warn">{{ p }}</p>
            }
            <p class="note warn">
              Lower margins let larger exchange-traded positions pass the risk check once
              <code>Risk:MultiAsset:Enabled</code>
              is on. Enter the venue's published terms, not estimates.
            </p>
            <div class="actions-row">
              <button
                type="button"
                class="btn btn-secondary"
                data-autofocus
                (click)="editing.set(null)"
              >
                Cancel
              </button>
              <button
                type="submit"
                class="btn btn-primary"
                [disabled]="busy() || problems().length > 0"
              >
                {{ busy() ? 'Saving…' : 'Save' }}
              </button>
            </div>
          </form>
        </section>
      }

      @if (importing(); as im) {
        <section class="card" aria-label="Import margin rows from a CSV file">
          <header class="card-head">
            <h3>Import rows from a CSV file</h3>
          </header>
          <div class="card-body">
            <p class="note">
              A spreadsheet saved as CSV, with a header row. Check the file first: nothing is saved
              until you import it. One bad line stops the whole file, rows already loaded are never
              overwritten, and a file holds at most 5,000 rows. Required columns:
              <code>Kind, Symbol, EffectiveFromUtc, Source</code>
            </p>
            <div class="form-grid">
              <label class="field">
                <span class="label">CSV file</span>
                <input
                  class="input"
                  type="file"
                  accept=".csv,text/csv,text/plain"
                  data-testid="margin-import-file"
                  (change)="pickFile($event)"
                />
              </label>
              <label class="field">
                <span class="label">Reason (audit log)</span>
                <input
                  class="input"
                  name="i-reason"
                  maxlength="500"
                  [ngModel]="im.reason"
                  (ngModelChange)="patchImport({ reason: $event })"
                />
              </label>
            </div>
            <label class="field">
              <span class="label">{{
                im.fileName ? 'Contents of ' + im.fileName : '…or paste the file here'
              }}</span>
              <textarea
                class="textarea"
                name="i-csv"
                rows="6"
                spellcheck="false"
                data-testid="margin-import-csv"
                [ngModel]="im.csv"
                (ngModelChange)="patchImport({ csv: $event })"
              ></textarea>
            </label>
            @if (im.result; as r) {
              <p
                class="note"
                [class.warn]="r.errors.length > 0"
                role="status"
                data-testid="margin-import-result"
              >
                {{ importText(r) }}
              </p>
              @if (r.errors.length) {
                <ul class="errors">
                  @for (err of r.errors.slice(0, shownErrors); track $index) {
                    <li>{{ err }}</li>
                  }
                  @if (r.errors.length > shownErrors) {
                    <li>…and {{ r.errors.length - shownErrors }} more.</li>
                  }
                </ul>
              } @else if (r.rows.length) {
                <div class="table-wrap">
                  <table class="grid">
                    <thead>
                      <tr>
                        <th>Symbol</th>
                        <th>Kind · venue</th>
                        <th>Terms</th>
                        <th>From</th>
                        <th>Source</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (m of r.rows.slice(0, shownRows); track $index) {
                        <tr>
                          <td>
                            <code style="white-space: nowrap">{{ m.symbol }}</code>
                          </td>
                          <td class="small">
                            {{ kindLabel[m.kind] }}{{ m.venue ? ' · ' + m.venue : '' }}
                          </td>
                          <td class="small">{{ summary(m) }}</td>
                          <td class="small">{{ m.effectiveFromUtc.slice(0, 10) }}</td>
                          <td class="small">{{ m.source }}</td>
                        </tr>
                      }
                    </tbody>
                  </table>
                </div>
                @if (r.rows.length > shownRows) {
                  <p class="note">…and {{ r.rows.length - shownRows }} more rows.</p>
                }
              }
            }
            <p class="note warn">
              Lower margins let larger exchange-traded positions pass the risk check. Import the
              venue's published terms, not estimates.
            </p>
            <div class="actions-row">
              <button type="button" class="btn btn-secondary" (click)="importing.set(null)">
                Cancel
              </button>
              <button
                type="button"
                class="btn btn-secondary"
                data-testid="margin-import-check"
                [disabled]="busy() || !im.csv.trim()"
                (click)="checkImport()"
              >
                {{ busy() && !confirmingImport() ? 'Checking…' : 'Check file' }}
              </button>
              <button
                type="button"
                class="btn btn-primary"
                data-testid="margin-import-submit"
                [disabled]="busy() || !canImport()"
                (click)="confirmingImport.set(true)"
              >
                Import {{ canImport() ? im.result!.inserted : '' }} row{{
                  im.result?.inserted === 1 ? '' : 's'
                }}
              </button>
            </div>
          </div>
        </section>
      }

      <section class="card" aria-label="Margin requirements">
        <div class="toolbar">
          <div class="seg" role="group" aria-label="Kind">
            <button type="button" [class.on]="!filterKind()" (click)="setKind('')">
              All<span class="n">{{ kindCounts()['all'] ?? 0 }}</span>
            </button>
            @for (k of kinds; track k) {
              @if (kindCounts()[k]) {
                <button type="button" [class.on]="filterKind() === k" (click)="setKind(k)">
                  {{ kindLabel[k] }}<span class="n">{{ kindCounts()[k] }}</span>
                </button>
              }
            }
          </div>
          @if (venues().length > 1) {
            <div class="seg" role="group" aria-label="Venue">
              <button type="button" [class.on]="!filterVenue()" (click)="setVenue(null)">
                All venues
              </button>
              @for (v of venues(); track v.venue) {
                <button
                  type="button"
                  [class.on]="filterVenue() === v.venue"
                  (click)="setVenue(v.venue)"
                >
                  {{ v.venue || 'Any venue' }}<span class="n">{{ v.count }}</span>
                </button>
              }
            </div>
          }
          <label class="search-box">
            <input
              class="input"
              name="f-sym"
              placeholder="Search symbol"
              aria-label="Search symbol"
              [ngModel]="symbol()"
              (ngModelChange)="symbol.set($event); page.set(0)"
            />
          </label>
          <span class="grow"></span>
          <label class="toggle" [class.on]="includeDeleted()">
            <input
              type="checkbox"
              name="f-del"
              [ngModel]="includeDeleted()"
              (ngModelChange)="includeDeleted.set($event); rows.reload()"
            />
            Show deleted
          </label>
        </div>
        <p class="rule">
          No row for an exchange-traded instrument = the risk check refuses it. A futures root row
          (ES) covers every contract without its own row; a venue row wins over a generic
          (empty-venue) one; the latest start in force wins.
        </p>
        @if (rows.error(); as err) {
          <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
        }
        <div class="table-wrap">
          <table class="grid">
            <thead>
              <tr>
                <th class="chev"><span class="sr-only">Expand</span></th>
                <th>Instrument</th>
                <th>Venue</th>
                <th>Kind</th>
                <th>Terms</th>
                <th class="num">Max leverage</th>
                <th>Status</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              @for (g of pageGroups(); track g.key) {
                <tr
                  class="group"
                  [class.open]="isOpen(g.key)"
                  [class.is-deleted]="g.allDeleted"
                  tabindex="0"
                  [attr.aria-expanded]="isOpen(g.key)"
                  (click)="toggle(g.key)"
                  (keydown.enter)="toggle(g.key)"
                  (keydown.space)="$event.preventDefault(); toggle(g.key)"
                >
                  <td class="chev"><span aria-hidden="true">▶</span></td>
                  <td>
                    <span class="ident">{{ g.symbol }}</span>
                    <span class="sub">{{ g.currency }}</span>
                  </td>
                  <td class="nowrap">{{ g.venue || 'any venue' }}</td>
                  <td>
                    <span class="chip">{{ kindLabel[g.kind] }}</span>
                  </td>
                  <td class="nowrap strong">{{ g.terms }}</td>
                  <td class="num">
                    @if (g.maxLev) {
                      <span class="lev">{{ g.maxLev }}×</span>
                    } @else {
                      <span class="dim">—</span>
                    }
                  </td>
                  <td class="nowrap">
                    <span class="dot" [class.ok]="g.inForce" [class.bad]="g.allDeleted">{{
                      g.allDeleted ? 'Deleted' : g.inForce ? 'In force' : 'Later'
                    }}</span>
                    <span class="when-sub">from {{ day(g.from) }}</span>
                  </td>
                  <td>
                    <span class="source" [title]="g.source">{{ g.source }}</span>
                  </td>
                </tr>
                @if (isOpen(g.key)) {
                  <tr class="ladder">
                    <td colspan="8">
                      <table class="grid ladder-table">
                        <thead>
                          <tr>
                            @for (c of detailCols[g.kind]; track c.key) {
                              <th class="num">{{ c.head }}</th>
                            }
                            <th>From</th>
                            <th>Status</th>
                            <th><span class="sr-only">Actions</span></th>
                          </tr>
                        </thead>
                        <tbody>
                          @for (m of g.rows; track m.id) {
                            <tr [class.is-deleted]="m.isDeleted">
                              @for (c of detailCols[g.kind]; track c.key) {
                                <td class="num" [class.dim]="detail(m, c) === '—'">
                                  {{ detail(m, c) }}
                                </td>
                              }
                              <td class="nowrap">{{ day(m.effectiveFromUtc) }}</td>
                              <td class="nowrap">
                                <span
                                  class="dot"
                                  [class.ok]="m.inForce"
                                  [class.bad]="m.isDeleted"
                                  >{{
                                    m.isDeleted ? 'Deleted' : m.inForce ? 'In force' : 'Later'
                                  }}</span
                                >
                              </td>
                              <td class="actions">
                                @if (!m.isDeleted) {
                                  <button
                                    *lscCan="'platform.data.manage'"
                                    type="button"
                                    class="btn btn-sm btn-ghost"
                                    (click)="$event.stopPropagation(); startEdit(m)"
                                  >
                                    Edit
                                  </button>
                                  <button
                                    *lscCan="'platform.data.manage'"
                                    type="button"
                                    class="btn btn-sm btn-ghost-danger"
                                    (click)="$event.stopPropagation(); deleting.set(m)"
                                  >
                                    Delete
                                  </button>
                                }
                              </td>
                            </tr>
                          }
                        </tbody>
                      </table>
                    </td>
                  </tr>
                }
              } @empty {
                <tr>
                  <td colspan="8" class="empty">
                    @if (rows.value().length) {
                      No margin requirement matches these filters.
                    } @else if (!rows.loading()) {
                      No margin requirement loaded: every exchange-traded instrument is refused by
                      the risk check.
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
        @if (groups().length > pageSize) {
          <nav class="pager" aria-label="Pages">
            <span
              >{{ page() * pageSize + 1 }}–{{ min((page() + 1) * pageSize, groups().length) }} of
              {{ groups().length }} instruments · {{ filteredRowCount() }} rows</span
            >
            <span class="pages">
              <button
                type="button"
                [disabled]="page() === 0"
                (click)="page.set(page() - 1)"
                aria-label="Previous page"
              >
                ‹
              </button>
              <span>Page {{ page() + 1 }} of {{ pageCount() }}</span>
              <button
                type="button"
                [disabled]="page() >= pageCount() - 1"
                (click)="page.set(page() + 1)"
                aria-label="Next page"
              >
                ›
              </button>
            </span>
          </nav>
        }
      </section>

      <app-confirm-dialog
        [open]="!!deleting()"
        title="Delete the margin requirement"
        [message]="deleteMessage()"
        confirmLabel="Delete"
        confirmVariant="destructive"
        [loading]="busy()"
        (confirm)="remove()"
        (cancelled)="deleting.set(null)"
      />

      <app-confirm-dialog
        [open]="confirmingImport()"
        title="Import the margin rows"
        [message]="importMessage()"
        confirmLabel="Import"
        [loading]="busy()"
        (confirm)="runImport()"
        (cancelled)="confirmingImport.set(false)"
      />
    </div>
  `,
})
export class MarginRequirementsPageComponent {
  private readonly api = inject(VenuesApiService);
  private readonly notify = inject(NotificationService);

  protected readonly when = when;
  protected readonly kinds = MARGIN_KINDS;
  protected readonly kindLabel = KIND_LABEL;
  protected readonly labels = MARGIN_LABELS as Record<string, string>;
  protected readonly summary = marginSummary;
  protected readonly importText = marginImportText;
  protected readonly shownErrors = SHOWN_ERRORS;
  protected readonly shownRows = SHOWN_ROWS;

  readonly filterKind = signal<MarginKind | ''>('');
  readonly symbol = signal('');
  readonly includeDeleted = signal(false);
  readonly rows = iamResource<MarginRequirement[]>(
    () =>
      this.api.marginRequirements({
        includeDeleted: this.includeDeleted(),
      }),
    [],
    'Could not load the margin requirements.',
  );
  readonly filterVenue = signal<string | null>(null);
  readonly page = signal(0);
  readonly pageSize = PAGE_SIZE;
  readonly detailCols = DETAIL_COLS;
  readonly day = day;
  readonly min = Math.min;
  private readonly open = signal<ReadonlySet<string>>(new Set());

  /** Rows after the symbol search (the pills count from here). */
  private readonly searched = computed(() => {
    const q = this.symbol().trim().toLowerCase();
    return q
      ? this.rows.value().filter((m) => m.symbol.toLowerCase().includes(q))
      : this.rows.value();
  });
  readonly kindCounts = computed(() => {
    const venue = this.filterVenue();
    const c: Record<string, number> = { all: 0 };
    for (const m of this.searched()) {
      if (venue !== null && m.venue !== venue) continue;
      c[m.kind] = (c[m.kind] ?? 0) + 1;
      c['all']++;
    }
    return c;
  });
  readonly venues = computed(() => {
    const kind = this.filterKind();
    const c = new Map<string, number>();
    for (const m of this.searched()) {
      if (kind && m.kind !== kind) continue;
      c.set(m.venue, (c.get(m.venue) ?? 0) + 1);
    }
    return [...c.entries()]
      .map(([venue, count]) => ({ venue, count }))
      .sort((a, b) => b.count - a.count);
  });
  private readonly filtered = computed(() => {
    const kind = this.filterKind();
    const venue = this.filterVenue();
    return this.searched().filter(
      (m) => (!kind || m.kind === kind) && (venue === null || m.venue === venue),
    );
  });
  readonly filteredRowCount = computed(() => this.filtered().length);
  /** One entry per instrument at a venue: a crypto instrument's ~10 leverage tiers read as one ladder. */
  readonly groups = computed(() => groupMargins(this.filtered()));
  readonly pageCount = computed(() => Math.max(1, Math.ceil(this.groups().length / PAGE_SIZE)));
  readonly pageGroups = computed(() => {
    const p = Math.min(this.page(), this.pageCount() - 1);
    return this.groups().slice(p * PAGE_SIZE, (p + 1) * PAGE_SIZE);
  });
  readonly tiles = computed<StatTile[]>(() => {
    const all = this.rows.value().filter((m) => !m.isDeleted);
    const live = all.filter((m) => m.inForce);
    const instruments = groupMargins(live);
    const byKind = (k: MarginKind) => instruments.filter((g) => g.kind === k).length;
    return [
      {
        label: 'Instruments covered',
        value: this.rows.loaded() ? String(instruments.length) : '…',
        caption: `${byKind('CryptoLeverageTier')} crypto · ${byKind('FuturesContract')} futures · ${byKind('Equity')} equity`,
      },
      {
        label: 'Rows in force',
        value: String(live.length),
        caption: `of ${all.length} stored`,
      },
      {
        label: 'Venues',
        value: String(new Set(live.map((m) => m.venue).filter(Boolean)).size),
        caption: [...new Set(live.map((m) => m.venue).filter(Boolean))].join(' · ') || 'none',
      },
      {
        label: 'Highest leverage',
        value: instruments.reduce((mx, g) => Math.max(mx, g.maxLev ?? 0), 0)
          ? `${instruments.reduce((mx, g) => Math.max(mx, g.maxLev ?? 0), 0)}×`
          : '—',
        caption: 'first tier, any crypto instrument',
      },
    ];
  });

  readonly editing = signal<Editing | null>(null);
  readonly deleting = signal<MarginRequirement | null>(null);
  readonly importing = signal<Importing | null>(null);
  readonly confirmingImport = signal(false);
  /** Import is offered only after a clean check of exactly the text in the box, and only when it adds rows. */
  readonly canImport = computed(() => {
    const im = this.importing();
    return (
      !!im?.result &&
      im.checked === im.csv &&
      im.result.errors.length === 0 &&
      im.result.inserted > 0
    );
  });
  readonly importMessage = computed(() => {
    const r = this.importing()?.result;
    return r
      ? `${r.inserted} new margin row${r.inserted === 1 ? '' : 's'} will be added and used by the risk check from their start dates. Rows already loaded stay as they are. Deletes are possible afterwards, one row at a time.`
      : '';
  });
  readonly busy = signal(false);
  private readonly version = signal(0);

  readonly numericFields = computed(() => {
    this.version();
    const e = this.editing();
    return e ? marginFieldsFor(e.fields.kind) : [];
  });
  readonly problems = computed(() => {
    this.version();
    const e = this.editing();
    if (!e) return [];
    const p = marginProblems(e.fields);
    if (!isoMidnight(e.from)) p.push('Give the date the terms apply from.');
    return p;
  });
  readonly deleteMessage = computed(() => {
    const m = this.deleting();
    return m
      ? `${m.symbol} (${KIND_LABEL[m.kind]}) is soft-deleted. If it was the instrument's only row, the risk check refuses the instrument again.`
      : '';
  });

  constructor() {
    this.rows.reload();
  }

  setKind(k: MarginKind | ''): void {
    this.filterKind.set(k);
    this.page.set(0);
  }

  setVenue(v: string | null): void {
    this.filterVenue.set(v);
    this.page.set(0);
  }

  isOpen(key: string): boolean {
    return this.open().has(key);
  }

  toggle(key: string): void {
    const next = new Set(this.open());
    if (next.has(key)) next.delete(key);
    else next.add(key);
    this.open.set(next);
  }

  detail(m: MarginRequirement, c: DetailCol): string {
    const v =
      c.key === 'initialMarginRate' && m.initialMarginRate === null && m.maxLeverage
        ? 1 / m.maxLeverage
        : (m[c.key] as number | null);
    if (v === null || v === undefined) return c.key === 'notionalCap' ? '∞' : '—';
    if (c.fmt === 'pct') return pct(v);
    if (c.fmt === 'lev') return `${num(v)}×`;
    return num(v);
  }

  touch(): void {
    this.version.update((v) => v + 1);
  }

  num(f: MarginRequirementFields, k: keyof MarginRequirementFields): number | null {
    return f[k] as number | null;
  }

  setNum(k: keyof MarginRequirementFields, v: number | string | null): void {
    const e = this.editing();
    if (!e) return;
    (e.fields as unknown as Record<string, number | null>)[k] =
      v === null || v === '' ? null : Number(v);
    this.touch();
  }

  startCreate(): void {
    this.importing.set(null);
    const fields = emptyMargin('FuturesContract');
    this.editing.set({ id: null, fields, from: dateOnly(fields.effectiveFromUtc), reason: '' });
    revealForm('Margin requirement row');
  }

  startEdit(m: MarginRequirement): void {
    this.importing.set(null);
    const { id, createdAtUtc, updatedAtUtc, isDeleted, inForce, ...fields } = m;
    void createdAtUtc;
    void updatedAtUtc;
    void isDeleted;
    void inForce;
    this.editing.set({ id, fields: { ...fields }, from: dateOnly(m.effectiveFromUtc), reason: '' });
    revealForm('Margin requirement row');
  }

  save(): void {
    const e = this.editing();
    if (!e || this.busy() || this.problems().length) return;
    this.busy.set(true);
    const body = {
      ...marginBody({
        ...e.fields,
        effectiveFromUtc: isoMidnight(e.from) ?? e.fields.effectiveFromUtc,
      }),
      reason: e.reason.trim() || null,
    };
    (e.id
      ? this.api.updateMarginRequirement(e.id, body)
      : this.api.createMarginRequirement(body)
    ).subscribe({
      next: (row) => {
        this.busy.set(false);
        this.editing.set(null);
        this.notify.success(`${row.symbol} saved.`);
        this.rows.reload();
      },
      error: (err) => {
        this.busy.set(false);
        if (reportable(err)) this.notify.error(errorText(err, 'The row was not saved.'));
      },
    });
  }

  startImport(): void {
    this.editing.set(null);
    this.importing.set({ csv: '', fileName: null, reason: '', result: null, checked: null });
    revealForm('Import margin rows from a CSV file');
  }

  /** Any change to the text forgets the last check, so Import never sends a file that was not checked. */
  patchImport(patch: Partial<Pick<Importing, 'csv' | 'reason'>>): void {
    const im = this.importing();
    if (!im) return;
    const csvChanged = patch.csv !== undefined && patch.csv !== im.csv;
    this.importing.set({
      ...im,
      ...patch,
      ...(csvChanged ? { result: null, checked: null, fileName: null } : {}),
    });
  }

  pickFile(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > MAX_CSV_CHARS * 4) {
      this.notify.error('The file is too large: a file holds at most 5,000 rows.');
      input.value = '';
      return;
    }
    file.text().then(
      (csv) => {
        const im = this.importing();
        if (!im) return;
        if (csv.length > MAX_CSV_CHARS) {
          this.notify.error('The file is too large: a file holds at most 5,000 rows.');
          return;
        }
        this.importing.set({ ...im, csv, fileName: file.name, result: null, checked: null });
      },
      () => this.notify.error('The file could not be read.'),
    );
  }

  checkImport(): void {
    this.sendImport(true);
  }

  runImport(): void {
    if (!this.canImport()) return;
    this.sendImport(false);
  }

  private sendImport(dryRun: boolean): void {
    const im = this.importing();
    if (!im || this.busy() || !im.csv.trim()) return;
    const csv = im.csv;
    this.busy.set(true);
    this.api.importMarginRequirements({ csv, dryRun, reason: im.reason.trim() || null }).subscribe({
      next: (result) => {
        this.busy.set(false);
        this.confirmingImport.set(false);
        if (dryRun) {
          this.keepResult(csv, result);
          return;
        }
        this.importing.set(null);
        this.notify.success(marginImportText(result));
        this.rows.reload();
      },
      error: (err) => {
        this.busy.set(false);
        this.confirmingImport.set(false);
        const result = marginImportFromError(err);
        if (result) this.keepResult(csv, { ...result, dryRun });
        else if (reportable(err))
          this.notify.error(errorText(err, 'The file could not be checked or imported.'));
      },
    });
  }

  private keepResult(csv: string, result: MarginImportResult): void {
    const im = this.importing();
    if (im && im.csv === csv) this.importing.set({ ...im, result, checked: csv });
  }

  remove(): void {
    const m = this.deleting();
    if (!m || this.busy()) return;
    this.busy.set(true);
    this.api.deleteMarginRequirement(m.id, null).subscribe({
      next: () => {
        this.busy.set(false);
        this.deleting.set(null);
        this.notify.success(`${m.symbol} deleted.`);
        this.rows.reload();
      },
      error: (err) => {
        this.busy.set(false);
        this.deleting.set(null);
        if (reportable(err)) this.notify.error(errorText(err, 'The row was not deleted.'));
      },
    });
  }
}
