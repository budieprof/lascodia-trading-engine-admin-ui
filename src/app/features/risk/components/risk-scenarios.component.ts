import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { Observable } from 'rxjs';

import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { ModalA11yDirective } from '@shared/directives/modal-a11y.directive';
import { failureMessage } from '@features/organisation/organisation.logic';

import { RiskApiService } from '../risk-api.service';
import { definitionJson, emptyScenarioForm, formFromDefinition, scenarioFormProblems, type ScenarioForm, type ShockRow } from '../risk.logic';
import type { ScenarioType, StressScenario } from '../risk.types';

/**
 * The stress scenario library: the platform's seeded scenarios (read-only for an organisation; platform staff can switch
 * one off for everyone) and the organisation's own (create, edit, copy, delete). The editor builds the shock definition
 * from rows; the engine validates it again and answers in its own words.
 */
@Component({
  selector: 'app-risk-scenarios',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, ConfirmDialogComponent, ModalA11yDirective],
  styleUrl: '../risk.scss',
  template: `
    <section class="card" aria-labelledby="lib-title">
      <header class="card-head">
        <h3 id="lib-title">Scenario library</h3>
        @if (canManage()) { <button type="button" class="btn btn-primary btn-sm" (click)="openEditor(null)">New scenario</button> }
      </header>
      @if (message(); as m) { <p class="pad small" role="status">{{ m }}</p> }
      @if (error()) { <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ error() }}</p> }
      <div class="table-wrap">
        <table class="grid">
          <thead><tr><th>Scenario</th><th>Type</th><th>Shocks</th><th>Owner</th><th>Active</th><th></th></tr></thead>
          <tbody>
            @for (s of scenarios(); track s.id) {
              <tr>
                <td><strong>{{ s.name }}</strong>
                  @if (s.description) { <div class="small muted">{{ s.description }}</div> }
                  @if (s.source) { <div class="small">Source: {{ s.source }}</div> }
                  @for (p of s.problems; track p) { <div class="small neg">{{ p }}</div> }
                </td>
                <td>{{ s.scenarioType }}</td>
                <td class="small">{{ shockSummary(s) }}</td>
                <td><span [class]="'chip ' + (s.ownership === 'Platform' ? 'info' : 'ok')">{{ s.ownership === 'Platform' ? 'Platform library' : 'Organisation' }}</span></td>
                <td>
                  @if (s.ownership === 'Platform' && canManagePlatform()) {
                    <button type="button" class="btn btn-secondary btn-sm" (click)="askToggle(s)">{{ s.isActive ? 'On — switch off' : 'Off — switch on' }}</button>
                  } @else {
                    <span [class]="'chip ' + (s.isActive ? 'ok' : 'muted')">{{ s.isActive ? 'On' : 'Off' }}</span>
                  }
                </td>
                <td>
                  @if (canManage()) {
                    @if (s.ownership === 'Organisation') {
                      <button type="button" class="btn btn-secondary btn-sm" (click)="openEditor(s)">Edit</button>
                      <button type="button" class="btn btn-danger btn-sm" (click)="deleting.set(s)">Delete</button>
                    } @else {
                      <button type="button" class="btn btn-secondary btn-sm" (click)="copy(s)">Copy</button>
                    }
                  }
                </td>
              </tr>
            } @empty {
              <tr><td colspan="6" class="muted">{{ loading() ? 'Loading…' : 'No scenarios. The engine seeds its library at start-up.' }}</td></tr>
            }
          </tbody>
        </table>
      </div>
    </section>

    @if (form(); as f) {
      <div class="modal-backdrop">
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="ed-title" appModalA11y (dismiss)="form.set(null)">
          <h3 id="ed-title">{{ editingId() ? 'Edit scenario' : 'New scenario' }}</h3>
          <div class="form-grid">
            <label class="field"><span class="label">Name</span><input class="input" [(ngModel)]="f.name" maxlength="200" /></label>
            <label class="field"><span class="label">Type</span>
              <select class="select" [(ngModel)]="f.scenarioType">
                @for (t of types; track t) { <option [value]="t">{{ t }}</option> }
              </select></label>
            @if (f.scenarioType === 'Historical') {
              <label class="field"><span class="label">From (UTC date)</span><input class="input" type="date" [(ngModel)]="f.dateFrom" /></label>
              <label class="field"><span class="label">To (UTC date)</span><input class="input" type="date" [(ngModel)]="f.dateTo" /></label>
            }
            @if (f.scenarioType === 'ReverseStress') {
              <label class="field"><span class="label">Target loss (% of equity)</span><input class="input" type="number" [(ngModel)]="f.targetLossPct" min="1" max="99" /></label>
            }
            <label class="field"><span class="label">Active</span><input type="checkbox" [(ngModel)]="f.isActive" /></label>
          </div>
          @if (f.scenarioType !== 'ReverseStress') {
            <p class="small muted">
              {{ f.scenarioType === 'Historical' ? 'Symbols with stored daily candles over the window replay them; the shocks below are the fallback for every other symbol.' : '' }}
              Currency shocks move a currency against USD (a pair moves (1 + base) ÷ (1 + quote) − 1); a symbol shock wins over everything; asset-class shocks move every Index / Commodity / Crypto symbol.
            </p>
            <table class="grid">
              <thead><tr><th>Kind</th><th>Currency / symbol / class</th><th class="num">Move %</th><th></th></tr></thead>
              <tbody>
                @for (r of f.rows; track $index) {
                  <tr>
                    <td><select class="select" [(ngModel)]="r.kind" [attr.aria-label]="'Kind of shock ' + ($index + 1)">
                      <option value="currency">Currency</option><option value="symbol">Symbol</option><option value="assetClass">Asset class</option></select></td>
                    <td><input class="input" [(ngModel)]="r.key" [attr.aria-label]="'Target of shock ' + ($index + 1)" /></td>
                    <td><input class="input num" type="number" step="0.1" [(ngModel)]="r.pctChange" [attr.aria-label]="'Move of shock ' + ($index + 1)" /></td>
                    <td><button type="button" class="btn btn-secondary btn-sm" (click)="removeRow(f, $index)">Remove</button></td>
                  </tr>
                }
              </tbody>
            </table>
            <button type="button" class="btn btn-secondary btn-sm" (click)="addRow(f)">Add shock</button>
          }
          <label class="field"><span class="label">Description</span><textarea class="textarea" [(ngModel)]="f.description" maxlength="1000"></textarea></label>
          <label class="field"><span class="label">Source of the numbers</span><textarea class="textarea" [(ngModel)]="f.source" maxlength="1000" placeholder="e.g. close-to-close moves of the event window, or 'hypothetical'"></textarea></label>
          @for (p of problems(f); track p) { <p class="small neg">{{ p }}</p> }
          @if (saveError()) { <p class="small neg" role="alert">{{ saveError() }}</p> }
          <div class="actions-row">
            <button type="button" class="btn btn-secondary" data-autofocus (click)="form.set(null)">Cancel</button>
            <button type="button" class="btn btn-primary" [disabled]="saving() || problems(f).length > 0" (click)="save(f)">{{ saving() ? 'Saving…' : 'Save' }}</button>
          </div>
        </div>
      </div>
    }

    <app-confirm-dialog
      [open]="deleting() !== null"
      title="Delete this scenario?"
      [message]="'“' + (deleting()?.name ?? '') + '” leaves the library; its past results stay.'"
      confirmLabel="Delete"
      confirmVariant="destructive"
      (confirm)="remove()"
      (cancelled)="deleting.set(null)"
    />
    <app-confirm-dialog
      [open]="toggling() !== null"
      [title]="toggling()?.isActive ? 'Switch this library scenario off for every organisation?' : 'Switch this library scenario on for every organisation?'"
      [message]="'“' + (toggling()?.name ?? '') + '” is part of the platform library: the change applies to every organisation\\'s stress tests and pre-trade check.'"
      confirmLabel="Confirm"
      (confirm)="toggle()"
      (cancelled)="toggling.set(null)"
    />
  `,
})
export class RiskScenariosComponent {
  private readonly api = inject(RiskApiService);

