import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { PlansApiService } from '@features/platform/plans-api.service';
import { PlanUsagePanelComponent } from '@features/platform/components/plan-usage-panel.component';
import type { TenantUsage } from '@features/platform/plans.types';
import { iamResource } from '../shared/iam-resource';

/**
 * Plan & usage (engine multi-tenancy Phase 7, `GET /tenant/usage`, `tenant.usage.read`): what the
 * organisation's plan allows — accounts, terminals, people, research jobs, strategies, scripts,
 * features — and how much is in use. Creations over a limit are refused with a message naming the
 * limit; platform staff change the plan.
 */
@Component({
  selector: 'app-iam-plan-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PageHeaderComponent, PlanUsagePanelComponent],
  styleUrl: '../shared/iam-page.scss',
  template: `
    <div class="page">
      <app-page-header
        title="Plan & usage"
        subtitle="What your organisation's plan allows and how much of it is in use."
      >
        <button
          type="button"
          class="btn btn-secondary"
          (click)="usage.reload()"
          [disabled]="usage.loading()"
        >
          {{ usage.loading() ? 'Loading…' : 'Refresh' }}
        </button>
      </app-page-header>

      <section class="card">
        @if (usage.error(); as err) {
          <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
        }
        @if (usage.value(); as u) {
          <app-plan-usage-panel [usage]="u" />
        } @else if (!usage.error()) {
          <p class="pad muted">Loading…</p>
        }
      </section>

      <p class="note">
        Something you try to add over a limit is refused with a message saying which limit. Nothing
        in use is ever removed when a plan changes. To move to a larger plan, contact platform
        staff.
      </p>
    </div>
  `,
})
export class PlanPageComponent {
  private readonly plans = inject(PlansApiService);

  readonly usage = iamResource<TenantUsage | null>(
    () => this.plans.myUsage(),
    null,
    'Could not load your plan and usage.',
  );

  constructor() {
    this.usage.reload();
  }
}
