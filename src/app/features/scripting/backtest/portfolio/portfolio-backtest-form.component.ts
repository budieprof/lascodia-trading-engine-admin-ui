import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  output,
  signal,
} from '@angular/core';
import { catchError, firstValueFrom, of } from 'rxjs';

import type { RiskProfileDto, TradingAccountDto } from '@core/api/api.types';
import { CurrencyPairsService } from '@core/services/currency-pairs.service';
import { RiskProfilesService } from '@core/services/risk-profiles.service';
import { ScriptingService } from '@core/services/scripting.service';
import { StrategiesService } from '@core/services/strategies.service';
import { TradingAccountsService } from '@core/services/trading-accounts.service';

import type { ScriptInputDef, ScriptStrategyDto } from '../../api/scripting-api.types';
import { SCRIPTING_UI_STYLES } from '../../components/scripting-ui.styles';
import { describeFailure, isOk } from '../../shared/api-error';
import { InputOverridesEditorComponent } from '../../shared/input-overrides-editor.component';
import { isScriptStrategy, scriptInputsOf, scriptSourceOf } from '../../shared/script-strategy';
import { PortfolioBacktestApiService } from './portfolio-backtest-api.service';
import {
  MAX_PORTFOLIO_MEMBERS,
  PORTFOLIO_TIMEFRAMES,
  buildRequest,
  newDraft,
  newMember,
  validateDraft,
  type LimitsSource,
  type MemberDraft,
  type MemberSourceKind,
  type PortfolioDraft,
} from './portfolio-backtest.model';

interface StrategyOption {
  id: number;
  label: string;
  symbol: string | null;
  timeframe: string | null;
}

/** A member's input editor: the script's inputs (from a compile) and the values its strategy saved. */
interface InputsPanel {
  loading: boolean;
  defs: ScriptInputDef[] | null;
  baseline: Record<string, unknown>;
  note: string | null;
  /** The written source the inputs were read from ('' for a saved strategy). */
  source: string;
}

/**
 * The new portfolio backtest (scripting API §8h): members — saved script strategies or Pine written for the run, each on
 * its own symbol and timeframe with its share of the account's equity and, optionally, input overrides — the account
 * (starting balance, currency, leverage), where the currency-exposure limits come from, and the window. The form checks
 * what it can; the engine checks every member as a manual backtest and answers all problems at once.
 */
