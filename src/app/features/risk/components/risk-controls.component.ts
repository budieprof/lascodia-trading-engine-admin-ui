import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import type { Observable } from 'rxjs';

import { AuthService } from '@core/auth/auth.service';
import { ConfigService, isQueuedForCoolingOff } from '@core/services/config.service';
import { ModalA11yDirective } from '@shared/directives/modal-a11y.directive';
import { OrganisationApiService } from '@features/organisation/organisation-api.service';
import { failureMessage } from '@features/organisation/organisation.logic';

import { RiskApiService } from '../risk-api.service';
import { decisionContext, groupSettings, isLoosening, jobTone, organisationValueAllowed, settingError, verdictLabel, verdictTone } from '../risk.logic';
import type { RiskJob, RiskSetting, StressDecision } from '../risk.types';

interface Edit {
  setting: RiskSetting;
  layer: 'Platform' | 'Organisation';
  value: string;
  reason: string;
}

/**
 * Console operability of the risk vertical (gaps program "Console operability"): every risk setting as a typed control
 * (current / default / last change, written through the existing audited paths — `PUT config` for the engine-wide value,
 * `PUT config/overrides` for an organisation's tighter value), the stress pre-trade check's recorded verdicts (judge the
 * Observe log before switching to Enforce), and the two risk workers with last run / result / next run and run-now.
 */