  readonly canManage = input(false);
  readonly canManagePlatform = input(false);

  protected readonly types: ScenarioType[] = ['Hypothetical', 'Historical', 'ReverseStress'];
  readonly scenarios = signal<StressScenario[]>([]);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly message = signal<string | null>(null);
  readonly form = signal<ScenarioForm | null>(null);
  readonly editingId = signal<number | null>(null);
  readonly saving = signal(false);
  readonly saveError = signal<string | null>(null);
  readonly deleting = signal<StressScenario | null>(null);
  readonly toggling = signal<StressScenario | null>(null);
  readonly count = computed(() => this.scenarios().length);

  constructor() {
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.api.scenarios().subscribe({
      next: (s) => {
        this.scenarios.set(s);
        this.loading.set(false);
      },
      error: () => {
        this.error.set('The scenario library did not load.');
        this.loading.set(false);
      },
    });
  }

  openEditor(s: StressScenario | null): void {
    this.saveError.set(null);
    this.editingId.set(s?.id ?? null);
    this.form.set(
      s
        ? formFromDefinition(s.name, s.scenarioType, s.definition, { description: s.description ?? '', source: s.source ?? '', isActive: s.isActive })
        : emptyScenarioForm(),
    );
  }

  copy(s: StressScenario): void {
    this.openEditor(s);
    this.editingId.set(null);
    const f = this.form();
    if (f) this.form.set({ ...f, name: `${s.name} (copy)` });
  }