@Component({
  selector: 'app-portfolio-backtest-form',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [InputOverridesEditorComponent],
  template: `
    <section class="card" aria-labelledby="pf-new-title" data-testid="portfolio-form">
      <h2 class="card-title" id="pf-new-title">New portfolio backtest</h2>
      <p class="muted small intro">
        Every member trades the same account on one bar clock: equity-sized orders compound on one balance, every
        order's margin comes out of the whole account, and the account applies the live currency-exposure limits. Each
        member also runs alone so you can see what sharing the account changed.
      </p>

      <h3 class="section-title">Members</h3>
      <ol class="members">
        @for (m of draft().members; track m.uid; let i = $index) {
          <li class="member" [attr.data-testid]="'member-' + i">
            <div class="member-head">
              <span class="member-no">{{ i + 1 }}</span>
              <div class="kinds" role="radiogroup" [attr.aria-label]="'Member ' + (i + 1) + ' script'">
                <label
                  ><input
                    type="radio"
                    [name]="'pf-kind-' + m.uid"
                    [checked]="m.kind === 'strategy'"
                    (change)="setKind(m.uid, 'strategy')"
                  />
                  Saved script strategy</label
                >
                <label
                  ><input
                    type="radio"
                    [name]="'pf-kind-' + m.uid"
                    [checked]="m.kind === 'source'"
                    (change)="setKind(m.uid, 'source')"
                  />
                  Write Pine</label
                >
              </div>
              <button
                type="button"
                class="btn btn-ghost btn-sm"
                (click)="removeMember(m.uid)"
                [disabled]="draft().members.length <= 1"
                [attr.aria-label]="'Remove member ' + (i + 1)"
              >
                Remove
              </button>
            </div>

            <div class="grid">
              @if (m.kind === 'strategy') {
                <label class="field wide">
                  <span>Strategy</span>
                  <select
                    class="field-input"
                    [value]="m.strategyId ?? ''"
                    (change)="setStrategy(m.uid, $any($event.target).value)"
                    [attr.data-testid]="'member-strategy-' + i"
                  >
                    <option value="">
                      {{ strategiesLoading() ? 'Loading script strategies…' : 'Choose a script strategy…' }}
                    </option>
                    @for (s of strategyOptions(); track s.id) {
                      <option [value]="s.id" [selected]="s.id === m.strategyId">{{ s.label }}</option>
                    }
                  </select>
                </label>
              } @else {
                <label class="field wide">
                  <span>Pine source (a strategy() script)</span>
                  <textarea
                    class="field-input source"
                    rows="6"
                    spellcheck="false"
                    [value]="m.pineSource"
                    (input)="patch(m.uid, { pineSource: $any($event.target).value })"
                    [attr.data-testid]="'member-source-' + i"
                  ></textarea>
                </label>
              }
              <label class="field">
                <span>Name</span>
                <input
                  class="field-input"
                  maxlength="120"
                  [placeholder]="m.kind === 'strategy' ? 'the strategy’s name' : 'Member ' + (i + 1)"
                  [value]="m.name"
                  (input)="patch(m.uid, { name: $any($event.target).value })"
                />
              </label>
              <label class="field">
                <span>Symbol</span>
                <input
                  class="field-input"
                  list="pf-symbols"
                  maxlength="20"
                  [placeholder]="m.kind === 'strategy' ? (strategyOf(m)?.symbol ?? 'the strategy’s own') : 'EURUSD'"
                  [value]="m.symbol"
                  (input)="patch(m.uid, { symbol: $any($event.target).value })"
                  [attr.data-testid]="'member-symbol-' + i"
                />
              </label>
              <label class="field">
                <span>Timeframe</span>
                <select
                  class="field-input"
                  [value]="m.timeframe"
                  (change)="patch(m.uid, { timeframe: $any($event.target).value })"
                  [attr.data-testid]="'member-timeframe-' + i"
                >
                  @if (m.kind === 'strategy') {
                    <option value="">{{ strategyOf(m)?.timeframe ?? 'the strategy’s own' }}</option>
                  }
                  @for (tf of timeframes; track tf) {
                    <option [value]="tf" [selected]="tf === m.timeframe">{{ tf }}</option>
                  }
                </select>
              </label>
              <label class="field">
                <span>Share of equity, %</span>
                <input
                  class="field-input"
                  type="number"
                  min="1"
                  max="100"
                  step="1"
                  placeholder="100"
                  [value]="m.equitySharePct ?? ''"
                  (input)="patch(m.uid, { equitySharePct: numberOrNull($any($event.target).value) })"
                  [attr.data-testid]="'member-share-' + i"
                />
              </label>
            </div>

            <div class="inputs-row">
              <button
                type="button"
                class="btn btn-ghost btn-sm"
                (click)="toggleInputs(m)"
                [disabled]="!canEditInputs(m)"
                [attr.aria-expanded]="openInputs() === m.uid"
              >
                {{ openInputs() === m.uid ? 'Hide inputs' : 'Inputs' }}
                @if (inputCount(m) > 0) {
                  <span class="chip chip-accent">{{ inputCount(m) }} changed</span>
                }
              </button>
            </div>
            <!-- Kept mounted while closed: the editor holds the values typed into it and re-emits "no change" when it
                 is created again. -->
            @if (panels()[m.uid]; as p) {
              <div class="inputs-panel" [hidden]="openInputs() !== m.uid" [attr.data-testid]="'member-inputs-' + i">
                @if (p.loading) {
                  <p class="muted small"><span class="spinner"></span> Reading the script's inputs…</p>
                } @else {
                  @if (p.note) {
                    <p class="note">{{ p.note }}</p>
                  }
                  @if (m.kind === 'source' && p.source !== m.pineSource) {
                    <p class="note">
                      The source changed after its inputs were read.
                      <button type="button" class="btn btn-ghost btn-sm" (click)="rereadInputs(m.uid)">
                        Read them again
                      </button>
                      (this clears the values changed here)
                    </p>
                  }
                  <app-input-overrides-editor
                    [inputs]="p.defs"
                    [baseline]="p.baseline"
                    (overridesChange)="patch(m.uid, { inputs: $event })"
                    (validityChange)="setValidity(m.uid, $event)"
                  />
                }
              </div>
            }
          </li>
        }
      </ol>
      <datalist id="pf-symbols">
        @for (s of symbols(); track s) {
          <option [value]="s"></option>
        }
      </datalist>
      <div class="add-row">
        <button
          type="button"
          class="btn btn-sm"
          (click)="addMember('strategy')"
          [disabled]="draft().members.length >= maxMembers"
          data-testid="add-member"
        >
          Add a strategy
        </button>
        <button
          type="button"
          class="btn btn-sm"
          (click)="addMember('source')"
          [disabled]="draft().members.length >= maxMembers"
        >
          Add written Pine
        </button>
        <span class="muted small">{{ draft().members.length }} of at most {{ maxMembers }}</span>
      </div>

      <h3 class="section-title">Account</h3>
      <div class="grid">
        <label class="field">
          <span>Starting balance</span>
          <input
            class="field-input"
            type="number"
            min="1"
            step="100"
            placeholder="the engine default"
            [value]="draft().initialBalance ?? ''"
            (input)="set({ initialBalance: numberOrNull($any($event.target).value) })"
            data-testid="pf-balance"
          />
        </label>
        <label class="field">
          <span>Currency</span>
          <input
            class="field-input"
            maxlength="3"
            placeholder="the engine’s"
            [value]="draft().accountCurrency"
            (input)="set({ accountCurrency: $any($event.target).value })"
          />
        </label>
        <label class="field">
          <span>Leverage (1:x)</span>
          <input
            class="field-input"
            type="number"
            min="1"
            max="1000"
            placeholder="each script’s own margin"
            [value]="draft().leverage ?? ''"
            (input)="set({ leverage: numberOrNull($any($event.target).value) })"
            data-testid="pf-leverage"
          />
        </label>
        <label class="field">
          <span>Bar magnifier</span>
          <select
            class="field-input"
            [value]="draft().barMagnifier"
            (change)="set({ barMagnifier: $any($event.target).value })"
          >
            <option value="script">As each script declares</option>
            <option value="on">On for every member</option>
            <option value="off">Off for every member</option>
          </select>
        </label>
      </div>

      <h3 class="section-title">Currency-exposure limits</h3>
      <div class="kinds" role="radiogroup" aria-label="Where the limits come from">
        @for (s of limitSources; track s.id) {
          <label
            ><input
              type="radio"
              name="pf-limits"
              [checked]="draft().limitsFrom === s.id"
              (change)="set({ limitsFrom: s.id })"
            />
            {{ s.label }}</label
          >
        }
      </div>
      <div class="grid">
        @if (draft().limitsFrom === 'account') {
          <label class="field wide">
            <span>Trading account</span>
            <select
              class="field-input"
              [value]="draft().tradingAccountId ?? ''"
              (change)="set({ tradingAccountId: numberOrNull($any($event.target).value) })"
            >
              <option value="">Choose an account…</option>
              @for (a of accounts(); track a.id) {
                <option [value]="a.id" [selected]="a.id === draft().tradingAccountId">{{ accountLabel(a) }}</option>
              }
            </select>
          </label>
        }
        @if (draft().limitsFrom === 'profile') {
          <label class="field wide">
            <span>Risk profile</span>
            <select
              class="field-input"
              [value]="draft().riskProfileId ?? ''"
              (change)="set({ riskProfileId: numberOrNull($any($event.target).value) })"
            >
              <option value="">Choose a profile…</option>
              @for (p of profiles(); track p.id) {
                <option [value]="p.id" [selected]="p.id === draft().riskProfileId">{{ profileLabel(p) }}</option>
              }
            </select>
          </label>
        }
        <label class="field">
          <span>Same-direction positions per currency</span>
          <input
            class="field-input"
            type="number"
            min="0"
            step="1"
            placeholder="the profile’s"
            [value]="draft().legsOverride ?? ''"
            (input)="set({ legsOverride: numberOrNull($any($event.target).value) })"
            data-testid="pf-legs"
          />
        </label>
        <label class="field">
          <span>Correlated positions per group</span>
          <input
            class="field-input"
            type="number"
            min="0"
            step="1"
            placeholder="the profile’s"
            [value]="draft().correlatedOverride ?? ''"
            (input)="set({ correlatedOverride: numberOrNull($any($event.target).value) })"
          />
        </label>
      </div>
      <p class="muted small">
        The account refuses an entry the live account's risk check would refuse: a currency already held that many
        times in the same direction, or a correlation group already full. Empty uses the profile's limit; 0 means no
        limit.
      </p>

      <h3 class="section-title">Window and name</h3>
      <div class="grid">
        <label class="field">
          <span>From</span>
          <input
            class="field-input"
            type="date"
            [value]="draft().fromDate"
            (change)="set({ fromDate: $any($event.target).value })"
          />
        </label>
        <label class="field">
          <span>To</span>
          <input
            class="field-input"
            type="date"
            [value]="draft().toDate"
            (change)="set({ toDate: $any($event.target).value })"
          />
        </label>
        <label class="field wide">
          <span>Name</span>
          <input
            class="field-input"
            maxlength="120"
            placeholder="its members and window"
            [value]="draft().name"
            (input)="set({ name: $any($event.target).value })"
          />
        </label>
      </div>

      @if (showProblems() && problems().length > 0) {
        <ul class="problems" role="alert" data-testid="pf-problems">
          @for (p of problems(); track p) {
            <li>{{ p }}</li>
          }
        </ul>
      }
      @if (engineError(); as e) {
        <p class="error-box" role="alert" data-testid="pf-engine-error">{{ e }}</p>
      }
      <div class="actions">
        <button
          type="button"
          class="btn btn-primary"
          (click)="submit()"
          [disabled]="submitting()"
          data-testid="pf-queue"
        >
          @if (submitting()) {
            <span class="spinner"></span>
          }
          Queue the portfolio backtest
        </button>
        <span class="muted small">It runs in the research process, one backtest at a time with the queued backtests.</span>
      </div>
    </section>
  `,
  styles: [
    SCRIPTING_UI_STYLES,
    `
      :host { display: block; }
      .card { padding: var(--space-5); border-radius: var(--radius-lg); background: var(--bg-secondary); }
      .card-title { margin: 0 0 4px; font-size: var(--text-lg); font-weight: var(--font-semibold); }
      .intro { margin: 0 0 var(--space-4); max-width: 72ch; }
      .section-title { margin: var(--space-5) 0 var(--space-2); font-size: var(--text-sm); font-weight: var(--font-semibold); }
      .members { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-3); }
      .member { padding: var(--space-3); border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--bg-primary); }
      .member-head { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; margin-bottom: var(--space-2); }
      .member-no {
        display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px;
        border-radius: 50%; background: var(--bg-tertiary); font-size: 12px; font-weight: var(--font-semibold);
      }
      .member-head .btn { margin-left: auto; }
      .kinds { display: flex; gap: var(--space-4); flex-wrap: wrap; font-size: 13px; }
      .kinds label { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
      .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: var(--space-3); }
      .field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text-secondary); min-width: 0; }
      .field.wide { grid-column: 1 / -1; }
      .source { height: auto; padding: 8px; font-family: ui-monospace, 'SF Mono', Menlo, monospace; font-size: 12px; resize: vertical; }
      .inputs-row { margin-top: var(--space-2); }
      .add-row, .actions { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; margin-top: var(--space-3); }
      .actions { margin-top: var(--space-5); }
      .problems { margin: var(--space-4) 0 0; padding: 8px 12px 8px 28px; border-radius: 8px; background: rgba(255, 149, 0, 0.1); font-size: 13px; }
      .note { margin: 6px 0; font-size: 12px; color: var(--text-secondary); }
      .error-box { margin-top: var(--space-3); }
    `,
  ],
})
export class PortfolioBacktestFormComponent implements OnInit {
  /** The id of a run the form queued. */
  readonly queued = output<number>();

