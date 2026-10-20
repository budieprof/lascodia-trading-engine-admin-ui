import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';

import { NotificationService } from '@core/notifications/notification.service';
import { reportable } from '@features/iam/iam.logic';
import { saveBlob } from '@features/scripting/shared/download';
import { PlansApiService } from '../plans-api.service';
import { blobErrorText, exportMonths, monthLabel } from '../plans.logic';

/**
 * The monthly usage export for invoicing (engine Phase 7, `platform.usage.read`): a CSV with one row
 * per organisation — plan, monthly peaks of accounts / terminals / people, research hours, LLM spend
 * (empty until it is measured per organisation). The engine records every export in the audit log.
 */
@Component({
  selector: 'app-usage-export',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  styleUrl: '../../iam/shared/iam-page.scss',
  template: `
    <select
      class="select"
      aria-label="Month to export"
      [ngModel]="month()"
      (ngModelChange)="month.set($event)"
    >
      @for (m of months; track m) {
        <option [value]="m">{{ label(m) }}</option>
      }
    </select>
    <button type="button" class="btn btn-secondary" (click)="download()" [disabled]="busy()">
      {{ busy() ? 'Exporting…' : 'Usage export (CSV)' }}
    </button>
  `,
})
export class UsageExportComponent {
  private readonly api = inject(PlansApiService);
  private readonly notify = inject(NotificationService);

  protected readonly months = exportMonths(new Date());
  protected readonly label = monthLabel;

  /** Last month by default: the usual one to invoice. */
  readonly month = signal(this.months[1] ?? this.months[0]);
  readonly busy = signal(false);

  async download(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      const file = await firstValueFrom(this.api.exportUsage(this.month()));
      saveBlob(file.blob, file.fileName);
      this.notify.success(`Usage for ${monthLabel(this.month())} downloaded.`);
    } catch (err: unknown) {
      if (reportable(err)) this.notify.error(await blobErrorText(err, 'The usage export failed.'));
    } finally {
      this.busy.set(false);
    }
  }
}