  addRow(f: ScenarioForm): void {
    f.rows.push({ kind: 'currency', key: '', pctChange: null } as ShockRow);
    this.form.set({ ...f });
  }

  removeRow(f: ScenarioForm, i: number): void {
    f.rows.splice(i, 1);
    this.form.set({ ...f });
  }

  protected problems(f: ScenarioForm): string[] {
    return scenarioFormProblems(f);
  }

  save(f: ScenarioForm): void {
    const body = {
      name: f.name.trim(),
      scenarioType: f.scenarioType,
      shockDefinitionJson: definitionJson(f),
      isActive: f.isActive,
      description: f.description.trim() || null,
      source: f.source.trim() || null,
    };
    this.saving.set(true);
    const id = this.editingId();
    const call: Observable<unknown> = id ? this.api.updateScenario(id, body) : this.api.createScenario(body);
    call.subscribe({
      next: () => {
        this.saving.set(false);
        this.form.set(null);
        this.message.set(id ? 'Scenario saved.' : 'Scenario created.');
        this.load();
      },
      error: (err: unknown) => {
        this.saving.set(false);
        this.saveError.set(failureMessage(err, 'The scenario could not be saved.'));
      },
    });
  }

  askToggle(s: StressScenario): void {
    this.toggling.set(s);
  }

  toggle(): void {
    const s = this.toggling();
    if (!s) return;
    this.api.setLibraryScenarioActive(s.id, !s.isActive).subscribe({
      next: () => {
        this.toggling.set(null);
        this.load();
      },
      error: (err: unknown) => {
        this.toggling.set(null);
        this.message.set(failureMessage(err, 'The scenario could not be switched.'));
      },
    });
  }

  remove(): void {
    const s = this.deleting();
    if (!s) return;
    this.api.deleteScenario(s.id).subscribe({
      next: () => {
        this.deleting.set(null);
        this.load();
      },
      error: (err: unknown) => {
        this.deleting.set(null);
        this.message.set(failureMessage(err, 'The scenario could not be deleted.'));
      },
    });
  }

  protected shockSummary(s: StressScenario): string {
    const d = s.definition;
    const parts = [
      ...(d.dateFrom ? [`window ${d.dateFrom.slice(0, 10)} → ${(d.dateTo ?? '').slice(0, 10)}`] : []),
      ...d.currencyShocks.map((c) => `${c.currency} ${c.pctChange > 0 ? '+' : ''}${c.pctChange} %`),
      ...d.symbolShocks.map((x) => `${x.symbol} ${x.pctChange > 0 ? '+' : ''}${x.pctChange} %`),
      ...d.assetClassShocks.map((a) => `${a.assetClass} ${a.pctChange > 0 ? '+' : ''}${a.pctChange} %`),
      ...(d.targetLossPct ? [`target loss ${d.targetLossPct} %`] : []),
    ];
    return parts.join(' · ') || '—';
  }
}
