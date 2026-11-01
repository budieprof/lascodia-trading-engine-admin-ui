import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { switchMap } from 'rxjs';

import { AuthService } from '@core/auth/auth.service';
import { Permission } from '@core/auth/permissions.generated';
import { ConfigService, isQueuedForCoolingOff } from '@core/services/config.service';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import {
  FeatureStateComponent,
  type FeatureRequirement,
} from '@shared/components/feedback/feature-state.component';

import { StatTilesComponent, type StatTile } from '../../iam/shared/stat-tiles.component';
import { SecurityPostureApiService } from './security-posture-api.service';
import {
  budgetError,
  budgetWarning,
  checkHeaders,
  findingCounts,
  rejectShare,
  sortFindings,
} from './security-posture.logic';
import type { HeaderCheck, RateLimitKeyPosture, SecurityPosture } from './security-posture.types';

/**
 * Organisation → Security, platform part (gaps program security, gap #8): request budgets with live counts and typed
 * controls (saved through PUT /config — audit + four-eyes), the heartbeat / health exemptions (read-only), the console
 * origin's security headers checked live, the endpoint audit of the running engine, the database login's RLS posture
 * (banner when it bypasses RLS), the findings register and the external-pentest readiness checklist. Platform staff
 * holding `platform.security.evidence`; saving a budget needs `platform.engine.manage`.
 */
