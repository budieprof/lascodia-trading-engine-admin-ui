import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { errorText } from '@features/iam/iam.logic';
import { iamResource } from '@features/iam/shared/iam-resource';
import { saveBlob } from '@features/scripting/shared/download';
import { leiProblem } from '@features/surveillance/surveillance.logic';
import type {
  ClientIdType,
  RegulatoryAccount,
  RegulatoryFirm,
  RegulatoryKind,
  RegulatoryPreview,
  RegulatoryReferenceData,
} from '@features/surveillance/surveillance.types';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';

import { FundApiService } from '../fund-api.service';
import { defaultPeriod, isUpgradeNotice, periodQuery, shortHash } from '../fund.logic';
import type { DownloadedFile } from '../fund.types';

const KINDS: { key: RegulatoryKind; title: string; text: string }[] = [
  {
    key: 'mifir-rts22',
    title: 'MiFIR transaction reports',
    text: 'One record per fill, shaped after RTS 22 Annex I (CSV, or XML after ISO 20022 auth.016).',
  },
  {
    key: 'emir-refit',
    title: 'EMIR Refit trade reports',
    text: 'OTC derivative trades (broker CFDs, FX forwards) shaped after the Refit fields (CSV, or XML after auth.030).',
  },
  {
    key: 'rts28-venues',
    title: 'Top-five venues (RTS 28-style)',
    text: 'Execution venues per instrument class with volume and order shares and best-execution figures (CSV).',
  },
];

const EMPTY_FIRM: RegulatoryFirm = {
  firmLei: null,
  firmCountry: null,
  investmentFirmCoveredByMifid: true,
  defaultVenueMic: 'XXXX',
  investmentDecisionCode: null,
  investmentDecisionIsAlgorithm: true,
  executionDecisionCode: null,
  executionDecisionIsAlgorithm: true,
  emirCounterpartyNature: null,
  emirCorporateSector: null,
};

/**
 * Regulatory report files (gaps program, surveillance): the organisation's reference data (LEI, venue,
 * decision makers, each account's client and counterparty), a validation of the chosen report for a
 * period, and the signed download — registered with the compliance exports. NEVER submitted anywhere:
 * the page says so. Needs `compliance.regulatory.generate`.
 */
