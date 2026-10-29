import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { catchError, of } from 'rxjs';

import { AuthService } from '@core/auth/auth.service';
import { Permission } from '@core/auth/permissions.generated';
import { AuditLogService } from '@features/audit-log/audit-log.service';
import type { AuditChainVerification } from '@features/audit-log/audit-log.types';
import { plural } from '@features/iam/shared/admin-context.logic';
import { AuditTrailComponent } from '@features/iam/shared/audit-trail.component';
import { iamResource } from '@features/iam/shared/iam-resource';
import { StatTilesComponent, type StatTile } from '@features/iam/shared/stat-tiles.component';

import { NotificationService } from '@core/notifications/notification.service';
import { errorText, reportable } from '@features/iam/iam.logic';
import { saveBlob } from '@features/scripting/shared/download';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';

import { SecurityApiService } from '../security-api.service';
import { evidencePeriodProblem, isoDay } from '../security.logic';
import type { AccessReviewCampaign, ReleaseNote } from '../security.types';

/**
 * The security evidence bundle (platform staff, `platform.security.evidence`): one signed zip of the period's access
 * reviews and sign-offs, audit-chain and anchor checks, backup/restore drill reports, release notes and CI
 * vulnerability-scan summaries, with a manifest of SHA-256s. Evidence for the operator's auditor — never a
 * certification; the page says so.
 */
