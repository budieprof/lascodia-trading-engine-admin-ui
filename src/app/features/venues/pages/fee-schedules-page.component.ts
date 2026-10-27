import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { LscCanDirective } from '@core/auth/can.directive';
import { NotificationService } from '@core/notifications/notification.service';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { errorText, reportable, when } from '@features/iam/iam.logic';
import { iamResource } from '@features/iam/shared/iam-resource';

import { VenuesApiService } from '../venues-api.service';
import {
  FEE_ASSET_CLASSES,
  FEE_LABELS,
  dateOnly,
  emptyFee,
  feeBody,
  feeFieldsFor,
  feeProblems,
  feeSummary,
  isoMidnight,
} from '../venues.logic';
import type { FeeAssetClass, FeeSchedule, FeeScheduleFields } from '../venues.types';

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
  imports: [FormsModule, PageHeaderComponent, LscCanDirective, ConfirmDialogComponent],
  styleUrl: '../../iam/shared/iam-page.scss',
  template: `
    <div class="page">
      <app-page-header
        title="Fee schedules"
        subtitle="Futures, crypto and equity fees the cost models and the venue ticket use — FX / CFD costs stay the broker's."
      >
        <button *lscCan="'platform.data.manage'" type="button" class="btn btn-secondary" (click)="startCreate()">Add a row</button>
        <button type="button" class="btn btn-secondary" (click)="rows.reload()" [disabled]="rows.loading()">
          {{ rows.loading() ? 'Loading…' : 'Refresh' }}
        </button>
      </app-page-header>

      <section class="card">
        <div class="card-body row">
          <label class="field">
            <span class="label">Asset class</span>
            <select class="select" name="f-ac" [ngModel]="filterClass()" (ngModelChange)="filterClass.set($event); rows.reload()">
              <option value="">All</option>
              @for (c of classes; track c) {
                <option [value]="c">{{ c }}</option>
              }
            </select>
          </label>
          <label class="field">
            <span class="label">Search (code, scope, notes)</span>
            <input class="input search" name="f-q" [ngModel]="search()" (ngModelChange)="search.set($event)" (keydown.enter)="rows.reload()" />
          </label>
          <label class="check">
            <input type="checkbox" name="f-del" [ngModel]="includeDeleted()" (ngModelChange)="includeDeleted.set($event); rows.reload()" />
            Show deleted
          </label>
        </div>
      </section>

      @if (editing(); as e) {
        <section class="card" aria-label="Fee schedule row">
          <header class="card-head"><h3>{{ e.id ? 'Edit ' + e.fields.code : 'New fee schedule row' }}</h3></header>
          <form class="card-body" (ngSubmit)="save()">
            <div class="form-grid">
              <label class="field">
                <span class="label">Code (e.g. cme:ES, binance:perp)</span>
                <input class="input" name="e-code" maxlength="64" [(ngModel)]="e.fields.code" (ngModelChange)="touch()" />
              </label>
              <label class="field">
                <span class="label">Asset class</span>
                <select class="select" name="e-ac" [(ngModel)]="e.fields.assetClass" (ngModelChange)="touch()">
                  @for (c of classes; track c) {
                    <option [value]="c">{{ c }}</option>
                  }
                </select>
              </label>
              <label class="field">
                <span class="label">Venue (cme, binance, us-equities…)</span>
                <input class="input" name="e-venue" maxlength="32" [(ngModel)]="e.fields.venue" (ngModelChange)="touch()" />
              </label>
              <label class="field">
                <span class="label">Scope (root, spot / perp, or empty = venue default)</span>
                <input class="input" name="e-scope" maxlength="32" [ngModel]="e.fields.scope ?? ''" (ngModelChange)="e.fields.scope = $event || null; touch()" />
              </label>
              <label class="field">
                <span class="label">Currency</span>
                <input class="input" name="e-ccy" maxlength="8" [(ngModel)]="e.fields.currency" (ngModelChange)="touch()" />
              </label>
              @for (k of numericFields(); track k) {
                <label class="field">
                  <span class="label">{{ labels[k] }}</span>
                  <input class="input" type="number" step="any" [name]="'e-' + k" [ngModel]="num(e.fields, k)" (ngModelChange)="setNum(k, $event)" />
                </label>
              }
              <label class="field">
                <span class="label">In force from (UTC date)</span>
                <input class="input" type="date" name="e-from" [(ngModel)]="e.from" (ngModelChange)="touch()" />
              </label>
              <label class="field">
                <span class="label">Until (exclusive, empty = still in force)</span>
                <input class="input" type="date" name="e-to" [(ngModel)]="e.to" (ngModelChange)="touch()" />
              </label>
              <label class="field">
                <span class="label">Source (URL and date read, or operator)</span>
                <input class="input" name="e-src" maxlength="500" [(ngModel)]="e.fields.source" (ngModelChange)="touch()" />
              </label>
              <label class="field">
                <span class="label">Notes</span>
                <input class="input" name="e-notes" maxlength="1000" [ngModel]="e.fields.notes ?? ''" (ngModelChange)="e.fields.notes = $event || null" />
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
              A changed fee changes the cost-model key of every symbol it prices: backtests priced with the old row stop
              counting as promotion evidence (they are re-run), as for any cost-model change.
            </p>
            <div class="actions-row">
              <button type="button" class="btn btn-secondary" data-autofocus (click)="editing.set(null)">Cancel</button>
              <button type="submit" class="btn btn-primary" [disabled]="busy() || problems().length > 0">{{ busy() ? 'Saving…' : 'Save' }}</button>
            </div>
          </form>
        </section>
      }

      <section class="card">
        @if (rows.error(); as err) {
          <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
        }
        <div class="table-wrap">
          <table class="grid">
            <thead>
              <tr>
                <th>Code</th>
                <th>Class · venue · scope</th>
                <th>Fees</th>
                <th>In force</th>
                <th>Source</th>
                <th><span class="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              @for (f of shown(); track f.id) {
                <tr [class.muted]="f.isDeleted">
                  <td><code>{{ f.code }}</code><span class="sub">{{ f.notes }}</span></td>
                  <td class="small">{{ f.assetClass }} · {{ f.venue }}{{ f.scope ? ' · ' + f.scope : '' }}</td>
                  <td class="small">{{ summary(f) }}</td>
                  <td class="small">
                    <span class="chip" [class.ok]="f.inForce" [class.bad]="f.isDeleted">{{ f.isDeleted ? 'deleted' : f.inForce ? 'yes' : 'no' }}</span>
                    <span class="sub">{{ f.effectiveFromUtc.slice(0, 10) }} → {{ f.effectiveToUtc ? f.effectiveToUtc.slice(0, 10) : '…' }}</span>
                  </td>
                  <td class="small">{{ f.source }}<span class="sub">{{ when(f.updatedAtUtc) }}</span></td>
                  <td class="actions">
                    @if (!f.isDeleted) {
                      <button *lscCan="'platform.data.manage'" type="button" class="btn btn-sm btn-secondary" (click)="startEdit(f)">Edit</button>
                      <button *lscCan="'platform.data.manage'" type="button" class="btn btn-sm btn-danger" (click)="deleting.set({ row: f, reason: '' })">Delete</button>
                    }
                  </td>
                </tr>
              } @empty {
                <tr><td colspan="6" class="muted">No fee schedule rows.</td></tr>
              }
            </tbody>
          </table>
        </div>
      </section>

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
  protected readonly summary = feeSummary;

  readonly filterClass = signal<FeeAssetClass | ''>('');
  readonly search = signal('');
  readonly includeDeleted = signal(false);
  readonly rows = iamResource<FeeSchedule[]>(
    () => this.api.feeSchedules({ assetClass: this.filterClass() || undefined, includeDeleted: this.includeDeleted() }),
    [],
    'Could not load the fee schedules.',
  );
  readonly shown = computed(() => {
    const q = this.search().trim().toLowerCase();
    return q
      ? this.rows.value().filter((f) => `${f.code} ${f.scope ?? ''} ${f.notes ?? ''} ${f.venue}`.toLowerCase().includes(q))
      : this.rows.value();
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

  touch(): void {
    this.version.update((v) => v + 1);
  }

  num(f: FeeScheduleFields, k: keyof FeeScheduleFields): number | null {
    return f[k] as number | null;
  }

  setNum(k: keyof FeeScheduleFields, v: number | string | null): void {
    const e = this.editing();
    if (!e) return;
    (e.fields as unknown as Record<string, number | null>)[k] = v === null || v === '' ? null : Number(v);
    this.touch();
  }

  startCreate(): void {
    const fields = emptyFee('Future');
    this.editing.set({ id: null, fields, from: dateOnly(fields.effectiveFromUtc), to: '', reason: '' });
  }

  startEdit(f: FeeSchedule): void {
    const { id, createdAtUtc, updatedAtUtc, isDeleted, inForce, ...fields } = f;
    void createdAtUtc;
    void updatedAtUtc;
    void isDeleted;
    void inForce;
    this.editing.set({ id, fields: { ...fields }, from: dateOnly(f.effectiveFromUtc), to: dateOnly(f.effectiveToUtc), reason: '' });
  }

  private fieldsOf(e: Editing): FeeScheduleFields {
    return { ...e.fields, effectiveFromUtc: isoMidnight(e.from) ?? e.fields.effectiveFromUtc, effectiveToUtc: e.to ? isoMidnight(e.to) : null };
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
