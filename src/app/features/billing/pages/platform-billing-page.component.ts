import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { catchError, of } from 'rxjs';

import { AuthService } from '@core/auth/auth.service';
import { Permission } from '@core/auth/permissions.generated';
import { NotificationService } from '@core/notifications/notification.service';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { IamApiService } from '@features/iam/iam-api.service';
import { errorText, reportable, when } from '@features/iam/iam.logic';
import { iamResource } from '@features/iam/shared/iam-resource';
import { PlansApiService } from '@features/platform/plans-api.service';
import { saveBlob } from '@features/scripting/shared/download';
import { BillingApiService } from '../billing-api.service';
import {
  emptyPriceBookForm,
  formFrom,
  invoiceActions,
  money,
  monthLabel,
  paymentLabel,
  paymentTone,
  previousMonth,
  priceBookBody,
  recentMonths,
  statusTone,
  totalsByCurrency,
  type PriceBookForm,
} from '../billing.logic';
import type { BillingUsageMonth, Invoice, PaymentProviderInfo, PriceBook } from '../billing.types';
import { InvoiceDetailComponent } from '../components/invoice-detail.component';
import { UsageMonthViewComponent } from '../components/usage-month-view.component';

type Tab = 'invoices' | 'price-books' | 'usage';
type Pending =
  | { kind: 'generate' }
  | { kind: 'finalise'; invoice: Invoice }
  | { kind: 'void'; invoice: Invoice }
  | { kind: 'collect'; invoice: Invoice }
  | { kind: 'publish'; book: PriceBook }
  | { kind: 'delete'; book: PriceBook };

/**
 * Platform billing (engine billing-metering): monthly invoice drafts → review → finalise / void,
 * exports and the payment hand-off; versioned price books per plan; any organisation's metered usage.
 * Reads `platform.usage.read`; every change `platform.billing.manage` and a confirmation.
 */
