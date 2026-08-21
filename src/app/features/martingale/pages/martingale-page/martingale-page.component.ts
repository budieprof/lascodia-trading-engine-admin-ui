import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import {
  MartingaleService,
  type MartingaleAccountSymbolsDto,
  type MartingaleSymbolDto,
  type MartingaleMode,
} from '@core/services/martingale.service';
import { TradingAccountsService } from '@core/services/trading-accounts.service';
import type { TradingAccountDto } from '@core/api/api.types';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';

/**
 * Operator control for the per-symbol recovery ladder.
 *
 * The page is deliberately account-first: a ladder is opted in per (account, symbol) pair, so
 * "which symbols does THIS account ladder" is the only question that has a well-defined answer.
 * Selecting a symbol without an account would be selecting nothing.
 */
@Component({
  selector: 'app-martingale-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    RouterLink,
    DecimalPipe,
    PageHeaderComponent,
    CardSkeletonComponent,
    EmptyStateComponent,
  ],
  template: `
    <app-page-header
      title="Martingale Ladders"
      subtitle="Per-symbol recovery ladders, opted in one account and one symbol at a time."
    />

    <!--
      This page configures what the ladder WILL do; the internals page explains what it HAS done.
      The link sits at the top because "why is this chain at depth 3?" is usually the question
      that brought an operator here in the first place.
    -->
    <p class="internals-link">
      <a routerLink="/martingale/internals">
        Open ladder internals → chains, ledgers and next-rung previews
      </a>
    </p>

    <!--
      The mode banner sits ABOVE the account picker on purpose: it is fleet-wide, so putting it
      inside the per-account section would imply a scope it does not have. It is also the first
      thing that determines whether anything below it does something — a symbol shown as enabled
      under Shadow is computing rungs and applying none.
    -->
    @if (view(); as v) {
      <section class="mode" [attr.data-mode]="v.mode">
        <div class="mode-row">
          <span class="mode-badge">{{ v.mode }}</span>
          <span class="mode-copy">
            @switch (v.mode) {
              @case ('Live') {
                <b>Ladders are placing real orders.</b> A losing trade on an enabled symbol
                escalates the next position's size.
              }
              @case ('Shadow') {
                Rungs are computed and logged but <b>never applied</b> — chains still open, advance
                and recover against real fills, so the ladder can be judged before it is trusted.
              }
              @case ('Off') {
                Ladders compute nothing. Chain state and sizing are both untouched.
              }
            }
          </span>
          <span class="mode-scope">fleet-wide · every account</span>
        </div>

        <div class="mode-actions">
          @for (m of modes; track m) {
            <button
              type="button"
              class="mode-btn"
              [class.sel]="m === v.mode"
              [disabled]="savingMode() || m === v.mode"
              (click)="changeMode(m)"
            >
              {{ m }}
            </button>
          }
          @if (savingMode()) {
            <span class="saving">Saving…</span>
          }
        </div>
      </section>
    }

    <div class="acct-bar">
      <label for="acct">Account</label>
      <select id="acct" [ngModel]="accountId()" (ngModelChange)="selectAccount($event)">
        @for (a of accounts(); track a.id) {
          <option [value]="a.id">#{{ a.id }} — {{ a.accountName || a.accountId }}</option>
        }
      </select>
      @if (saving()) {
        <span class="saving">Saving…</span>
      }
    </div>

    @if (error(); as e) {
      <div class="banner err" role="alert">{{ e }}</div>
    }

    @if (loading()) {
      <app-card-skeleton />
    } @else if (view(); as v) {
      <!--
        The profile gate comes first because it is a precondition, not a detail: every symbol
        toggle below is inert while it is off, and the flag is shared with any account on the
        same profile.
      -->
      <section class="gate" [class.gate-off]="!v.profileMartingaleEnabled">
        <div class="gate-head">
          <span class="dot" [class.on]="v.profileMartingaleEnabled"></span>
          <strong>Risk profile:</strong>
          <span>{{ v.riskProfileName || '—' }}</span>
          <span class="pill" [class.on]="v.profileMartingaleEnabled">
            {{ v.profileMartingaleEnabled ? 'martingale allowed' : 'martingale disabled' }}
          </span>
        </div>

        @if (!v.profileMartingaleEnabled) {
          <p class="gate-note">
            Every symbol toggle below is inert until this profile allows martingale. Enable it on
            the Risk Profiles page.
          </p>
        }

        @if (v.accountsSharingProfile.length > 0) {
          <p class="gate-note warn">
            <strong
              >{{ v.accountsSharingProfile.length }} other account(s) share this profile</strong
            >
            (#{{ v.accountsSharingProfile.join(', #') }}). Changing the profile flag affects all of
            them. The per-symbol toggles below do not — they are scoped to account #{{
              v.tradingAccountId
            }}
            alone.
          </p>
        }

        <!--
          Profile defaults are editable here rather than only on the Risk Profiles page: they were
          previously reachable only by direct database update, which is the invisible-config trap
          this codebase has already been bitten by twice.
        -->
        <div class="pform">
          <label class="fld master">
            <input type="checkbox" [(ngModel)]="pf.enabled" [disabled]="savingProfile()" />
            <span>Allow martingale on this profile</span>
          </label>

          <label class="fld">
            <span>Depth cap</span>
            <input
              type="number"
              min="1"
              max="20"
              step="1"
              [(ngModel)]="pf.maxDepth"
              (ngModelChange)="onDepthChange($event)"
            />
          </label>

          <label class="fld">
            <span>Target profit (R)</span>
            <input type="number" min="0" max="10" step="0.1" [(ngModel)]="pf.targetProfitR" />
          </label>

          <label class="fld">
            <span>Max stake (% equity)</span>
            <input
              type="number"
              min="0.01"
              max="100"
              step="0.5"
              [(ngModel)]="pf.maxStakePctEquity"
            />
          </label>

          <label class="fld">
            <span>Chain age cap (h)</span>
            <input type="number" min="1" max="8760" step="1" [(ngModel)]="pf.maxChainAgeHours" />
          </label>

          <label class="fld master">
            <input type="checkbox" [(ngModel)]="pf.abandonAtCap" [disabled]="savingProfile()" />
            <span>Abandon at depth cap</span>
          </label>
        </div>

        <!--
          The projected worst case is computed client-side from the DRAFT depth, so it moves as the
          operator types. Showing it only after saving would mean the number that decides whether a
          cap is safe arrives after the decision.
        -->
        <p
          class="proj"
          [class.danger]="projectedWorstCase() >= v.haltedDrawdownPct"
          [class.warn]="
            projectedWorstCase() >= v.reducedDrawdownPct &&
            projectedWorstCase() < v.haltedDrawdownPct
          "
        >
          Worst case at depth {{ pf.maxDepth }} on {{ v.baseRiskPerTradePct }}% base risk:
          <b>{{ projectedWorstCase() | number: '1.0-1' }}%</b> of equity
          @if (!pf.abandonAtCap) {
            <b> — unbounded, the depth cap is disabled</b>
          } @else if (projectedWorstCase() >= v.haltedDrawdownPct) {
            — past the {{ v.haltedDrawdownPct }}% Halted threshold. A chain this deep halts the
            account before it can finish recovering.
          } @else if (projectedWorstCase() >= v.reducedDrawdownPct) {
            — past the {{ v.reducedDrawdownPct }}% Reduced threshold, but inside the
            {{ v.haltedDrawdownPct }}% halt boundary.
          } @else {
            — inside both drawdown thresholds.
          }
        </p>

        <div class="pactions">
          <button type="button" (click)="saveProfile()" [disabled]="savingProfile()">
            {{ savingProfile() ? 'Saving…' : 'Save profile defaults' }}
          </button>
          <button type="button" class="ghost" (click)="resetProfileForm()">Reset</button>
        </div>
      </section>

      @if (openChains().length > 0) {
        <section class="chains">
          <h2>Open chains</h2>
          <ul>
            @for (s of openChains(); track s.symbol) {
              <li>
                <b>{{ s.symbol }}</b>
                depth {{ s.chainDepth }}, owing {{ s.chainDeficitAmount | number: '1.2-2' }} (target
                {{ s.chainTargetAmount | number: '1.2-2' }})
              </li>
            }
          </ul>
          <p class="chains-note">
            Disabling a symbol does not clear its chain — the deficit is real and stays visible.
          </p>
        </section>
      }

      @if (v.symbols.length === 0) {
        <app-empty-state title="No currency pairs configured." />
      } @else {
        <div class="table-wrap">
          <table class="mtg">
            <thead>
              <tr>
                <th>Symbol</th>
                <th class="c">Ladder</th>
                <th class="n">Depth cap</th>
                <th class="n">Worst case</th>
                <th class="n">Target</th>
                <th class="n">Max stake</th>
                <th>Chain</th>
                <th class="c">Tune</th>
              </tr>
            </thead>
            <tbody>
              @for (s of v.symbols; track s.symbol) {
                <tr [class.active]="s.effectivelyActive">
                  <td class="sym">{{ s.symbol }}</td>
                  <td class="c">
                    <input
                      type="checkbox"
                      [checked]="s.enabled"
                      [disabled]="saving() || (!s.enabled && !v.profileMartingaleEnabled)"
                      (change)="toggle(s, $any($event.target).checked)"
                      [attr.aria-label]="'Ladder ' + s.symbol"
                    />
                    @if (s.enabled && !s.effectivelyActive) {
                      <span class="inert" title="Profile does not allow martingale">inert</span>
                    }
                  </td>
                  <td class="n">{{ s.effectiveMaxDepth }}</td>
                  <!--
                    Worst case is shown on every row, not just enabled ones, because it is the
                    number that decides whether the depth cap is safe: a rung is exempt from
                    Reduced recovery, so these caps are all that keeps a chain inside the 20%
                    halt boundary.
                  -->
                  <td class="n" [class.danger]="s.worstCaseDrawdownPct >= 20">
                    {{ s.worstCaseDrawdownPct | number: '1.0-1' }}%
                  </td>
                  <td class="n">{{ s.effectiveTargetProfitR }}R</td>
                  <td class="n">{{ s.effectiveMaxStakePctEquity }}%</td>
                  <td>
                    @if (s.hasOpenChain) {
                      <span class="chain">
                        depth {{ s.chainDepth }} · owing
                        {{ s.chainDeficitAmount | number: '1.0-0' }}
                      </span>
                    } @else {
                      <span class="muted">—</span>
                    }
                  </td>
                  <td class="c">
                    <button type="button" class="link" (click)="startEdit(s)">
                      {{ hasOverrides(s) ? 'Overrides ✎' : 'Override' }}
                    </button>
                  </td>
                </tr>

                @if (editing() === s.symbol) {
                  <tr class="editrow">
                    <td colspan="8">
                      <!--
                        An empty field means INHERIT, not zero. Stated explicitly because a blank
                        numeric input reading as 0 is exactly how a stake ceiling of 0 would get
                        set — which abandons every chain on its first rung.
                      -->
                      <div class="edit">
                        <span class="edit-title">{{ s.symbol }} overrides</span>
                        <span class="edit-hint">blank = inherit the profile default</span>

                        <label class="fld">
                          <span>Depth cap</span>
                          <input
                            type="number"
                            min="1"
                            max="20"
                            [(ngModel)]="ef.maxDepthOverride"
                            [placeholder]="v.defaultMaxDepth"
                          />
                        </label>

                        <label class="fld">
                          <span>Target (R)</span>
                          <input
                            type="number"
                            min="0"
                            max="10"
                            step="0.1"
                            [(ngModel)]="ef.targetProfitROverride"
                            [placeholder]="v.defaultTargetProfitR"
                          />
                        </label>

                        <label class="fld">
                          <span>Max stake (%)</span>
                          <input
                            type="number"
                            min="0.01"
                            max="100"
                            step="0.5"
                            [(ngModel)]="ef.maxStakePctEquityOverride"
                            [placeholder]="v.defaultMaxStakePctEquity"
                          />
                        </label>

                        <label class="fld">
                          <span>Age cap (h)</span>
                          <input
                            type="number"
                            min="1"
                            max="8760"
                            [(ngModel)]="ef.maxChainAgeHoursOverride"
                            [placeholder]="v.defaultMaxChainAgeHours"
                          />
                        </label>

                        <div class="edit-actions">
                          <button type="button" (click)="saveOverrides(s)" [disabled]="saving()">
                            Save
                          </button>
                          <button type="button" class="ghost" (click)="cancelEdit()">Cancel</button>
                          @if (hasOverrides(s)) {
                            <button type="button" class="ghost" (click)="clearOverrides(s)">
                              Clear all
                            </button>
                          }
                        </div>
                      </div>
                    </td>
                  </tr>
                }
              }
            </tbody>
          </table>
        </div>
      }
    } @else {
      <app-empty-state title="Select an account to view its ladders." />
    }
  `,
  styles: [
    `
      :host {
        display: block;
      }

      .internals-link {
        margin: 0 0 1rem;
        font-size: 0.875rem;
      }

      /*
       * Mode banner. Colour-coded by consequence rather than by state: Live is the only one that
       * moves money, so it is the only one that reads as an alarm.
       */
      .mode {
        border: 1px solid var(--border-default);
        border-left-width: 4px;
        border-radius: 12px;
        padding: var(--space-3) var(--space-4);
        margin-bottom: var(--space-4);
        background: var(--surface-raised);
      }
      .mode[data-mode='Live'] {
        border-left-color: #ff3b30;
        background: color-mix(in srgb, #ff3b30 7%, var(--surface-raised));
      }
      .mode[data-mode='Shadow'] {
        border-left-color: #0a84ff;
      }
      .mode[data-mode='Off'] {
        border-left-color: #8e8e93;
      }
      .mode-row {
        display: flex;
        align-items: baseline;
        flex-wrap: wrap;
        gap: var(--space-2) var(--space-3);
      }
      .mode-badge {
        font-weight: 700;
        font-size: 12px;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        padding: 3px 10px;
        border-radius: 999px;
        background: color-mix(in srgb, currentColor 14%, transparent);
      }
      .mode[data-mode='Live'] .mode-badge {
        color: #ff3b30;
      }
      .mode[data-mode='Shadow'] .mode-badge {
        color: #0a84ff;
      }
      .mode[data-mode='Off'] .mode-badge {
        color: #8e8e93;
      }
      .mode-copy {
        font-size: 13px;
        color: var(--text-secondary);
        flex: 1 1 320px;
      }
      .mode-scope {
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-tertiary);
      }
      .mode-actions {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        margin-top: var(--space-3);
      }
      .mode-btn {
        padding: 5px 14px;
        border-radius: 8px;
        border: 1px solid var(--border-default);
        background: transparent;
        color: var(--text-secondary);
        font-size: 13px;
        cursor: pointer;
      }
      .mode-btn.sel {
        background: var(--surface-base);
        color: var(--text-primary);
        font-weight: 600;
        cursor: default;
      }
      .mode-btn:disabled:not(.sel) {
        opacity: 0.5;
        cursor: default;
      }

      .acct-bar {
        display: flex;
        align-items: center;
        gap: var(--space-3);
        margin-bottom: var(--space-4);
      }
      .acct-bar select {
        padding: 6px 10px;
        border-radius: 8px;
        border: 1px solid var(--border-default);
        background: var(--surface-raised);
        color: var(--text-primary);
      }
      .saving {
        font-size: 12px;
        color: var(--text-secondary);
      }

      .banner {
        padding: 10px 14px;
        border-radius: 8px;
        margin-bottom: var(--space-4);
        font-size: 13px;
      }
      .banner.err {
        background: color-mix(in srgb, #ff3b30 12%, transparent);
        color: #ff3b30;
        border: 1px solid color-mix(in srgb, #ff3b30 35%, transparent);
      }

      .gate {
        border: 1px solid var(--border-default);
        border-radius: 12px;
        padding: var(--space-4);
        margin-bottom: var(--space-4);
        background: var(--surface-raised);
      }
      .gate-off {
        border-color: color-mix(in srgb, #ff9500 40%, var(--border-default));
      }
      .gate-head {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        flex-wrap: wrap;
      }
      .dot {
        width: 9px;
        height: 9px;
        border-radius: 50%;
        background: #8e8e93;
      }
      .dot.on {
        background: #34c759;
      }
      .pill {
        font-size: 11px;
        padding: 2px 8px;
        border-radius: 999px;
        background: color-mix(in srgb, #8e8e93 18%, transparent);
        color: var(--text-secondary);
      }
      .pill.on {
        background: color-mix(in srgb, #34c759 18%, transparent);
        color: #248a3d;
      }
      .gate-note {
        margin: var(--space-2) 0 0;
        font-size: 12px;
        color: var(--text-secondary);
      }
      .gate-note.warn {
        color: #b25000;
      }
      /* Profile default editor */
      .pform {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-3) var(--space-4);
        margin-top: var(--space-3);
        align-items: flex-end;
      }
      .fld {
        display: flex;
        flex-direction: column;
        gap: 4px;
        font-size: 12px;
        color: var(--text-secondary);
      }
      .fld.master {
        flex-direction: row;
        align-items: center;
        gap: 6px;
        font-size: 13px;
        color: var(--text-primary);
      }
      .fld input[type='number'] {
        width: 120px;
        padding: 6px 8px;
        border-radius: 8px;
        border: 1px solid var(--border-default);
        background: var(--surface-base);
        color: var(--text-primary);
        font-variant-numeric: tabular-nums;
      }
      .proj {
        margin: var(--space-3) 0 0;
        font-size: 12px;
        color: var(--text-secondary);
      }
      .proj.warn {
        color: #b25000;
      }
      .proj.danger {
        color: #ff3b30;
      }
      .pactions {
        display: flex;
        gap: var(--space-2);
        margin-top: var(--space-3);
      }
      .pactions button,
      .edit-actions button {
        padding: 6px 14px;
        border-radius: 8px;
        border: 1px solid var(--border-default);
        background: var(--accent, #0a84ff);
        color: #fff;
        font-size: 13px;
        cursor: pointer;
      }
      .pactions button.ghost,
      .edit-actions button.ghost {
        background: transparent;
        color: var(--text-secondary);
      }
      .pactions button:disabled {
        opacity: 0.55;
        cursor: default;
      }

      /* Per-symbol override editor */
      button.link {
        background: none;
        border: none;
        color: var(--accent, #0a84ff);
        font-size: 12px;
        cursor: pointer;
        padding: 0;
      }
      tr.editrow > td {
        background: var(--surface-raised);
      }
      .edit {
        display: flex;
        flex-wrap: wrap;
        align-items: flex-end;
        gap: var(--space-3) var(--space-4);
        padding: var(--space-2) 0;
      }
      .edit-title {
        font-weight: 600;
        font-size: 13px;
      }
      .edit-hint {
        font-size: 11px;
        color: var(--text-tertiary);
      }
      .edit-actions {
        display: flex;
        gap: var(--space-2);
      }

      .chains {
        border: 1px solid color-mix(in srgb, #ff9500 35%, var(--border-default));
        border-radius: 12px;
        padding: var(--space-4);
        margin-bottom: var(--space-4);
      }
      .chains h2 {
        margin: 0 0 var(--space-2);
        font-size: 14px;
      }
      .chains ul {
        margin: 0;
        padding-left: 18px;
        font-size: 13px;
      }
      .chains-note {
        margin: var(--space-2) 0 0;
        font-size: 12px;
        color: var(--text-secondary);
      }

      /* Wide content scrolls inside its own container so the page never scrolls sideways. */
      .table-wrap {
        overflow-x: auto;
      }
      table.mtg {
        width: 100%;
        border-collapse: collapse;
        font-size: 13px;
      }
      table.mtg th,
      table.mtg td {
        padding: 8px 10px;
        border-bottom: 1px solid var(--border-subtle);
        text-align: left;
        white-space: nowrap;
      }
      table.mtg th {
        font-weight: 600;
        color: var(--text-secondary);
        font-size: 12px;
      }
      .n {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .c {
        text-align: center;
      }
      .sym {
        font-weight: 600;
      }
      tr.active {
        background: color-mix(in srgb, #34c759 8%, transparent);
      }
      .danger {
        color: #ff3b30;
        font-weight: 700;
      }
      .inert {
        margin-left: 6px;
        font-size: 10px;
        text-transform: uppercase;
        color: #b25000;
      }
      .chain {
        color: #b25000;
      }
      .muted {
        color: var(--text-tertiary);
      }
    `,
  ],
})
export class MartingalePageComponent {
  private readonly martingale = inject(MartingaleService);
  private readonly accountsApi = inject(TradingAccountsService);