@Component({
  selector: 'app-security-evidence-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, RouterLink, PageHeaderComponent, StatTilesComponent, AuditTrailComponent],
  styleUrl: '../../iam/shared/iam-page.scss',
  styles: [
    `
      .cols {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
        gap: var(--space-3);
        align-items: start;
      }
      @media (max-width: 860px) {
        .cols {
          grid-template-columns: 1fr;
        }
      }
    `,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Security evidence"
        subtitle="Download the evidence an auditor asks for, over a period, as one signed archive."
      />

      <app-stat-tiles [tiles]="tiles()" label="Evidence summary" />

      <div class="cols">
        <section class="card">
          <header class="card-head"><h3>Download</h3></header>
          <div class="card-body">
            <p class="note">
              This archive is engineering evidence for your own assessment and your auditor. It is
              not a certification or an attestation of compliance with SOC 2, ISO 27001 or any other
              standard.
            </p>
            <p class="small">
              It contains: quarterly access reviews with their sign-offs (one CSV per review) and
              the monthly counts; the audit log's hash-chain check and the external anchor check;
              backup/restore drill reports; release notes; CI security-scan summaries; and a
              manifest with every file's SHA-256. Sources the engine host is not configured for are
              listed as "not configured". Each download is recorded in the audit log.
            </p>
            <div class="row">
              <label class="field">
                <span class="label">From</span>
                <input
                  class="input"
                  type="date"
                  name="from"
                  [ngModel]="from()"
                  (ngModelChange)="from.set($event)"
                />
              </label>
              <label class="field">
                <span class="label">To</span>
                <input
                  class="input"
                  type="date"
                  name="to"
                  [ngModel]="to()"
                  (ngModelChange)="to.set($event)"
                />
              </label>
            </div>
            <div class="actions-row">
              <button
                type="button"
                class="btn btn-primary"
                (click)="download()"
                [disabled]="busy() || problem() !== null"
                [title]="problem() ?? ''"
              >
                {{ busy() ? 'Preparing…' : 'Download evidence bundle' }}
              </button>
              @if (problem(); as p) {
                <span class="small muted">{{ p }}</span>
              }
            </div>
            @if (last(); as l) {
              <p class="small">
                {{ l.fileName }} · SHA-256 <code>{{ l.sha256 ?? 'not sent' }}</code>
                @if (l.signature) {
                  · signed (key {{ l.signingKeyId }})
                } @else {
                  · unsigned (no signing key configured on the engine)
                }
              </p>
            }
          </div>
        </section>

        <section class="card">
          <header class="card-head"><h3>What the bundle holds today</h3></header>
          <div class="table-wrap">
            <table class="grid">
              <thead>
                <tr>
                  <th>Source</th>
                  <th>State now</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>
                    Quarterly access reviews
                    <span class="sub"
                      >snapshots of people, grants, credentials and tokens + sign-offs</span
                    >
                  </td>
                  <td class="small">
                    @if (latestReview(); as r) {
                      {{ plural(campaigns.value().length, 'review') }} · latest {{ r.period }}
                      <span
                        class="chip"
                        [class.ok]="!!r.signedOffAtUtc"
                        [class.warn]="!r.signedOffAtUtc"
                        >{{ r.signedOffAtUtc ? 'signed off' : 'not signed off' }}</span
                      >
                      <a routerLink="/iam/access-review">Open</a>
                    } @else {
                      {{ campaigns.loaded() ? 'None yet — one opens each quarter.' : 'Loading…' }}
                    }
                  </td>
                </tr>
                <tr>
                  <td>
                    Audit log hash chain
                    <span class="sub"
                      >recomputed over the newest events now, as the bundle does</span
                    >
                  </td>
                  <td class="small">
                    @if (chain(); as c) {
                      <span class="chip" [class.ok]="c.intact" [class.bad]="!c.intact">{{
                        c.intact ? 'intact' : 'broken link'
                      }}</span>
                      {{ c.rowsChecked }} events checked{{
                        c.pendingUnsealed ? ' · ' + c.pendingUnsealed + ' awaiting sealing' : ''
                      }}
                    } @else if (!canVerify()) {
                      Checking needs <code>audit.read</code>.
                    } @else {
                      {{ chainError() ?? 'Checking…' }}
                    }
                  </td>
                </tr>
                <tr>
                  <td>
                    Release notes
                    <span class="sub">written notes of each release in the period</span>
                  </td>
                  <td class="small">
                    {{ notes.loaded() ? plural(notes.value().length, 'note') : 'Loading…' }}
                    @if (notes.loaded() && notes.value().length === 0) {
                      — none published; <a routerLink="/releases">see Releases</a>
                    }
                  </td>
                </tr>
                <tr>
                  <td>
                    External anchor check, drill reports, CI scan summaries
                    <span class="sub">files on the engine host</span>
                  </td>
                  <td class="small muted">
                    Read from the host's configured folders (<code>Audit:Anchors:FilePath</code>,
                    <code>Security:Evidence:DrillResultsDirectory</code>,
                    <code>Security:Evidence:ScanSummaryDirectory</code>); a folder that is not set
                    is listed in the bundle as "not configured".
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <app-audit-trail
        heading="Evidence downloads and exports"
        [actions]="['platform.security.evidence', 'iam.access_review.', 'audit.events.exported']"
        empty="No evidence bundle, access-review export or audit export has been downloaded yet. Each download is recorded here."
      />
    </div>
  `,
})
export class SecurityEvidencePageComponent {
  private readonly api = inject(SecurityApiService);
  private readonly notify = inject(NotificationService);
  private readonly audit = inject(AuditLogService);
  private readonly auth = inject(AuthService);

  protected readonly plural = plural;
  readonly campaigns = iamResource<AccessReviewCampaign[]>(
    () => this.api.campaigns().pipe(catchError(() => of([] as AccessReviewCampaign[]))),
    [],
  );
  readonly notes = iamResource<ReleaseNote[]>(
    () => this.api.releaseNotes(null, 100).pipe(catchError(() => of([] as ReleaseNote[]))),
    [],
  );
  readonly canVerify = computed(() => this.auth.hasPermission(Permission.AuditRead));
  readonly chain = signal<AuditChainVerification | null>(null);
  readonly chainError = signal<string | null>(null);
  readonly latestReview = computed(
    () =>
      [...this.campaigns.value()].sort((a, b) =>
        b.periodStartUtc.localeCompare(a.periodStartUtc),
      )[0] ?? null,
  );
  readonly tiles = computed<StatTile[]>(() => {
    const r = this.latestReview();
    const c = this.chain();
    return [
      {
        label: 'Access reviews',
        value: this.campaigns.loaded() ? String(this.campaigns.value().length) : '…',
        caption: r
          ? `latest ${r.period} · ${r.signedOffAtUtc ? 'signed off' : 'awaiting sign-off'}`
          : 'none taken yet',
        tone: r ? (r.signedOffAtUtc ? 'good' : 'warn') : null,
        route: '/iam/access-review',
      },
      {
        label: 'Audit chain',
        value: c ? (c.intact ? 'Intact' : 'Broken') : '…',
        caption: c ? `${c.rowsChecked} newest events re-hashed` : 'checking the newest events',
        tone: c ? (c.intact ? 'good' : 'bad') : null,
        route: '/admin/audit',
      },
      {
        label: 'Release notes',
        value: this.notes.loaded() ? String(this.notes.value().length) : '…',
        caption: this.notes.value().length ? 'included for the period' : 'none published yet',
        route: '/releases',
      },
      {
        label: 'Period chosen',
        value: `${Math.max(0, Math.round((Date.parse(this.to()) - Date.parse(this.from())) / 86_400_000) + 1)} days`,
        caption: `${this.from()} to ${this.to()}`,
      },
    ];
  });

  constructor() {
    this.campaigns.reload();
    this.notes.reload();
    if (this.canVerify()) {
      this.audit.verify(null, null, 2000).subscribe({
        next: (v) => this.chain.set(v),
        error: (e) => this.chainError.set(errorText(e, 'The chain could not be checked.')),
      });
    }
  }

  readonly to = signal(isoDay(new Date()));
  readonly from = signal(isoDay(new Date(Date.now() - 365 * 86_400_000)));
  readonly busy = signal(false);
  readonly last = signal<{
    fileName: string;
    sha256: string | null;
    signature: string | null;
    signingKeyId: string | null;
  } | null>(null);
  readonly problem = computed(() => evidencePeriodProblem(this.from(), this.to()));

  download(): void {
    if (this.busy() || this.problem() !== null) return;
    this.busy.set(true);
    this.api.evidenceBundle(this.from(), this.to()).subscribe({
      next: (file) => {
        this.busy.set(false);
        this.last.set({
          fileName: file.fileName,
          sha256: file.sha256,
          signature: file.signature,
          signingKeyId: file.signingKeyId,
        });
        saveBlob(file.blob, file.fileName);
      },
      error: (e) => {
        this.busy.set(false);
        if (reportable(e))
          this.notify.error(errorText(e, 'The evidence bundle could not be produced.'));
      },
    });
  }
}
