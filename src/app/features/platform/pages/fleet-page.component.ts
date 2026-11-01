import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { when } from '@features/iam/iam.logic';
import { ago } from '@features/iam/shared/admin-context.logic';
import { iamResource } from '@features/iam/shared/iam-resource';
import { PlansApiService } from '../plans-api.service';
import {
  ageText,
  attentionFirst,
  credentialLabel,
  fleetRows,
  type FleetFilter,
} from '../plans.logic';
import type { FleetHealth } from '../plans.types';

/** `ShuttingDown` → "Shutting down", `PendingApproval` → "Pending approval". */
function humanise(value: string | null | undefined): string {
  if (!value) return '—';
  const spaced = value.replace(/([a-z])([A-Z])/g, '$1 $2');
  return spaced.charAt(0) + spaced.slice(1).toLowerCase();
}

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
  styleUrls: ['../../iam/shared/iam-page.scss', './fleet-access-page.scss'],
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
          <p class="banner" role="status">
            <span class="dot bad">Kill switch</span>
            The platform kill switch is engaged: no organisation is trading.
          </p>
        }

        @let k = kpis();
        <ul class="kpis" aria-label="Fleet health summary">
          <li class="kpi" [class.tone-warn]="k.attention > 0">
            <span class="kpi-label">Organisations</span>
            <span class="kpi-value">{{ k.orgs }}</span>
            <span class="kpi-hint">{{
              k.attention > 0 ? k.attention + ' need attention' : 'none need attention'
            }}</span>
          </li>
          <li class="kpi tone-info">
            <span class="kpi-label">Terminals</span>
            <span class="kpi-value">{{ k.terminals }}</span>
            <span class="kpi-hint" [title]="windowLabel()">{{
              k.legacy > 0 ? k.legacy + ' on the legacy API key' : 'no legacy API keys'
            }}</span>
          </li>
          <li class="kpi" [class.tone-good]="k.terminals > 0 && k.healthy === k.terminals">
            <span class="kpi-label">Healthy</span>
            <span class="kpi-value">{{ k.healthy }}</span>
            <span class="kpi-hint">{{ pct(k.healthy, k.terminals) }} of terminals</span>
          </li>
          <li class="kpi" [class.tone-warn]="k.stale > 0">
            <span class="kpi-label">Stale</span>
            <span class="kpi-value">{{ k.stale }}</span>
            <span class="kpi-hint">no heartbeat for over {{ f.heartbeatTimeoutSeconds }} s</span>
          </li>
          <li class="kpi" [class.tone-bad]="k.disconnected > 0">
            <span class="kpi-label">Disconnected</span>
            <span class="kpi-value">{{ k.disconnected }}</span>
            <span class="kpi-hint">seen in the {{ windowLabel().toLowerCase() }}</span>
          </li>
          <li class="kpi" [class.tone-bad]="k.killSwitches > 0 || f.globalKillSwitchEngaged">
            <span class="kpi-label">Kill switches</span>
            <span class="kpi-value">{{ k.killSwitches }}</span>
            <span class="kpi-hint">{{
              f.globalKillSwitchEngaged
                ? 'platform switch engaged too'
                : k.killSwitches > 0
                  ? 'engaged in organisations'
                  : 'none engaged'
            }}</span>
          </li>
        </ul>

        <section class="card">
          <header class="card-head">
            <h3>Organisations</h3>
            <span class="count">{{ organisations().length }}</span>
            <span class="spacer"></span>
            <span class="hint" [title]="when(f.generatedAtUtc)"
              >Stale = connected but no heartbeat for over {{ f.heartbeatTimeoutSeconds }} s · as of
              {{ rel(f.generatedAtUtc) }} · choose a name to show only its terminals</span
            >
          </header>
          @if (organisations().length === 0) {
            <p class="empty">
              <strong>No organisations reported</strong>
              Each organisation with an EA terminal (or an engaged kill switch) appears here.
            </p>
          } @else {
            <div class="table-wrap">
              <table class="grid">
                <thead>
                  <tr>
                    <th>Organisation</th>
                    <th>Health mix</th>
                    <th class="num">Terminals</th>
                    <th class="num">Healthy</th>
                    <th class="num">Stale</th>
                    <th class="num">Disconnected</th>
                    <th>Kill switches engaged</th>
                  </tr>
                </thead>
                <tbody>
                  @for (o of organisations(); track o.tenantId) {
                    <tr [class.selected]="tenantFilter() === o.tenantId">
                      <td>
                        <button
                          type="button"
                          class="org-btn"
                          [attr.aria-pressed]="tenantFilter() === o.tenantId"
                          [title]="orgTitle(o.tenantId, o.name)"
                          (click)="toggleTenant(o.tenantId)"
                        >
                          {{ o.name }}
                        </button>
                        <span class="inline-chips">
                          @if (o.needsAttention) {
                            <span class="chip warn">Needs attention</span>
                          }
                          @if (o.status !== 'Active') {
                            <span class="chip bad">{{ human(o.status) }}</span>
                          }
                        </span>
                        <span class="sub"
                          ><code>{{ o.slug }}</code> · {{ human(o.kind) }}</span
                        >
                      </td>
                      <td>
                        <span
                          class="mix"
                          role="img"
                          [attr.aria-label]="
                            o.healthy +
                            ' healthy, ' +
                            o.stale +
                            ' stale, ' +
                            o.disconnected +
                            ' disconnected'
                          "
                          [title]="
                            o.healthy +
                            ' healthy · ' +
                            o.stale +
                            ' stale · ' +
                            o.disconnected +
                            ' disconnected'
                          "
                        >
                          <i class="m-ok" [style.width.%]="share(o.healthy, o.instances)"></i>
                          <i class="m-warn" [style.width.%]="share(o.stale, o.instances)"></i>
                          <i class="m-bad" [style.width.%]="share(o.disconnected, o.instances)"></i>
                        </span>
                      </td>
                      <td class="num strong">{{ o.instances }}</td>
                      <td class="num">{{ o.healthy }}</td>
                      <td class="num">
                        @if (o.stale > 0) {
                          <span class="chip warn">{{ o.stale }}</span>
                        } @else {
                          <span class="dim">0</span>
                        }
                      </td>
                      <td class="num" [class.dim]="o.disconnected === 0">{{ o.disconnected }}</td>
                      <td class="small">
                        @for (ks of o.killSwitches; track $index) {
                          <span class="sub"
                            ><span class="chip bad">{{
                              ks.scope === 'Account'
                                ? 'Account #' + ks.tradingAccountId
                                : 'Organisation'
                            }}</span>
                            {{ ks.reason }} — {{ ks.changedBy ?? 'unknown' }},
                            <span [title]="when(ks.changedAtUtc)">{{
                              rel(ks.changedAtUtc)
                            }}</span></span
                          >
                        } @empty {
                          <span class="dim">None</span>
                        }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </section>

        <section class="card">
          <header class="card-head">
            <h3>Terminals</h3>
            <span class="count">{{ rows().length }} of {{ f.instances.length }}</span>
            <span class="spacer"></span>
            <span class="hint">Stale first, then by organisation</span>
          </header>
          <div class="toolbar">
            <div class="seg" role="group" aria-label="Show">
              @for (o of filterOptions; track o.value) {
                <button
                  type="button"
                  [class.on]="filter() === o.value"
                  [attr.aria-pressed]="filter() === o.value"
                  (click)="filter.set(o.value)"
                >
                  {{ o.label }}<span class="n">{{ filterCount(o.value) }}</span>
                </button>
              }
            </div>
            <label class="search-box">
              <input
                class="input"
                type="search"
                placeholder="Instance, organisation, login, version"
                aria-label="Search terminals"
                [ngModel]="search()"
                (ngModelChange)="search.set($event)"
              />
            </label>
            @if (tenantFilter() !== null) {
              <span class="scope-pill">
                {{ tenantName() }}
                <button type="button" class="btn btn-sm btn-ghost" (click)="tenantFilter.set(null)">
                  All organisations
                </button>
              </span>
            }
          </div>
          @if (rows().length === 0) {
            <p class="empty">
              <strong>No terminals match</strong>
              {{
                f.instances.length === 0
                  ? 'No EA terminal has connected in the ' + windowLabel().toLowerCase() + '.'
                  : 'Try another filter, clear the search, or show all organisations.'
              }}
            </p>
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
                    <th class="num">Last heartbeat</th>
                    <th>Signs in with</th>
                  </tr>
                </thead>
                <tbody>
                  @for (i of rows(); track i.id) {
                    <tr
                      [class.is-past]="i.health === 'Disconnected' || i.health === 'ShuttingDown'"
                    >
                      <td class="small">
                        <code>{{ i.tenantSlug }}</code>
                      </td>
                      <td>
                        <span class="ident" [title]="i.instanceId">{{ i.instanceId }}</span>
                      </td>
                      <td class="small">
                        <span class="mono">{{ i.accountLogin ?? '#' + i.tradingAccountId }}</span>
                        @if (i.brokerServer) {
                          <span class="sub">{{ i.brokerServer }}</span>
                        }
                      </td>
                      <td>
                        <span
                          class="dot"
                          [class.ok]="i.health === 'Healthy'"
                          [class.warn]="i.health === 'Stale'"
                          [class.bad]="i.health === 'Disconnected'"
                          >{{ human(i.health) }}</span
                        >
                      </td>
                      <td class="small">
                        @if (i.stateMachine) {
                          <span
                            class="chip"
                            [class.ok]="i.stateMachine === 'RUNNING'"
                            [class.warn]="i.stateMachine !== 'RUNNING'"
                            >{{ i.stateMachine }}</span
                          >
                        } @else {
                          <span class="dim">—</span>
                        }
                        @if (i.eaKillSwitchActive) {
                          <span class="chip bad">EA kill switch</span>
                        }
                      </td>
                      <td class="small">
                        <span class="mono">{{ i.eaVersion || '—' }}</span>
                      </td>
                      <td class="num small" [title]="when(i.lastHeartbeatUtc)">
                        {{ age(i.heartbeatAgeSeconds) }} ago
                        <span class="when-sub">{{ when(i.lastHeartbeatUtc) }}</span>
                      </td>
                      <td class="small">
                        <span
                          class="chip wrap"
                          [class.warn]="i.credentialOrigin === 'LegacyApiKey'"
                          >{{ credential(i.credentialOrigin) }}</span
                        >
                        @if (i.credentialLastUsedUtc) {
                          <span class="sub" [title]="when(i.credentialLastUsedUtc)"
                            >used {{ rel(i.credentialLastUsedUtc) }}</span
                          >
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
        <section class="card"><p class="empty">Loading fleet health…</p></section>
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
  protected readonly rel = ago;
  protected readonly human = humanise;
  protected readonly filterOptions: readonly { value: FleetFilter; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'attention', label: 'Stale or not RUNNING' },
    { value: 'stale', label: 'Stale' },
    { value: 'disconnected', label: 'Disconnected' },
  ];

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
    fleetRows(
      this.fleet.value()?.instances ?? [],
      this.filter(),
      this.tenantFilter(),
      this.search(),
    ),
  );

  /** The summary strip, from the same response the tables show. */
  readonly kpis = computed(() => {
    const f = this.fleet.value();
    const orgs = f?.organisations ?? [];
    const inst = f?.instances ?? [];
    return {
      orgs: orgs.length,
      attention: orgs.filter((o) => o.needsAttention).length,
      terminals: inst.length,
      healthy: inst.filter((i) => i.health === 'Healthy').length,
      stale: inst.filter((i) => i.health === 'Stale').length,
      disconnected: inst.filter((i) => i.health === 'Disconnected' || i.health === 'ShuttingDown')
        .length,
      legacy: inst.filter((i) => i.credentialOrigin === 'LegacyApiKey').length,
      killSwitches: orgs.reduce((n, o) => n + o.killSwitches.length, 0),
    };
  });

  readonly tenantName = computed(() => {
    const id = this.tenantFilter();
    return this.fleet.value()?.organisations.find((o) => o.tenantId === id)?.name ?? `#${id}`;
  });

  constructor() {
    this.fleet.reload();
  }

  windowLabel(): string {
    return WINDOWS.find((w) => w.hours === this.sinceHours())?.label ?? 'Chosen window';
  }

  /** How many terminals each filter pill would show, given the organisation and search. */
  filterCount(filter: FleetFilter): number {
    return fleetRows(
      this.fleet.value()?.instances ?? [],
      filter,
      this.tenantFilter(),
      this.search(),
    ).length;
  }

  orgTitle(tenantId: number, name: string): string {
    return this.tenantFilter() === tenantId
      ? "Show every organisation's terminals"
      : `Show only ${name}'s terminals`;
  }

  share(part: number, whole: number): number {
    return whole > 0 ? (part / whole) * 100 : 0;
  }

  pct(part: number, whole: number): string {
    return whole > 0 ? `${Math.round((part / whole) * 100)}%` : '—';
  }

  toggleTenant(tenantId: number): void {
    this.tenantFilter.set(this.tenantFilter() === tenantId ? null : tenantId);
  }
}
