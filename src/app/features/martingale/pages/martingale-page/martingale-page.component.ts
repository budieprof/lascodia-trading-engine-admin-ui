import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';

import {
  MartingaleService,
  type MartingaleAccountSymbolsDto,
  type MartingaleSymbolDto,
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

        <div class="defaults">
          <span
            >depth <b>{{ v.defaultMaxDepth }}</b></span
          >
          <span
            >target <b>{{ v.defaultTargetProfitR }}R</b></span
          >
          <span
            >max stake <b>{{ v.defaultMaxStakePctEquity }}%</b></span
          >
          <span
            >age cap <b>{{ v.defaultMaxChainAgeHours }}h</b></span
          >
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
                </tr>
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
      .defaults {
        display: flex;
        gap: var(--space-4);
        margin-top: var(--space-3);
        font-size: 12px;
        color: var(--text-secondary);
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
        this.loading.set(false);
      },
      error: (e: { message?: string }) => {
        this.error.set(e?.message ?? 'Could not load martingale settings.');
        this.loading.set(false);
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
