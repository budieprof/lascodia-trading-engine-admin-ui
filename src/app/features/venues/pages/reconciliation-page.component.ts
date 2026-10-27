import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';

import { AuthService } from '@core/auth/auth.service';
import { Permission } from '@core/auth/permissions.generated';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { when } from '@features/iam/iam.logic';
import { iamResource } from '@features/iam/shared/iam-resource';

import { VenuesApiService } from '../venues-api.service';
import { driftLabel, driftSummary } from '../venues.logic';
import type { ExecutionAccountReconciliation } from '../venues.types';

/**
 * Venue reconciliation drift (multi-asset WS7 7.10): the engine's latest pass per account (exec-gateway / exec-core
 * `GET execution/reconciliation`) — engine positions and working orders against what each adapter reports, matched by
 * venue id. READ-ONLY: in `report` mode nothing is corrected; in `act` mode (venue accounts only) the engine lists the
 * corrections it made. MT5 accounts stay with the EA's own reconciliation. Empty until
 * `Execution:Reconciliation:Enabled` is on. Reads `accounts.read`.
 */
@Component({
  selector: 'app-reconciliation-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, PageHeaderComponent],
  styleUrl: '../../iam/shared/iam-page.scss',
  template: `
    <div class="page">
      <app-page-header
        title="Reconciliation drift"
        subtitle="Engine positions and working orders against what each venue adapter reports — read-only."
      >
        <a class="btn btn-secondary" routerLink="/connections">Connections</a>
        <button type="button" class="btn btn-secondary" (click)="rows.reload()" [disabled]="rows.loading()">
          {{ rows.loading() ? 'Loading…' : 'Refresh' }}
        </button>
      </app-page-header>

      @if (rows.error(); as err) {
        <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
      }

      <section class="card">
        <div class="card-body">
          <p>
            <span class="chip">{{ summary().accounts }} account(s)</span>
            <span class="chip" [class.bad]="summary().withDrift > 0" [class.ok]="summary().withDrift === 0">
              {{ summary().withDrift }} with drift
            </span>
            <span class="chip">{{ summary().drifts }} difference(s)</span>
            @if (summary().skipped) {
              <span class="chip warn">{{ summary().skipped }} skipped</span>
            }
          </p>
          <p class="note">
            Nothing appears until the platform switch <code>Execution:Reconciliation:Enabled</code> is on. In
            <code>report</code> mode (the default) differences are only reported; MT5 accounts are always report-only.
          </p>
        </div>
      </section>

      @for (r of rows.value(); track $index) {
        <section class="card" [attr.aria-label]="'Account ' + (r.executionAccountId ?? r.tradingAccountId)">
          <header class="card-head">
            <h3>
              <code>{{ r.adapterKind }}</code>
              {{ r.executionAccountId ? 'execution account #' + r.executionAccountId : '' }}
              {{ r.tradingAccountId ? 'trading account #' + r.tradingAccountId : '' }}
            </h3>
            <span class="spacer"></span>
            <span class="small muted">{{ when(r.atUtc) }}</span>
          </header>
          <div class="card-body">
            <p class="small">
              Positions: engine {{ r.enginePositions }} · venue {{ r.venuePositions }} — orders: engine
              {{ r.engineOrders }} · venue {{ r.venueOrders }}
              @if (r.skipped) {
                <span class="chip warn">skipped: {{ r.skipped }}</span>
              }
            </p>
            @if (r.drift.length) {
              <div class="table-wrap">
                <table class="grid">
                  <thead>
                    <tr>
                      <th>Difference</th>
                      <th>Symbol</th>
                      <th>Venue id</th>
                      <th>Engine id</th>
                      <th>Engine qty</th>
                      <th>Venue qty</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (d of r.drift; track $index) {
                      <tr>
                        <td>{{ label(d.kind) }}</td>
                        <td>{{ d.symbol }}</td>
                        <td><code>{{ d.venueId ?? '—' }}</code></td>
                        <td>{{ d.engineId ?? '—' }}</td>
                        <td>{{ d.engineQuantity ?? '—' }}</td>
                        <td>{{ d.venueQuantity ?? '—' }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            } @else {
              <p class="muted small">In agreement.</p>
            }
            @if (r.actions?.length) {
              <p class="note warn">Corrections made (act mode): {{ r.actions!.join('; ') }}</p>
            }
          </div>
        </section>
      } @empty {
        @if (rows.loaded() && !rows.error()) {
          <p class="pad muted">No reconciliation pass yet.</p>
        }
      }
    </div>
  `,
})
export class ReconciliationPageComponent {
  private readonly api = inject(VenuesApiService);
  private readonly auth = inject(AuthService);

  protected readonly when = when;
  protected readonly label = driftLabel;

  readonly rows = iamResource<ExecutionAccountReconciliation[]>(
    () => this.api.reconciliation(),
    [],
    'Could not load the reconciliation.',
  );
  readonly summary = computed(() => driftSummary(this.rows.value()));

  constructor() {
    if (this.auth.hasPermission(Permission.AccountsRead)) this.rows.reload();
  }
}
