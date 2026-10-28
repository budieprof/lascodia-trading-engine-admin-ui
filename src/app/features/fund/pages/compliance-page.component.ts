import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { errorText } from '@features/iam/iam.logic';
import { isMissingEndpoint } from '@features/organisation/organisation.logic';
import { iamResource } from '@features/iam/shared/iam-resource';
import { saveBlob } from '@features/scripting/shared/download';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';

import { FundApiService } from '../fund-api.service';
import {
  day,
  defaultPeriod,
  enumWords,
  isSha256,
  isUpgradeNotice,
  periodQuery,
  shareOfMax,
  shortHash,
} from '../fund.logic';
import type {
  ComplianceExportPreview,
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
  styles: [
    `
      .split {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr);
        gap: 1rem;
        padding: 0 1rem 1rem;
      }
      @media (max-width: 1100px) {
        .split {
          grid-template-columns: minmax(0, 1fr);
        }
      }
      .bars li {
        display: grid;
        grid-template-columns: minmax(0, 9rem) minmax(0, 1fr) 3.5rem;
        gap: 0.5rem;
        align-items: center;
        font-size: var(--text-xs);
        margin: 0.2rem 0;
      }
      .bars {
        list-style: none;
        margin: 0.4rem 0 0;
        padding: 0;
      }
      .bar {
        height: 6px;
        border-radius: 3px;
        background: var(--accent, #2563eb);
        min-width: 2px;
      }
      .days {
        display: flex;
        align-items: flex-end;
        gap: 2px;
        height: 70px;
        padding: 0 1rem;
      }
      .days span {
        flex: 1;
        background: var(--accent, #2563eb);
        opacity: 0.75;
        border-radius: 2px 2px 0 0;
        min-height: 1px;
      }
      .sections dt {
        font-weight: 600;
        font-size: var(--text-sm);
      }
      .sections dd {
        margin: 0 0 0.6rem;
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .sections {
        margin: 0;
        padding: 1rem;
      }
    `,
  ],
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
                (ngModelChange)="setFrom($event)"
            /></label>
            <label class="field"
              ><span class="label">To (UTC, exclusive)</span>
              <input
                class="input"
                type="date"
                name="to"
                [ngModel]="to()"
                (ngModelChange)="setTo($event)"
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

        @if (preview(); as p) {
          <section class="card">
            <div class="card-head">
              <strong>What an export of this period holds</strong>
              <span class="muted small"
                >{{ day(p.fromUtc) }} → {{ day(p.toUtc) }} (exclusive) · counted now, nothing is
                built or registered</span
              >
            </div>
            <div class="tiles">
              <div class="tile">
                <div class="tile-label">Audit events</div>
                <div class="tile-value">{{ p.rowCounts['audit'] ?? 0 }}</div>
                <div class="tile-label">sign-ins, access, settings, controls</div>
              </div>
              <div class="tile">
                <div class="tile-label">Orders</div>
                <div class="tile-value">{{ p.rowCounts['orders'] ?? 0 }}</div>
                <div class="tile-label">
                  {{ p.paperOrders }} paper · with fills and position events
                </div>
              </div>
              <div class="tile">
                <div class="tile-label">Approval requests</div>
                <div class="tile-value">{{ p.rowCounts['approvals'] ?? 0 }}</div>
                <div class="tile-label">two-person / four-eyes, with every approval</div>
              </div>
              <div class="tile">
                <div class="tile-label">Signing</div>
                <div class="tile-value" [class.pos]="p.signingConfigured">
                  {{ p.signingConfigured ? 'On' : 'Off' }}
                </div>
                <div class="tile-label">
                  {{
                    p.signingConfigured
                      ? 'HMAC-SHA256, key ' + p.signingKeyId
                      : 'hash only — no Compliance:Export:SigningKey on the engine host'
                  }}
                </div>
              </div>
              <div class="tile">
                <div class="tile-label">Exports registered</div>
                <div class="tile-value">{{ p.exportsTotal }}</div>
                <div class="tile-label">
                  {{ p.lastExportAtUtc ? 'last ' + day(p.lastExportAtUtc) : 'none downloaded yet' }}
                </div>
              </div>
            </div>
            @if (p.tooLarge.length) {
              <p class="pad" role="alert">
                <span class="chip warn">Too large</span> {{ p.tooLarge.join(', ') }} has more than
                {{ p.maxRowsPerSection.toLocaleString('en-US') }} rows in this period — a download
                would be refused; export a shorter period.
              </p>
            }
            @if (p.days.length > 1) {
              <div class="pad small muted">Audit events and orders per day</div>
              <div class="days" aria-hidden="true">
                @for (d of p.days; track d.dayUtc; let i = $index) {
                  <span
                    [style.height.%]="dayHeights()[i]"
                    [title]="day(d.dayUtc) + ': ' + d.audit + ' audit, ' + d.orders + ' orders'"
                  ></span>
                }
              </div>
            }
            <div class="split">
              <div>
                <strong class="small">Audit events by kind</strong>
                <ul class="bars">
                  @for (c of p.auditByCategory; track c.key; let i = $index) {
                    <li>
                      <span>{{ words(c.key) }}</span
                      ><span class="bar" [style.width.%]="auditWidths()[i]"></span
                      ><span class="num">{{ c.count }}</span>
                    </li>
                  } @empty {
                    <li class="muted">None in the period.</li>
                  }
                </ul>
              </div>
              <div>
                <strong class="small">Orders by status</strong>
                <ul class="bars">
                  @for (c of p.ordersByStatus; track c.key; let i = $index) {
                    <li>
                      <span>{{ words(c.key) }}</span
                      ><span class="bar" [style.width.%]="orderWidths()[i]"></span
                      ><span class="num">{{ c.count }}</span>
                    </li>
                  } @empty {
                    <li class="muted">None in the period.</li>
                  }
                </ul>
              </div>
              <div>
                <strong class="small">Approval requests by outcome</strong>
                <ul class="bars">
                  @for (c of p.approvalsByStatus; track c.key; let i = $index) {
                    <li>
                      <span>{{ words(c.key) }}</span
                      ><span class="bar" [style.width.%]="approvalWidths()[i]"></span
                      ><span class="num">{{ c.count }}</span>
                    </li>
                  } @empty {
                    <li class="muted">
                      None in the period (set up a policy under Organisation → Approval policies).
                    </li>
                  }
                </ul>
              </div>
            </div>
          </section>
        } @else if (previewMissing()) {
          <section class="card">
            <p class="pad small muted">
              The period's row counts appear here once the engine serves
              <code>GET fund/compliance-exports/preview</code>.
            </p>
          </section>
        }

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
                    <td colspan="8" class="muted">
                      No export downloaded yet. Each download is registered here with its period,
                      row counts, SHA-256 and signature, so anyone holding a copy can check it with
                      “Check a copy” above.
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </section>

        <section class="card">
          <div class="card-head"><strong>What a compliance export contains</strong></div>
          <dl class="sections">
            <dt>audit</dt>
            <dd>
              The organisation's audit events in the period, oldest first — sign-ins, access
              changes, configuration, trading controls, approvals — each with its chain hash (the
              engine's audit log is hash-chained).
            </dd>
            <dt>orders</dt>
            <dd>
              Orders created in the period (deleted ones included and marked): requested and filled
              price, latency, the position each opened and that position's lifecycle events.
            </dd>
            <dt>approvals</dt>
            <dd>
              Two-person and four-eyes requests made in the period, with every approval recorded.
            </dd>
            <dt>Integrity</dt>
            <dd>
              The SHA-256 of the exact file is returned with the download and kept in the register;
              with a signing key the register also holds an HMAC-SHA256 signature of it. Times are
              UTC; the period is from (inclusive) to (exclusive). Evidence for your own records —
              not a regulator's template.
            </dd>
          </dl>
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

  readonly preview = signal<ComplianceExportPreview | null>(null);
  readonly previewMissing = signal(false);
  protected readonly day = day;
  protected readonly words = enumWords;
  readonly dayHeights = computed(() =>
    shareOfMax((this.preview()?.days ?? []).map((d) => d.audit + d.orders)),
  );
  readonly auditWidths = computed(() =>
    shareOfMax((this.preview()?.auditByCategory ?? []).map((c) => c.count)),
  );
  readonly orderWidths = computed(() =>
    shareOfMax((this.preview()?.ordersByStatus ?? []).map((c) => c.count)),
  );
  readonly approvalWidths = computed(() =>
    shareOfMax((this.preview()?.approvalsByStatus ?? []).map((c) => c.count)),
  );

  constructor() {
    this.register.reload();
    this.loadPreview();
  }

  setFrom(v: string): void {
    this.from.set(v);
    this.loadPreview();
  }

  setTo(v: string): void {
    this.to.set(v);
    this.loadPreview();
  }

  /** The period's counts (refreshed when the period changes; nothing is built or registered). */
  loadPreview(): void {
    const period = periodQuery(this.from(), this.to());
    if ('problem' in period) return;
    this.fund.compliancePreview(period.from, period.to).subscribe({
      next: (p) => this.preview.set(p),
      error: (e) => {
        this.preview.set(null);
        if (isMissingEndpoint(e)) this.previewMissing.set(true);
        else if (isUpgradeNotice(e))
          this.upgrade.set(errorText(e, 'Your plan does not include the fund module.'));
      },
    });
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
        this.loadPreview();
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