@Component({
  selector: 'app-security-posture-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, ConfirmDialogComponent, FeatureStateComponent, StatTilesComponent],
  styleUrl: '../../iam/shared/iam-page.scss',
  styles: [
    `
      .num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .budget {
        width: 9rem;
      }
      .route {
        font-family: var(--font-mono, monospace);
        font-size: 0.85em;
        word-break: break-all;
      }
      .sev-Critical,
      .sev-High {
        color: var(--color-danger, #d33);
        font-weight: 600;
      }
      .sev-Medium {
        color: var(--color-warning, #b80);
      }
    `,
  ],
  template: `
    <div class="page" aria-label="Platform security posture">
      @if (error(); as err) {
        <section class="card">
          <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
        </section>
      } @else if (posture(); as p) {
        @if (p.database.bypassesRls) {
          <section class="card" role="alert">
            <p class="pad">
              <span class="chip bad">Row-level security is not enforced</span>
              The engine's database login <code>{{ p.database.role }}</code>
              {{ p.database.superuser ? 'is a superuser' : 'has BYPASSRLS' }} — the database no
              longer backs up the tenant filter. {{ p.database.action }}
            </p>
          </section>
        }

        <app-stat-tiles [tiles]="tiles()" label="Security posture summary" />

        <section class="card">
          <header class="card-head">
            <h3>Request budgets (rate limits)</h3>
            <span class="spacer"></span>
            <span class="small muted"
              >Counts from the {{ p.rateLimits.process }} process since
              {{ p.rateLimits.countingSinceUtc.slice(0, 16).replace('T', ' ') }} UTC</span
            >
            <button
              type="button"
              class="btn btn-secondary"
              (click)="reload()"
              [disabled]="loading()"
            >
              {{ loading() ? 'Loading…' : 'Reload' }}
            </button>
          </header>
          <div class="table-wrap">
            <table class="grid">
              <thead>
                <tr>
                  <th>Policy</th>
                  <th>Budgeted</th>
                  <th>Applies to</th>
                  <th class="num">Endpoints</th>
                  <th class="num">Requests</th>
                  <th class="num">Refused (429)</th>
                </tr>
              </thead>
              <tbody>
                @for (pol of p.rateLimits.policies; track pol.name) {
                  <tr>
                    <td>
                      <code>{{ pol.name }}</code>
                    </td>
                    <td class="small">{{ pol.partition }}</td>
                    <td class="small">{{ pol.applies }}</td>
                    <td class="num">{{ pol.endpoints }}</td>
                    <td class="num">{{ pol.counted.toLocaleString('en-US') }}</td>
                    <td class="num">
                      {{ pol.rejected.toLocaleString('en-US') }} ({{ share(pol) }})
                    </td>
                  </tr>
                }
                @for (e of p.rateLimits.exemptions; track e.route + e.verb) {
                  <tr>
                    <td><span class="chip good">exempt</span></td>
                    <td class="small route">{{ e.verb }} {{ e.route }}</td>
                    <td class="small" colspan="4">{{ e.reason }} Never limited — not editable.</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          @if (p.rateLimits.settingsReadError; as readErr) {
            <p class="pad small" role="alert">
              <span class="chip warn">Budgets not re-read</span> {{ readErr }} — the engine keeps
              the last good values.
            </p>
          }
        </section>

        <section class="card">
          <header class="card-head">
            <h3>Budgets</h3>
            <span class="spacer"></span>
            <span class="small muted"
              >Requests per minute. Saved through the engine settings (audited; four-eyes when a
              policy exists).</span
            >
          </header>
          <div class="table-wrap">
            <table class="grid">
              <thead>
                <tr>
                  <th>Setting</th>
                  <th class="num">Now</th>
                  <th class="num">Default</th>
                  <th>Last change</th>
                  @if (canEdit()) {
                    <th>New value</th>
                  }
                </tr>
              </thead>
              <tbody>
                @for (k of p.rateLimits.keys; track k.key) {
                  <tr>
                    <td>
                      <code>{{ k.key }}</code>
                      <div class="small muted">{{ k.description }}</div>
                    </td>
                    <td class="num">{{ k.effective.toLocaleString('en-US') }}</td>
                    <td class="num">{{ k.default.toLocaleString('en-US') }}</td>
                    <td class="small">
                      @if (k.lastChangedAtUtc) {
                        {{ k.lastChangedAtUtc.slice(0, 16).replace('T', ' ') }}
                        {{ k.lastChangedBy ? '· ' + k.lastChangedBy : '' }}
                      } @else {
                        <span class="muted">never stored (default)</span>
                      }
                    </td>
                    @if (canEdit()) {
                      <td>
                        <input
                          class="input budget"
                          inputmode="numeric"
                          [attr.aria-label]="'New value for ' + k.key"
                          [ngModel]="draft(k)"
                          (ngModelChange)="setDraft(k, $event)"
                        />
                        @if (draftError(k); as de) {
                          <div class="small" role="alert">{{ de }}</div>
                        } @else if (draftWarning(k); as dw) {
                          <div class="small">{{ dw }}</div>
                        }
                        <button
                          type="button"
                          class="btn btn-secondary"
                          [disabled]="!dirty(k) || !!draftError(k) || busy()"
                          (click)="pending.set(k)"
                        >
                          Save
                        </button>
                      </td>
                    }
                  </tr>
                }
              </tbody>
            </table>
          </div>
          @if (saved(); as s) {
            <p class="pad small" role="status">{{ s }}</p>
          }
          @if (saveError(); as se) {
            <p class="pad small" role="alert"><span class="chip bad">Not saved</span> {{ se }}</p>
          }
        </section>

        <section class="card">
          <header class="card-head">
            <h3>Security headers of this console</h3>
            <span class="spacer"></span>
            <span class="small muted">Read live from this origin; the edge (Caddy) sets them.</span>
          </header>
          <div class="table-wrap">
            <table class="grid">
              <thead>
                <tr>
                  <th>Header</th>
                  <th>State</th>
                  <th>Policy</th>
                  <th>Sent</th>
                </tr>
              </thead>
              <tbody>
                @for (h of headerChecks(); track h.name) {
                  <tr>
                    <td>{{ h.name }}</td>
                    <td>
                      <span
                        class="chip"
                        [class.good]="h.status === 'ok'"
                        [class.warn]="h.status === 'weak' || h.status === 'na'"
                        [class.bad]="h.status === 'missing'"
                        >{{ statusLabel(h) }}</span
                      >
                      <div class="small muted">{{ h.note }}</div>
                    </td>
                    <td class="small">{{ h.expected }}</td>
                    <td class="small route">{{ h.actual ?? '—' }}</td>
                  </tr>
                } @empty {
                  <tr>
                    <td colspan="4" class="small muted">{{ headersNote() }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          <p class="pad small muted">
            The engine's own answers carry:
            @for (h of p.engineHeaders; track h.name) {
              <code>{{ h.name }}: {{ h.value }}</code
              >{{ $last ? '' : ' · ' }}
            }
          </p>
        </section>

        <section class="card">
          <header class="card-head">
            <h3>Endpoint audit</h3>
            <span class="spacer"></span>
            <span class="small muted"
              >Every route of the running engine, from the metadata it enforces.</span
            >
          </header>
          <div class="pad">
            <p>
              <span class="chip" [class.good]="undecided() === 0" [class.bad]="undecided() > 0">
                {{ undecided() }} route(s) lacking an explicit decision
              </span>
              {{ p.endpointAudit.endpoints }} endpoints · {{ p.endpointAudit.permission }} by
              permission · {{ p.endpointAudit.anonymous }} anonymous ·
              {{ p.endpointAudit.authenticatedOnly }} own-session ·
              {{ p.endpointAudit.signedInHub }} hub · {{ p.endpointAudit.exempt }} never limited
            </p>
            <p class="small muted">
              By policy:
              @for (e of policyCounts(); track e[0]) {
                <code>{{ e[0] }}</code> {{ e[1] }}{{ $last ? '' : ' · ' }}
              }
              — full table: engine <code>docs/security/endpoint-audit.md</code>.
            </p>
            @for (r of undecidedRoutes(); track r) {
              <div class="small route" role="alert">{{ r }}</div>
            }
          </div>
        </section>

        <section class="card">
          <header class="card-head">
            <h3>Findings register</h3>
            <span class="spacer"></span>
            <span class="small muted"
              >Internal review, 2026-11-01 (engine
              <code>docs/security/threat-model.md</code>).</span
            >
          </header>
          <div class="table-wrap">
            <table class="grid">
              <thead>
                <tr>
                  <th>Id</th>
                  <th>Severity</th>
                  <th>Status</th>
                  <th>Finding</th>
                  <th>Remedy</th>
                </tr>
              </thead>
              <tbody>
                @for (f of findings(); track f.id) {
                  <tr>
                    <td>{{ f.id }}</td>
                    <td [class]="'sev-' + f.severity">{{ f.severity }}</td>
                    <td>
                      <span
                        class="chip"
                        [class.good]="f.status === 'Fixed'"
                        [class.warn]="f.status === 'Operator'"
                        [class.bad]="f.status === 'Open'"
                        >{{ f.status }}</span
                      >
                    </td>
                    <td>
                      {{ f.title }}
                      <div class="small muted">{{ f.area }}</div>
                    </td>
                    <td class="small">{{ f.remedy }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </section>

        <app-feature-state
          title="External penetration test readiness"
          summary="What an external firm needs before testing: scope, an isolated environment, test organisations and accounts, rules of engagement. Testing itself is arranged by the operator."
          [kind]="pentestReady() ? 'on' : 'partial'"
          [stateLabel]="
            pentestReady() ? 'Ready' : pentestDone() + ' of ' + p.pentestReadiness.length + ' done'
          "
          [requirements]="pentestRequirements()"
          [links]="[{ label: 'Security evidence', route: '/platform/security-evidence' }]"
        />
      } @else {
        <section class="card"><p class="pad small muted">Loading the security posture…</p></section>
      }

      <app-confirm-dialog
        [open]="pending() !== null"
        title="Change this request budget?"
        [message]="confirmText()"
        confirmLabel="Save budget"
        [loading]="busy()"
        (confirm)="save()"
        (cancelled)="pending.set(null)"
      />
    </div>
  `,
})
export class SecurityPosturePanelComponent {
  private readonly api = inject(SecurityPostureApiService);
  private readonly configs = inject(ConfigService);
  private readonly auth = inject(AuthService);
  private readonly destroyRef = inject(DestroyRef);

