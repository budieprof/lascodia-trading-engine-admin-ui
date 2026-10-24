import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

import { when } from '@features/iam/iam.logic';
import {
  money,
  monthLabel,
  paymentLabel,
  paymentTone,
  quantity,
  statusTone,
} from '../billing.logic';
import type { Invoice } from '../billing.types';

/** One invoice: header facts, explained lines, review notes, downloads. */
@Component({
  selector: 'app-invoice-detail',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: '../../iam/shared/iam-page.scss',
  styles: [
    `
      .num {
        text-align: right;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }
      .facts {
        display: flex;
        flex-wrap: wrap;
        gap: 6px 18px;
        padding: 10px 16px;
      }
    `,
  ],
  template: `
    @let i = invoice();
    <section class="card">
      <header class="card-head">
        <h3>
          {{ i.number ?? (i.status === 'Draft' ? 'Draft invoice' : 'Invoice') }} —
          {{ i.tenantName }} · {{ monthLabel(i.month) }}
        </h3>
        <span class="spacer"></span>
        <span class="chip" [class]="statusTone(i.status)">{{ i.status }}</span>
        <button type="button" class="btn btn-sm btn-secondary" (click)="download.emit('pdf')">
          PDF
        </button>
        <button type="button" class="btn btn-sm btn-secondary" (click)="download.emit('csv')">
          CSV
        </button>
        <button type="button" class="btn btn-sm btn-secondary" (click)="closed.emit()">
          Close
        </button>
      </header>
      <div class="facts small">
        <span
          ><span class="muted">Total</span> <strong>{{ money(i.total, i.currency) }}</strong> (no
          tax computed)</span
        >
        <span
          ><span class="muted">Days metered</span> {{ i.daysMetered }} of {{ i.daysInPeriod }}</span
        >
        <span><span class="muted">Drafted</span> {{ when(i.generatedAtUtc) }}</span>
        @if (i.finalisedAtUtc) {
          <span
            ><span class="muted">Finalised</span> {{ when(i.finalisedAtUtc) }} by
            {{ i.finalisedBy ?? 'unknown' }}</span
          >
        }
        <span>
          <span class="muted">Payment</span>
          <span class="chip" [class]="paymentTone(i.paymentStatus)">{{
            paymentLabel(i.paymentStatus)
          }}</span>
          @if (i.paymentProvider) {
            via <code>{{ i.paymentProvider }}</code>
          }
        </span>
      </div>
      @if (i.paymentMessage) {
        <p class="pad small muted">{{ i.paymentMessage }}</p>
      }
      @if (i.status === 'Void') {
        <p class="note warn" role="status">Voided {{ when(i.voidedAtUtc) }}: {{ i.voidReason }}</p>
      }
      @if (i.reviewNote) {
        <p class="pad small">Reviewer's note: {{ i.reviewNote }}</p>
      }
      @if (i.lines?.length) {
        <div class="table-wrap">
          <table class="grid">
            <thead>
              <tr>
                <th>Line</th>
                <th class="num">Quantity</th>
                <th class="num">Unit price</th>
                <th class="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              @for (l of i.lines; track l.sortOrder) {
                <tr>
                  <td>
                    {{ l.description }}
                    <span class="sub">{{ l.explanation }}</span>
                  </td>
                  <td class="num">{{ quantity(l.quantity) }}</td>
                  <td class="num">{{ l.unitPrice }}</td>
                  <td class="num">{{ money(l.amount, i.currency) }}</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      } @else {
        <p class="pad muted">No charged lines.</p>
      }
      @if (i.warnings.length) {
        <div class="pad small">
          <strong>Notes for review</strong>
          <ul>
            @for (w of i.warnings; track $index) {
              <li>{{ w }}</li>
            }
          </ul>
        </div>
      }
    </section>
  `,
})
export class InvoiceDetailComponent {
  readonly invoice = input.required<Invoice>();
  readonly download = output<'pdf' | 'csv'>();
  readonly closed = output<void>();

  protected readonly when = when;
  protected readonly money = money;
  protected readonly quantity = quantity;
  protected readonly monthLabel = monthLabel;
  protected readonly statusTone = statusTone;
  protected readonly paymentTone = paymentTone;
  protected readonly paymentLabel = paymentLabel;
}
