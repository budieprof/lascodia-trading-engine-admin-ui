import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { iamResource } from '@features/iam/shared/iam-resource';
import { PropDashboardViewComponent } from '../components/prop-dashboard-view.component';
import { PropGateComponent } from '../components/prop-gate.component';
import { PropApiService } from '../prop-api.service';
import type { PropDashboard } from '../prop.types';

/** One enrolment's dashboard as the firm sees it (`prop.read`). */
@Component({
  selector: 'app-prop-dashboard-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, PageHeaderComponent, PropGateComponent, PropDashboardViewComponent],
  styleUrl: '../../iam/shared/iam-page.scss',
  template: `
    <div class="page">
      <app-page-header
        title="Trader dashboard"
        subtitle="Where the account stands against every rule of its phase."
      >
        <a class="btn btn-secondary" routerLink="/prop/enrollments">All enrolments</a>
        <button
          type="button"
          class="btn btn-secondary"
          (click)="dashboard.reload()"
          [disabled]="dashboard.loading()"
        >
          {{ dashboard.loading() ? 'Loading…' : 'Refresh' }}
        </button>
      </app-page-header>
      <app-prop-gate (ready)="dashboard.reload()">
        @if (dashboard.error(); as err) {
          <section class="card">
            <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
          </section>
        }
        @if (dashboard.value(); as d) {
          <app-prop-dashboard-view [dashboard]="d" />
        }
      </app-prop-gate>
    </div>
  `,
})
export class PropDashboardPageComponent {
  private readonly api = inject(PropApiService);
  private readonly id = Number(inject(ActivatedRoute).snapshot.paramMap.get('id'));

  readonly dashboard = iamResource<PropDashboard | null>(
    () => this.api.dashboard(this.id),
    null,
    'Could not load the dashboard.',
  );
}