  readonly posture = signal<SecurityPosture | null>(null);
  readonly error = signal<string | null>(null);
  readonly loading = signal(false);
  readonly headerChecks = signal<HeaderCheck[]>([]);
  readonly headersNote = signal('Checking…');
  readonly drafts = signal<Record<string, string>>({});
  readonly pending = signal<RateLimitKeyPosture | null>(null);
  readonly busy = signal(false);
  readonly saved = signal<string | null>(null);
  readonly saveError = signal<string | null>(null);

  readonly canEdit = computed(() => this.auth.hasPermission(Permission.PlatformEngineManage));

  readonly findings = computed(() => sortFindings(this.posture()?.findings ?? []));
  readonly undecidedRoutes = computed(() => {
    const a = this.posture()?.endpointAudit;
    return a
      ? [...a.lackingAuthDecision, ...a.lackingRateLimitDecision, ...a.unreviewedExemptions]
      : [];
  });
  readonly undecided = computed(() => this.undecidedRoutes().length);
  readonly policyCounts = computed(() =>
    Object.entries(this.posture()?.endpointAudit.byPolicy ?? {}).sort(([a], [b]) =>
      a.localeCompare(b),
    ),
  );
  readonly pentestDone = computed(
    () => (this.posture()?.pentestReadiness ?? []).filter((i) => i.status === 'Done').length,
  );
  readonly pentestReady = computed(
    () => this.pentestDone() === (this.posture()?.pentestReadiness.length ?? -1),
  );
  readonly pentestRequirements = computed<FeatureRequirement[]>(() =>
    (this.posture()?.pentestReadiness ?? []).map((i) => ({
      label: `${i.id} · ${i.title} (${i.owner})`,
      ok: i.status === 'Done',
      detail: i.detail,
    })),
  );