@Component({
  selector: 'app-fund-regulatory-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, RouterLink, PageHeaderComponent],
  styleUrls: ['../../iam/shared/iam-page.scss', './fund-page.scss', './regulatory-page.scss'],
  template: `
    <div class="page">
      <app-page-header
        title="Regulatory reports"
        subtitle="Transaction and trade report files shaped after MiFIR RTS 22 and EMIR Refit, and a venue summary — for you to check and file."
      />

      <section class="card notice" role="note">
        <strong>Not submitted.</strong>
        {{ reference.value()?.notice ?? defaultNotice }}
      </section>

      @if (upgrade()) {
        <section class="card upgrade" role="status">
          <span class="chip warn">Not in your plan</span> {{ upgrade() }}
        </section>
      } @else {
        <!-- ── Generate ───────────────────────────── -->
        <section class="card">
          <div class="card-head"><h3>Generate</h3></div>
          <div class="kinds" role="radiogroup" aria-label="Report">
            @for (k of kinds; track k.key) {
              <button type="button" role="radio" class="kind" [class.on]="kind() === k.key" [attr.aria-checked]="kind() === k.key" (click)="setKind(k.key)">
                <strong>{{ k.title }}</strong>
                <span>{{ k.text }}</span>
              </button>
            }
          </div>
          <div class="query">
            <label class="field date">
              <span class="label">From (UTC)</span>
              <input class="input" type="date" name="from" [ngModel]="from()" (ngModelChange)="from.set($event); preview.set(null)" />
            </label>
            <label class="field date">
              <span class="label">To (not included)</span>
              <input class="input" type="date" name="to" [ngModel]="to()" (ngModelChange)="to.set($event); preview.set(null)" />
            </label>
            @if (kind() === 'mifir-rts22') {
              <label class="field">
                <span class="label">Trading capacity (field 29)</span>
                <select class="input" name="capacity" [ngModel]="capacity()" (ngModelChange)="capacity.set($event); preview.set(null)">
                  <option value="AOTC">AOTC — any other capacity</option>
                  <option value="DEAL">DEAL — own account</option>
                  <option value="MTCH">MTCH — matched principal</option>
                </select>
              </label>
            }
            @if (kind() !== 'rts28-venues') {
              <label class="field">
                <span class="label">Format</span>
                <select class="input" name="format" [ngModel]="format()" (ngModelChange)="format.set($event)">
                  <option value="csv">CSV</option>
                  <option value="xml">CSV + ISO 20022-shaped XML</option>
                </select>
              </label>
            }
            <label class="check">
              <input type="checkbox" name="demo" [ngModel]="includeDemo()" (ngModelChange)="includeDemo.set($event); preview.set(null)" />
              Include demo accounts (to check the shape only — never to file)
            </label>
          </div>
          <div class="go">
            <button type="button" class="btn btn-secondary" [disabled]="busy()" (click)="validate()">Validate</button>
            <button type="button" class="btn btn-primary" [disabled]="busy() || !preview()" (click)="download()">
              {{ busy() ? 'Working…' : '⤓ Download signed file' }}
            </button>
            @if (!preview()) {
              <span class="hint">Validate first: you see what is missing before a file is made.</span>
            }
          </div>
          @if (error()) {
            <p class="alert" role="alert">{{ error() }}</p>
          }

          @if (preview(); as p) {
            <div class="result" [class.ok]="p.complete" [class.bad]="!p.complete">
              <strong>{{ p.complete ? 'Every field the engine fills is present and valid' : p.errors + ' error(s) to fix before filing' }}</strong>
              · {{ p.records }} record(s) · {{ p.warnings }} warning(s)
              · {{ p.canSign ? 'the file will be signed' : 'hash only — no signing key on the engine host' }}
            </div>
            <p class="small">{{ p.schemaNote }}</p>
            @for (n of p.notes; track n) {
              <p class="small">• {{ n }}</p>
            }
            @if (p.issues.length) {
              <div class="table-wrap">
                <table class="grid">
                  <thead>
                    <tr><th>Severity</th><th>Record</th><th>Field</th><th>Problem</th></tr>
                  </thead>
                  <tbody>
                    @for (i of p.issues; track $index) {
                      <tr [class.bad]="i.severity === 'error'">
                        <td>{{ i.severity }}</td>
                        <td class="mono">{{ i.record }}</td>
                        <td class="mono">{{ i.field }}</td>
                        <td>{{ i.message }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
              @if (p.issuesOmitted) {
                <p class="small">{{ p.issuesOmitted }} more in the file's validation.csv.</p>
              }
            }
            @if (p.sample.length) {
              <details class="sample">
                <summary>First {{ p.sample.length }} record(s)</summary>
                <div class="table-wrap">
                  <table class="grid small">
                    <thead>
                      <tr>
                        @for (c of p.columns; track c) {
                          <th>{{ c }}</th>
                        }
                      </tr>
                    </thead>
                    <tbody>
                      @for (r of p.sample; track $index) {
                        <tr>
                          @for (c of p.columns; track c) {
                            <td>{{ r[c] ?? '' }}</td>
                          }
                        </tr>
                      }
                    </tbody>
                  </table>
                </div>
              </details>
            }
          }
          @if (last(); as f) {
            <div class="receipt" role="status">
              <strong>{{ f.fileName }}</strong> downloaded and registered.
              <div class="mono small">SHA-256 {{ f.sha256 }}</div>
              @if (f.signature) {
                <div class="mono small">Signature (key {{ f.signingKeyId }}) {{ short(f.signature) }}</div>
              }
              <a routerLink="/fund/compliance" class="small">Check a copy in the compliance export register →</a>
            </div>
          }
        </section>

        <!-- ── Reference data ─────────────────────── -->
        <section class="card">
          <div class="card-head">
            <h3>The organisation</h3>
            @if (reference.value()?.firm?.updatedAtUtc; as at) {
              <span class="hint">changed {{ at.slice(0, 16).replace('T', ' ') }} UTC by {{ reference.value()?.firm?.updatedBy }}</span>
            }
          </div>
          <div class="form">
            <label class="field">
              <span class="label">LEI (ISO 17442)</span>
              <input class="input mono" name="firmLei" [ngModel]="firm().firmLei" (ngModelChange)="patchFirm({ firmLei: $event })" />
              @if (lei(firm().firmLei); as p) {
                <span class="bad small">{{ p }}</span>
              }
            </label>
            <label class="field">
              <span class="label">Country (ISO 3166, 2 letters)</span>
              <input class="input" maxlength="2" name="firmCountry" [ngModel]="firm().firmCountry" (ngModelChange)="patchFirm({ firmCountry: $event })" />
            </label>
            <label class="field">
              <span class="label">Default venue (MIC)</span>
              <input class="input" maxlength="4" name="mic" [ngModel]="firm().defaultVenueMic" (ngModelChange)="patchFirm({ defaultVenueMic: $event })" />
            </label>
            <label class="check">
              <input type="checkbox" name="mifid" [ngModel]="firm().investmentFirmCoveredByMifid" (ngModelChange)="patchFirm({ investmentFirmCoveredByMifid: $event })" />
              Investment firm covered by MiFID II
            </label>
            <label class="field">
              <span class="label">Investment decision (field 57)</span>
              <input class="input" name="inv" [ngModel]="firm().investmentDecisionCode" (ngModelChange)="patchFirm({ investmentDecisionCode: $event })" />
            </label>
            <label class="check">
              <input type="checkbox" name="invAlgo" [ngModel]="firm().investmentDecisionIsAlgorithm" (ngModelChange)="patchFirm({ investmentDecisionIsAlgorithm: $event })" />
              an algorithm
            </label>
            <label class="field">
              <span class="label">Execution within firm (field 59)</span>
              <input class="input" name="exec" [ngModel]="firm().executionDecisionCode" (ngModelChange)="patchFirm({ executionDecisionCode: $event })" />
            </label>
            <label class="check">
              <input type="checkbox" name="execAlgo" [ngModel]="firm().executionDecisionIsAlgorithm" (ngModelChange)="patchFirm({ executionDecisionIsAlgorithm: $event })" />
              an algorithm
            </label>
            <label class="field">
              <span class="label">EMIR nature of counterparty</span>
              <select class="input" name="nature" [ngModel]="firm().emirCounterpartyNature" (ngModelChange)="patchFirm({ emirCounterpartyNature: $event })">
                <option [ngValue]="null">—</option>
                <option value="F">F — financial</option>
                <option value="N">N — non-financial</option>
                <option value="C">C — CCP</option>
                <option value="O">O — other</option>
              </select>
            </label>
            <label class="field">
              <span class="label">EMIR corporate sector</span>
              <input class="input" name="sector" [ngModel]="firm().emirCorporateSector" (ngModelChange)="patchFirm({ emirCorporateSector: $event })" />
            </label>
          </div>
          <div class="go">
            <button type="button" class="btn btn-primary" [disabled]="saving() || !!lei(firm().firmLei)" (click)="saveFirm()">Save</button>
          </div>
          @if (reference.value(); as r) {
            @if (r.problems.length) {
              <ul class="problems">
                @for (p of r.problems; track p.field) {
                  <li><span class="mono">{{ p.field }}</span>: {{ p.problem }}</li>
                }
              </ul>
            } @else {
              <p class="ok-line">Reference data complete.</p>
            }
          }
        </section>

        <section class="card">
          <div class="card-head">
            <h3>Accounts: clients and counterparties</h3>
            <span class="hint">the client identifier is personal data — kept out of the LLM SQL tool</span>
          </div>
          <div class="table-wrap">
            <table class="grid">
              <thead>
                <tr><th>Account</th><th>Type</th><th>Client id type</th><th>Client identifier</th><th>Client country</th><th>Counterparty (broker) LEI</th><th>Venue MIC</th><th></th></tr>
              </thead>
              <tbody>
                @for (a of accounts(); track a.tradingAccountId) {
                  <tr>
                    <td>{{ a.account }}<div class="small">{{ a.brokerServer }}</div></td>
                    <td>{{ a.accountType }}</td>
                    <td>
                      <select class="input" [name]="'t' + a.tradingAccountId" [ngModel]="a.clientIdType" (ngModelChange)="patchAccount(a.tradingAccountId, { clientIdType: $event })">
                        @for (t of idTypes; track t) {
                          <option [value]="t">{{ t }}</option>
                        }
                      </select>
                    </td>
                    <td><input class="input mono" [name]="'c' + a.tradingAccountId" [ngModel]="a.clientIdentifier" (ngModelChange)="patchAccount(a.tradingAccountId, { clientIdentifier: $event })" /></td>
                    <td><input class="input narrow" maxlength="2" [name]="'n' + a.tradingAccountId" [ngModel]="a.clientCountry" (ngModelChange)="patchAccount(a.tradingAccountId, { clientCountry: $event })" /></td>
                    <td>
                      <input class="input mono" [name]="'l' + a.tradingAccountId" [ngModel]="a.counterpartyLei" (ngModelChange)="patchAccount(a.tradingAccountId, { counterpartyLei: $event })" />
                      @if (lei(a.counterpartyLei); as p) {
                        <div class="bad small">{{ p }}</div>
                      }
                    </td>
                    <td><input class="input narrow" maxlength="4" [name]="'m' + a.tradingAccountId" [ngModel]="a.venueMic" (ngModelChange)="patchAccount(a.tradingAccountId, { venueMic: $event })" /></td>
                    <td>
                      <button type="button" class="btn btn-sm btn-secondary" [disabled]="saving() || !!lei(a.counterpartyLei)" (click)="saveAccount(a)">Save</button>
                    </td>
                  </tr>
                } @empty {
                  <tr><td colspan="8" class="empty">No live trading accounts in the organisation yet.</td></tr>
                }
              </tbody>
            </table>
          </div>
        </section>
      }
    </div>
  `,
})
export class RegulatoryPageComponent {
  private readonly fund = inject(FundApiService);

