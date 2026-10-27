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
  MARGIN_KINDS,
  MARGIN_LABELS,
  dateOnly,
  emptyMargin,
  isoMidnight,
  marginBody,
  marginFieldsFor,
  marginProblems,
  marginSummary,
} from '../venues.logic';
import type { MarginKind, MarginRequirement, MarginRequirementFields } from '../venues.types';

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
  imports: [FormsModule, PageHeaderComponent, LscCanDirective, ConfirmDialogComponent],
  styleUrl: '../../iam/shared/iam-page.scss',
  template: `
    <div class="page">
      <app-page-header
        title="Margin requirements"
        subtitle="Futures margins, crypto leverage tiers and equity house rates the multi-asset risk models use. FX / CFD margin stays the MT5 account's."
      >
        <button *lscCan="'platform.data.manage'" type="button" class="btn btn-secondary" (click)="startCreate()">Add a row</button>
        <button type="button" class="btn btn-secondary" (click)="rows.reload()" [disabled]="rows.loading()">
          {{ rows.loading() ? 'Loading…' : 'Refresh' }}
        </button>
      </app-page-header>

      <section class="card">
        <div class="card-body row">
          <label class="field">
            <span class="label">Kind</span>
            <select class="select" name="f-kind" [ngModel]="filterKind()" (ngModelChange)="filterKind.set($event); rows.reload()">
              <option value="">All</option>
              @for (k of kinds; track k) {
                <option [value]="k">{{ kindLabel[k] }}</option>
              }
            </select>
          </label>
          <label class="field">
            <span class="label">Symbol starts with</span>
            <input class="input search" name="f-sym" [ngModel]="symbol()" (ngModelChange)="symbol.set($event)" (keydown.enter)="rows.reload()" />
          </label>
          <label class="check">
            <input type="checkbox" name="f-del" [ngModel]="includeDeleted()" (ngModelChange)="includeDeleted.set($event); rows.reload()" />
            Show deleted
          </label>
        </div>
        <p class="note">
          No row for an exchange-traded instrument = the risk check refuses it. A futures root row (ES) covers every
          contract without its own row; a venue row wins over a generic (empty-venue) one; the latest start in force wins.
        </p>
      </section>

      @if (editing(); as e) {
        <section class="card" aria-label="Margin requirement row">
          <header class="card-head"><h3>{{ e.id ? 'Edit ' + e.fields.symbol : 'New margin requirement' }}</h3></header>
          <form class="card-body" (ngSubmit)="save()">
            <div class="form-grid">
              <label class="field">
                <span class="label">Kind</span>
                <select class="select" name="e-kind" [(ngModel)]="e.fields.kind" (ngModelChange)="touch()" [disabled]="!!e.id">
                  @for (k of kinds; track k) {
                    <option [value]="k">{{ kindLabel[k] }}</option>
                  }
                </select>
              </label>
              <label class="field">
                <span class="label">Symbol or futures root</span>
                <input class="input" name="e-sym" maxlength="32" [(ngModel)]="e.fields.symbol" (ngModelChange)="touch()" />
              </label>
              <label class="field">
                <span class="label">Venue (empty = the instrument's exchange)</span>
                <input class="input" name="e-venue" maxlength="32" [(ngModel)]="e.fields.venue" (ngModelChange)="touch()" />
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
                <span class="label">Applies from (UTC date)</span>
                <input class="input" type="date" name="e-from" [(ngModel)]="e.from" (ngModelChange)="touch()" />
              </label>
              <label class="field">
                <span class="label">Source (exchange page, broker sheet, operator)</span>
                <input class="input" name="e-src" maxlength="128" [(ngModel)]="e.fields.source" (ngModelChange)="touch()" />
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
              Lower margins let larger exchange-traded positions pass the risk check once <code>Risk:MultiAsset:Enabled</code>
              is on. Enter the venue's published terms, not estimates.
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
                <th>Symbol</th>
                <th>Kind · venue</th>
                <th>Terms</th>
                <th>From</th>
                <th>Source</th>
                <th><span class="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              @for (m of rows.value(); track m.id) {
                <tr [class.muted]="m.isDeleted">
                  <td><code>{{ m.symbol }}</code></td>
                  <td class="small">{{ kindLabel[m.kind] }}{{ m.venue ? ' · ' + m.venue : '' }}</td>
                  <td class="small">{{ summary(m) }}</td>
                  <td class="small">
                    <span class="chip" [class.ok]="m.inForce" [class.bad]="m.isDeleted">{{ m.isDeleted ? 'deleted' : m.inForce ? 'in force' : 'later' }}</span>
                    <span class="sub">{{ m.effectiveFromUtc.slice(0, 10) }}</span>
                  </td>
                  <td class="small">{{ m.source }}<span class="sub">{{ when(m.updatedAtUtc) }}</span></td>
                  <td class="actions">
                    @if (!m.isDeleted) {
                      <button *lscCan="'platform.data.manage'" type="button" class="btn btn-sm btn-secondary" (click)="startEdit(m)">Edit</button>
                      <button *lscCan="'platform.data.manage'" type="button" class="btn btn-sm btn-danger" (click)="deleting.set(m)">Delete</button>
                    }
                  </td>
                </tr>
              } @empty {
                <tr><td colspan="6" class="muted">No margin requirement loaded: every exchange-traded instrument is refused by the risk check.</td></tr>
              }
            </tbody>
          </table>
        </div>
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

  readonly filterKind = signal<MarginKind | ''>('');
  readonly symbol = signal('');
  readonly includeDeleted = signal(false);
  readonly rows = iamResource<MarginRequirement[]>(
    () =>
      this.api.marginRequirements({
        kind: this.filterKind() || undefined,
        symbol: this.symbol().trim() || undefined,
        includeDeleted: this.includeDeleted(),
      }),
    [],
    'Could not load the margin requirements.',
  );
  readonly editing = signal<Editing | null>(null);
  readonly deleting = signal<MarginRequirement | null>(null);
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

  touch(): void {
    this.version.update((v) => v + 1);
  }

  num(f: MarginRequirementFields, k: keyof MarginRequirementFields): number | null {
    return f[k] as number | null;
  }

  setNum(k: keyof MarginRequirementFields, v: number | string | null): void {
    const e = this.editing();
    if (!e) return;
    (e.fields as unknown as Record<string, number | null>)[k] = v === null || v === '' ? null : Number(v);
    this.touch();
  }

  startCreate(): void {
    const fields = emptyMargin('FuturesContract');
    this.editing.set({ id: null, fields, from: dateOnly(fields.effectiveFromUtc), reason: '' });
  }

  startEdit(m: MarginRequirement): void {
    const { id, createdAtUtc, updatedAtUtc, isDeleted, inForce, ...fields } = m;
    void createdAtUtc;
    void updatedAtUtc;
    void isDeleted;
    void inForce;
    this.editing.set({ id, fields: { ...fields }, from: dateOnly(m.effectiveFromUtc), reason: '' });
  }

  save(): void {
    const e = this.editing();
    if (!e || this.busy() || this.problems().length) return;
    this.busy.set(true);
    const body = { ...marginBody({ ...e.fields, effectiveFromUtc: isoMidnight(e.from) ?? e.fields.effectiveFromUtc }), reason: e.reason.trim() || null };
    (e.id ? this.api.updateMarginRequirement(e.id, body) : this.api.createMarginRequirement(body)).subscribe({
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
