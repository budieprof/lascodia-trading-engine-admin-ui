import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { errorText } from '@features/iam/iam.logic';
import { iamResource } from '@features/iam/shared/iam-resource';
import { saveBlob } from '@features/scripting/shared/download';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';

import { FundApiService } from '../fund-api.service';
import { defaultPeriod, isSha256, isUpgradeNotice, periodQuery, shortHash } from '../fund.logic';
import type {
  ComplianceExportRecord,
  ComplianceFormat,
  ComplianceSection,
  ComplianceVerification,
  DownloadedFile,
} from '../fund.types';

/**
 * Compliance exports (fund module): the organisation's audit log, order lifecycle and approvals for a
 * period, as JSON or a zip of CSV files. Each download's SHA-256 (and HMAC signature when the engine has
 * a signing key) is shown and kept in the register below, so a copy can be checked later. Needs
 * `compliance.export`.
 */
@Component({
  selector: 'app-fund-compliance-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, PageHeaderComponent],
  styleUrls: ['../../iam/shared/iam-page.scss', './fund-page.scss'],
  template: `
    <div class="page">
      <app-page-header
        title="Compliance exports"
        subtitle="Audit log, order lifecycle and approvals for a period — hashed, signed and registered."
      />

      @if (upgrade()) {
        <section class="card upgrade" role="status">
          <span class="chip warn">Not in your plan</span> {{ upgrade() }}
        </section>
      } @else {
        <section class="card">
          <div class="filters">
            <label class="field"
              ><span class="label">From (UTC)</span>
              <input
                class="input"
                type="date"
                name="from"
                [ngModel]="from()"
                (ngModelChange)="from.set($event)"
            /></label>
            <label class="field"
              ><span class="label">To (UTC, exclusive)</span>
              <input
                class="input"
                type="date"
                name="to"
                [ngModel]="to()"
                (ngModelChange)="to.set($event)"
            /></label>
            @for (s of allSections; track s) {
              <label class="check"
                ><input
                  type="checkbox"
                  [name]="'s-' + s"
                  [ngModel]="sections().includes(s)"
                  (ngModelChange)="toggle(s)"
                />
                {{ s }}</label
              >
            }
            <label class="field"
              ><span class="label">Format</span>
              <select
                class="select"
                name="format"
                [ngModel]="format()"
                (ngModelChange)="format.set($event)"
              >
                <option [ngValue]="'json'">JSON (one document)</option>
                <option [ngValue]="'csv'">CSV (zip)</option>
              </select></label
            >
            <button
              type="button"
              class="btn btn-primary"
              [disabled]="busy() || sections().length === 0"
              (click)="download()"
            >
              {{ busy() ? 'Preparing…' : 'Download' }}
            </button>
          </div>
          @if (error()) {
            <p class="pad" role="alert"><span class="chip bad">Not exported</span> {{ error() }}</p>
          }
          @if (last(); as f) {
            <div class="pad small">
              <div>
                <strong>{{ f.fileName }}</strong>
              </div>
              <div>
                SHA-256: <span class="mono">{{ f.sha256 }}</span>
              </div>
              @if (f.signature) {
                <div>
                  Signature: <span class="mono">{{ f.signature }}</span> (key {{ f.signingKeyId }})
                </div>
              } @else {
                <div class="muted">
                  Unsigned: the engine has no signing key configured. The hash is still registered.
                </div>
              }
            </div>
          }
        </section>

        <section class="card">
          <div class="card-head">
            <strong>Check a copy</strong>
            <span class="muted small">paste the file's SHA-256 (shasum -a 256 &lt;file&gt;)</span>
          </div>
          <div class="filters">
            <input
              class="input search"
              name="sha"
              aria-label="SHA-256"
              [ngModel]="sha()"
              (ngModelChange)="sha.set($event)"
            />
            <button
              type="button"
              class="btn btn-secondary"
              [disabled]="!validSha()"
              (click)="verify()"
            >
              Check
            </button>
          </div>
          @if (verification(); as v) {
            <p class="pad">
              <span
                class="chip"
                [class.ok]="v.issued && v.signatureValid !== false"
                [class.bad]="!v.issued || v.signatureValid === false"
              >
                {{
                  v.issued
                    ? v.signatureValid === false
                      ? 'Signature mismatch'
                      : 'Issued by the engine'
                    : 'Not issued'
                }}
              </span>
              {{ v.message }}
            </p>
          }
        </section>

        <section class="card">
          <div class="card-head">
            <strong>Register</strong>
            <button
              type="button"
              class="btn btn-sm btn-secondary"
              (click)="register.reload()"
              [disabled]="register.loading()"
            >
              Refresh
            </button>
          </div>
          @if (register.error(); as err) {
            <p class="pad" role="alert">{{ err }}</p>
          }
          <div class="table-wrap">
            <table class="grid">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Period</th>
                  <th>Sections</th>
                  <th>Format</th>
                  <th>Rows</th>
                  <th>SHA-256</th>
                  <th>Signed</th>
                  <th>By</th>
                </tr>
              </thead>
              <tbody>
                @for (r of register.value(); track r.id) {
                  <tr>
                    <td class="small">{{ r.createdAtUtc.slice(0, 16).replace('T', ' ') }}</td>
                    <td class="small">{{ r.fromUtc.slice(0, 10) }} → {{ r.toUtc.slice(0, 10) }}</td>
                    <td>{{ r.sections.join(', ') }}</td>
                    <td>{{ r.format }}</td>
                    <td class="small">{{ rows(r) }}</td>
                    <td class="mono" [title]="r.sha256">{{ shortHash(r.sha256) }}</td>
                    <td>{{ r.signature ? 'yes (' + r.signingKeyId + ')' : 'no' }}</td>
                    <td class="small">{{ r.createdBy }}</td>
                  </tr>
                } @empty {
                  <tr>
                    <td colspan="8" class="muted">No exports yet.</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </section>
      }
    </div>
  `,
})
export class CompliancePageComponent {
  private readonly fund = inject(FundApiService);