  readonly accounts = signal<TradingAccountDto[]>([]);
  readonly accountId = signal<number | null>(null);
  readonly view = signal<MartingaleAccountSymbolsDto | null>(null);
  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);

  readonly openChains = computed(() => (this.view()?.symbols ?? []).filter((s) => s.hasOpenChain));

  readonly savingProfile = signal(false);
  readonly savingMode = signal(false);
  readonly editing = signal<string | null>(null);

  readonly modes: MartingaleMode[] = ['Off', 'Shadow', 'Live'];

  /**
   * Draft profile settings. A plain mutable object rather than a signal because ngModel two-way
   * binding writes into it directly; `projectedDepth` is the signal that drives recomputation.
   */
  pf = {
    enabled: false,
    maxDepth: 3,
    targetProfitR: 0.5,
    maxStakePctEquity: 10,
    maxChainAgeHours: 72,
    abandonAtCap: true,
  };

  /** Draft per-symbol overrides. Empty string means inherit, NOT zero. */
  ef: {
    maxDepthOverride: number | string | null;
    targetProfitROverride: number | string | null;
    maxStakePctEquityOverride: number | string | null;
    maxChainAgeHoursOverride: number | string | null;
  } = {
    maxDepthOverride: '',
    targetProfitROverride: '',
    maxStakePctEquityOverride: '',
    maxChainAgeHoursOverride: '',
  };

  /** Mirrors pf.maxDepth so the projection recomputes as the operator types. */
  private readonly draftDepth = signal(3);

  /**
   * Worst-case cumulative loss if every rung to the depth cap loses.
   *
   * A rung sized to recover the accumulated deficit plus a target grows roughly 3x per step at
   * this book's geometry, so k losing rungs cost basePct * (3^k - 1)/2. Mirrors the server's
   * calculation deliberately: the operator needs it while typing, not after saving.
   */
  readonly projectedWorstCase = computed(() => {
    const base = this.view()?.baseRiskPerTradePct ?? 0;
    const depth = Math.min(Math.max(this.draftDepth(), 0), 20);
    if (base <= 0 || depth <= 0) return 0;
    return (base * (Math.pow(3, depth) - 1)) / 2;
  });

  constructor() {
    this.accountsApi.list({ currentPage: 1, itemCountPerPage: 100 }).subscribe({
      next: (res) => {
        const rows = res?.data?.data ?? [];
        this.accounts.set(rows);
        if (rows.length > 0) this.selectAccount(rows[0].id);
      },
      error: () => this.error.set('Could not load trading accounts.'),
    });
  }

  selectAccount(id: number | string): void {
    const numeric = typeof id === 'string' ? Number(id) : id;
    this.accountId.set(numeric);
    this.load();
  }

  private load(): void {
    const id = this.accountId();
    if (id == null) return;

    this.loading.set(true);
    this.error.set(null);
    this.martingale.getSymbols(id).subscribe({
      next: (v) => {
        this.view.set(v);
        this.resetProfileForm();
        this.loading.set(false);
      },
      error: (e: { message?: string }) => {
        this.error.set(e?.message ?? 'Could not load martingale settings.');
        this.loading.set(false);
      },
    });
  }

  // ── Fleet-wide mode ───────────────────────────────────────────────────────

  changeMode(mode: MartingaleMode): void {
    // Going Live is the moment a size-escalating scheme starts placing real orders, across every
    // account at once. The server demands a reason and an explicit acknowledgement; both are
    // collected here rather than sent as placeholders.
    let reason: string | null = null;
    let ack = false;

    if (mode === 'Live') {
      ack = window.confirm(
        'Put martingale ladders LIVE?\n\n' +
          'Every enabled (account, symbol) pair will start sizing recovery rungs with real ' +
          'orders — a loss escalates the next position instead of being logged.\n\n' +
          'This is fleet-wide and takes effect within a minute. Continue?',
      );
      if (!ack) return;

      reason = window.prompt('Reason for going Live (required):');
      if (!reason || !reason.trim()) return;
    }

    this.savingMode.set(true);
    this.error.set(null);
    this.martingale.setMode({ mode, reason, acknowledgeLiveTrading: ack }).subscribe({
      next: (r) => {
        this.savingMode.set(false);
        // Report the blast radius the server measured, rather than leaving the operator to guess
        // how many ladders a fleet-wide switch just touched.
        if (r.activeLadderCount > 0) {
          window.alert(
            `Mode ${r.previousMode} → ${r.newMode}.\n\n` +
              `${r.activeLadderCount} active ladder(s) affected:\n${r.activeLadders.join('\n')}`,
          );
        }
        this.load();
      },
      error: (e: { message?: string }) => {
        this.error.set(e?.message ?? 'Could not change the martingale mode.');
        this.savingMode.set(false);
        this.load();
      },
    });
  }

  // ── Profile defaults ──────────────────────────────────────────────────────

  /** Keeps the live worst-case projection in step with the depth field as it is typed. */
  onDepthChange(value: number | string): void {
    this.draftDepth.set(Number(value) || 0);
  }

  resetProfileForm(): void {
    const v = this.view();
    if (!v) return;
    this.pf = {
      enabled: v.profileMartingaleEnabled,
      maxDepth: v.defaultMaxDepth,
      targetProfitR: v.defaultTargetProfitR,
      maxStakePctEquity: v.defaultMaxStakePctEquity,
      maxChainAgeHours: v.defaultMaxChainAgeHours,
      abandonAtCap: v.defaultAbandonAtCap,
    };
    this.draftDepth.set(v.defaultMaxDepth);
  }

  saveProfile(): void {
    const v = this.view();
    if (!v?.riskProfileId) {
      this.error.set('This account has no risk profile, so there is nothing to configure.');
      return;
    }

    // Keep the projection honest if the operator typed without blurring.
    this.draftDepth.set(Number(this.pf.maxDepth) || 0);

    let reason: string | null = null;
    if (this.pf.enabled) {
      const shared = v.accountsSharingProfile.length;
      reason = window.prompt(
        `Allow martingale on "${v.riskProfileName}"?\n\n` +
          (shared > 0
            ? `This profile is shared with ${shared} other account(s): #${v.accountsSharingProfile.join(', #')}. ` +
              `Ladders become reachable for all of them (each still needs its own per-symbol opt-in).\n\n`
            : '') +
          `Worst case at depth ${this.pf.maxDepth}: ${this.projectedWorstCase().toFixed(1)}% of equity.\n\n` +
          `Reason (required):`,
      );
      if (!reason || !reason.trim()) return;
    }

    // AbandonAtCap = false removes the only bound on a chain's loss. The server demands an
    // explicit acknowledgement rather than trusting a dialog, so the intent lands in the audit
    // trail instead of only in the browser that clicked OK.
    let ack = false;
    if (!this.pf.abandonAtCap) {
      ack = window.confirm(
        'Disabling "Abandon at depth cap" makes the worst-case loss UNBOUNDED — a chain will keep ' +
          'escalating past the depth cap until the equity floor or a halt stops it.\n\n' +
          'This is recorded in the audit trail. Continue?',
      );
      if (!ack) return;
    }

    this.savingProfile.set(true);
    this.error.set(null);
    this.martingale
      .setProfile(v.riskProfileId, {
        enabled: this.pf.enabled,
        targetProfitR: Number(this.pf.targetProfitR),
        maxDepth: Number(this.pf.maxDepth),
        maxStakePctEquity: Number(this.pf.maxStakePctEquity),
        maxChainAgeHours: Number(this.pf.maxChainAgeHours),
        abandonAtCap: this.pf.abandonAtCap,
        acknowledgeUnboundedRisk: ack,
        reason,
      })
      .subscribe({
        next: () => {
          this.savingProfile.set(false);
          this.load();
        },
        error: (e: { message?: string }) => {
          this.error.set(e?.message ?? 'Could not save the profile defaults.');
          this.savingProfile.set(false);
          this.load();
        },
      });
  }

  // ── Per-symbol overrides ──────────────────────────────────────────────────

  hasOverrides(s: MartingaleSymbolDto): boolean {
    return (
      s.maxDepthOverride != null ||
      s.targetProfitROverride != null ||
      s.maxStakePctEquityOverride != null ||
      s.maxChainAgeHoursOverride != null
    );
  }

  startEdit(s: MartingaleSymbolDto): void {
    this.editing.set(s.symbol);
    // null becomes '' rather than 0 — an empty field means inherit, and a 0 stake ceiling would
    // abandon every chain on its first rung.
    this.ef = {
      maxDepthOverride: s.maxDepthOverride ?? '',
      targetProfitROverride: s.targetProfitROverride ?? '',
      maxStakePctEquityOverride: s.maxStakePctEquityOverride ?? '',
      maxChainAgeHoursOverride: s.maxChainAgeHoursOverride ?? '',
    };
  }

  cancelEdit(): void {
    this.editing.set(null);
  }

  saveOverrides(s: MartingaleSymbolDto): void {
    this.writeSymbol(s, {
      maxDepthOverride: toNullableNumber(this.ef.maxDepthOverride),
      targetProfitROverride: toNullableNumber(this.ef.targetProfitROverride),
      maxStakePctEquityOverride: toNullableNumber(this.ef.maxStakePctEquityOverride),
      maxChainAgeHoursOverride: toNullableNumber(this.ef.maxChainAgeHoursOverride),
    });
  }

  clearOverrides(s: MartingaleSymbolDto): void {
    this.writeSymbol(s, {
      maxDepthOverride: null,
      targetProfitROverride: null,
      maxStakePctEquityOverride: null,
      maxChainAgeHoursOverride: null,
    });
  }

  /**
   * Overrides are written with the symbol's CURRENT enabled state, never a fresh decision — a
   * tuning edit must not silently switch a ladder on or off.
   */
  private writeSymbol(
    s: MartingaleSymbolDto,
    overrides: {
      maxDepthOverride: number | null;
      targetProfitROverride: number | null;
      maxStakePctEquityOverride: number | null;
      maxChainAgeHoursOverride: number | null;
    },
  ): void {
    const id = this.accountId();
    if (id == null) return;

    this.saving.set(true);
    this.error.set(null);
    this.martingale
      .setSymbol(id, s.symbol, {
        enabled: s.enabled,
        ...overrides,
        reason: s.enabled ? `Tuning overrides for ${s.symbol}` : null,
      })
      .subscribe({
        next: () => {
          this.saving.set(false);
          this.editing.set(null);
          this.load();
        },
        error: (e: { message?: string }) => {
          this.error.set(e?.message ?? 'Could not save the overrides.');
          this.saving.set(false);
          this.load();
        },
      });
  }

  toggle(symbol: MartingaleSymbolDto, enabled: boolean): void {
    const id = this.accountId();
    if (id == null) return;

    // Enabling requires a reason on the server — it is a risk-loosening change and goes through
    // the same config-governance audit as any other. Prompting here keeps that honest rather than
    // sending a placeholder.
    let reason: string | null = null;
    if (enabled) {
      reason = window.prompt(
        `Enable a martingale recovery ladder for ${symbol.symbol} on account #${id}?\n\n` +
          `Worst case if every rung to depth ${symbol.effectiveMaxDepth} loses: ` +
          `${symbol.worstCaseDrawdownPct.toFixed(1)}% of equity.\n\n` +
          `Reason (required):`,
      );
      if (!reason || !reason.trim()) return;
    }

    this.saving.set(true);
    this.error.set(null);
    this.martingale.setSymbol(id, symbol.symbol, { enabled, reason }).subscribe({
      next: () => {
        this.saving.set(false);
        this.load();
      },
      error: (e: { message?: string }) => {
        this.error.set(e?.message ?? 'Could not update the ladder.');
        this.saving.set(false);
        this.load();
      },
    });
  }
}

/**
 * Blank / empty means INHERIT the profile default, so it maps to null rather than 0. Getting this
 * backwards would write a stake ceiling of 0, which abandons every chain on its first rung.
 */
function toNullableNumber(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