  private readonly api = inject(PortfolioBacktestApiService);
  private readonly strategiesApi = inject(StrategiesService);
  private readonly pairsApi = inject(CurrencyPairsService);
  private readonly accountsApi = inject(TradingAccountsService);
  private readonly profilesApi = inject(RiskProfilesService);
  private readonly scripting = inject(ScriptingService);

  readonly timeframes = PORTFOLIO_TIMEFRAMES;
  readonly maxMembers = MAX_PORTFOLIO_MEMBERS;
  readonly limitSources: { id: LimitsSource; label: string }[] = [
    { id: 'default', label: 'The default risk profile' },
    { id: 'account', label: 'A trading account’s risk profile' },
    { id: 'profile', label: 'A risk profile' },
  ];

  readonly draft = signal<PortfolioDraft>(newDraft());
  /** Per member uid: false while its inputs editor holds a value that is not valid. */
  readonly inputsValid = signal<Record<number, boolean>>({});
  readonly problems = computed(() => {
    const list = validateDraft(this.draft());
    const valid = this.inputsValid();
    this.draft().members.forEach((m, i) => {
      if (valid[m.uid] === false) list.push(`Member ${i + 1}: an input value is not valid; correct it or reset it.`);
    });
    return list;
  });
  readonly showProblems = signal(false);
  readonly submitting = signal(false);
  readonly engineError = signal<string | null>(null);