  protected readonly shortHash = shortHash;
  protected readonly allSections: ComplianceSection[] = ['audit', 'orders', 'approvals'];

  readonly from = signal(defaultPeriod(new Date(), 30).from);
  readonly to = signal(defaultPeriod(new Date(), 30).to);
  readonly sections = signal<ComplianceSection[]>(['audit', 'orders', 'approvals']);
  readonly format = signal<ComplianceFormat>('json');
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly upgrade = signal<string | null>(null);
  readonly last = signal<DownloadedFile | null>(null);
  readonly sha = signal('');
  readonly verification = signal<ComplianceVerification | null>(null);
  readonly register = iamResource(
    () => this.fund.complianceExports(),
    [] as ComplianceExportRecord[],
    'Could not load the register.',
  );

  constructor() {
    this.register.reload();
  }

  validSha(): boolean {
    return isSha256(this.sha());
  }

  toggle(section: ComplianceSection): void {
    this.sections.update((s) =>
      s.includes(section) ? s.filter((x) => x !== section) : [...s, section],
    );
  }

  rows(r: ComplianceExportRecord): string {
    return Object.entries(r.rowCounts)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ');
  }

  download(): void {
    const period = periodQuery(this.from(), this.to());
    if ('problem' in period) {
      this.error.set(period.problem);
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    this.fund.downloadCompliance(period.from, period.to, this.sections(), this.format()).subscribe({
      next: (file) => {
        this.busy.set(false);
        this.last.set(file);
        saveBlob(file.blob, file.fileName);
        this.register.reload();
      },
      error: (e) => {
        this.busy.set(false);
        if (isUpgradeNotice(e))
          this.upgrade.set(errorText(e, 'Your plan does not include the fund module.'));
        else this.error.set(errorText(e, 'The export failed.'));
      },
    });
  }

  verify(): void {
    this.fund.verifyCompliance(this.sha().trim()).subscribe({
      next: (v) => this.verification.set(v),
      error: (e) => this.error.set(errorText(e, 'The check failed.')),
    });
  }
}
