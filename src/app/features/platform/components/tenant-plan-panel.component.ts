import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
  type OnInit,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

import { NotificationService } from '@core/notifications/notification.service';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { errorText, reportable } from '@features/iam/iam.logic';
import type { TenantDto } from '@features/iam/iam.types';
import { iamResource } from '@features/iam/shared/iam-resource';
import { PlansApiService } from '../plans-api.service';
import { overLimitOn } from '../plans.logic';
import type { PlanDto, TenantUsage } from '../plans.types';
import { PlanUsagePanelComponent } from './plan-usage-panel.component';

/**
 * One organisation's plan and usage on the platform Organisations page (engine Phase 7): its use
 * against its plan (`platform.usage.read`; the engine records the read in that organisation's audit
 * log) and, for holders of `platform.plans.manage`, moving it to another plan — with what would then
 * be over a limit shown before confirming (moving removes nothing; it only stops new additions).
 */
@Component({
  selector: 'app-tenant-plan-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, ConfirmDialogComponent, PlanUsagePanelComponent],
  styleUrl: '../../iam/shared/iam-page.scss',
  template: `
    @if (canReadUsage()) {
      @if (usage.error(); as err) {
        <p class="pad" role="alert"><span class="chip bad">Could not load usage</span> {{ err }}</p>
      } @else if (usage.value(); as u) {
        <app-plan-usage-panel [usage]="u" />
      } @else {
        <p class="pad muted small">Loading usage…</p>
      }
    }

    @if (plans(); as all) {
      <form class="card-body" (ngSubmit)="openConfirm()">
        @if (isHouse()) {
          <p class="note">House is always on its own unlimited plan.</p>
        } @else {
          <div class="form-grid">
            <label class="field">
              <span class="label">Move to plan</span>
              <select class="select" name="plan" [ngModel]="planId()" (ngModelChange)="planId.set($event)">
                <option [ngValue]="null">Choose…</option>
                @for (p of assignable(); track p.id) {
                  <option [ngValue]="p.id">{{ p.name }}{{ p.isDefault ? ' (default)' : '' }}</option>
                }
              </select>
            </label>
            <label class="field">
              <span class="label">Reason (recorded in its audit log)</span>
              <input class="input" name="reason" [ngModel]="reason()" (ngModelChange)="reason.set($event)" />
            </label>
          </div>
          <div class="actions-row">
            <button
              type="submit"
              class="btn btn-primary btn-sm"
              [disabled]="busy() || planId() === null || planId() === tenant().planId"
            >
              Move
            </button>
          </div>
        }
      </form>
    }

    <app-confirm-dialog
      [open]="confirming()"
      [title]="'Move ' + tenant().name + ' to ' + (target()?.name ?? '') + '?'"
      [message]="confirmMessage()"
      confirmLabel="Move"
      [loading]="busy()"
      (confirm)="assign()"
      (cancelled)="confirming.set(false)"
    >
      @if (warnings().length) {
        <ul class="errors">
          @for (w of warnings(); track w) {
            <li>{{ w }}</li>
          }
        </ul>
      }
    </app-confirm-dialog>
  `,
})
export class TenantPlanPanelComponent implements OnInit {
  private readonly api = inject(PlansApiService);
  private readonly notify = inject(NotificationService);

  readonly tenant = input.required<TenantDto>();
  /** Every plan, or null when the viewer may not move organisations between plans. */
  readonly plans = input<PlanDto[] | null>(null);
  readonly canReadUsage = input(false);
  readonly changed = output<TenantDto>();

  readonly usage = iamResource<TenantUsage | null>(
    () => this.api.tenantUsage(this.tenant().id),
    null,
    'Could not load usage.',
  );

  readonly planId = signal<number | null>(null);
  readonly reason = signal('');
  readonly busy = signal(false);
  readonly confirming = signal(false);

  readonly isHouse = computed(() => this.tenant().kind === 'House');
  /** The House plan is House's alone. */
  readonly assignable = computed(() => (this.plans() ?? []).filter((p) => !p.isHousePlan));
  readonly target = computed(() => this.assignable().find((p) => p.id === this.planId()) ?? null);
  readonly warnings = computed(() => {
    const t = this.target();
    return t ? overLimitOn(t, this.usage.value()) : [];
  });
  readonly confirmMessage = computed(() =>
    this.warnings().length
      ? 'Nothing in use is removed, but these would be over the new limits, so nothing more of them can be added:'
      : 'It takes effect at the next thing the organisation adds. Nothing in use is removed.',
  );

  ngOnInit(): void {
    if (this.canReadUsage()) this.usage.reload();
  }

  openConfirm(): void {
    if (this.planId() === null || this.busy()) return;
    this.confirming.set(true);
  }

  assign(): void {
    const t = this.target();
    if (!t || this.busy()) return;
    this.busy.set(true);
    this.api.assignPlan(this.tenant().id, t.id, this.reason().trim() || null).subscribe({
      next: (tenant) => {
        this.busy.set(false);
        this.confirming.set(false);
        this.reason.set('');
        this.notify.success(`${this.tenant().name} moved to ${t.name}.`);
        this.changed.emit(tenant);
        if (this.canReadUsage()) this.usage.reload();
      },
      error: (err) => {
        this.busy.set(false);
        this.confirming.set(false);
        if (reportable(err)) this.notify.error(errorText(err, 'The plan was not changed.'));
      },
    });
  }
}
