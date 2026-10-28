import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { map, of } from 'rxjs';

import { AuthService } from '@core/auth/auth.service';
import { Permission } from '@core/auth/permissions.generated';
import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import { EAInstancesService } from '@core/services/ea-instances.service';
import { when } from '@features/iam/iam.logic';
import { ago, auditActorLabel, bytes, plural } from '@features/iam/shared/admin-context.logic';
import { AuditTrailComponent } from '@features/iam/shared/audit-trail.component';
import { iamResource } from '@features/iam/shared/iam-resource';
import { StatTilesComponent, type StatTile } from '@features/iam/shared/stat-tiles.component';
import { OrganisationApiService } from '@features/organisation/organisation-api.service';
import type { TerminalSetup } from '@features/organisation/connect/terminal-wizard.types';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';

import { SecurityApiService } from '../security-api.service';
import { COMPONENT_LABELS, filterReleases, shortHash, terminalsByVersion } from '../security.logic';
import type {
  EaReleaseInfo,
  ReleaseComponent,
  ReleaseNote,
  RoleBuildSkew,
} from '../security.types';

/**
 * `/releases` — what is published and running, and what changed in each release (`releases.read`).
 * Real sources, each shown only to someone allowed to read it: the EA builds the rollout published to the engine
 * (`platform/ea/releases`, staff; members see the latest through `onboarding/terminal-setup`), which build each
 * connected terminal runs (`ea/instances`), the engine processes' build (`admin/observability/build-skew`), this
 * console's own build (runtime config) — then the written release notes (engine `tools/release-notes/`).
 */
