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
  FEE_ASSET_CLASSES,
  FEE_LABELS,
  dateOnly,
  emptyFee,
  feeBody,
  feeFieldsFor,
  feeProblems,
  isoMidnight,
} from '../venues.logic';
import type { FeeAssetClass, FeeSchedule, FeeScheduleFields } from '../venues.types';

type FeeCol = { key: keyof FeeScheduleFields; head: string; strong?: boolean };

const CLASS_LABEL: Record<string, string> = {
  Future: 'Futures',
  Crypto: 'Crypto',
  Equity: 'Equities',
  Etf: 'ETFs',
};

/** Each asset class shows its own fee columns (a futures row carries no bps, a crypto row no per-contract fee). */
const EQUITY_COLS: FeeCol[] = [
  { key: 'commissionPerShare', head: 'Per share', strong: true },
  { key: 'commissionBps', head: 'Bps' },
  { key: 'minCommissionPerOrder', head: 'Min / order' },
  { key: 'maxCommissionPctOfNotional', head: 'Cap %' },
  { key: 'secFeePerMillion', head: 'SEC / $1M' },
  { key: 'finraTafPerShare', head: 'TAF / share' },
  { key: 'finraTafMaxPerTrade', head: 'TAF cap' },
  { key: 'borrowFeeAnnualPct', head: 'Borrow %/yr' },
  { key: 'slippageTicks', head: 'Slip ticks' },
];
const FEE_COLUMNS: Record<string, FeeCol[]> = {
  Crypto: [
    { key: 'makerFeeBps', head: 'Maker bps', strong: true },
    { key: 'takerFeeBps', head: 'Taker bps', strong: true },
    { key: 'tierMinVolume30d', head: 'Tier from (30d vol)' },
  ],
  Future: [
    { key: 'commissionPerContract', head: 'Commission' },
    { key: 'exchangeFeePerContract', head: 'Exchange' },
    { key: 'clearingFeePerContract', head: 'Clearing' },
    { key: 'regulatoryFeePerContract', head: 'Regulatory' },
    { key: '__total' as keyof FeeScheduleFields, head: 'Total / side', strong: true },
    { key: 'slippageTicks', head: 'Slip ticks' },
  ],
  Equity: EQUITY_COLS,
  Etf: EQUITY_COLS,
};

const numFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 });
const dayFmt = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});
const day = (iso: string): string => dayFmt.format(new Date(iso));

