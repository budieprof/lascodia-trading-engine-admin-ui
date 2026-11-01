import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { AuthService } from '@core/auth/auth.service';
import { Permission } from '@core/auth/permissions.generated';

import { errorText } from '@features/iam/iam.logic';
import { isMissingEndpoint } from '@features/organisation/organisation.logic';
import { iamResource } from '@features/iam/shared/iam-resource';
import { saveBlob } from '@features/scripting/shared/download';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';

import { FundApiService } from '../fund-api.service';
import {
  dayLabel,
  defaultPeriod,
  enumWords,
  isSha256,
  isUpgradeNotice,
  matchPreset,
  minuteUtc,
  periodLabel,
  periodPresets,
  periodQuery,
  shareOfMax,
  shortHash,
  type PresetKey,
} from '../fund.logic';
import type {
  ComplianceExportPreview,
  ComplianceExportRecord,
  ComplianceFormat,
  ComplianceSection,
  ComplianceVerification,
  DownloadedFile,
} from '../fund.types';

/** What each section of an export holds, in the words the page shows. */
const SECTION_INFO: Record<ComplianceSection, { title: string; text: string }> = {
  audit: {
    title: 'Audit log',
    text: "The organisation's audit events, oldest first — sign-ins, access changes, configuration, trading controls, approvals — each with its chain hash (the audit log is hash-chained).",
  },
  orders: {
    title: 'Orders',
    text: "Orders created in the period (deleted ones included and marked): requested and filled price, latency, the position each opened and that position's lifecycle events.",
  },
  approvals: {
    title: 'Approvals',
    text: 'Two-person and four-eyes requests made in the period, with every approval recorded.',
  },
};

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
  imports: [FormsModule, RouterLink, PageHeaderComponent],
  styleUrls: ['../../iam/shared/iam-page.scss', './fund-page.scss', './compliance-page.scss'],
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
        <div class="build">
          <!-- ── New export ─────────────────────────── -->
          <section class="card">
            <div class="card-head">
              <h3>New export</h3>
              <span class="hint">counted live — nothing is built until you download</span>
            </div>
            <div class="query">
              <div class="field full">
                <span class="label">Period</span>
                <div class="seg" role="group" aria-label="Quick periods">
                  @for (p of presets; track p.key) {
                    <button
                      type="button"
                      [class.on]="preset() === p.key"
                      [attr.aria-pressed]="preset() === p.key"
                      (click)="applyPreset(p.key)"
                    >
                      {{ p.label }}
                    </button>
                  }
                  <button type="button" [class.on]="preset() === null" disabled>Custom</button>
                </div>
              </div>
              <label class="field date">
                <span class="label">From (UTC)</span>
                <input
                  class="input"
                  type="date"
                  name="from"
                  [ngModel]="from()"
                  (ngModelChange)="setFrom($event)"
                />
              </label>
              <label class="field date">
                <span class="label">To (not included)</span>
                <input
                  class="input"
                  type="date"
                  name="to"
                  [ngModel]="to()"
                  (ngModelChange)="setTo($event)"
                />
              </label>
            </div>

            <div class="picks" role="group" aria-label="Sections to include">
              @for (s of allSections; track s) {
                <label class="pick" [class.on]="sections().includes(s)" [class.big]="isTooLarge(s)">
                  <input
                    type="checkbox"
                    [name]="'s-' + s"
                    [ngModel]="sections().includes(s)"
                    (ngModelChange)="toggle(s)"
                  />
                  <span class="pick-head">
                    <span class="box" aria-hidden="true">✓</span>
                    <strong>{{ info[s].title }}</strong>
                    @if (preview(); as p) {
                      <span class="rows"
                        >{{ (p.rowCounts[s] ?? 0).toLocaleString('en-US') }} rows</span
                      >
                    }
                  </span>
                  <span class="pick-text">{{ info[s].text }}</span>
                  @if (isTooLarge(s)) {
                    <span class="pill warn">Too large for one file — shorten the period</span>
                  }
                </label>
              }
            </div>

            <div class="query">
              <div class="field">
                <span class="label">Format</span>
                <div class="seg" role="radiogroup" aria-label="Format">
                  <button
                    type="button"
                    role="radio"
                    [class.on]="format() === 'json'"
                    [attr.aria-checked]="format() === 'json'"
                    (click)="format.set('json')"
                  >
                    JSON · one document
                  </button>
                  <button
                    type="button"
                    role="radio"
                    [class.on]="format() === 'csv'"
                    [attr.aria-checked]="format() === 'csv'"
                    (click)="format.set('csv')"
                  >
                    CSV · zip of files
                  </button>
                </div>
              </div>
            </div>

            <div class="go">
              <div class="go-text">
                <strong>{{ summaryLine() }}</strong>
                @if (preview(); as p) {
                  <span
                    class="dot"
                    [class.ok]="p.signingConfigured"
                    [class.warn]="!p.signingConfigured"
                  >
                    {{
                      p.signingConfigured
                        ? 'Signed with HMAC-SHA256 · key ' + p.signingKeyId
                        : 'Hash only — no signing key on the engine host'
                    }}
                  </span>
                }
              </div>
              <button
                type="button"
                class="btn btn-primary"
                [disabled]="busy() || sections().length === 0"
                (click)="download()"
              >
                {{ busy() ? 'Preparing…' : '⤓ Download' }}
              </button>
            </div>
            @if (error()) {
              <p class="alert" role="alert"><strong>Not exported.</strong> {{ error() }}</p>
            }
            @if (last(); as f) {
              <div class="receipt" role="status">
                <div class="receipt-head">
                  <span class="tick" aria-hidden="true">✓</span>
                  <div>
                    <strong>{{ f.fileName }}</strong>
                    <span class="sub"
                      >Downloaded and registered — anyone holding a copy can check it below.</span
                    >
                  </div>
                </div>
                <div class="hash">
                  <span class="label">SHA-256</span>
                  <span class="mono">{{ f.sha256 }}</span>
                </div>
                @if (f.signature) {
                  <div class="hash">
                    <span class="label">Signature (key {{ f.signingKeyId }})</span>
                    <span class="mono">{{ f.signature }}</span>
                  </div>
                } @else {
                  <p class="sub">
                    Unsigned: the engine has no signing key configured. The hash is still
                    registered.
                  </p>
                }
              </div>
            }
          </section>

          <!-- ── What the period holds ─────────────── -->
          <section class="card">
            <div class="card-head">
              <h3>This period</h3>
              @if (preview(); as p) {
                <span class="hint">{{ periodText(p) }}</span>
              }
            </div>
            @if (preview(); as p) {
              <div class="kpis pad-all">
                <div class="kpi">
                  <div class="k-label">Audit events</div>
                  <div class="k-value">
                    {{ (p.rowCounts['audit'] ?? 0).toLocaleString('en-US') }}
                  </div>
                  <div class="k-hint">sign-ins, access, settings, controls</div>
                </div>
                <div class="kpi">
                  <div class="k-label">Orders</div>
                  <div class="k-value">
                    {{ (p.rowCounts['orders'] ?? 0).toLocaleString('en-US') }}
                  </div>
                  <div class="k-hint">{{ p.paperOrders }} paper · with fills and positions</div>
                </div>
                <div class="kpi">
                  <div class="k-label">Approval requests</div>
                  <div class="k-value">{{ p.rowCounts['approvals'] ?? 0 }}</div>
                  <div class="k-hint">two-person / four-eyes</div>
                </div>
              </div>
              @if (p.days.length > 1) {
                <div class="days-wrap">
                  <div class="mini-head">Audit events and orders per day</div>
                  <div class="days" aria-hidden="true">
                    @for (d of p.days; track d.dayUtc; let i = $index) {
                      <span
                        [style.height.%]="dayHeights()[i]"
                        [title]="
                          dayLabel(d.dayUtc) + ': ' + d.audit + ' audit, ' + d.orders + ' orders'
                        "
                      ></span>
                    }
                  </div>
                  <div class="days-axis">
                    <span>{{ dayLabel(p.days[0].dayUtc, false) }}</span>
                    <span>{{ dayLabel(p.days[p.days.length - 1].dayUtc, false) }}</span>
                  </div>
                </div>
              }
              <div class="split">
                <div>
                  <div class="mini-head">Audit events by kind</div>
                  <ul class="bars">
                    @for (c of p.auditByCategory; track c.key; let i = $index) {
                      <li>
                        <span>{{ words(c.key) }}</span
                        ><span class="track"
                          ><span class="bar" [style.width.%]="auditWidths()[i]"></span></span
                        ><span class="num">{{ c.count }}</span>
                      </li>
                    } @empty {
                      <li class="none">None in the period.</li>
                    }
                  </ul>
                </div>
                <div>
                  <div class="mini-head">Orders by status</div>
                  <ul class="bars">
                    @for (c of p.ordersByStatus; track c.key; let i = $index) {
                      <li>
                        <span>{{ words(c.key) }}</span
                        ><span class="track"
                          ><span class="bar" [style.width.%]="orderWidths()[i]"></span></span
                        ><span class="num">{{ c.count }}</span>
                      </li>
                    } @empty {
                      <li class="none">None in the period.</li>
                    }
                  </ul>
                </div>
                <div>
                  <div class="mini-head">Approval requests by outcome</div>
                  <ul class="bars">
                    @for (c of p.approvalsByStatus; track c.key; let i = $index) {
                      <li>
                        <span>{{ words(c.key) }}</span
                        ><span class="track"
                          ><span class="bar" [style.width.%]="approvalWidths()[i]"></span></span
                        ><span class="num">{{ c.count }}</span>
                      </li>
                    } @empty {
                      <li class="none">
                        None in the period (set up a policy under Organisation → Approval policies).
                      </li>
                    }
                  </ul>
                </div>
              </div>
            } @else if (previewMissing()) {
              <p class="empty">
                The period's row counts appear here once the engine serves
                <code>GET fund/compliance-exports/preview</code>.
              </p>
            } @else {
              <p class="empty">Counting the period…</p>
            }
          </section>
        </div>

        @if (canRegulatory()) {
          <section class="card">
            <div class="card-head">
              <h3>Regulatory report files</h3>
              <span class="hint"
                >MiFIR RTS 22 / EMIR Refit-shaped files and a venue summary — signed, registered
                below, never submitted</span
              >
              <span class="spacer"></span>
              <a routerLink="/fund/regulatory" class="btn btn-sm btn-secondary">Open</a>
            </div>
          </section>
        }

        <!-- ── Check a copy ──────────────────────────── -->
        <section class="card">
          <div class="card-head">
            <h3>Check a copy</h3>
            <span class="hint">was this file issued by the engine, unchanged?</span>
          </div>
          <div class="check-row">
            <div class="field grow">
              <span class="label">The file's SHA-256</span>
              <input
                class="input mono"
                name="sha"
                aria-label="SHA-256"
                placeholder="64 characters — on a Mac or Linux: shasum -a 256 &lt;file&gt;"
                spellcheck="false"
                autocomplete="off"
                [attr.aria-invalid]="shaProblem() ? 'true' : null"
                [ngModel]="sha()"
                (ngModelChange)="sha.set($event)"
                (keydown.enter)="validSha() && verify()"
              />
              <span class="field-hint" [class.bad]="shaProblem()">
                {{ shaProblem() || shaLength() + ' / 64 characters' }}
              </span>
            </div>
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
            <div
              class="verdict"
              [class.ok]="v.issued && v.signatureValid !== false"
              [class.bad]="!v.issued || v.signatureValid === false"
              role="status"
            >
              <strong>
                {{
                  v.issued
                    ? v.signatureValid === false
                      ? 'Signature mismatch'
                      : 'Issued by the engine'
                    : 'Not issued'
                }}
              </strong>
              {{ v.message }}
            </div>
          }
          <p class="foot">
            The SHA-256 of the exact file is returned with the download and kept in the register;
            with a signing key the register also holds an HMAC-SHA256 signature of it. Times are
            UTC; the period is from (inclusive) to (exclusive). Evidence for your own records — not
            a regulator's template.
          </p>
        </section>

        <!-- ── Register ──────────────────────────────── -->
        <section class="card">
          <div class="card-head">
            <h3>Register</h3>
            <span class="count">{{ register.value().length }}</span>
            @if (preview()?.lastExportAtUtc; as lastAt) {
              <span class="hint">last export {{ minuteUtc(lastAt) }} UTC</span>
            }
            <span class="spacer"></span>
            <button
              type="button"
              class="btn btn-sm btn-ghost"
              (click)="register.reload()"
              [disabled]="register.loading()"
            >
              Refresh
            </button>
          </div>
          @if (register.error(); as err) {
            <p class="alert" role="alert">{{ err }}</p>
          }
          <div class="table-wrap">
            <table class="grid">
              <thead>
                <tr>
                  <th>When (UTC)</th>
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
                    <td class="nowrap">
                      {{ r.createdAtUtc.slice(0, 10) }}
                      <span class="sub">{{ r.createdAtUtc.slice(11, 16) }}</span>
                    </td>
                    <td class="nowrap">{{ periodText(r) }}</td>
                    <td>
                      <span class="tags">
                        @for (s of r.sections; track s) {
                          <span class="pill">{{ sectionTitle(s) }}</span>
                        }
                      </span>
                    </td>
                    <td>
                      <span class="pill info">{{ r.format.toUpperCase() }}</span>
                    </td>
                    <td class="small">{{ rows(r) }}</td>
                    <td class="mono" [title]="r.sha256">{{ shortHash(r.sha256) }}</td>
                    <td>
                      @if (r.signature) {
                        <span class="dot ok">key {{ r.signingKeyId }}</span>
                      } @else {
                        <span class="dot">hash only</span>
                      }
                    </td>
                    <td class="small">{{ r.createdBy }}</td>
                  </tr>
                } @empty {
                  <tr>
                    <td colspan="8" class="empty">
                      <strong>No export downloaded yet</strong>
                      Each download is registered here with its period, row counts, SHA-256 and
                      signature, so anyone holding a copy can check it with “Check a copy” above.
                    </td>
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
  private readonly auth = inject(AuthService);
  readonly canRegulatory = computed(() =>
    this.auth.hasPermission(Permission.ComplianceRegulatoryGenerate),
  );

  protected readonly shortHash = shortHash;
  protected readonly minuteUtc = minuteUtc;
  protected readonly dayLabel = dayLabel;
  protected readonly info = SECTION_INFO;
  protected readonly presets = periodPresets(new Date());
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
  protected readonly words = enumWords;
  readonly preset = computed(() => matchPreset(this.from(), this.to(), new Date()));
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
  /** "3 sections · 306 rows · JSON" — what the Download button will produce. */
  readonly summaryLine = computed(() => {
    const n = this.sections().length;
    if (n === 0) return 'Pick at least one section';
    const p = this.preview();
    const rows = p ? this.sections().reduce((sum, s) => sum + (p.rowCounts[s] ?? 0), 0) : null;
    const fmt = this.format() === 'json' ? 'JSON' : 'CSV zip';
    return `${n} section${n === 1 ? '' : 's'}${rows === null ? '' : ` · ${rows.toLocaleString('en-US')} rows`} · ${fmt}`;
  });
  readonly shaLength = computed(() => this.sha().trim().length);
  readonly shaProblem = computed(() => {
    const s = this.sha().trim();
    if (!s) return '';
    if (/[^0-9a-fA-F]/.test(s)) return 'Only 0–9 and a–f — paste just the hash.';
    if (s.length !== 64) return `${s.length} / 64 characters`;
    return '';
  });

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

  applyPreset(key: PresetKey): void {
    const p = this.presets.find((x) => x.key === key);
    if (!p) return;
    this.from.set(p.from);
    this.to.set(p.to);
    this.loadPreview();
  }

  periodText(p: { fromUtc: string; toUtc: string }): string {
    return periodLabel(p.fromUtc, p.toUtc);
  }

  sectionTitle(s: string): string {
    // Regulatory report files share the register (gaps program, surveillance).
    if (s.startsWith('regulatory:')) return `Regulatory · ${s.slice('regulatory:'.length)}`;
    return SECTION_INFO[s as ComplianceSection]?.title ?? s;
  }

  isTooLarge(s: ComplianceSection): boolean {
    return this.preview()?.tooLarge.includes(s) ?? false;
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