@Component({
  selector: 'app-platform-billing-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    PageHeaderComponent,
    ConfirmDialogComponent,
    InvoiceDetailComponent,
    UsageMonthViewComponent,
  ],
  styleUrl: '../../iam/shared/iam-page.scss',
  styles: [
    `
      .tabs {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
      }
      .tabs .btn[aria-selected='true'] {
        font-weight: 600;
        border-color: var(--accent, currentColor);
      }
      .num {
        text-align: right;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }
      .wide {
        grid-column: 1 / -1;
      }
    `,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Billing"
        subtitle="Invoices from metered usage × plan price books. No tax is computed; no real payment provider is integrated."
      />

      <div class="tabs" role="tablist" aria-label="Billing sections">
        @for (t of tabs; track t.id) {
          <button
            type="button"
            role="tab"
            class="btn btn-secondary"
            [attr.aria-selected]="tab() === t.id"
            (click)="tab.set(t.id)"
          >
            {{ t.label }}
          </button>
        }
      </div>

      @if (provider.value(); as p) {
        <p class="note" [class.warn]="!p.active" role="status">
          Payment provider: <code>{{ p.configured }}</code>
          @if (p.isTestDouble) {
            — the local test double (nothing leaves the engine, no money moves).
          } @else if (!p.active) {
            — invoices are exported and collected outside the engine.
          }
          <span class="muted small">{{ p.notice }}</span>
        </p>
      }

      <!-- ── Invoices ── -->
      @if (tab() === 'invoices') {
        <section class="card">
          <header class="card-head">
            <h3>Invoices</h3>
            <span class="spacer"></span>
            <select
              class="select"
              aria-label="Month"
              [ngModel]="month()"
              (ngModelChange)="month.set($event); invoices.reload()"
            >
              @for (m of months; track m) {
                <option [ngValue]="m">{{ monthLabel(m) }}</option>
              }
            </select>
            <select
              class="select"
              aria-label="Status"
              [ngModel]="status()"
              (ngModelChange)="status.set($event); invoices.reload()"
            >
              <option [ngValue]="''">Any status</option>
              <option ngValue="Draft">Draft</option>
              <option ngValue="Finalised">Finalised</option>
              <option ngValue="Void">Void</option>
            </select>
            <button
              type="button"
              class="btn btn-secondary btn-sm"
              (click)="invoices.reload()"
              [disabled]="invoices.loading()"
            >
              {{ invoices.loading() ? 'Loading…' : 'Refresh' }}
            </button>
            @if (canManage()) {
              <button
                type="button"
                class="btn btn-primary btn-sm"
                (click)="pending.set({ kind: 'generate' })"
              >
                Draft invoices for {{ monthLabel(month()) }}
              </button>
            }
          </header>
          @if (invoices.error(); as err) {
            <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
          } @else if (invoices.value().length === 0) {
            <p class="pad muted">
              {{
                invoices.loaded()
                  ? 'No invoices for this month. Draft them once the month is over.'
                  : 'Loading…'
              }}
            </p>
          } @else {
            <p class="pad small muted">Total of live invoices: {{ totals() }}</p>
            <div class="table-wrap">
              <table class="grid">
                <thead>
                  <tr>
                    <th>Organisation</th>
                    <th>Number</th>
                    <th class="num">Total</th>
                    <th>Status</th>
                    <th>Payment</th>
                    <th>Notes</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  @for (i of invoices.value(); track i.id) {
                    @let a = actions(i);
                    <tr [class.selected]="selected()?.id === i.id">
                      <td>
                        {{ i.tenantName }}
                        <span class="sub"
                          ><code>{{ i.tenantSlug }}</code></span
                        >
                      </td>
                      <td>
                        <code>{{ i.number ?? '—' }}</code>
                      </td>
                      <td class="num">{{ money(i.total, i.currency) }}</td>
                      <td>
                        <span class="chip" [class]="statusTone(i.status)">{{ i.status }}</span>
                      </td>
                      <td>
                        <span class="chip" [class]="paymentTone(i.paymentStatus)">{{
                          paymentLabel(i.paymentStatus)
                        }}</span>
                      </td>
                      <td class="small">
                        {{ i.warnings.length ? i.warnings.length + ' to review' : '—' }}
                      </td>
                      <td class="actions-row">
                        <button type="button" class="btn btn-sm btn-secondary" (click)="open(i)">
                          Review
                        </button>
                        @if (canManage()) {
                          @if (a.finalise) {
                            <button
                              type="button"
                              class="btn btn-sm btn-primary"
                              (click)="startFinalise(i)"
                            >
                              Finalise
                            </button>
                          }
                          @if (a.collect) {
                            <button
                              type="button"
                              class="btn btn-sm btn-secondary"
                              (click)="pending.set({ kind: 'collect', invoice: i })"
                            >
                              Collect
                            </button>
                          }
                          @if (a.refresh) {
                            <button
                              type="button"
                              class="btn btn-sm btn-secondary"
                              (click)="refreshPayment(i)"
                            >
                              Payment status
                            </button>
                          }
                          @if (a.void) {
                            <button
                              type="button"
                              class="btn btn-sm btn-danger"
                              (click)="startVoid(i)"
                            >
                              Void
                            </button>
                          }
                        }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
          @if (lastRun(); as run) {
            <div class="pad small">
              <strong>Last draft run ({{ monthLabel(run.month) }}):</strong>
              {{ run.drafted.length }} drafted, {{ run.skipped.length }} skipped.
              @if (run.skipped.length) {
                <ul>
                  @for (s of run.skipped; track s.tenantId) {
                    <li>
                      <code>{{ s.tenantSlug }}</code
                      >: {{ s.reason }}
                    </li>
                  }
                </ul>
              }
            </div>
          }
        </section>

        @if (selected(); as inv) {
          <app-invoice-detail
            [invoice]="inv"
            (download)="download(inv, $event)"
            (closed)="selected.set(null)"
          />
        }
      }

      <!-- ── Price books ── -->
      @if (tab() === 'price-books') {
        <section class="card">
          <header class="card-head">
            <h3>Price books</h3>
            <span class="spacer"></span>
            <span class="muted small"
              >Monthly prices, charged per UTC day. Published versions are frozen; a change is a new
              version.</span
            >
            @if (canManage()) {
              <button type="button" class="btn btn-primary btn-sm" (click)="newBook(null)">
                New price book
              </button>
            }
          </header>
          @if (books.error(); as err) {
            <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
          } @else if (books.value().length === 0) {
            <p class="pad muted">
              {{
                books.loaded()
                  ? 'No price books yet: nothing can be invoiced until a plan has a published one.'
                  : 'Loading…'
              }}
            </p>
          } @else {
            <div class="table-wrap">
              <table class="grid">
                <thead>
                  <tr>
                    <th>Plan</th>
                    <th>Version</th>
                    <th>From</th>
                    <th class="num">Platform</th>
                    <th class="num">Per terminal (incl.)</th>
                    <th class="num">Per user (incl.)</th>
                    <th>Modules</th>
                    <th>Feeds / LLM</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  @for (b of books.value(); track b.id) {
                    <tr>
                      <td>
                        {{ b.planName }}
                        <span class="sub"
                          ><code>{{ b.planSlug }}</code></span
                        >
                      </td>
                      <td>
                        v{{ b.version }}
                        <span
                          class="chip"
                          [class.ok]="b.inForce"
                          [class.warn]="b.status === 'Draft'"
                          >{{ b.inForce ? 'In force' : b.status }}</span
                        >
                      </td>
                      <td class="small">{{ b.effectiveFromUtc.slice(0, 10) }}</td>
                      <td class="num">{{ money(b.platformFeeMonthly, b.currency) }}</td>
                      <td class="num">
                        {{ money(b.perTerminalMonthly, b.currency) }} ({{ b.includedTerminals }})
                      </td>
                      <td class="num">
                        {{ money(b.perUserMonthly, b.currency) }} ({{ b.includedUsers }})
                      </td>
                      <td class="small">
                        Prop {{ b.propModuleMonthly }} · Broker {{ b.brokerModuleMonthly }} · Fund
                        {{ b.fundModuleMonthly }}
                      </td>
                      <td class="small">
                        {{ b.feedPrices.length }} feed(s) · LLM
                        {{ b.llmMarginPct === null ? 'not billed' : '+' + b.llmMarginPct + ' %' }}
                      </td>
                      <td class="actions-row">
                        @if (canManage()) {
                          @if (b.status === 'Draft') {
                            <button
                              type="button"
                              class="btn btn-sm btn-secondary"
                              (click)="editBook(b)"
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              class="btn btn-sm btn-primary"
                              (click)="pending.set({ kind: 'publish', book: b })"
                            >
                              Publish
                            </button>
                            <button
                              type="button"
                              class="btn btn-sm btn-danger"
                              (click)="pending.set({ kind: 'delete', book: b })"
                            >
                              Delete
                            </button>
                          } @else {
                            <button
                              type="button"
                              class="btn btn-sm btn-secondary"
                              (click)="newBook(b)"
                            >
                              New version
                            </button>
                          }
                        }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </section>

        @if (form(); as f) {
          <section class="card">
            <header class="card-head">
              <h3>{{ editingId() === null ? 'New price book (draft)' : 'Edit draft' }}</h3>
            </header>
            <div class="form-grid pad">
              <label class="field">
                <span class="label">Plan</span>
                <select
                  class="select"
                  [ngModel]="f.planId"
                  (ngModelChange)="patch({ planId: $event })"
                  [disabled]="editingId() !== null"
                >
                  <option [ngValue]="null">Choose…</option>
                  @for (p of plans.value(); track p.id) {
                    <option [ngValue]="p.id">{{ p.name }} ({{ p.slug }})</option>
                  }
                </select>
              </label>
              <label class="field">
                <span class="label">Currency</span>
                <input
                  class="input"
                  maxlength="3"
                  [ngModel]="f.currency"
                  (ngModelChange)="patch({ currency: $event })"
                />
              </label>
              <label class="field">
                <span class="label">Prices apply from (UTC day)</span>
                <input
                  class="input"
                  type="date"
                  [ngModel]="f.effectiveFrom"
                  (ngModelChange)="patch({ effectiveFrom: $event })"
                />
              </label>
              @for (n of numberFields; track n.key) {
                <label class="field">
                  <span class="label">{{ n.label }}</span>
                  <input
                    class="input"
                    inputmode="decimal"
                    [ngModel]="f[n.key]"
                    (ngModelChange)="patchField(n.key, $event)"
                  />
                </label>
              }
              <label class="field">
                <span class="label">LLM margin % (blank = LLM not invoiced)</span>
                <input
                  class="input"
                  inputmode="decimal"
                  [ngModel]="f.llmMarginPct"
                  (ngModelChange)="patch({ llmMarginPct: $event })"
                />
              </label>
              <label class="field wide">
                <span class="label"
                  >Feed prices — one per line: feed id, monthly pass-through cost, per display user,
                  margin %</span
                >
                <textarea
                  class="textarea"
                  rows="4"
                  placeholder="cme-l2, 120, 15, 20"
                  [ngModel]="f.feedPrices"
                  (ngModelChange)="patch({ feedPrices: $event })"
                ></textarea>
              </label>
              <label class="field wide">
                <span class="label"
                  >Exchange fees per subscriber — one per exchange: family, professional,
                  non-professional, non-display (per organisation), margin %. Charged per person who
                  read the exchange's real-time data in the month; people without a declaration
                  count as professional.</span
                >
                <textarea
                  class="textarea"
                  rows="3"
                  placeholder="cme-group, 105, 3, 0, 0"
                  [ngModel]="f.exchangeFees ?? ''"
                  (ngModelChange)="patch({ exchangeFees: $event })"
                ></textarea>
              </label>
              <label class="field wide">
                <span class="label">Notes</span>
                <textarea
                  class="textarea"
                  rows="2"
                  [ngModel]="f.notes"
                  (ngModelChange)="patch({ notes: $event })"
                ></textarea>
              </label>
            </div>
            @if (formErrors().length) {
              <ul class="errors pad">
                @for (e of formErrors(); track $index) {
                  <li>{{ e }}</li>
                }
              </ul>
            }
            <div class="actions-row pad">
              <button
                type="button"
                class="btn btn-secondary"
                (click)="form.set(null)"
                [disabled]="busy()"
              >
                Cancel
              </button>
              <button
                type="button"
                class="btn btn-primary"
                (click)="saveBook()"
                [disabled]="busy()"
              >
                Save draft
              </button>
            </div>
          </section>
        }
      }

      <!-- ── Usage ── -->
      @if (tab() === 'usage') {
        <section class="card">
          <header class="card-head">
            <h3>An organisation's metered usage</h3>
            <span class="spacer"></span>
            @if (tenants.value().length) {
              <select
                class="select"
                aria-label="Organisation"
                [ngModel]="usageTenant()"
                (ngModelChange)="usageTenant.set($event)"
              >
                <option [ngValue]="null">Choose an organisation…</option>
                @for (t of tenants.value(); track t.id) {
                  <option [ngValue]="t.id">{{ t.name }} ({{ t.slug }})</option>
                }
              </select>
            } @else {
              <input
                class="input"
                type="number"
                min="1"
                placeholder="Organisation id"
                aria-label="Organisation id"
                [ngModel]="usageTenant()"
                (ngModelChange)="usageTenant.set($event ? +$event : null)"
              />
            }
            <select
              class="select"
              aria-label="Month"
              [ngModel]="usageMonth()"
              (ngModelChange)="usageMonth.set($event)"
            >
              @for (m of months; track m) {
                <option [ngValue]="m">{{ monthLabel(m) }}</option>
              }
            </select>
            <button
              type="button"
              class="btn btn-secondary btn-sm"
              (click)="loadUsage()"
              [disabled]="usageTenant() === null || usage.loading()"
            >
              {{ usage.loading() ? 'Loading…' : 'Show' }}
            </button>
          </header>
          <p class="pad small muted">Each view is recorded in that organisation's audit log.</p>
          @if (usage.error(); as err) {
            <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
          }
        </section>
        @if (usage.value(); as u) {
          <app-billing-usage-month [usage]="u" />
        }
      }

      <app-confirm-dialog
        [open]="pending() !== null"
        [title]="confirmTitle()"
        [message]="confirmMessage()"
        [confirmLabel]="confirmLabel()"
        [confirmVariant]="
          pending()?.kind === 'void' || pending()?.kind === 'delete' ? 'destructive' : 'primary'
        "
        [loading]="busy()"
        (confirm)="confirm()"
        (cancelled)="pending.set(null)"
      >
        @if (pending()?.kind === 'finalise') {
          <label class="field">
            <span class="label">Reviewer's note (optional, printed on the invoice)</span>
            <textarea
              class="textarea"
              rows="2"
              maxlength="1000"
              [ngModel]="note()"
              (ngModelChange)="note.set($event)"
            ></textarea>
          </label>
        }
        @if (pending()?.kind === 'void') {
          <label class="field">
            <span class="label">Why is it voided? (required)</span>
            <textarea
              class="textarea"
              rows="2"
              maxlength="1000"
              [ngModel]="note()"
              (ngModelChange)="note.set($event)"
            ></textarea>
          </label>
        }
      </app-confirm-dialog>
    </div>
  `,
})
export class PlatformBillingPageComponent {
  private readonly api = inject(BillingApiService);
  private readonly plansApi = inject(PlansApiService);
  private readonly iamApi = inject(IamApiService);
  private readonly auth = inject(AuthService);
  private readonly notify = inject(NotificationService);

  protected readonly tabs: { id: Tab; label: string }[] = [
    { id: 'invoices', label: 'Invoices' },
    { id: 'price-books', label: 'Price books' },
    { id: 'usage', label: 'Usage' },
  ];
  protected readonly months = recentMonths(13);
  protected readonly monthLabel = monthLabel;
  protected readonly money = money;
  protected readonly when = when;
  protected readonly statusTone = statusTone;
  protected readonly paymentTone = paymentTone;
  protected readonly paymentLabel = paymentLabel;
  protected readonly actions = invoiceActions;
  protected readonly numberFields: { key: keyof PriceBookForm; label: string }[] = [
    { key: 'platformFeeMonthly', label: 'Platform fee / month' },
    { key: 'perTerminalMonthly', label: 'Per terminal / month' },
    { key: 'includedTerminals', label: 'Terminals included' },
    { key: 'perUserMonthly', label: 'Per active user / month' },
    { key: 'includedUsers', label: 'Users included' },
    { key: 'propModuleMonthly', label: 'Prop module / month' },
    { key: 'brokerModuleMonthly', label: 'Broker module / month' },
    { key: 'fundModuleMonthly', label: 'Fund module / month' },
  ];

  readonly tab = signal<Tab>('invoices');
  readonly month = signal(previousMonth());
  readonly status = signal('');
  readonly selected = signal<Invoice | null>(null);
  readonly pending = signal<Pending | null>(null);
  readonly note = signal('');
  readonly busy = signal(false);
  readonly lastRun = signal<{
    month: string;
    drafted: Invoice[];
    skipped: { tenantId: number; tenantSlug: string; reason: string }[];
  } | null>(null);
  readonly form = signal<PriceBookForm | null>(null);
  readonly editingId = signal<number | null>(null);
  readonly formErrors = signal<string[]>([]);
  readonly usageTenant = signal<number | null>(null);
  readonly usageMonth = signal(recentMonths(1)[0]);

  readonly canManage = computed(() => this.auth.hasPermission(Permission.PlatformBillingManage));

  readonly invoices = iamResource<Invoice[]>(
    () => this.api.invoices(this.month(), this.status() || null),
    [],
    'Could not load invoices.',
  );
  readonly books = iamResource<PriceBook[]>(
    () => this.api.priceBooks(),
    [],
    'Could not load price books.',
  );
  readonly provider = iamResource<PaymentProviderInfo | null>(
    () => this.api.paymentProvider(),
    null,
    'Could not read the payment provider.',
  );
  readonly plans = iamResource(
    () => this.plansApi.plans().pipe(catchError(() => of([]))),
    [],
    'Could not load plans.',
  );
  readonly tenants = iamResource(
    () => this.iamApi.tenants().pipe(catchError(() => of([]))),
    [],
    'Could not load organisations.',
  );
  readonly usage = iamResource<BillingUsageMonth | null>(
    () => this.api.tenantUsage(this.usageTenant() ?? 0, this.usageMonth()),
    null,
    'Could not load usage.',
  );

  readonly totals = computed(() => totalsByCurrency(this.invoices.value()));

  readonly confirmTitle = computed(() => {
    const p = this.pending();
    switch (p?.kind) {
      case 'generate':
        return `Draft invoices for ${monthLabel(this.month())}?`;
      case 'finalise':
        return `Finalise ${p.invoice.tenantName}'s invoice?`;
      case 'void':
        return `Void ${p.invoice.number ?? 'this draft'}?`;
      case 'collect':
        return `Hand ${p.invoice.number} to the payment provider?`;
      case 'publish':
        return `Publish ${p.book.planName} price book v${p.book.version}?`;
      case 'delete':
        return `Delete draft v${p.book.version}?`;
      default:
        return '';
    }
  });
  readonly confirmMessage = computed(() => {
    const p = this.pending();
    switch (p?.kind) {
      case 'generate':
        return 'Every metered organisation (House excepted) gets a draft; existing drafts are recomputed, finalised invoices are left alone.';
      case 'finalise':
        return `It gets its number and is frozen at ${money(p.invoice.total, p.invoice.currency)}; the organisation sees it. A mistake afterwards means voiding it.`;
      case 'void':
        return 'The invoice is kept for the record, marked void; a new draft can then be made for the month.';
      case 'collect':
        return `${money(p.invoice.total, p.invoice.currency)} is submitted to the configured provider (${this.provider.value()?.configured ?? 'unknown'}).`;
      case 'publish':
        return `From ${p.book.effectiveFromUtc.slice(0, 10)} these prices apply to every organisation on the plan. A published version can never be edited.`;
      case 'delete':
        return 'The draft is removed; its version number is not reused.';
      default:
        return '';
    }
  });
  readonly confirmLabel = computed(() => {
    const k = this.pending()?.kind;
    return k === 'generate'
      ? 'Draft invoices'
      : k === 'finalise'
        ? 'Finalise'
        : k === 'void'
          ? 'Void'
          : k === 'collect'
            ? 'Collect'
            : k === 'publish'
              ? 'Publish'
              : 'Delete';
  });

  constructor() {
    this.invoices.reload();
    this.books.reload();
    this.provider.reload();
    this.plans.reload();
    this.tenants.reload();
  }

  open(invoice: Invoice): void {
    this.api.invoice(invoice.id).subscribe({
      next: (full) => this.selected.set(full),
      error: (e) => reportable(e) && this.notify.error(errorText(e, 'Could not open the invoice.')),
    });
  }

  startFinalise(invoice: Invoice): void {
    this.note.set('');
    this.pending.set({ kind: 'finalise', invoice });
  }

  startVoid(invoice: Invoice): void {
    this.note.set('');
    this.pending.set({ kind: 'void', invoice });
  }

  refreshPayment(invoice: Invoice): void {
    this.api.refreshPayment(invoice.id).subscribe({
      next: (i) => this.updated(i, `Payment status: ${paymentLabel(i.paymentStatus)}.`),
      error: (e) =>
        reportable(e) && this.notify.error(errorText(e, 'Could not ask the payment provider.')),
    });
  }

  download(invoice: Invoice, format: 'pdf' | 'csv'): void {
    this.api.downloadInvoice(invoice.id, format).subscribe({
      next: (f) => saveBlob(f.blob, f.fileName),
      error: (e) => reportable(e) && this.notify.error('Could not download the invoice.'),
    });
  }

  loadUsage(): void {
    if (this.usageTenant() !== null) this.usage.reload();
  }

  newBook(from: PriceBook | null): void {
    this.editingId.set(null);
    this.formErrors.set([]);
    this.form.set(
      from
        ? formFrom(from, emptyPriceBookForm(from.planId).effectiveFrom)
        : emptyPriceBookForm(null),
    );
  }

  editBook(book: PriceBook): void {
    this.editingId.set(book.id);
    this.formErrors.set([]);
    this.form.set(formFrom(book));
  }

  patch(change: Partial<PriceBookForm>): void {
    const f = this.form();
    if (f) this.form.set({ ...f, ...change });
  }

  patchField(key: keyof PriceBookForm, value: string): void {
    this.patch({ [key]: value } as Partial<PriceBookForm>);
  }

  saveBook(): void {
    const f = this.form();
    if (!f) return;
    const { body, errors } = priceBookBody(f);
    this.formErrors.set(errors);
    if (!body) return;
    const id = this.editingId();
    this.busy.set(true);
    (id === null ? this.api.createPriceBook(body) : this.api.updatePriceBook(id, body)).subscribe({
      next: (b) => {
        this.busy.set(false);
        this.form.set(null);
        this.notify.success(`Draft v${b.version} of ${b.planName} saved. Publish it to apply it.`);
        this.books.reload();
      },
      error: (e) => {
        this.busy.set(false);
        if (reportable(e)) this.formErrors.set([errorText(e, 'Could not save the price book.')]);
      },
    });
  }

  confirm(): void {
    const p = this.pending();
    if (!p) return;
    if (p.kind === 'void' && this.note().trim().length < 3) {
      this.notify.error('Say why the invoice is voided.');
      return;
    }
    this.busy.set(true);
    const done = (message: string) => {
      this.busy.set(false);
      this.pending.set(null);
      this.notify.success(message);
    };
    const failed = (fallback: string) => (e: unknown) => {
      this.busy.set(false);
      if (reportable(e)) this.notify.error(errorText(e, fallback));
    };
    switch (p.kind) {
      case 'generate':
        this.api.generateInvoices(this.month(), null).subscribe({
          next: (r) => {
            this.lastRun.set(r);
            done(`${r.drafted.length} draft(s) made, ${r.skipped.length} skipped.`);
            this.invoices.reload();
          },
          error: failed('Could not draft the invoices.'),
        });
        break;
      case 'finalise':
        this.api.finalise(p.invoice.id, this.note().trim() || null).subscribe({
          next: (i) => {
            done(`Finalised as ${i.number}.`);
            this.updated(i);
          },
          error: failed('Could not finalise the invoice.'),
        });
        break;
      case 'void':
        this.api.void(p.invoice.id, this.note().trim()).subscribe({
          next: (i) => {
            done('Invoice voided.');
            this.updated(i);
          },
          error: failed('Could not void the invoice.'),
        });
        break;
      case 'collect':
        this.api.collect(p.invoice.id).subscribe({
          next: (i) => {
            done(`Payment: ${paymentLabel(i.paymentStatus)}.`);
            this.updated(i);
          },
          error: failed('Could not hand the invoice to the payment provider.'),
        });
        break;
      case 'publish':
        this.api.publishPriceBook(p.book.id).subscribe({
          next: (b) => {
            done(`v${b.version} published.`);
            this.books.reload();
          },
          error: failed('Could not publish the price book.'),
        });
        break;
      case 'delete':
        this.api.deletePriceBook(p.book.id).subscribe({
          next: () => {
            done('Draft deleted.');
            this.books.reload();
          },
          error: failed('Could not delete the draft.'),
        });
        break;
    }
  }

  private updated(invoice: Invoice, message?: string): void {
    if (message) this.notify.success(message);
    if (this.selected()?.id === invoice.id) this.selected.set(invoice);
    this.invoices.reload();
  }
}
