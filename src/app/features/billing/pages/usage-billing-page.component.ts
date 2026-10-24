import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { NotificationService } from '@core/notifications/notification.service';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { errorText, reportable, when } from '@features/iam/iam.logic';
import { iamResource } from '@features/iam/shared/iam-resource';
import { saveBlob } from '@features/scripting/shared/download';
import { BillingApiService } from '../billing-api.service';
import {
  money,
  monthLabel,
  paymentLabel,
  paymentTone,
  recentMonths,
  statusTone,
} from '../billing.logic';
import type { BillingUsageMonth, Invoice } from '../billing.types';
import { InvoiceDetailComponent } from '../components/invoice-detail.component';
import { UsageMonthViewComponent } from '../components/usage-month-view.component';

/**
 * The organisation's "Usage & billing" (engine billing-metering, `tenant.billing.read`): what was
 * metered each day, the month's estimate on the price books in force, and its finalised invoices.
 */
@Component({
  selector: 'app-usage-billing-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, PageHeaderComponent, UsageMonthViewComponent, InvoiceDetailComponent],
  styleUrl: '../../iam/shared/iam-page.scss',
  template: `
    <div class="page">
      <app-page-header
        title="Usage & billing"
        subtitle="Metered usage per UTC day, this month's estimate and your invoices."
      >
        <select
          class="select"
          aria-label="Month"
          [ngModel]="month()"
          (ngModelChange)="month.set($event); usage.reload()"
        >
          @for (m of months; track m) {
            <option [ngValue]="m">{{ monthLabel(m) }}</option>
          }
        </select>
        <button
          type="button"
          class="btn btn-secondary"
          (click)="refresh()"
          [disabled]="usage.loading()"
        >
          {{ usage.loading() ? 'Loading…' : 'Refresh' }}
        </button>
      </app-page-header>

      @if (usage.error(); as err) {
        <section class="card">
          <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
        </section>
      }
      @if (usage.value(); as u) {
        <app-billing-usage-month [usage]="u" />
      } @else if (!usage.error()) {
        <section class="card"><p class="pad muted">Loading…</p></section>
      }

      <section class="card">
        <header class="card-head">
          <h3>Invoices</h3>
          <span class="spacer"></span>
          <span class="muted small"
            >Invoices appear here once the platform has reviewed and finalised them.</span
          >
        </header>
        @if (invoices.error(); as err) {
          <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
        } @else if (invoices.value().length === 0) {
          <p class="pad muted">{{ invoices.loaded() ? 'No invoices yet.' : 'Loading…' }}</p>
        } @else {
          <div class="table-wrap">
            <table class="grid">
              <thead>
                <tr>
                  <th>Number</th>
                  <th>Month</th>
                  <th>Total</th>
                  <th>Status</th>
                  <th>Payment</th>
                  <th>Finalised</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                @for (i of invoices.value(); track i.id) {
                  <tr [class.selected]="selected()?.id === i.id">
                    <td>
                      <code>{{ i.number ?? '—' }}</code>
                    </td>
                    <td>{{ monthLabel(i.month) }}</td>
                    <td>{{ money(i.total, i.currency) }}</td>
                    <td>
                      <span class="chip" [class]="statusTone(i.status)">{{ i.status }}</span>
                    </td>
                    <td>
                      <span class="chip" [class]="paymentTone(i.paymentStatus)">{{
                        paymentLabel(i.paymentStatus)
                      }}</span>
                    </td>
                    <td class="small">{{ when(i.finalisedAtUtc) }}</td>
                    <td>
                      <button type="button" class="btn btn-sm btn-secondary" (click)="open(i)">
                        View
                      </button>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
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
    </div>
  `,
})
export class UsageBillingPageComponent {
  private readonly api = inject(BillingApiService);
  private readonly notify = inject(NotificationService);

  protected readonly months = recentMonths(12);
  protected readonly monthLabel = monthLabel;
  protected readonly money = money;
  protected readonly when = when;
  protected readonly statusTone = statusTone;
  protected readonly paymentTone = paymentTone;
  protected readonly paymentLabel = paymentLabel;

  readonly month = signal(this.months[0]);
  readonly selected = signal<Invoice | null>(null);

  readonly usage = iamResource<BillingUsageMonth | null>(
    () => this.api.myUsage(this.month()),
    null,
    'Could not load usage.',
  );
  readonly invoices = iamResource<Invoice[]>(
    () => this.api.myInvoices(),
    [],
    'Could not load invoices.',
  );

  constructor() {
    this.usage.reload();
    this.invoices.reload();
  }

  refresh(): void {
    this.usage.reload();
    this.invoices.reload();
  }

  open(invoice: Invoice): void {
    this.api.myInvoice(invoice.id).subscribe({
      next: (full) => this.selected.set(full),
      error: (e) => reportable(e) && this.notify.error(errorText(e, 'Could not open the invoice.')),
    });
  }

  download(invoice: Invoice, format: 'pdf' | 'csv'): void {
    this.api.downloadMyInvoice(invoice.id, format).subscribe({
      next: (f) => saveBlob(f.blob, f.fileName),
      error: (e) => reportable(e) && this.notify.error('Could not download the invoice.'),
    });
  }
}