/** The edit form renders above the tables; bring it into view when a row far down is edited. */
function revealForm(label: string): void {
  setTimeout(() =>
    document
      .querySelector(`[aria-label="${label}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
  );
}

function futureTotal(f: FeeScheduleFields): number | null {
  const parts = [
    f.commissionPerContract,
    f.exchangeFeePerContract,
    f.clearingFeePerContract,
    f.regulatoryFeePerContract,
  ];
  if (parts.every((v) => v === null)) return null;
  return Math.round(parts.reduce<number>((s, v) => s + (v ?? 0), 0) * 1e6) / 1e6;
}

interface Editing {
  id: number | null;
  fields: FeeScheduleFields;
  from: string;
  to: string;
  reason: string;
}

/**
 * Fee schedules (multi-asset WS7 7.10): the dated exchange / broker fee rows the research cost models price NON-FX
 * backtests and paper fills with, and the venue ticket's fee estimate (engine `reference/fee-schedules`). FX / CFD
 * costs are not here. The seeded rows are STARTING values marked "NOT a quote — verify"; correct one in place or add a
 * dated row that supersedes it. Reading `marketdata.read`; every change `platform.data.manage`, audited by the engine
 * (before / after) — a delete is soft. Changing a row retires the evidence of backtests priced with the old one (the
 * cost-model key changes), by design.
 */
@Component({
  selector: 'app-fee-schedules-page',
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
  template: `
    <div class="page">
      <app-page-header
        title="Fee schedules"
        subtitle="Futures, crypto and equity fees the cost models and the venue ticket use — FX / CFD costs stay the broker's."
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
          type="button"
          class="btn btn-secondary"
          (click)="rows.reload()"
          [disabled]="rows.loading()"
        >
          {{ rows.loading() ? 'Loading…' : 'Refresh' }}
        </button>
      </app-page-header>

      <app-stat-tiles [tiles]="tiles()" label="Fee schedule summary" />

      @if (editing(); as e) {
        <section class="card" aria-label="Fee schedule row">
          <header class="card-head">
            <h3>{{ e.id ? 'Edit ' + e.fields.code : 'New fee schedule row' }}</h3>
          </header>
          <form class="card-body" (ngSubmit)="save()">
            <div class="form-grid">
              <label class="field">
                <span class="label">Code (e.g. cme:ES, binance:perp)</span>
                <input
                  class="input"
                  name="e-code"
                  maxlength="64"
                  [(ngModel)]="e.fields.code"
                  (ngModelChange)="touch()"
                />
              </label>
              <label class="field">
                <span class="label">Asset class</span>
                <select
                  class="select"
                  name="e-ac"
                  [(ngModel)]="e.fields.assetClass"
                  (ngModelChange)="touch()"
                >
                  @for (c of classes; track c) {
                    <option [value]="c">{{ c }}</option>
                  }
                </select>
              </label>
              <label class="field">
                <span class="label">Venue (cme, binance, us-equities…)</span>
                <input
                  class="input"
                  name="e-venue"
                  maxlength="32"
                  [(ngModel)]="e.fields.venue"
                  (ngModelChange)="touch()"
                />
              </label>
              <label class="field">
                <span class="label">Scope (root, spot / perp, or empty = venue default)</span>
                <input
                  class="input"
                  name="e-scope"
                  maxlength="32"
                  [ngModel]="e.fields.scope ?? ''"
                  (ngModelChange)="e.fields.scope = $event || null; touch()"
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
                <span class="label">In force from (UTC date)</span>
                <input
                  class="input"
                  type="date"
                  name="e-from"
                  [(ngModel)]="e.from"
                  (ngModelChange)="touch()"
                />
              </label>
              <label class="field">
                <span class="label">Until (exclusive, empty = still in force)</span>
                <input
                  class="input"
                  type="date"
                  name="e-to"
                  [(ngModel)]="e.to"
                  (ngModelChange)="touch()"
                />
              </label>
              <label class="field">
                <span class="label">Source (URL and date read, or operator)</span>
                <input
                  class="input"
                  name="e-src"
                  maxlength="500"
                  [(ngModel)]="e.fields.source"
                  (ngModelChange)="touch()"
                />
              </label>
              <label class="field">
                <span class="label">Notes</span>
                <input
                  class="input"
                  name="e-notes"
                  maxlength="1000"
                  [ngModel]="e.fields.notes ?? ''"
                  (ngModelChange)="e.fields.notes = $event || null"
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
            <p class="note">
              A changed fee changes the cost-model key of every symbol it prices: backtests priced
              with the old row stop counting as promotion evidence (they are re-run), as for any
              cost-model change.
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

      <section class="card">
        <div class="toolbar">
          <div class="seg" role="group" aria-label="Asset class">
            <button type="button" [class.on]="!filterClass()" (click)="filterClass.set('')">
              All<span class="n">{{ classCounts()['all'] }}</span>
            </button>
            @for (c of presentClasses(); track c) {
              <button type="button" [class.on]="filterClass() === c" (click)="filterClass.set(c)">
                {{ classLabel(c) }}<span class="n">{{ classCounts()[c] ?? 0 }}</span>
              </button>
            }
          </div>
          <label class="search-box">
            <input
              class="input"
              name="f-q"
              placeholder="Search code, venue, notes"
              aria-label="Search code, venue, scope or notes"
              [ngModel]="search()"
              (ngModelChange)="search.set($event)"
            />
          </label>
          <span class="grow"></span>
          <label class="toggle" [class.on]="showHistory()">
            <input
              type="checkbox"
              name="f-hist"
              [ngModel]="showHistory()"
              (ngModelChange)="showHistory.set($event)"
            />
            Show superseded
            @if (expiredCount()) {
              <span class="dim">({{ expiredCount() }})</span>
            }
          </label>
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
        @if (rows.error(); as err) {
          <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
        }
      </section>

      @for (sec of sections(); track sec.cls) {
        <section class="card" [attr.aria-label]="classLabel(sec.cls) + ' fees'">
          <header class="card-head">
            <h3>{{ classLabel(sec.cls) }}</h3>
            <span class="count">{{ sec.rows.length }}</span>
            <span class="hint">{{ classHint(sec.cls) }}</span>
          </header>
          <div class="table-wrap">
            <table class="grid">
              <thead>
                <tr>
                  <th>Code</th>
                  @for (col of sec.cols; track col.key) {
                    <th class="num" [title]="labels[col.key] ?? col.head">{{ col.head }}</th>
                  }
                  <th>Status</th>
                  @if (!sec.wide) {
                    <th>Source</th>
                  }
                  <th><span class="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                @for (f of sec.rows; track f.id) {
                  <tr [class.is-deleted]="f.isDeleted" [class.is-past]="isExpired(f)">
                    <td>
                      <span class="ident">{{ f.code }}</span>
                      <span class="sub"
                        >{{ f.venue }}{{ f.scope ? ' · ' + f.scope : '' }} · {{ f.currency }}</span
                      >
                      @if (f.notes) {
                        <span class="sub" [title]="f.notes">{{ f.notes }}</span>
                      }
                      @if (sec.wide) {
                        @if (unverified(f)) {
                          <span class="chip warn">Unverified</span>
                        }
                        <span class="source" [title]="f.source">{{ f.source }}</span>
                      }
                    </td>
                    @for (col of sec.cols; track col.key) {
                      <td
                        class="num"
                        [class.dim]="cell(f, col.key) === '—'"
                        [class.strong]="col.strong"
                      >
                        {{ cell(f, col.key) }}
                      </td>
                    }
                    <td class="nowrap">
                      <span class="dot" [class]="statusTone(f)">{{ statusLabel(f) }}</span>
                      <span class="when-sub">{{ period(f) }}</span>
                    </td>
                    @if (!sec.wide) {
                      <td>
                        @if (unverified(f)) {
                          <span
                            class="chip warn"
                            title="The source says these are starting values, not a verified quote"
                            >Unverified</span
                          >
                        }
                        <span class="source" [title]="f.source">{{ f.source }}</span>
                        <span class="when-sub">updated {{ when(f.updatedAtUtc) }}</span>
                      </td>
                    }
                    <td class="actions" [class.stack]="sec.wide">
                      @if (!f.isDeleted) {
                        <button
                          *lscCan="'platform.data.manage'"
                          type="button"
                          class="btn btn-sm btn-ghost"
                          (click)="startEdit(f)"
                        >
                          Edit
                        </button>
                        <button
                          *lscCan="'platform.data.manage'"
                          type="button"
                          class="btn btn-sm btn-ghost-danger"
                          (click)="deleting.set({ row: f, reason: '' })"
                        >
                          Delete
                        </button>
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </section>
      } @empty {
        @if (!rows.loading()) {
          <section class="card">
            <p class="empty">No fee schedule rows match.</p>
          </section>
        }
      }

      <app-confirm-dialog
        [open]="!!deleting()"
        title="Delete the fee schedule row"
        [message]="deleteMessage()"
        confirmLabel="Delete"
        confirmVariant="destructive"
        [loading]="busy()"
        (confirm)="remove()"
        (cancelled)="deleting.set(null)"
      />
    </div>
  `,
})
export class FeeSchedulesPageComponent {
  private readonly api = inject(VenuesApiService);
  private readonly notify = inject(NotificationService);

  protected readonly when = when;
  protected readonly classes = FEE_ASSET_CLASSES;
  protected readonly labels = FEE_LABELS as Record<string, string>;

  readonly filterClass = signal<FeeAssetClass | ''>('');
  readonly search = signal('');
  readonly includeDeleted = signal(false);
  readonly rows = iamResource<FeeSchedule[]>(
    () =>
      this.api.feeSchedules({
        includeDeleted: this.includeDeleted(),
      }),
    [],
    'Could not load the fee schedules.',
  );
  readonly showHistory = signal(false);

  /** Rows after search and the superseded toggle, before the class pills. */
  private readonly base = computed(() => {
    const q = this.search().trim().toLowerCase();
    const hist = this.showHistory();
    return this.rows
      .value()
      .filter((f) => hist || f.isDeleted || !this.isExpired(f))
      .filter(
        (f) =>
          !q || `${f.code} ${f.scope ?? ''} ${f.notes ?? ''} ${f.venue}`.toLowerCase().includes(q),
      );
  });
  readonly expiredCount = computed(
    () => this.rows.value().filter((f) => !f.isDeleted && this.isExpired(f)).length,
  );
  readonly classCounts = computed(() => {
    const c: Record<string, number> = { all: 0 };
    for (const f of this.base()) {
      c[f.assetClass] = (c[f.assetClass] ?? 0) + 1;
      c['all']++;
    }
    return c;
  });
  readonly presentClasses = computed(() =>
    FEE_ASSET_CLASSES.filter((c) => this.rows.value().some((f) => f.assetClass === c)),
  );
  readonly sections = computed(() => {
    const cls = this.filterClass();
    const rows = this.base().filter((f) => !cls || f.assetClass === cls);
    return FEE_ASSET_CLASSES.map((c) => {
      const list = rows
        .filter((f) => f.assetClass === c)
        .sort(
          (a, b) =>
            a.code.localeCompare(b.code) || b.effectiveFromUtc.localeCompare(a.effectiveFromUtc),
        );
      // A fee no row of the section uses is a column of dashes: leave it out.
      const cols = (FEE_COLUMNS[c] ?? FEE_COLUMNS['Equity']).filter((col) =>
        list.some((f) => this.cell(f, col.key) !== '—'),
      );
      // Many fee columns leave no room for a source column; it moves under the code instead.
      return { cls: c, cols, rows: list, wide: cols.length > 6 };
    }).filter((s) => s.rows.length > 0);
  });
  readonly tiles = computed<StatTile[]>(() => {
    const all = this.rows.value().filter((f) => !f.isDeleted);
    const live = all.filter((f) => f.inForce);
    const unverified = live.filter((f) => this.unverified(f)).length;
    return [
      {
        label: 'Rows in force',
        value: this.rows.loaded() ? String(live.length) : '…',
        caption: `of ${all.length} stored`,
      },
      {
        label: 'Venues',
        value: String(new Set(live.map((f) => f.venue)).size),
        caption:
          [...new Set(live.map((f) => f.assetClass))].map((c) => this.classLabel(c)).join(' · ') ||
          'none',
      },
      {
        label: 'Unverified in force',
        value: String(unverified),
        caption: unverified ? 'starting values — check against the venue' : 'all sourced',
        tone: unverified ? 'warn' : 'good',
      },
      {
        label: 'Superseded',
        value: String(this.expiredCount()),
        caption: 'older rows kept for backtest history',
      },
    ];
  });
  readonly editing = signal<Editing | null>(null);
  readonly deleting = signal<{ row: FeeSchedule; reason: string } | null>(null);
  readonly busy = signal(false);
  private readonly version = signal(0);

  readonly numericFields = computed(() => {
    this.version();
    const e = this.editing();
    return e ? feeFieldsFor(e.fields.assetClass) : [];
  });
  readonly problems = computed(() => {
    this.version();
    const e = this.editing();
    if (!e) return [];
    const p = feeProblems(this.fieldsOf(e));
    if (!isoMidnight(e.from)) p.push('Give the date the row applies from.');
    return p;
  });
  readonly deleteMessage = computed(() => {
    const d = this.deleting();
    return d
      ? `${d.row.code} (${d.row.venue}) is soft-deleted: the cost models stop using it at once and the seeder never re-adds it. The engine records who deleted it.`
      : '';
  });

  constructor() {
    this.rows.reload();
  }

  classLabel(c: string): string {
    return CLASS_LABEL[c] ?? c;
  }

  classHint(c: string): string {
    return c === 'Crypto'
      ? 'basis points of notional · negative maker = rebate'
      : c === 'Future'
        ? 'per contract per side'
        : 'per share / notional · sells pay SEC + FINRA TAF';
  }

  isExpired(f: FeeSchedule): boolean {
    return !!f.effectiveToUtc && Date.parse(f.effectiveToUtc) <= Date.now();
  }

  unverified(f: FeeSchedule): boolean {
    return /NOT a quote|NOT verified/i.test(f.source ?? '');
  }

  statusLabel(f: FeeSchedule): string {
    if (f.isDeleted) return 'Deleted';
    if (f.inForce) return 'In force';
    return this.isExpired(f) ? 'Superseded' : 'Scheduled';
  }

  statusTone(f: FeeSchedule): string {
    return 'dot ' + (f.isDeleted ? 'bad' : f.inForce ? 'ok' : this.isExpired(f) ? '' : 'warn');
  }

  period(f: FeeSchedule): string {
    const from =
      Date.parse(f.effectiveFromUtc) <= Date.parse('2000-01-02') ? null : day(f.effectiveFromUtc);
    const to = f.effectiveToUtc ? day(f.effectiveToUtc) : null;
    if (from && to) return `${from} → ${to}`;
    if (to) return `until ${to}`;
    return from ? `since ${from}` : 'since the start';
  }

  cell(f: FeeSchedule, k: keyof FeeScheduleFields): string {
    const v = (k as string) === '__total' ? futureTotal(f) : (f[k] as number | null);
    if (v === null || v === undefined) return '—';
    return numFmt.format(v);
  }

  touch(): void {
    this.version.update((v) => v + 1);
  }

  num(f: FeeScheduleFields, k: keyof FeeScheduleFields): number | null {
    return f[k] as number | null;
  }

  setNum(k: keyof FeeScheduleFields, v: number | string | null): void {
    const e = this.editing();
    if (!e) return;
    (e.fields as unknown as Record<string, number | null>)[k] =
      v === null || v === '' ? null : Number(v);
    this.touch();
  }

  startCreate(): void {
    const fields = emptyFee('Future');
    this.editing.set({
      id: null,
      fields,
      from: dateOnly(fields.effectiveFromUtc),
      to: '',
      reason: '',
    });
    revealForm('Fee schedule row');
  }

  startEdit(f: FeeSchedule): void {
    const { id, createdAtUtc, updatedAtUtc, isDeleted, inForce, ...fields } = f;
    void createdAtUtc;
    void updatedAtUtc;
    void isDeleted;
    void inForce;
    this.editing.set({
      id,
      fields: { ...fields },
      from: dateOnly(f.effectiveFromUtc),
      to: dateOnly(f.effectiveToUtc),
      reason: '',
    });
    revealForm('Fee schedule row');
  }

  private fieldsOf(e: Editing): FeeScheduleFields {
    return {
      ...e.fields,
      effectiveFromUtc: isoMidnight(e.from) ?? e.fields.effectiveFromUtc,
      effectiveToUtc: e.to ? isoMidnight(e.to) : null,
    };
  }

  save(): void {
    const e = this.editing();
    if (!e || this.busy() || this.problems().length) return;
    this.busy.set(true);
    const body = { ...feeBody(this.fieldsOf(e)), reason: e.reason.trim() || null };
    (e.id ? this.api.updateFeeSchedule(e.id, body) : this.api.createFeeSchedule(body)).subscribe({
      next: (row) => {
        this.busy.set(false);
        this.editing.set(null);
        this.notify.success(`${row.code} saved.`);
        this.rows.reload();
      },
      error: (err) => {
        this.busy.set(false);
        if (reportable(err)) this.notify.error(errorText(err, 'The row was not saved.'));
      },
    });
  }

  remove(): void {
    const d = this.deleting();
    if (!d || this.busy()) return;
    this.busy.set(true);
    this.api.deleteFeeSchedule(d.row.id, d.reason.trim() || null).subscribe({
      next: () => {
        this.busy.set(false);
        this.deleting.set(null);
        this.notify.success(`${d.row.code} deleted.`);
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
