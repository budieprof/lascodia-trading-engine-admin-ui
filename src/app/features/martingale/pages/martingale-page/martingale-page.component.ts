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
import { ToggleComponent } from '@shared/components/ui/toggle/toggle.component';
import { ModalA11yDirective } from '@shared/directives/modal-a11y.directive';

/**
 * One question put to the operator before a write. Every risk-bearing change on this page goes
 * through it — the fleet-wide mode switch used to fire straight from the Off / Shadow click, and the
 * rest asked through window.prompt / confirm / alert, which an automated session dismisses unseen
 * and an operator cannot read back once answered.
 */
interface MartingaleAsk {
  title: string;
  lines: string[];
  /** Show the fleet-wide open-chain summary (mode switches). */
  showChains?: boolean;
  /** Present = a reason box; `reasonRequired` makes it mandatory (the server's rule). */
  reasonLabel?: string;
  reasonRequired?: boolean;
  /** Present = a checkbox that must be ticked (server-side acknowledgements). */
  ackLabel?: string;
  confirmLabel: string;
  danger?: boolean;
  run: (reason: string | null, ack: boolean) => void;
  /** Undo whatever the trigger already did on screen (a switch that flipped itself). */
  onCancel?: () => void;
}

/** Which symbols the table shows — a filter over rows already loaded. */
type SymbolFilter = 'all' | 'laddered' | 'overrides' | 'chain';