@Component({
  selector: 'app-release-notes-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, RouterLink, PageHeaderComponent, StatTilesComponent, AuditTrailComponent],
  styleUrl: '../../iam/shared/iam-page.scss',
  styles: [
    `
      .cols {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(380px, 1fr));
        gap: var(--space-3);
        align-items: start;
      }
      @media (max-width: 860px) {
        .cols {
          grid-template-columns: 1fr;
        }
      }
      .bar {
        display: inline-block;
        height: 8px;
        border-radius: 4px;
        background: var(--accent);
        vertical-align: middle;
        margin-right: var(--space-2);
      }
      .bar.warn {
        background: var(--warning);
      }
    `,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Releases"
        subtitle="Which builds are published and running on this platform, and what changed in each release."
      >
        <button type="button" class="btn btn-secondary" (click)="reloadAll()" [disabled]="busy()">
          {{ busy() ? 'Loading…' : 'Refresh' }}
        </button>
      </app-page-header>

      <app-stat-tiles [tiles]="tiles()" label="Release summary" />

      <div class="cols">
        <section class="card">
          <header class="card-head">
            <h3>Expert Advisor builds</h3>
            <span class="spacer"></span>
            <span class="small muted">published by each rollout after its checksum check</span>
          </header>
          @if (eaRows().length === 0) {
            <p class="pad small muted">
              @if (setup.error() || eaList.error()) {
                <span class="chip bad">Could not load</span> {{ setup.error() || eaList.error() }}
              } @else if (setup.loaded() || eaList.loaded()) {
                No EA build is published to the engine yet. The EA repository's
                <code>make rollout</code> publishes the verified <code>.ex5</code> after it checks
                the file on every host; until then the connection wizard has nothing to offer.
              } @else {
                Loading…
              }
            </p>
          } @else {
            <div class="table-wrap">
              <table class="grid">
                <thead>
                  <tr>
                    <th>Version</th>
                    <th>Published</th>
                    <th>Size</th>
                    <th>SHA-256</th>
                  </tr>
                </thead>
                <tbody>
                  @for (r of eaRows(); track r.id) {
                    <tr>
                      <td>
                        <strong>{{ r.version }}</strong>
                        @if (r.version === latestEa()?.version) {
                          <span class="chip ok">latest</span>
                        }
                        <span class="sub">{{ r.notes || '—' }}</span>
                      </td>
                      <td class="small" [title]="when(r.publishedAtUtc)">
                        {{ ago(r.publishedAtUtc) }}
                        <span class="sub"
                          >by {{ actor(r.publishedBy)
                          }}{{ r.builtAtUtc ? ' · compiled ' + when(r.builtAtUtc) : '' }}</span
                        >
                      </td>
                      <td class="small">{{ size(r.sizeBytes) }}</td>
                      <td class="small">
                        <code [title]="r.sha256">{{ hash(r.sha256) }}</code>
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
            @if (!canListEa()) {
              <p class="pad small muted">
                The engine keeps older builds too; listing them needs platform staff access.
              </p>
            }
          }
          @if (setup.value(); as s) {
            <p class="pad small muted">
              Terminals older than <strong>{{ s.eaMinimumVersion || 'no minimum' }}</strong> are
              flagged by the connection wizard (<code>Onboarding:EaMinimumVersion</code>, never
              raised automatically).
              <a routerLink="/organisation/terminals/connect">Connect a terminal</a>
            </p>
          }
        </section>

        <section class="card">
          <header class="card-head">
            <h3>Connected terminals by EA version</h3>
            <span class="spacer"></span>
            @if (canSeeInstances()) {
              <a class="small" routerLink="/ea-instances">EA instances</a>
            }
          </header>
          @if (!canSeeInstances()) {
            <p class="pad small muted">Seeing every terminal's version needs operator access.</p>
          } @else if (instances.error(); as err) {
            <p class="pad small" role="alert">
              <span class="chip bad">Could not load</span> {{ err }}
            </p>
          } @else if (instances.loaded() && byVersion().length === 0) {
            <p class="pad small muted">
              No terminal is connected right now, so no EA version is running. Each connected
              terminal reports its version with every heartbeat.
            </p>
          } @else {
            <div class="table-wrap">
              <table class="grid">
                <thead>
                  <tr>
                    <th>EA version</th>
                    <th>Terminals</th>
                    <th>State</th>
                  </tr>
                </thead>
                <tbody>
                  @for (v of byVersion(); track v.version) {
                    <tr>
                      <td>
                        <strong>{{ v.version }}</strong>
                      </td>
                      <td class="small">
                        <span
                          class="bar"
                          [class.warn]="!v.isLatest"
                          [style.width.px]="barWidth(v.terminals)"
                        ></span>
                        {{ v.terminals }}
                      </td>
                      <td>
                        @if (v.isLatest) {
                          <span class="chip ok">latest build</span>
                        } @else if (v.belowMinimum) {
                          <span class="chip bad">below the minimum</span>
                        } @else {
                          <span class="chip warn">older build</span>
                        }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }

          <header class="card-head">
            <h3>Engine and console</h3>
          </header>
          <div class="table-wrap">
            <table class="grid">
              <thead>
                <tr>
                  <th>Part</th>
                  <th>Build</th>
                  <th>Running since</th>
                </tr>
              </thead>
              <tbody>
                @for (r of engine.value()?.roles ?? []; track r.role) {
                  <tr>
                    <td>
                      Engine · {{ roleLabel(r.role) }}
                      <span class="sub">{{ r.hostName || '—' }}</span>
                    </td>
                    <td class="small">
                      <code [title]="r.buildId">{{ r.buildId.slice(0, 8) }}</code>
                      <span class="sub">compiled {{ when(r.buildTimeUtc) }}</span>
                    </td>
                    <td class="small" [title]="when(r.startedAtUtc)">
                      {{ ago(r.startedAtUtc) }}
                      <span class="sub">last seen {{ ago(r.lastSeenAtUtc) }}</span>
                    </td>
                  </tr>
                }
                <tr>
                  <td>Console (this page)</td>
                  <td class="small">
                    <code>{{ consoleSha() || 'development build' }}</code>
                    @if (cfg.releaseId) {
                      <span class="sub">release {{ cfg.releaseId }}</span>
                    }
                  </td>
                  <td class="small">
                    {{ cfg.buildTime ? 'built ' + ago(cfg.buildTime) : '—' }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          @if (engine.error() && canSeeInstances()) {
            <p class="pad small muted">
              The engine's build list could not be read: {{ engine.error() }}
            </p>
          } @else if (engine.value(); as e) {
            <p class="pad small" [class.muted]="!e.hasSkew">
              @if (e.hasSkew) {
                <span class="chip warn">mixed builds</span> The engine's processes run
                {{ e.distinctBuilds }} different builds — one was recreated without the others.
              } @else {
                All {{ e.roles.length }} engine processes run one build, as they must.
              }
            </p>
          }
        </section>
      </div>

      <section class="card">
        <header class="card-head">
          <h3>Release notes</h3>
          <span class="spacer"></span>
          <label class="row small">
            <span class="label">Component</span>
            <select
              class="select"
              name="component"
              [ngModel]="component()"
              (ngModelChange)="component.set($event)"
            >
              <option [ngValue]="null">All</option>
              @for (c of components; track c) {
                <option [ngValue]="c">{{ labels[c] }}</option>
              }
            </select>
          </label>
        </header>
        @if (notes.error(); as err) {
          <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
        } @else if (notes.loaded() && notes.value().length === 0) {
          <div class="card-body">
            <p class="small">
              No written release notes are published yet — the builds above are what is live. A
              release note lists each change of a release by kind (features, fixes, security fixes,
              breaking changes) from its commits.
            </p>
            <p class="note">
              Platform staff publish them with the engine's
              <code>tools/release-notes/generate.py</code> (reads the commits between two tags) and
              <code>publish.sh</code> (<code>POST /platform/release-notes</code>, permission
              <code>platform.releases.manage</code
              >{{ canPublishNotes() ? ', which you hold' : '' }}). Publishing the same component and
              version again replaces it.
            </p>
          </div>
        } @else if (notes.loaded() && shown().length === 0) {
          <p class="pad small muted">No release notes for {{ labels[component()!] }} yet.</p>
        }
        @for (n of shown(); track n.id) {
          <div class="card-body">
            <div class="row">
              <strong>{{ labels[n.component] }} {{ n.version }}</strong>
              @if (n.hasSecurityFixes) {
                <span class="chip bad">security</span>
              }
              @if (n.hasBreakingChanges) {
                <span class="chip warn">breaking changes</span>
              }
              <span class="small muted">· {{ when(n.releasedAtUtc) }}</span>
            </div>
            <p class="small">
              {{ n.summary }}
              <span class="muted"
                >· {{ n.commitCount }} commit{{ n.commitCount === 1 ? '' : 's' }} ·
                <code>{{ n.fromRef || 'start' }}..{{ n.toRef }}</code></span
              >
            </p>
            @for (s of n.sections; track s.kind) {
              <h4 class="small">{{ s.title }}</h4>
              <ul class="small">
                @for (i of s.items; track $index) {
                  <li>
                    @if (i.scope) {
                      <strong>{{ i.scope }}:</strong>
                    }
                    {{ i.subject }}
                    @if (i.breaking) {
                      <span class="chip warn">breaking</span>
                    }
                    @if (i.sha) {
                      <code class="muted">{{ i.sha }}</code>
                    }
                  </li>
                }
              </ul>
            }
          </div>
        }
      </section>

      <app-audit-trail
        heading="Publishing and downloads"
        [actions]="['platform.ea_release.', 'onboarding.ea.', 'platform.release_notes.']"
        empty="No build has been published or downloaded yet. Each EA publish, each refused publish and each EA download is recorded here."
      />
    </div>
  `,
})
export class ReleaseNotesPageComponent {
  private readonly api = inject(SecurityApiService);
  private readonly org = inject(OrganisationApiService);
  private readonly eaApi = inject(EAInstancesService);
  private readonly auth = inject(AuthService);
  protected readonly cfg = inject(RUNTIME_CONFIG);

  protected readonly when = when;
  protected readonly ago = (utc: string | null) => ago(utc);
  protected readonly hash = shortHash;
  protected readonly size = bytes;
  protected readonly actor = (id: string) => auditActorLabel({ actorId: id, actorDisplay: null });
  protected readonly labels = COMPONENT_LABELS;
  protected readonly components = Object.keys(COMPONENT_LABELS) as ReleaseComponent[];

  readonly canListEa = computed(() => this.auth.hasPermission(Permission.PlatformEaReleasesManage));
  readonly canSeeInstances = computed(() => this.auth.hasPermission(Permission.AccessOperator));
  readonly canReadSetup = computed(() => this.auth.hasPermission(Permission.AccountsRead));
  readonly canPublishNotes = computed(() =>
    this.auth.hasPermission(Permission.PlatformReleasesManage),
  );

  readonly component = signal<ReleaseComponent | null>(null);
  readonly notes = iamResource<ReleaseNote[]>(
    () => this.api.releaseNotes(null, 100),
    [],
    'Could not load the release notes.',
  );
  readonly eaList = iamResource<EaReleaseInfo[]>(
    () => (this.canListEa() ? this.api.eaReleases() : of([])),
    [],
    'Could not load the EA builds.',
  );
  readonly setup = iamResource<TerminalSetup | null>(
    () => (this.canReadSetup() ? this.org.terminalSetup() : of(null)),
    null,
    'Could not load the published EA build.',
  );
  readonly instances = iamResource<{ eaVersion: string; status: string }[]>(
    () => (this.canSeeInstances() ? this.eaApi.list().pipe(map((r) => r?.data ?? [])) : of([])),
    [],
    'Could not load the connected terminals.',
  );
  readonly engine = iamResource<RoleBuildSkew | null>(
    () => (this.canSeeInstances() ? this.api.engineBuilds() : of(null)),
    null,
    'Could not load the engine builds.',
  );

  readonly busy = computed(
    () =>
      this.notes.loading() ||
      this.eaList.loading() ||
      this.setup.loading() ||
      this.instances.loading() ||
      this.engine.loading(),
  );
  readonly shown = computed(() => filterReleases(this.notes.value(), this.component()));
  readonly latestEa = computed<EaReleaseInfo | null>(
    () => this.eaList.value().at(0) ?? this.setup.value()?.latestEa ?? null,
  );
  /** Staff see every kept build; others the latest one the wizard offers. */
  readonly eaRows = computed<EaReleaseInfo[]>(() => {
    const all = this.eaList.value();
    if (all.length) return all;
    const latest = this.setup.value()?.latestEa;
    return latest ? [latest] : [];
  });
  readonly byVersion = computed(() =>
    terminalsByVersion(
      this.instances.value(),
      this.latestEa()?.version ?? null,
      this.setup.value()?.eaMinimumVersion ?? null,
    ),
  );
  readonly consoleSha = computed(() => (this.cfg.buildSha ?? '').slice(0, 7));

  readonly tiles = computed<StatTile[]>(() => {
    const latest = this.latestEa();
    const versions = this.byVersion();
    const total = versions.reduce((n, v) => n + v.terminals, 0);
    const onLatest = versions.find((v) => v.isLatest)?.terminals ?? 0;
    const below = versions.filter((v) => v.belowMinimum).reduce((n, v) => n + v.terminals, 0);
    const engine = this.engine.value();
    const newestEngine = engine?.roles
      .map((r) => r.buildTimeUtc)
      .filter((t): t is string => !!t)
      .sort()
      .at(-1);
    const notes = this.notes.value();
    const tiles: StatTile[] = [
      {
        label: 'Latest EA build',
        value: latest?.version ?? (this.setup.loaded() || this.eaList.loaded() ? 'None' : '…'),
        caption: latest
          ? `published ${ago(latest.publishedAtUtc)}${latest.notes ? ' · ' + latest.notes : ''}`
          : 'nothing published to the engine yet',
        tone: latest ? 'good' : 'warn',
      },
    ];
    if (this.canSeeInstances()) {
      tiles.push({
        label: 'Terminals on the latest build',
        value: this.instances.loaded() ? `${onLatest} of ${total}` : '…',
        caption:
          total === 0
            ? 'no terminal connected'
            : below > 0
              ? `${plural(below, 'terminal')} below the minimum ${this.setup.value()?.eaMinimumVersion}`
              : onLatest === total
                ? 'every connected terminal is up to date'
                : `${total - onLatest} on an older build`,
        tone: total === 0 ? null : below > 0 ? 'bad' : onLatest === total ? 'good' : 'warn',
        route: '/ea-instances',
      });
    }
    if (this.canListEa()) {
      tiles.push({
        label: 'EA builds kept',
        value: String(this.eaList.value().length),
        caption: 'downloadable by members who connect terminals',
      });
    }
    if (engine) {
      tiles.push({
        label: 'Engine build',
        value: engine.hasSkew ? `${engine.distinctBuilds} builds` : '1 build',
        caption: `${plural(engine.roles.length, 'process', 'processes')}${newestEngine ? ' · compiled ' + ago(newestEngine) : ''}`,
        tone: engine.hasSkew ? 'warn' : 'good',
      });
    }
    tiles.push(
      {
        label: 'Console build',
        value: this.consoleSha() || 'dev',
        caption: this.cfg.buildTime
          ? `built ${ago(this.cfg.buildTime)}`
          : 'not a published release',
      },
      {
        label: 'Release notes',
        value: this.notes.loaded() ? String(notes.length) : '…',
        caption:
          notes.length === 0
            ? 'none written yet — see below'
            : `latest ${ago(notes[0]?.releasedAtUtc ?? null)}`,
      },
    );
    return tiles;
  });

  constructor() {
    this.reloadAll();
  }

  reloadAll(): void {
    this.notes.reload();
    this.eaList.reload();
    this.setup.reload();
    this.instances.reload();
    this.engine.reload();
  }

  roleLabel(role: string): string {
    const labels: Record<string, string> = {
      'money-path': 'trading',
      research: 'research and backtesting',
      llm: 'AI analysis',
    };
    return labels[role] ?? role;
  }

  barWidth(n: number): number {
    const max = Math.max(1, ...this.byVersion().map((v) => v.terminals));
    return Math.max(6, Math.round((n / max) * 120));
  }
}