  readonly strategiesLoading = signal(false);
  readonly strategyOptions = signal<StrategyOption[]>([]);
  readonly symbols = signal<string[]>([]);
  readonly accounts = signal<TradingAccountDto[]>([]);
  readonly profiles = signal<RiskProfileDto[]>([]);
  readonly openInputs = signal<number | null>(null);
  readonly panels = signal<Record<number, InputsPanel>>({});

  ngOnInit(): void {
    this.loadStrategies();
    this.pairsApi
      .list({ currentPage: 1, itemCountPerPage: 500, filter: null })
      .pipe(catchError(() => of(null)))
      .subscribe((res) => {
        const rows = res && isOk(res) ? (res.data?.data ?? []) : [];
        this.symbols.set(
          rows.map((p) => p.symbol ?? '').filter((s) => s !== '').sort((a, b) => a.localeCompare(b)),
        );
      });
    this.accountsApi
      .list({ currentPage: 1, itemCountPerPage: 200, filter: null })
      .pipe(catchError(() => of(null)))
      .subscribe((res) => this.accounts.set(res && isOk(res) ? (res.data?.data ?? []) : []));
    this.profilesApi
      .list({ currentPage: 1, itemCountPerPage: 200, filter: null })
      .pipe(catchError(() => of(null)))
      .subscribe((res) => this.profiles.set(res && isOk(res) ? (res.data?.data ?? []) : []));
  }

