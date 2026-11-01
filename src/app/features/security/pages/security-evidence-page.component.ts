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
  styleUrls: [
    '../../iam/shared/iam-page.scss',
    '../../venues/pages/venue-page.scss',
    './security-evidence-page.scss',
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
          <header class="card-head">
            <div class="titles">
              <h3>Download</h3>
              <p>One zip for the period, with a manifest of SHA-256s</p>
            </div>
          </header>
          <div class="card-body">
            <p class="note">
              This archive is engineering evidence for your own assessment and your auditor. It is
              not a certification or an attestation of compliance with SOC 2, ISO 27001 or any other
              standard.
            </p>
            <div class="contents">
              <span class="section-label">It contains</span>
              <ul class="checklist">
                <li>
                  Quarterly access reviews with their sign-offs (one CSV per review) and the monthly
                  counts
                </li>
                <li>The audit log's hash-chain check and the external anchor check</li>
                <li>Backup/restore drill reports</li>
                <li>Release notes</li>
                <li>CI security-scan summaries</li>
                <li>A manifest with every file's SHA-256</li>
              </ul>
              <p class="small muted">
                Sources the engine host is not configured for are listed as "not configured". Each
                download is recorded in the audit log.
              </p>
            </div>
            <div class="period">
              <label class="field">
                <span class="label">From</span>
                <input
                  class="input"
                  type="date"
                  name="from"
                  [ngModel]="from()"
                  (ngModelChange)="from.set($event)"
                  [attr.aria-invalid]="problem() !== null"
                />
              </label>
              <span class="arrow" aria-hidden="true">→</span>
              <label class="field">
                <span class="label">To</span>
                <input
                  class="input"
                  type="date"
                  name="to"
                  [ngModel]="to()"
                  (ngModelChange)="to.set($event)"
                  [attr.aria-invalid]="problem() !== null"
                />
              </label>
              <span class="days">{{ periodDays() }}</span>
            </div>
            <div class="actions-row">
              @if (problem(); as p) {
                <span class="small problem">{{ p }}</span>
              }
              <button
                type="button"
                class="btn btn-primary"
                (click)="download()"
                [disabled]="busy() || problem() !== null"
                [title]="problem() ?? ''"
              >
                {{ busy() ? 'Preparing…' : 'Download evidence bundle' }}
              </button>
            </div>
            @if (last(); as l) {
              <div class="result" role="status">
                <div class="result-head">
                  <span class="dot ok">Downloaded</span>
                  <span class="file">{{ l.fileName }}</span>
                  <span class="spacer"></span>
                  @if (l.signature) {
                    <span class="dot ok">signed (key {{ l.signingKeyId }})</span>
                  } @else {
                    <span class="dot warn">unsigned (no signing key configured on the engine)</span>
                  }
                </div>
                <span class="small muted"
                  >SHA-256 <code>{{ l.sha256 ?? 'not sent' }}</code></span
                >
              </div>
            }
          </div>
        </section>

        <section class="card">
          <header class="card-head">
            <div class="titles">
              <h3>What the bundle holds today</h3>
              <p>Each source as it stands right now</p>
            </div>
          </header>
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
                    <span class="src">Quarterly access reviews</span>
                    <span class="sub"
                      >snapshots of people, grants, credentials and tokens + sign-offs</span
                    >
                  </td>
                  <td class="small state">
                    @if (latestReview(); as r) {
                      <span
                        class="dot"
                        [class.ok]="!!r.signedOffAtUtc"
                        [class.warn]="!r.signedOffAtUtc"
                        >{{ r.signedOffAtUtc ? 'signed off' : 'not signed off' }}</span
                      >
                      <span class="sub"
                        >{{ plural(campaigns.value().length, 'review') }} · latest {{ r.period }} ·
                        <a routerLink="/iam/access-review">Open</a></span
                      >
                    } @else {
                      <span class="dot">{{
                        campaigns.loaded() ? 'None yet — one opens each quarter.' : 'Loading…'
                      }}</span>
                    }
                  </td>
                </tr>
                <tr>
                  <td>
                    <span class="src">Audit log hash chain</span>
                    <span class="sub"
                      >recomputed over the newest events now, as the bundle does</span
                    >
                  </td>
                  <td class="small state">
                    @if (chain(); as c) {
                      <span class="dot" [class.ok]="c.intact" [class.bad]="!c.intact">{{
                        c.intact ? 'intact' : 'broken link'
                      }}</span>
                      <span class="sub"
                        >{{ c.rowsChecked.toLocaleString() }} events checked{{
                          c.pendingUnsealed ? ' · ' + c.pendingUnsealed + ' awaiting sealing' : ''
                        }}</span
                      >
                    } @else if (!canVerify()) {
                      <span class="dot">Checking needs <code>audit.read</code>.</span>
                    } @else {
                      <span class="dot" [class.bad]="!!chainError()">{{
                        chainError() ?? 'Checking…'
                      }}</span>
                    }
                  </td>
                </tr>
                <tr>
                  <td>
                    <span class="src">Release notes</span>
                    <span class="sub">written notes of each release in the period</span>
                  </td>
                  <td class="small state">
                    <span class="dot" [class.ok]="notes.value().length > 0">{{
                      notes.loaded() ? plural(notes.value().length, 'note') : 'Loading…'
                    }}</span>
                    @if (notes.loaded() && notes.value().length === 0) {
                      <span class="sub"
                        >none published; <a routerLink="/releases">see Releases</a></span
                      >
                    }
                  </td>
                </tr>
                <tr>
                  <td>
                    <span class="src">External anchor check, drill reports, CI scan summaries</span>
                    <span class="sub">files on the engine host</span>
                  </td>
                  <td class="small muted state">
                    Read from the host's configured folders:
                    <span class="keys">
                      <code>Audit:Anchors:FilePath</code>
                      <code>Security:Evidence:DrillResultsDirectory</code>
                      <code>Security:Evidence:ScanSummaryDirectory</code>
                    </span>
                    a folder that is not set is listed in the bundle as "not configured".
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
        value: this.periodDays(),
        caption: `${this.from() || '—'} to ${this.to() || '—'}`,
        tone: this.problem() !== null ? 'warn' : null,
      },
    ];
  });

  /** Length of the chosen period ("365 days"); '—' while a date is missing or unreadable. */
  periodDays(): string {
    const ms = Date.parse(this.to()) - Date.parse(this.from());
    if (!Number.isFinite(ms)) return '—';
    const n = Math.max(0, Math.round(ms / 86_400_000) + 1);
    return `${n.toLocaleString()} day${n === 1 ? '' : 's'}`;
  }

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
