import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { iamResource } from '@features/iam/shared/iam-resource';
import { PropDashboardViewComponent } from '../components/prop-dashboard-view.component';
import { PropGateComponent } from '../components/prop-gate.component';
import { PropApiService } from '../prop-api.service';
import type { PropDashboard } from '../prop.types';

/**
 * "My challenge" (`prop.self`): the signed-in trader's own enrolments — those of the trading account
 * they signed in with, or of the trader their console user is linked to. Nobody else's.
 */
@Component({
  selector: 'app-prop-me-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PageHeaderComponent, PropGateComponent, PropDashboardViewComponent],
  styleUrl: '../../iam/shared/iam-page.scss',
  template: `
    <div class="page">
      <app-page-header
        title="My challenge"
        subtitle="Your progress against every rule of your program."
      >
        <button
          type="button"
          class="btn btn-secondary"
          (click)="mine.reload()"
          [disabled]="mine.loading()"
        >
          {{ mine.loading() ? 'Loading…' : 'Refresh' }}
        </button>
      </app-page-header>
      <app-prop-gate (ready)="mine.reload()">
        @if (mine.error(); as err) {
          <section class="card">
            <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
          </section>
        }
        @for (d of mine.value(); track d.enrollment.id) {
          <app-prop-dashboard-view [dashboard]="d" />
        } @empty {
          @if (mine.loaded() && !mine.error()) {
            <section class="card">
              <p class="pad muted">
                No prop challenge is linked to you. Sign in with your challenge account, or ask the
                firm to link your user to your trader record.
              </p>
            </section>
          }
        }
      </app-prop-gate>
    </div>
  `,
})
export class PropMePageComponent {
  private readonly api = inject(PropApiService);
  readonly mine = iamResource<PropDashboard[]>(
    () => this.api.myDashboards(),
    [],
    'Could not load your challenge.',
  );
}