  // ── form edits ─────────────────────────────────────────────────────────────────

  set(patch: Partial<PortfolioDraft>): void {
    this.draft.update((d) => ({ ...d, ...patch }));
    this.engineError.set(null);
  }

  patch(uid: number, patch: Partial<MemberDraft>): void {
    this.draft.update((d) => ({
      ...d,
      members: d.members.map((m) => (m.uid === uid ? { ...m, ...patch } : m)),
    }));
    this.engineError.set(null);
  }

  setKind(uid: number, kind: MemberSourceKind): void {
    this.patch(uid, { kind, inputs: {}, timeframe: kind === 'source' ? 'H1' : '' });
    this.dropPanel(uid);
  }

  setStrategy(uid: number, value: string): void {
    this.patch(uid, { strategyId: this.numberOrNull(value), inputs: {} });
    this.dropPanel(uid);
  }

  addMember(kind: MemberSourceKind): void {
    if (this.draft().members.length >= this.maxMembers) return;
    this.draft.update((d) => ({ ...d, members: [...d.members, newMember(kind)] }));
  }

  removeMember(uid: number): void {
    if (this.draft().members.length <= 1) return;
    this.draft.update((d) => ({ ...d, members: d.members.filter((m) => m.uid !== uid) }));
    this.dropPanel(uid);
  }