@Component({
  selector: 'app-risk-controls',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, FormsModule, RouterLink, ModalA11yDirective],
  styleUrl: '../risk.scss',
  template: `
    @if (message(); as m) { <p class="small" role="status">{{ m }}</p> }

    <section class="card" aria-labelledby="jobs-title">
      <header class="card-head"><h3 id="jobs-title">Risk workers</h3>
        <button type="button" class="btn btn-secondary btn-sm" (click)="loadJobs()">Refresh</button></header>
      <div class="table-wrap">
        <table class="grid">
          <thead><tr><th>Worker</th><th>State</th><th>Last run</th><th>Result</th><th>Next run</th><th>Last error</th><th></th></tr></thead>
          <tbody>
            @for (j of jobs(); track j.name) {
              <tr>
                <td><strong>{{ j.name }}</strong><div class="small muted">{{ j.purpose }}</div>
                  @if (j.operatorNote) { <div class="small">Operator step: {{ j.operatorNote }}</div> }</td>
                <td><span [class]="'chip ' + jTone(j)">{{ !j.enabled ? 'Off' : j.consecutiveFailures > 0 ? j.consecutiveFailures + ' failure(s)' : (j.lastStatus ?? '—') }}</span></td>
                <td class="small">{{ j.lastRunAtUtc ? (j.lastRunAtUtc | date: 'd MMM, HH:mm:ss') : 'never' }}</td>
                <td class="small">{{ j.lastResult ?? '—' }}</td>
                <td class="small">{{ j.nextRunAtUtc ? (j.nextRunAtUtc | date: 'd MMM, HH:mm') : '—' }}</td>
                <td class="small">{{ j.lastError ? (j.lastErrorAtUtc | date: 'd MMM, HH:mm') + ' — ' + j.lastError : '—' }}</td>
                <td>
                  @if (canManage()) {
                    <button type="button" class="btn btn-primary btn-sm" [disabled]="running() === j.name" (click)="confirmRun.set(j)" [title]="j.runNow">
                      {{ running() === j.name ? 'Running…' : 'Run now' }}</button>
                  } @else { <span class="small muted">needs {{ j.runNowPermission }}</span> }
                </td>
              </tr>
            } @empty { <tr><td colspan="7" class="muted">{{ jobsError() ?? 'Loading…' }}</td></tr> }
          </tbody>
        </table>
      </div>
    </section>

    <section class="card" aria-labelledby="dec-title">
      <header class="card-head"><h3 id="dec-title">Stress pre-trade check — recorded verdicts</h3>
        <div class="toolbar">
          @for (o of outcomes; track o.value) {
            <button type="button" class="btn btn-sm" [class.btn-primary]="outcome() === o.value" [class.btn-secondary]="outcome() !== o.value" (click)="setOutcome(o.value)">{{ o.label }}</button>
          }
        </div></header>
      <p class="pad small muted">
        Last 7 days:
        @for (k of summaryKeys(); track k) { <span [class]="'chip ' + vTone(k)">{{ vLabel(k) }}: {{ summary()[k] }}</span> } @empty { no verdict recorded — every evaluated trade passed both limits, or the check is Off. }
        In Observe these trades were NOT blocked; this is what Enforce would have done.
      </p>
      <div class="table-wrap">
        <table class="grid">
          <thead><tr><th>When</th><th>Signal</th><th>Verdict</th><th>Why</th><th class="num">Lots → max</th></tr></thead>
          <tbody>
            @for (d of decisions(); track d.id) {
              <tr>
                <td class="small">{{ d.createdAt | date: 'd MMM, HH:mm:ss' }}</td>
                <td><a [routerLink]="['/trade-signals', d.tradeSignalId]">#{{ d.tradeSignalId }}</a></td>
                <td><span [class]="'chip ' + vTone(d.outcome)">{{ vLabel(d.outcome) }}</span></td>
                <td class="small">{{ d.reason }}</td>
                <td class="num small">{{ ctx(d)?.['lots'] ?? '—' }} → {{ ctx(d)?.['maxLots'] ?? '—' }}</td>
              </tr>
            } @empty { <tr><td colspan="5" class="muted">No recorded verdict{{ outcome() ? ' of this kind' : '' }}.</td></tr> }
          </tbody>
        </table>
      </div>
      <div class="toolbar">
        <button type="button" class="btn btn-secondary btn-sm" [disabled]="page() <= 1" (click)="goPage(page() - 1)">Previous</button>
        <span class="small">Page {{ page() }}</span>
        <button type="button" class="btn btn-secondary btn-sm" [disabled]="decisions().length < pageSize" (click)="goPage(page() + 1)">Next</button>
      </div>
    </section>

    @for (g of groups(); track g.group) {
      <section class="card" [attr.aria-label]="g.group + ' settings'">
        <header class="card-head"><h3>{{ g.group }}</h3></header>
        <div class="table-wrap">
          <table class="grid">
            <thead><tr><th>Setting</th><th>In effect</th><th>Default</th><th>Engine-wide</th><th>Organisation</th><th>Last change</th><th></th></tr></thead>
            <tbody>
              @for (s of g.items; track s.key) {
                <tr>
                  <td><strong>{{ s.label }}</strong> <code class="small">{{ s.key }}</code><div class="small muted">{{ s.description }}</div></td>
                  <td><strong>{{ show(s, s.effectiveValue) }}</strong> <span class="small muted">({{ s.effectiveSource }})</span></td>
                  <td class="small">{{ show(s, s.defaultValue) }}</td>
                  <td class="small">{{ s.platformValue !== null ? show(s, s.platformValue) : 'not set' }}</td>
                  <td class="small">{{ !s.layered ? '—' : s.organisationValue !== null ? show(s, s.organisationValue) : 'inherits' }}</td>
                  <td class="small">{{ s.lastChangedAtUtc ? (s.lastChangedAtUtc | date: 'd MMM yyyy, HH:mm') + ' · ' + s.lastChangedBy + ' (' + s.lastChangedLayer + '): ' + (s.lastOldValue ?? '∅') + ' → ' + (s.lastNewValue ?? '∅') : 'never changed' }}</td>
                  <td>
                    @if (has(s.platformWritePermission)) { <button type="button" class="btn btn-secondary btn-sm" (click)="startEdit(s, 'Platform')">Change engine-wide</button> }
                    @if (s.layered && s.organisationWritePermission && has(s.organisationWritePermission)) {
                      <button type="button" class="btn btn-secondary btn-sm" (click)="startEdit(s, 'Organisation')">Set for organisation</button>
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      </section>
    } @empty {
      <section class="card"><p class="pad muted">{{ settingsError() ?? 'Loading settings…' }}</p></section>
    }

    @if (edit(); as e) {
      <div class="modal-backdrop">
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="edit-title" appModalA11y (dismiss)="edit.set(null)">
          <h3 id="edit-title">{{ e.setting.label }} — {{ e.layer === 'Platform' ? 'engine-wide value' : 'this organisation' }}</h3>
          <p class="small muted">{{ e.setting.description }}</p>
          <label class="field"><span class="label">Value{{ e.setting.unit ? ' (' + e.setting.unit + ')' : '' }}</span>
            @switch (e.setting.kind) {
              @case ('Bool') { <select class="select" [(ngModel)]="e.value"><option value="true">On</option><option value="false">Off</option></select> }
              @case ('Enum') { <select class="select" [(ngModel)]="e.value">@for (v of e.setting.allowedValues; track v) { <option [value]="v">{{ v }}</option> }</select> }
              @default { <input class="input" type="number" [(ngModel)]="e.value" [attr.min]="e.setting.min" [attr.max]="e.setting.max" /> }
            }
          </label>
          <label class="field"><span class="label">Reason (recorded in the audit trail{{ loosens(e) ? '; required — this loosens a risk limit' : '' }})</span>
            <textarea class="textarea" [(ngModel)]="e.reason" maxlength="500"></textarea></label>
          @if (editProblem(e); as p) { <p class="small neg">{{ p }}</p> }
          @if (loosens(e)) { <p class="note warn small">This loosens a risk limit: the engine may hold it for the cooling-off period or ask a second person to approve.</p> }
          @if (e.setting.key === 'Risk:Stress:Mode' && e.value === 'Enforce') {
            <p class="note warn small">Enforce makes the check reject or cut trades. Review the recorded Observe verdicts above first.</p>
          }
          <div class="actions-row">
            <button type="button" class="btn btn-secondary" data-autofocus (click)="edit.set(null)">Cancel</button>
            <button type="button" class="btn btn-primary" [disabled]="saving() || !!editProblem(e)" (click)="save(e)">{{ saving() ? 'Saving…' : 'Save change' }}</button>
          </div>
        </div>
      </div>
    }

    @if (confirmRun(); as j) {
      <div class="modal-backdrop">
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="run-title" appModalA11y (dismiss)="confirmRun.set(null)">
          <h3 id="run-title">Run {{ j.name }} now?</h3>
          <p>{{ j.runNow }}</p>
          <div class="actions-row">
            <button type="button" class="btn btn-secondary" data-autofocus (click)="confirmRun.set(null)">Cancel</button>
            <button type="button" class="btn btn-primary" (click)="runNow(j)">Run now</button>
          </div>
        </div>
      </div>
    }
  `,
})
export class RiskControlsComponent {
  private readonly api = inject(RiskApiService);
  private readonly config = inject(ConfigService);
  private readonly org = inject(OrganisationApiService);
  private readonly auth = inject(AuthService);

