import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { NotificationService } from '@core/notifications/notification.service';
import { errorText, reportable } from '@features/iam/iam.logic';
import { saveBlob } from '@features/scripting/shared/download';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';

import { SecurityApiService } from '../security-api.service';
import { evidencePeriodProblem, isoDay } from '../security.logic';

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
  imports: [FormsModule, PageHeaderComponent],
  styleUrl: '../../iam/shared/iam-page.scss',
  template: `
    <div class="page">
      <app-page-header
        title="Security evidence"
        subtitle="Download the evidence an auditor asks for, over a period, as one signed archive."
      />

      <section class="card">
        <div class="card-body">
          <p class="note">
            This archive is engineering evidence for your own assessment and your auditor. It is not
            a certification or an attestation of compliance with SOC 2, ISO 27001 or any other
            standard.
          </p>
          <p class="small">
            It contains: quarterly access reviews with their sign-offs (one CSV per review) and the
            monthly counts; the audit log's hash-chain check and the external anchor check;
            backup/restore drill reports; release notes; CI security-scan summaries; and a manifest
            with every file's SHA-256. Sources the engine host is not configured for are listed as
            "not configured". Each download is recorded in the audit log.
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
    </div>
  `,
})
export class SecurityEvidencePageComponent {
  private readonly api = inject(SecurityApiService);
  private readonly notify = inject(NotificationService);

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