  protected readonly kinds = KINDS;
  protected readonly idTypes: ClientIdType[] = ['Lei', 'NationalId', 'Concat'];
  protected readonly lei = leiProblem;
  protected readonly short = shortHash;
  protected readonly defaultNotice =
    'The engine never submits anything to a regulator, an ARM or a trade repository; filing remains your responsibility.';

  readonly kind = signal<RegulatoryKind>('mifir-rts22');
  readonly from = signal(defaultPeriod(new Date(), 7).from);
  readonly to = signal(defaultPeriod(new Date(), 7).to);
  readonly capacity = signal('AOTC');
  readonly format = signal<'csv' | 'xml'>('csv');
  readonly includeDemo = signal(false);
  readonly busy = signal(false);
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);
  readonly upgrade = signal<string | null>(null);
  readonly preview = signal<RegulatoryPreview | null>(null);
  readonly last = signal<DownloadedFile | null>(null);
  readonly firm = signal<RegulatoryFirm>(EMPTY_FIRM);
  readonly accountEdits = signal<Record<number, Partial<RegulatoryAccount>>>({});

  readonly reference = iamResource<RegulatoryReferenceData | null>(
    () => this.fund.regulatoryReference(),
    null,
    'Could not load the reference data.',
  );
  readonly accounts = computed(() =>
    (this.reference.value()?.accounts ?? []).map((a) => ({ ...a, ...(this.accountEdits()[a.tradingAccountId] ?? {}) })),
  );

  constructor() {
    this.loadReference();
  }

  private loadReference(): void {
    this.fund.regulatoryReference().subscribe({
      next: (r) => {
        this.reference.value.set(r);
        this.reference.loaded.set(true);
        this.firm.set({ ...r.firm });
        this.accountEdits.set({});
      },
      error: (e) => {
        if (isUpgradeNotice(e)) this.upgrade.set(errorText(e, 'Your plan does not include the fund module.'));
        else this.reference.error.set(errorText(e, 'Could not load the reference data.'));
      },
    });
  }

  setKind(k: RegulatoryKind): void {
    this.kind.set(k);
    if (k === 'rts28-venues') this.format.set('csv');
    this.preview.set(null);
  }

  patchFirm(patch: Partial<RegulatoryFirm>): void {
    this.firm.update((f) => ({ ...f, ...patch }));
  }

  patchAccount(id: number, patch: Partial<RegulatoryAccount>): void {
    this.accountEdits.update((e) => ({ ...e, [id]: { ...(e[id] ?? {}), ...patch } }));
  }

  private applyReference(r: RegulatoryReferenceData): void {
    this.reference.value.set(r);
    this.firm.set({ ...r.firm });
    this.accountEdits.set({});
    this.saving.set(false);
    this.preview.set(null);
  }

  saveFirm(): void {
    this.saving.set(true);
    this.error.set(null);
    this.fund.updateRegulatoryFirm(this.firm()).subscribe({
      next: (r) => this.applyReference(r),
      error: (e) => {
        this.saving.set(false);
        this.error.set(errorText(e, 'The reference data was not saved.'));
      },
    });
  }

  saveAccount(a: RegulatoryAccount): void {
    this.saving.set(true);
    this.error.set(null);
    this.fund
      .updateRegulatoryAccount(a.tradingAccountId, {
        clientIdType: a.clientIdType,
        clientIdentifier: a.clientIdentifier,
        clientCountry: a.clientCountry,
        counterpartyLei: a.counterpartyLei,
        venueMic: a.venueMic,
      })
      .subscribe({
        next: (r) => this.applyReference(r),
        error: (e) => {
          this.saving.set(false);
          this.error.set(errorText(e, 'The account was not saved.'));
        },
      });
  }

  private period(): { from: string; to: string } | null {
    const p = periodQuery(this.from(), this.to());
    if ('problem' in p) {
      this.error.set(p.problem);
      return null;
    }
    return p;
  }

  validate(): void {
    const p = this.period();
    if (!p) return;
    this.busy.set(true);
    this.error.set(null);
    this.fund
      .regulatoryPreview({ kind: this.kind(), from: p.from, to: p.to, includeDemo: this.includeDemo(), tradingCapacity: this.capacity() })
      .subscribe({
        next: (r) => {
          this.busy.set(false);
          this.preview.set(r);
        },
        error: (e) => {
          this.busy.set(false);
          if (isUpgradeNotice(e)) this.upgrade.set(errorText(e, 'Your plan does not include the fund module.'));
          else this.error.set(errorText(e, 'The validation failed.'));
        },
      });
  }

  download(): void {
    const p = this.period();
    if (!p) return;
    this.busy.set(true);
    this.error.set(null);
    this.fund
      .downloadRegulatory({
        kind: this.kind(),
        from: p.from,
        to: p.to,
        format: this.kind() === 'rts28-venues' ? 'csv' : this.format(),
        includeDemo: this.includeDemo(),
        tradingCapacity: this.capacity(),
      })
      .subscribe({
        next: (file) => {
          this.busy.set(false);
          this.last.set(file);
          saveBlob(file.blob, file.fileName);
        },
        error: (e) => {
          this.busy.set(false);
          this.error.set(errorText(e, 'The report was not generated.'));
        },
      });
  }
}