  readonly canManage = input(false);
  readonly changed = output<void>();

  readonly settings = signal<RiskSetting[]>([]);
  readonly settingsError = signal<string | null>(null);
  readonly groups = computed(() => groupSettings(this.settings()));
  readonly jobs = signal<RiskJob[]>([]);
  readonly jobsError = signal<string | null>(null);
  readonly decisions = signal<StressDecision[]>([]);
  readonly summary = signal<Record<string, number>>({});
  readonly summaryKeys = computed(() => Object.keys(this.summary()));
  readonly outcome = signal<string | null>(null);
  readonly page = signal(1);
  readonly pageSize = 25;
  readonly edit = signal<Edit | null>(null);
  readonly saving = signal(false);
  readonly running = signal<string | null>(null);
  readonly confirmRun = signal<RiskJob | null>(null);
  readonly message = signal<string | null>(null);

  protected readonly outcomes = [
    { label: 'All', value: null as string | null },
    { label: 'Would reject', value: 'WouldReject' },
    { label: 'Would cut size', value: 'WouldShrink' },
    { label: 'Rejected', value: 'Rejected' },
    { label: 'Size cut', value: 'Shrunk' },
  ];

  constructor() {
    this.loadSettings();
    this.loadJobs();
    this.loadDecisions();
  }

  loadSettings(): void {
    this.api.settings().subscribe({
      next: (s) => this.settings.set(s),
      error: () => this.settingsError.set('The risk settings did not load.'),
    });
  }

  loadJobs(): void {
    this.api.jobs().subscribe({
      next: (j) => this.jobs.set(j),
      error: () => this.jobsError.set('The worker status did not load.'),
    });
  }