/** Fleet-wide open chains, read when a mode switch is asked. */
interface ModeChainSummary {
  count: number;
  outstanding: number;
  lines: string[];
}

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
    ToggleComponent,
    ModalA11yDirective,
  ],
  styleUrl: './martingale-page.scss',
  template: `
    <!--
      This page configures what the ladder WILL do; the internals page explains what it HAS done.
      The link sits at the top because "why is this chain at depth 3?" is usually the question
      that brought an operator here in the first place.
    -->
    <app-page-header
      title="Martingale Ladders"
      subtitle="Per-symbol recovery ladders, opted in one account and one symbol at a time."
    >
      <a
        class="btn-ghost internals-link"
        routerLink="/martingale/internals"
        title="Chains, ledgers and next-rung previews"
      >
        Open ladder internals → chains, ledgers and next-rung previews
      </a>
    </app-page-header>

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
                <!-- Not "chain state untouched": the close handler advances open chains in every
                     mode (engine need filed), so only the sizing claim is made here. -->
                Ladders size nothing — every order goes out at base size.
              }
            }
          </span>
          <div class="mode-actions">
            <span class="mode-scope">fleet-wide · every account</span>
            <div class="mode-seg" role="group" aria-label="Martingale mode">
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
            </div>
            @if (savingMode()) {
              <span class="saving">Saving…</span>
            }
          </div>
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
      <span class="acct-hint">
        Profile defaults and symbol switches below apply to this account's ladders.
      </span>
      @if (saving()) {
        <span class="saving">Saving…</span>
      }
    </div>

    @if (error(); as e) {
      <div class="banner err" role="alert">{{ e }}</div>
    }
    @if (notice(); as n) {
      <div class="banner info" role="status">
        <span class="notice-text">{{ n }}</span>
        <button type="button" class="notice-close" (click)="notice.set(null)" aria-label="Dismiss">
          ✕
        </button>
      </div>
    }

    @if (loading()) {
      <app-card-skeleton />
    } @else if (view(); as v) {
      <!--
        The profile gate comes first because it is a precondition, not a detail: every symbol
        toggle below is inert while it is off, and the flag is shared with any account on the
        same profile.
      -->
      <section class="gate card" [class.gate-off]="!v.profileMartingaleEnabled">
        <div class="gate-head">
          <span class="dot" [class.ok]="v.profileMartingaleEnabled"></span>
          <span class="gate-k">Risk profile</span>
          <strong class="gate-name">{{ v.riskProfileName || '—' }}</strong>
          <span class="pill" [class.ok]="v.profileMartingaleEnabled">
            {{ v.profileMartingaleEnabled ? 'martingale allowed' : 'martingale disabled' }}
          </span>
        </div>

        @if (!v.profileMartingaleEnabled) {
          <p class="callout warn gate-note">
            Every symbol toggle below is inert until this profile allows martingale. Enable it on
            the Risk Profiles page.
          </p>
        }

        @if (v.accountsSharingProfile.length > 0) {
          <p class="callout warn gate-note">
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
        <div class="pgrid">
          <div class="pform">
            <div class="pswitches">
              <label class="fld master">
                <ui-toggle [(ngModel)]="pf.enabled" [disabled]="savingProfile()" />
                <span>Allow martingale on this profile</span>
                <span class="pill" [class.ok]="pf.enabled">{{
                  pf.enabled ? 'allowed' : 'off'
                }}</span>
              </label>

              <label class="fld master">
                <ui-toggle [(ngModel)]="pf.abandonAtCap" [disabled]="savingProfile()" />
                <span>Abandon at depth cap</span>
                <span class="pill" [class.ok]="pf.abandonAtCap" [class.bad]="!pf.abandonAtCap">
                  {{ pf.abandonAtCap ? 'bounded' : 'unbounded' }}
                </span>
              </label>
            </div>

            <div class="pfields">
              <label
                class="fld"
                title="Recovery rungs allowed after the opening loss. The opening loss is depth 0 and does not count, so a cap of 2 permits two recovery trades and a fully-lost chain has lost three times."
              >
                <span>Depth cap (recovery rungs)</span>
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
                <input
                  type="number"
                  min="1"
                  max="8760"
                  step="1"
                  [(ngModel)]="pf.maxChainAgeHours"
                />
              </label>
            </div>
          </div>

          <!--
            The projected worst case is computed client-side from the DRAFT depth, so it moves as
            the operator types. Showing it only after saving would mean the number that decides
            whether a cap is safe arrives after the decision.
          -->
          <div
            class="kpi proj"
            [class.neg]="!pf.abandonAtCap || projectedWorstCase() >= v.haltedDrawdownPct"
            [class.warn]="
              pf.abandonAtCap &&
              projectedWorstCase() >= v.reducedDrawdownPct &&
              projectedWorstCase() < v.haltedDrawdownPct
            "
            [class.pos]="pf.abandonAtCap && projectedWorstCase() < v.reducedDrawdownPct"
          >
            <div class="k-label">Worst case (draft)</div>
            <div
              class="k-value"
              [class.danger]="!pf.abandonAtCap || projectedWorstCase() >= v.haltedDrawdownPct"
            >
              {{ projectedWorstCase() | number: '1.0-1' }}%
              <span class="k-unit">of equity</span>
            </div>
            <p
              class="proj-copy"
              [class.danger]="projectedWorstCase() >= v.haltedDrawdownPct"
              [class.warn]="
                projectedWorstCase() >= v.reducedDrawdownPct &&
                projectedWorstCase() < v.haltedDrawdownPct
              "
            >
              Worst case at {{ pf.maxDepth }} recovery rung{{ pf.maxDepth === 1 ? '' : 's' }} (the
              opening loss plus every rung losing) on {{ v.baseRiskPerTradePct }}% base risk:
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
          </div>
        </div>

        <!--
          Deliberately a secondary button: saving defaults is bookkeeping. The
          risk-bearing action on this page is switching a symbol's ladder on
          below, and the visual weight should say so.
        -->
        <div class="pactions">
          <button
            type="button"
            class="secondary"
            (click)="saveProfile()"
            [disabled]="savingProfile()"
          >
            {{ savingProfile() ? 'Saving…' : 'Save profile defaults' }}
          </button>
          <button type="button" class="ghost" (click)="resetProfileForm()">Reset</button>
          <span class="pactions-hint">Every save asks for confirmation first.</span>
        </div>
      </section>

      @if (openChains().length > 0) {
        <section class="chains card">
          <div class="chains-head">
            <h2>Open chains</h2>
            <a class="btn-link" routerLink="/martingale/internals">Ledgers →</a>
          </div>
          <ul>
            @for (s of openChains(); track s.symbol) {
              <li>
                <b>{{ s.symbol }}</b>
                depth {{ s.chainDepth }}, owing
                <span class="neg">{{ s.chainDeficitAmount | number: '1.2-2' }}</span> (target
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
        <section class="symbols card flush">
          <div class="sym-bar">
            <!--
              With no per-symbol override every row repeats the profile defaults, so
              say that once above the table and mute the inherited cells — the eye
              then lands on the two things that vary: the ladder switch and any
              override that has been set.
            -->
            <p class="table-summary">
              <b>{{ v.symbols.length }} symbols</b> · <b>{{ enabledCount() }}</b> laddered ·
              @if (overrideCount() === 0) {
                all inherit the profile defaults (depth {{ v.defaultMaxDepth }} ·
                {{ v.defaultWorstCaseDrawdownPct | number: '1.0-1' }}% worst case ·
                {{ v.defaultTargetProfitR }}R · {{ v.defaultMaxStakePctEquity }}% stake)
              } @else {
                <b>{{ overrideCount() }}</b> with overrides; muted values inherit the profile
                defaults
              }
            </p>
            <div class="seg" role="group" aria-label="Show symbols">
              @for (f of symFilters; track f.key) {
                <button
                  type="button"
                  [class.on]="symFilter() === f.key"
                  (click)="symFilter.set(f.key)"
                >
                  {{ f.label }}<span class="n">{{ symCount(f.key) }}</span>
                </button>
              }
            </div>
          </div>
          @if (shownSymbols().length === 0) {
            <div class="empty">
              <strong>No symbols match this view.</strong>
              Switch to All to see every symbol on this account.
            </div>
          } @else {
            <div class="table-wrap">
              <table class="mtg">
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th>Ladder</th>
                    <th class="n">Depth cap</th>
                    <th class="n">Worst case</th>
                    <th class="n">Target</th>
                    <th class="n">Max stake</th>
                    <th>Chain</th>
                    <th class="c">Tune</th>
                  </tr>
                </thead>
                <tbody>
                  <!--
                    Rows are keyed on (symbol, rowRev): the switch is a control-value
                    accessor that flips its own visual state on click, so when the
                    operator dismisses the reason prompt the model stays false
                    while the knob shows "on". Bumping rowRev re-creates the row and
                    the switch re-reads the model.
                  -->
                  @for (s of shownSymbols(); track s.symbol + ':' + rowRev()) {
                    <tr [class.active]="s.effectivelyActive">
                      <td class="sym">{{ s.symbol }}</td>
                      <td>
                        <div class="ladder-cell">
                          <ui-toggle
                            [ngModel]="s.enabled"
                            (ngModelChange)="toggle(s, $event)"
                            [disabled]="saving() || (!s.enabled && !v.profileMartingaleEnabled)"
                            [attr.aria-label]="'Ladder ' + s.symbol"
                          />
                          @if (s.effectivelyActive) {
                            <span class="pill ok">enabled</span>
                          } @else if (s.enabled) {
                            <span class="pill warn" title="Profile does not allow martingale"
                              >inert</span
                            >
                          } @else {
                            <span class="pill">off</span>
                          }
                        </div>
                      </td>
                      <td class="n" [class.inherit]="(s.maxDepthOverride ?? null) === null">
                        {{ s.effectiveMaxDepth }}
                      </td>
                      <!--
                        Worst case is shown on every row, not just enabled ones, because it is the
                        number that decides whether the depth cap is safe: a rung is exempt from
                        Reduced recovery, so these caps are all that keeps a chain inside the halt
                        boundary. The threshold is the profile's own Halted %, not a hard-coded 20.
                      -->
                      <td
                        class="n"
                        [class.inherit]="(s.maxDepthOverride ?? null) === null"
                        [class.danger]="s.worstCaseDrawdownPct >= v.haltedDrawdownPct"
                        [class.warn]="
                          s.worstCaseDrawdownPct >= v.reducedDrawdownPct &&
                          s.worstCaseDrawdownPct < v.haltedDrawdownPct
                        "
                      >
                        {{ s.worstCaseDrawdownPct | number: '1.0-1' }}%
                      </td>
                      <td class="n" [class.inherit]="(s.targetProfitROverride ?? null) === null">
                        {{ s.effectiveTargetProfitR }}R
                      </td>
                      <td
                        class="n"
                        [class.inherit]="(s.maxStakePctEquityOverride ?? null) === null"
                      >
                        {{ s.effectiveMaxStakePctEquity }}%
                      </td>
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

                            <label
                              class="fld"
                              title="Round-trip broker cost per lot, in account currency. Subtracted from a rung's reward so a win recovers the deficit net of the commission the rung itself pays. Measure it from recent closes; blank models no cost."
                            >
                              <span>Cost /lot</span>
                              <input
                                type="number"
                                min="0"
                                max="10000"
                                step="0.5"
                                [(ngModel)]="ef.rungCostPerLotOverride"
                                placeholder="0"
                              />
                            </label>

                            <div class="edit-actions">
                              <button
                                type="button"
                                (click)="saveOverrides(s)"
                                [disabled]="saving()"
                              >
                                Save
                              </button>
                              <button type="button" class="ghost" (click)="cancelEdit()">
                                Cancel
                              </button>
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
        </section>
      }
    } @else {
      <app-empty-state title="Select an account to view its ladders." />
    }

    @if (ask(); as a) {
      <div class="ask-backdrop" role="presentation" (click)="cancelAsk()">
        <div
          class="ask"
          [class.danger]="a.danger"
          role="dialog"
          aria-modal="true"
          aria-labelledby="mtg-ask-title"
          appModalA11y
          (dismiss)="cancelAsk()"
          (click)="$event.stopPropagation()"
        >
          <h3 id="mtg-ask-title">{{ a.title }}</h3>
          @for (line of a.lines; track $index) {
            <p>{{ line }}</p>
          }
          @if (a.showChains) {
            <div class="ask-chains">
              @if (modeChains() === null) {
                <span class="muted">Reading open chains…</span>
              } @else if (modeChains() === 'unavailable') {
                <span class="warn">Open chains could not be read — check the internals page.</span>
              } @else if (modeChainSummary(); as c) {
                @if (c.count === 0) {
                  <span>No open chains fleet-wide — nothing is mid-recovery.</span>
                } @else {
                  <strong>
                    {{ c.count }} open chain{{ c.count === 1 ? '' : 's' }} fleet-wide, owing
                    {{ c.outstanding | number: '1.2-2' }}:
                  </strong>
                  <ul>
                    @for (l of c.lines; track $index) {
                      <li>{{ l }}</li>
                    }
                  </ul>
                }
              }
            </div>
          }
          @if (a.reasonLabel) {
            <label class="ask-field">
              <span>{{ a.reasonLabel }}</span>
              <textarea rows="2" [(ngModel)]="askReason" [disabled]="askBusy()"></textarea>
            </label>
          }
          @if (a.ackLabel) {
            <label class="ask-ack">
              <input type="checkbox" [(ngModel)]="askAck" [disabled]="askBusy()" />
              <span>{{ a.ackLabel }}</span>
            </label>
          }
          <div class="ask-actions">
            <button
              type="button"
              class="ghost"
              (click)="cancelAsk()"
              [disabled]="askBusy()"
              data-autofocus
            >
              Cancel
            </button>
            <button
              type="button"
              [class.danger-btn]="a.danger"
              [disabled]="askBusy() || !askReady(a)"
              (click)="confirmAsk(a)"
            >
              {{ a.confirmLabel }}
            </button>
          </div>
        </div>
      </div>
    }
  `,
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
  readonly enabledCount = computed(
    () => (this.view()?.symbols ?? []).filter((s) => s.effectivelyActive).length,
  );
  readonly overrideCount = computed(
    () => (this.view()?.symbols ?? []).filter((s) => this.hasOverrides(s)).length,
  );

  // ── Client-side view over the symbols already loaded (no request) ─────────
  readonly symFilters: readonly { key: SymbolFilter; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'laddered', label: 'Switched on' },
    { key: 'overrides', label: 'With overrides' },
    { key: 'chain', label: 'Open chain' },
  ];
  readonly symFilter = signal<SymbolFilter>('all');
  readonly shownSymbols = computed(() => {
    const f = this.symFilter();
    return (this.view()?.symbols ?? []).filter((s) => this.symbolInFilter(s, f));
  });

  symCount(f: SymbolFilter): number {
    return (this.view()?.symbols ?? []).filter((s) => this.symbolInFilter(s, f)).length;
  }

  private symbolInFilter(s: MartingaleSymbolDto, f: SymbolFilter): boolean {
    switch (f) {
      case 'laddered':
        return s.enabled;
      case 'overrides':
        return this.hasOverrides(s);
      case 'chain':
        return s.hasOpenChain;
      default:
        return true;
    }
  }

  readonly savingProfile = signal(false);
  readonly savingMode = signal(false);
  readonly editing = signal<string | null>(null);
  /** Outcome of the last fleet-wide action, shown in-page (it used to be a window.alert). */
  readonly notice = signal<string | null>(null);

  // ── Confirmation dialog ───────────────────────────────────────────────────
  readonly ask = signal<MartingaleAsk | null>(null);
  /** Bound to the dialog's reason box / acknowledgement; reset per question. */
  askReason = '';
  askAck = false;
  /** Open chains fleet-wide while a mode switch is being asked; null = still reading. */
  readonly modeChains = signal<ModeChainSummary | 'unavailable' | null>(null);
  readonly modeChainSummary = computed(() => {
    const c = this.modeChains();
    return c && c !== 'unavailable' ? c : null;
  });
  /** A dialog's write is in flight — Cancel / Escape must not abandon it. */
  readonly askBusy = computed(() => this.savingMode() || this.savingProfile() || this.saving());

  private openAsk(a: MartingaleAsk): void {
    this.askReason = '';
    this.askAck = false;
    this.ask.set(a);
  }

  askReady(a: MartingaleAsk): boolean {
    if (a.reasonRequired && !this.askReason.trim()) return false;
    if (a.ackLabel && !this.askAck) return false;
    return true;
  }

  confirmAsk(a: MartingaleAsk): void {
    if (!this.askReady(a)) return;
    const reason = this.askReason.trim() || null;
    const ack = this.askAck;
    this.ask.set(null);
    a.run(reason, ack);
  }

  cancelAsk(): void {
    if (this.askBusy()) return;
    const a = this.ask();
    this.ask.set(null);
    a?.onCancel?.();
  }
  /** See the @for track comment in the template — forces switch re-creation. */
  readonly rowRev = signal(0);

  readonly modes: MartingaleMode[] = ['Off', 'Shadow', 'Live'];

  /**
   * Draft profile settings. A plain mutable object rather than a signal because ngModel two-way
   * binding writes into it directly; `projectedDepth` is the signal that drives recomputation.
   */
  pf = {
    enabled: false,
    maxDepth: 2,
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
    rungCostPerLotOverride: number | string | null;
  } = {
    maxDepthOverride: '',
    targetProfitROverride: '',
    maxStakePctEquityOverride: '',
    maxChainAgeHoursOverride: '',
    rungCostPerLotOverride: '',
  };

  /** Mirrors pf.maxDepth so the projection recomputes as the operator types. */
  private readonly draftDepth = signal(2);

  /**
   * Worst-case cumulative loss if the opening trade and every rung to the depth cap all lose.
   *
   * A rung sized to recover the accumulated deficit plus a target grows roughly 3x per step at
   * this book's geometry, so k consecutive losses cost basePct * (3^k - 1)/2. The depth cap counts
   * RECOVERY rungs — the opening loss is depth 0 — so k = maxDepth + 1. Mirrors the server's
   * calculation deliberately: the operator needs it while typing, not after saving.
   */
  readonly projectedWorstCase = computed(() => {
    const base = this.view()?.baseRiskPerTradePct ?? 0;
    const depth = Math.min(Math.max(this.draftDepth(), 0), 20);
    if (base <= 0 || depth <= 0) return 0;
    return (base * (Math.pow(3, depth + 1) - 1)) / 2;
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
        this.rowRev.update((n) => n + 1);
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
    // Every switch asks. It is fleet-wide — every account at once — and it lands mid-chain: what
    // happens to the open chains is the thing the operator has to weigh, so they are listed.
    // Going Live additionally needs the server's reason + explicit acknowledgement.
    const from = this.view()?.mode ?? null;
    const lines: string[] = [];
    if (mode === 'Live') {
      lines.push(
        'Every enabled (account, symbol) pair starts sizing recovery rungs with real orders — a ' +
          'loss escalates the next position instead of being logged.',
      );
      if (from === 'Shadow') {
        lines.push(
          'Open chains keep the depth and deficit they built up in Shadow; their next rung is ' +
            'sized with real money.',
        );
      }
    } else if (mode === 'Shadow') {
      lines.push(
        from === 'Live'
          ? 'Rungs stop being applied — the next position on every laddered symbol goes out at ' +
              'base size, so open deficits stop being recovered by size. Chains keep advancing ' +
              'against real fills and their rungs are logged.'
          : 'Rungs are computed and logged against real fills but never applied to an order.',
      );
    } else {
      lines.push(
        'Sizing returns to base on every laddered symbol. Open chains are not cleared — their ' +
          'deficits stay on the books (closes are still recorded against them), and the next ' +
          'rung is sized from them when the mode leaves Off.',
      );
    }
    lines.push('Fleet-wide: every account, effective within a minute.');

    this.modeChains.set(null);
    this.martingale.getOverview({ status: 'Open', maxChains: 50 }).subscribe({
      next: (o) => {
        const open = o.chains.filter((c) => c.status === 'Open');
        this.modeChains.set({
          count: o.totals.openChains,
          outstanding: o.totals.outstandingDeficit,
          lines: open.map(
            (c) =>
              `${c.symbol} · ${c.accountName} #${c.tradingAccountId} — depth ${c.depth}/` +
              `${c.maxDepth}, owing ${c.deficitAmount.toFixed(2)}`,
          ),
        });
      },
      error: () => this.modeChains.set('unavailable'),
    });

    this.openAsk({
      title: `Switch martingale to ${mode}?`,
      lines,
      showChains: true,
      reasonLabel:
        mode === 'Live' ? 'Reason (required, audit trail)' : 'Reason (optional, audit trail)',
      reasonRequired: mode === 'Live',
      ackLabel:
        mode === 'Live'
          ? 'I understand ladders will place real, size-escalating orders on every enabled pair.'
          : undefined,
      confirmLabel: mode === 'Live' ? 'Go Live' : `Switch to ${mode}`,
      danger: mode === 'Live',
      run: (reason, ack) => this.applyMode(mode, reason, mode === 'Live' && ack),
    });
  }

  private applyMode(mode: MartingaleMode, reason: string | null, ack: boolean): void {
    this.savingMode.set(true);
    this.error.set(null);
    this.notice.set(null);
    this.martingale.setMode({ mode, reason, acknowledgeLiveTrading: ack }).subscribe({
      next: (r) => {
        this.savingMode.set(false);
        // Report the blast radius the server measured, rather than leaving the operator to guess
        // how many ladders a fleet-wide switch just touched.
        this.notice.set(
          `Mode ${r.previousMode} → ${r.newMode}. ` +
            (r.activeLadderCount > 0
              ? `${r.activeLadderCount} active ladder(s) affected: ${r.activeLadders.join(', ')}.`
              : 'No active ladders were affected.'),
        );
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

    const shared = v.accountsSharingProfile.length;
    const lines = [
      `Depth cap ${this.pf.maxDepth} · target ${this.pf.targetProfitR}R · max stake ` +
        `${this.pf.maxStakePctEquity}% · chain age cap ${this.pf.maxChainAgeHours}h. Worst case at ` +
        `depth ${this.pf.maxDepth}: ${this.projectedWorstCase().toFixed(1)}% of equity.`,
    ];
    if (shared > 0) {
      lines.push(
        `This profile is shared with ${shared} other account(s): #` +
          `${v.accountsSharingProfile.join(', #')}. The change applies to all of them` +
          (this.pf.enabled ? ' (each still needs its own per-symbol opt-in).' : '.'),
      );
    }
    // AbandonAtCap = false removes the only bound on a chain's loss. The server demands an
    // explicit acknowledgement rather than trusting a dialog, so the intent lands in the audit
    // trail instead of only in the browser that clicked OK.
    if (!this.pf.abandonAtCap) {
      lines.push(
        'Abandon at depth cap is OFF: the worst-case loss is UNBOUNDED — a chain keeps escalating ' +
          'past the depth cap until the equity floor or a halt stops it.',
      );
    }

    this.openAsk({
      title: this.pf.enabled
        ? `Allow martingale on "${v.riskProfileName}"?`
        : `Save martingale defaults for "${v.riskProfileName}"?`,
      lines,
      reasonLabel: this.pf.enabled
        ? 'Reason (required, audit trail)'
        : 'Reason (optional, audit trail)',
      reasonRequired: this.pf.enabled,
      ackLabel: this.pf.abandonAtCap
        ? undefined
        : 'I understand the worst-case loss is unbounded; record that in the audit trail.',
      confirmLabel: 'Save profile defaults',
      danger: this.pf.enabled && !this.pf.abandonAtCap,
      run: (reason, ack) => this.writeProfile(v.riskProfileId!, reason, ack),
    });
  }

  private writeProfile(riskProfileId: number, reason: string | null, ack: boolean): void {
    this.savingProfile.set(true);
    this.error.set(null);
    this.martingale
      .setProfile(riskProfileId, {
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
      s.maxChainAgeHoursOverride != null ||
      s.rungCostPerLot != null
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
      rungCostPerLotOverride: s.rungCostPerLot ?? '',
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
      rungCostPerLotOverride: toNullableNumber(this.ef.rungCostPerLotOverride),
    });
  }

  clearOverrides(s: MartingaleSymbolDto): void {
    this.writeSymbol(s, {
      maxDepthOverride: null,
      targetProfitROverride: null,
      maxStakePctEquityOverride: null,
      maxChainAgeHoursOverride: null,
      rungCostPerLotOverride: null,
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
      rungCostPerLotOverride: number | null;
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

    // Both directions ask. Enabling requires a reason on the server — it is a risk-loosening change
    // and goes through the same config-governance audit as any other. Disabling mid-chain leaves
    // the deficit on the books, which the operator should see before choosing it.
    const lines: string[] = [];
    if (enabled) {
      lines.push(
        `Worst case if every rung to depth ${symbol.effectiveMaxDepth} loses: ` +
          `${symbol.worstCaseDrawdownPct.toFixed(1)}% of equity.`,
      );
    } else {
      lines.push(`New positions on ${symbol.symbol} go out at base size.`);
      if (symbol.hasOpenChain) {
        lines.push(
          `Its open chain (depth ${symbol.chainDepth}, owing ` +
            `${symbol.chainDeficitAmount.toFixed(2)}) is NOT cleared — the deficit stays visible ` +
            `and is picked up again if the ladder is re-enabled. Reset it on the internals page ` +
            `to write it off.`,
        );
      }
    }
    this.openAsk({
      title: enabled
        ? `Enable a recovery ladder for ${symbol.symbol} on account #${id}?`
        : `Disable the ${symbol.symbol} ladder on account #${id}?`,
      lines,
      reasonLabel: enabled ? 'Reason (required, audit trail)' : undefined,
      reasonRequired: enabled,
      confirmLabel: enabled ? 'Enable ladder' : 'Disable ladder',
      danger: enabled,
      run: (reason) => this.writeToggle(id, symbol, enabled, reason),
      // The switch flipped itself on click; re-create the row so it re-reads the model.
      onCancel: () => this.rowRev.update((n) => n + 1),
    });
  }

  private writeToggle(
    id: number,
    symbol: MartingaleSymbolDto,
    enabled: boolean,
    reason: string | null,
  ): void {
    this.saving.set(true);
    this.error.set(null);
    // The PUT is a full replace, so every override has to be re-sent or the toggle silently
    // wipes them. Flipping a ladder off and on again used to reset the depth cap, stake ceiling
    // and age cap to the profile defaults without saying so.
    this.martingale
      .setSymbol(id, symbol.symbol, {
        enabled,
        reason,
        maxDepthOverride: symbol.maxDepthOverride,
        targetProfitROverride: symbol.targetProfitROverride,
        maxStakePctEquityOverride: symbol.maxStakePctEquityOverride,
        maxChainAgeHoursOverride: symbol.maxChainAgeHoursOverride,
        rungCostPerLotOverride: symbol.rungCostPerLot,
      })
      .subscribe({
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
