import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { when } from '@features/iam/iam.logic';
import { iamResource } from '@features/iam/shared/iam-resource';
import { PlansApiService } from '../plans-api.service';
import { ageText, attentionFirst, credentialLabel, fleetRows, type FleetFilter } from '../plans.logic';
import type { FleetHealth } from '../plans.types';

/** The look-back choices for disconnected terminals. */
const WINDOWS = [
  { hours: 24, label: 'Last 24 hours' },
  { hours: 168, label: 'Last 7 days' },
  { hours: 720, label: 'Last 30 days' },
] as const;

/**
 * Fleet health across organisations (engine multi-tenancy Phase 7, `platform.fleet.read`): every
 * organisation's EA terminals — health, the EA's own state, version, last heartbeat, how it signs in —
 * and engaged kill switches. Read-only; the engine records each view in the audit log. The House-only
 * EA pages (EA Instances, Fleet Health under Ops) remain the place to act on a terminal.
 */
@Component({
  selector: 'app-platform-fleet-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, PageHeaderComponent],
  styleUrl: '../../iam/shared/iam-page.scss',
  template: `
    <div class="page">
      <app-page-header
        title="Fleet health"
        subtitle="Every organisation's EA terminals and kill switches. Read-only; each view is recorded in the audit log."
      >
        <select
          class="select"
          aria-label="Disconnected terminals seen in"
          [ngModel]="sinceHours()"
          (ngModelChange)="sinceHours.set(+$event); fleet.reload()"
        >
          @for (w of windows; track w.hours) {
            <option [ngValue]="w.hours">{{ w.label }}</option>
          }
        </select>
        <button
          type="button"
          class="btn btn-secondary"
          (click)="fleet.reload()"
          [disabled]="fleet.loading()"
        >
          {{ fleet.loading() ? 'Loading…' : 'Refresh' }}
        </button>
      </app-page-header>

      @if (fleet.error(); as err) {
        <section class="card">
          <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
        </section>
      }

      @if (fleet.value(); as f) {
        @if (f.globalKillSwitchEngaged) {
          <p class="note warn" role="status">
            The platform kill switch is engaged: no organisation is trading.
          </p>
        }

        <section class="card">
          <header class="card-head">
            <h3>Organisations</h3>
            <span class="spacer"></span>
            <span class="muted small"
              >Stale = connected but no heartbeat for over {{ f.heartbeatTimeoutSeconds }} s · as of
              {{ when(f.generatedAtUtc) }}</span
            >
          </header>
          <div class="table-wrap">
            <table class="grid">
              <thead>
                <tr>
                  <th>Organisation</th>
                  <th>Terminals</th>
                  <th>Healthy</th>
                  <th>Stale</th>
                  <th>Disconnected</th>
                  <th>Kill switches engaged</th>
                </tr>
              </thead>
              <tbody>
                @for (o of organisations(); track o.tenantId) {
                  <tr [class.selected]="tenantFilter() === o.tenantId">
                    <td>
                      <button type="button" class="btn btn-sm btn-secondary" (click)="toggleTenant(o.tenantId)">
                        {{ o.name }}
                      </button>
                      @if (o.needsAttention) {
                        <span class="chip warn">Needs attention</span>
                      }
                      @if (o.status !== 'Active') {
                        <span class="chip bad">{{ o.status }}</span>
                      }
                      <span class="sub"><code>{{ o.slug }}</code> · {{ o.kind }}</span>
                    </td>
                    <td class="small">{{ o.instances }}</td>
                    <td class="small">{{ o.healthy }}</td>
                    <td class="small">
                      @if (o.stale > 0) {
                        <span class="chip warn">{{ o.stale }}</span>
                      } @else {
                        0
                      }
                    </td>
                    <td class="small">{{ o.disconnected }}</td>
                    <td class="small">
                      @for (k of o.killSwitches; track $index) {
                        <span class="sub"
                          ><span class="chip bad">{{
                            k.scope === 'Account' ? 'Account #' + k.tradingAccountId : 'Organisation'
                          }}</span>
                          {{ k.reason }} — {{ k.changedBy ?? 'unknown' }}, {{ when(k.changedAtUtc) }}</span
                        >
                      } @empty {
                        <span class="muted">None</span>
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </section>

        <section class="card">
          <header class="card-head">
            <h3>Terminals</h3>
            <select
              class="select"
              aria-label="Show"
              [ngModel]="filter()"
              (ngModelChange)="filter.set($event)"
            >
              <option value="all">All</option>
              <option value="attention">Stale or not RUNNING</option>
              <option value="stale">Stale</option>
              <option value="disconnected">Disconnected</option>
            </select>
            <input
              class="input search"
              type="search"
              placeholder="Instance, organisation, login, version"
              aria-label="Search terminals"
              [ngModel]="search()"
              (ngModelChange)="search.set($event)"
            />
            @if (tenantFilter() !== null) {
              <button type="button" class="btn btn-sm btn-secondary" (click)="tenantFilter.set(null)">
                All organisations
              </button>
            }
            <span class="spacer"></span>
            <span class="muted small">{{ rows().length }} of {{ f.instances.length }}</span>
          </header>
          @if (rows().length === 0) {
            <p class="pad muted">No terminals match.</p>
          } @else {
            <div class="table-wrap">
              <table class="grid">
                <thead>
                  <tr>
                    <th>Organisation</th>
                    <th>Terminal</th>
                    <th>Account</th>
                    <th>Health</th>
                    <th>EA state</th>
                    <th>Version</th>
                    <th>Last heartbeat</th>
                    <th>Signs in with</th>
                  </tr>
                </thead>
                <tbody>
                  @for (i of rows(); track i.id) {
                    <tr>
                      <td class="small"><code>{{ i.tenantSlug }}</code></td>
                      <td class="small"><code>{{ i.instanceId }}</code></td>
                      <td class="small">
                        {{ i.accountLogin ?? '#' + i.tradingAccountId }}
                        @if (i.brokerServer) {
                          <span class="sub">{{ i.brokerServer }}</span>
                        }
                      </td>
                      <td>
                        <span
                          class="chip"
                          [class.ok]="i.health === 'Healthy'"
                          [class.warn]="i.health === 'Stale'"
                          [class.bad]="i.health === 'Disconnected'"
                          >{{ i.health }}</span
                        >
                      </td>
                      <td class="small">
                        {{ i.stateMachine ?? '—' }}
                        @if (i.eaKillSwitchActive) {
                          <span class="chip bad">EA kill switch</span>
                        }
                      </td>
                      <td class="small">{{ i.eaVersion || '—' }}</td>
                      <td class="small">
                        {{ age(i.heartbeatAgeSeconds) }} ago
                        <span class="sub">{{ when(i.lastHeartbeatUtc) }}</span>
                      </td>
                      <td class="small">
                        <span class="chip" [class.warn]="i.credentialOrigin === 'LegacyApiKey'">{{
                          credential(i.credentialOrigin)
                        }}</span>
                        @if (i.credentialLastUsedUtc) {
                          <span class="sub">used {{ when(i.credentialLastUsedUtc) }}</span>
                        }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </section>
      } @else if (!fleet.error()) {
        <section class="card"><p class="pad muted">Loading…</p></section>
      }
    </div>
  `,
})
export class FleetPageComponent {
  private readonly api = inject(PlansApiService);

  protected readonly windows = WINDOWS;
  protected readonly when = when;
  protected readonly age = ageText;
  protected readonly credential = credentialLabel;

  readonly sinceHours = signal<number>(168);
  readonly filter = signal<FleetFilter>('all');
  readonly search = signal('');
  readonly tenantFilter = signal<number | null>(null);

  readonly fleet = iamResource<FleetHealth | null>(
    () => this.api.fleet(this.sinceHours()),
    null,
    'Could not load fleet health.',
  );

  readonly organisations = computed(() => attentionFirst(this.fleet.value()?.organisations ?? []));
  readonly rows = computed(() =>
    fleetRows(this.fleet.value()?.instances ?? [], this.filter(), this.tenantFilter(), this.search()),
  );

  constructor() {
    this.fleet.reload();
  }

  toggleTenant(tenantId: number): void {
    this.tenantFilter.set(this.tenantFilter() === tenantId ? null : tenantId);
  }
}