  loadDecisions(): void {
    this.api.decisions(this.page(), this.pageSize, this.outcome()).subscribe({
      next: (p) => this.decisions.set(p.data ?? []),
      error: () => this.decisions.set([]),
    });
    this.api.decisionSummary(7).subscribe({ next: (s) => this.summary.set(s), error: () => this.summary.set({}) });
  }

  setOutcome(o: string | null): void {
    this.outcome.set(o);
    this.page.set(1);
    this.loadDecisions();
  }

  goPage(p: number): void {
    this.page.set(p);
    this.loadDecisions();
  }

  startEdit(s: RiskSetting, layer: 'Platform' | 'Organisation'): void {
    const current = layer === 'Platform' ? (s.platformValue ?? s.defaultValue) : (s.organisationValue ?? s.effectiveValue);
    this.edit.set({ setting: s, layer, value: current, reason: '' });
  }

  protected loosens(e: Edit): boolean {
    const current = e.layer === 'Platform' ? (e.setting.platformValue ?? e.setting.defaultValue) : e.setting.effectiveValue;
    return isLoosening(e.setting, current, e.value) === true;
  }

  protected editProblem(e: Edit): string | null {
    const err = settingError(e.setting, String(e.value));
    if (err) return err;
    if (e.layer === 'Organisation' && !organisationValueAllowed(e.setting, String(e.value)))
      return 'An organisation may only tighten this limit: the value must be at least as strict as the engine-wide one.';
    if (this.loosens(e) && !e.reason.trim()) return 'Give a reason for loosening a risk limit.';
    return null;
  }

  save(e: Edit): void {
    this.saving.set(true);
    const value = String(e.value).trim();
    const done = (msg: string) => {
      this.saving.set(false);
      this.edit.set(null);
      this.message.set(msg);
      this.loadSettings();
      this.changed.emit();
    };
    const fail = (err: unknown) => {
      this.saving.set(false);
      const m = failureMessage(err, 'The change was not saved.');
      this.message.set(m ?? 'The change was sent for approval by a second person.');
      this.edit.set(null);
    };
    if (e.layer === 'Platform') {
      this.config
        .upsert({ key: e.setting.key, value, dataType: e.setting.dataType, isHotReloadable: true, reason: e.reason.trim() || null })
        .subscribe({
          next: (res) => {
            if (!res.status) return fail({ code: res.responseCode, message: res.message });
            done(isQueuedForCoolingOff(res) ? 'Queued for the cooling-off period: it takes effect later (see Engine config → pending).' : 'Saved.');
          },
          error: fail,
        });
    } else {
      this.org.setOverride({ scopeType: 'Tenant', key: e.setting.key, value, reason: e.reason.trim() || undefined }).subscribe({
        next: (res) => done(res.outcome === 'QueuedForCoolingOff' ? 'Queued for the cooling-off period.' : (res.message ?? 'Saved.')),
        error: fail,
      });
    }
  }

  runNow(j: RiskJob): void {
    this.confirmRun.set(null);
    this.running.set(j.name);
    const call: Observable<unknown> = j.name === 'StressTestWorker' ? this.api.runStress(null, null) : this.api.snapshotNow(null);
    call.subscribe({
      next: (r) => {
        this.running.set(null);
        this.message.set(Array.isArray(r) ? `${r.length} stress test(s) run.` : `${r} snapshot(s) stored.`);
        this.loadJobs();
        this.changed.emit();
      },
      error: (err: unknown) => {
        this.running.set(null);
        this.message.set(failureMessage(err, 'The run did not complete.'));
      },
    });
  }

  protected has(key: string): boolean {
    return this.auth.hasPermission(key);
  }
  protected show(s: RiskSetting, v: string): string {
    if (s.kind === 'Bool') return v === 'true' ? 'On' : 'Off';
    return s.unit ? `${v} ${s.unit}` : v;
  }
  protected jTone = (j: RiskJob) => jobTone(j);
  protected vTone = verdictTone;
  protected vLabel = verdictLabel;
  protected ctx(d: StressDecision): Record<string, unknown> | null {
    return decisionContext(d.contextJson);
  }
}