  readonly tiles = computed<StatTile[]>(() => {
    const p = this.posture();
    if (!p) return [];
    const counts = findingCounts(p.findings);
    const rejected = p.rateLimits.policies.reduce((s, x) => s + x.rejected, 0);
    const weakHeaders = this.headerChecks().filter(
      (h) => h.status === 'weak' || h.status === 'missing',
    ).length;
    return [
      {
        label: 'Routes without a decision',
        value: String(this.undecided()),
        caption: `${p.endpointAudit.endpoints} endpoints audited`,
        tone: this.undecided() === 0 ? 'good' : 'bad',
      },
      {
        label: 'Refused by rate limits',
        value: rejected.toLocaleString('en-US'),
        caption: 'since this process started',
        tone: rejected === 0 ? 'good' : 'warn',
      },
      {
        label: 'Database login',
        value: p.database.role ?? 'unknown',
        caption:
          p.database.bypassesRls === null
            ? (p.database.error ?? 'not checked')
            : p.database.bypassesRls
              ? 'bypasses row-level security'
              : `bound by RLS (${p.database.tablesWithRls ?? 0} tables)`,
        tone: p.database.bypassesRls === null ? 'warn' : p.database.bypassesRls ? 'bad' : 'good',
      },
      {
        label: 'Edge headers short of policy',
        value: String(weakHeaders),
        caption: 'HSTS, CSP, framing, sniffing, referrer',
        tone: weakHeaders === 0 ? 'good' : 'warn',
      },
      {
        label: 'Findings open / operator / fixed',
        value: `${counts.open} / ${counts.operator} / ${counts.fixed}`,
        caption: 'internal review register',
        tone: counts.open === 0 ? 'good' : 'warn',
      },
    ];
  });