  numberOrNull(raw: string): number | null {
    if (raw === null || raw === undefined || String(raw).trim() === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  strategyOf(m: MemberDraft): StrategyOption | null {
    return m.strategyId === null ? null : (this.strategyOptions().find((s) => s.id === m.strategyId) ?? null);
  }

  accountLabel(a: TradingAccountDto): string {
    return `${a.accountName || a.accountId || `Account #${a.id}`} (#${a.id}${a.brokerName ? `, ${a.brokerName}` : ''})`;
  }

  profileLabel(p: RiskProfileDto): string {
    return `${p.name || `Profile #${p.id}`} — ${p.maxSameDirectionCurrencyLegs} per currency, ${p.maxCorrelatedPositions} per group`;
  }

  // ── inputs ─────────────────────────────────────────────────────────────────────

  canEditInputs(m: MemberDraft): boolean {
    return m.kind === 'strategy' ? m.strategyId !== null : m.pineSource.trim().length > 0;
  }

  inputCount(m: MemberDraft): number {
    return Object.keys(m.inputs).length;
  }

  toggleInputs(m: MemberDraft): void {
    if (this.openInputs() === m.uid) {
      this.openInputs.set(null);
      return;
    }
    this.openInputs.set(m.uid);
    if (!this.panels()[m.uid]) void this.loadPanel(m.uid);
  }

  /** Re-read a written member's inputs after its source changed (its changed values start over). */
  rereadInputs(uid: number): void {
    this.dropPanel(uid);
    this.patch(uid, { inputs: {} });
    this.openInputs.set(uid);
    void this.loadPanel(uid);
  }

  setValidity(uid: number, valid: boolean): void {
    this.inputsValid.update((v) => ({ ...v, [uid]: valid }));
  }

  /** Read the member's inputs: the saved strategy's source and values, or the written source, compiled. */
  private async loadPanel(uid: number): Promise<void> {
    const m = this.draft().members.find((x) => x.uid === uid);
    if (!m) return;
    const loading: InputsPanel = { loading: true, defs: null, baseline: {}, note: null, source: m.pineSource };
    this.setPanel(uid, loading);
    // The member may change (or go) while the engine answers; then this answer is for nothing on screen.
    const current = () => this.panels()[uid] === loading;
    let source = m.pineSource;
    let baseline: Record<string, unknown> = {};
    if (m.kind === 'strategy' && m.strategyId !== null) {
      try {
        const res = await firstValueFrom(this.strategiesApi.getById(m.strategyId));
        const s = (isOk(res) ? res.data : null) as ScriptStrategyDto | null;
        if (!current()) return;
        const own = scriptSourceOf(s);
        if (!s || !own) {
          this.setPanel(uid, {
            ...loading,
            loading: false,
            note: s
              ? 'That strategy has no Pine source to read its inputs from; enter overrides by input id.'
              : describeFailure(res, 'The strategy could not be read.') + ' Enter overrides by input id.',
          });
          return;
        }
        source = own;
        baseline = scriptInputsOf(s);
      } catch (err) {
        if (!current()) return;
        this.setPanel(uid, {
          ...loading,
          loading: false,
          note: describeFailure(err, 'The strategy could not be read.') + ' Enter overrides by input id.',
        });
        return;
      }
    }
    try {
      // A script with errors still resolves (with its diagnostics); only an unreachable engine rejects.
      const result = await firstValueFrom(this.scripting.compile({ source, timeframe: m.timeframe || null }));
      if (!current()) return;
      const error = (result.diagnostics ?? []).find((d) => d.severity === 'error');
      this.setPanel(uid, {
        ...loading,
        loading: false,
        defs: (result.inputs ?? []) as ScriptInputDef[],
        baseline,
        note: error ? `The script does not compile yet (line ${error.line}: ${error.message}).` : null,
      });
    } catch (err) {
      if (!current()) return;
      this.setPanel(uid, {
        ...loading,
        loading: false,
        baseline,
        note: `The script could not be compiled (${describeFailure(err, 'the engine did not answer')}); enter overrides by input id.`,
      });
    }
  }

  private setPanel(uid: number, panel: InputsPanel): void {
    this.panels.update((p) => ({ ...p, [uid]: panel }));
  }

  private dropPanel(uid: number): void {
    this.panels.update((p) => {
      const next = { ...p };
      delete next[uid];
      return next;
    });
    this.inputsValid.update((v) => {
      const next = { ...v };
      delete next[uid];
      return next;
    });
    if (this.openInputs() === uid) this.openInputs.set(null);
  }

  // ── submit ─────────────────────────────────────────────────────────────────────

  async submit(): Promise<void> {
    this.showProblems.set(true);
    this.engineError.set(null);
    if (this.problems().length > 0) return;
    this.submitting.set(true);
    try {
      const res = await firstValueFrom(this.api.queue(buildRequest(this.draft())));
      if (isOk(res) && typeof res.data === 'number' && res.data > 0) {
        this.queued.emit(res.data);
        this.showProblems.set(false);
      } else {
        this.engineError.set(describeFailure(res, 'The portfolio backtest could not be queued.'));
      }
    } catch (err) {
      this.engineError.set(describeFailure(err, 'The portfolio backtest could not be queued.'));
    } finally {
      this.submitting.set(false);
    }
  }

  private loadStrategies(): void {
    this.strategiesLoading.set(true);
    this.strategiesApi
      .list({ currentPage: 1, itemCountPerPage: 500, filter: null, sortBy: 'name', sortDirection: 'asc' })
      .pipe(catchError(() => of(null)))
      .subscribe((res) => {
        this.strategiesLoading.set(false);
        const rows = (res && isOk(res) ? (res.data?.data ?? []) : []) as ScriptStrategyDto[];
        // The list DTO may not carry authoringMode; then every rule-based strategy is offered and the engine refuses a
        // non-script one when the run is queued.
        const modeKnown = rows.some((r) => r.authoringMode != null);
        this.strategyOptions.set(
          rows
            .filter((r) => (modeKnown ? isScriptStrategy(r) : r.strategyType === 'RuleBased'))
            .map((r) => ({
              id: r.id,
              label: `${r.name || `Strategy #${r.id}`} — ${r.symbol ?? '?'} ${r.timeframe ?? ''}`.trim(),
              symbol: r.symbol ?? null,
              timeframe: r.timeframe ?? null,
            }))
            .sort((a, b) => a.label.localeCompare(b.label)),
        );
      });
  }
}