  readonly confirmText = computed(() => {
    const k = this.pending();
    if (!k) return '';
    const v = this.draft(k).trim();
    const warn = this.draftWarning(k);
    return `${k.key}: ${k.effective.toLocaleString('en-US')} → ${Number(v).toLocaleString('en-US')} requests per minute. The engine applies it within 30 seconds; refused requests answer HTTP 429.${warn ? ' ' + warn : ''}`;
  });

  constructor() {
    this.reload();
    void this.checkHeaders();
  }

  reload(): void {
    this.loading.set(true);
    this.api
      .posture()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (p) => {
          this.posture.set(p);
          this.error.set(null);
          this.loading.set(false);
        },
        error: (e: unknown) => {
          this.error.set(
            (e as { message?: string })?.message ?? 'The security posture could not be read.',
          );
          this.loading.set(false);
        },
      });
  }

  private async checkHeaders(): Promise<void> {
    try {
      const res = await fetch('/', {
        method: 'HEAD',
        cache: 'no-store',
        credentials: 'same-origin',
      });
      this.headerChecks.set(
        checkHeaders((n) => res.headers.get(n), location.protocol === 'https:'),
      );
    } catch {
      this.headersNote.set('This origin could not be read (offline or blocked).');
    }
  }

  share(p: { counted: number; rejected: number }): string {
    return rejectShare(p);
  }

  statusLabel(h: HeaderCheck): string {
    return {
      ok: 'meets policy',
      weak: 'short of policy',
      missing: 'not sent',
      na: 'not checked here',
    }[h.status];
  }

  draft(k: RateLimitKeyPosture): string {
    return this.drafts()[k.key] ?? String(k.effective);
  }

  setDraft(k: RateLimitKeyPosture, value: string): void {
    this.drafts.update((d) => ({ ...d, [k.key]: value }));
    this.saved.set(null);
    this.saveError.set(null);
  }

  dirty(k: RateLimitKeyPosture): boolean {
    return this.draft(k).trim() !== String(k.effective);
  }

  draftError(k: RateLimitKeyPosture): string | null {
    return this.dirty(k) ? budgetError(this.draft(k), k) : null;
  }

  draftWarning(k: RateLimitKeyPosture): string | null {
    const p = this.posture();
    if (!p || !this.dirty(k) || this.draftError(k)) return null;
    const policyName = k.policy === 'api-address' ? 'api' : k.policy;
    return budgetWarning(
      Number(this.draft(k).trim()),
      p.rateLimits.policies.find((x) => x.name === policyName),
      p.rateLimits.countingSinceUtc,
      Date.now(),
    );
  }

  save(): void {
    const k = this.pending();
    if (!k) return;
    this.busy.set(true);
    this.saveError.set(null);
    this.configs
      .upsert({
        key: k.key,
        value: this.draft(k).trim(),
        dataType: 'Int',
        description: k.description,
        isHotReloadable: true,
      })
      .pipe(
        switchMap((res) => {
          if (!res.status) throw res;
          this.saved.set(
            isQueuedForCoolingOff(res)
              ? `${k.key}: queued for the cooling-off period.`
              : `${k.key} saved — applied within 30 seconds.`,
          );
          return this.api.refreshBudgets();
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: () => {
          this.busy.set(false);
          this.pending.set(null);
          this.drafts.update((d) => {
            const { [k.key]: _drop, ...rest } = d;
            return rest;
          });
          this.reload();
        },
        error: (e: unknown) => {
          this.busy.set(false);
          this.pending.set(null);
          const text = JSON.stringify(e ?? {});
          if (/-202-approval/.test(text)) this.saved.set(`${k.key}: sent for approval.`);
          else
            this.saveError.set((e as { message?: string })?.message ?? 'The change was not saved.');
          this.reload();
        },
      });
  }
}
