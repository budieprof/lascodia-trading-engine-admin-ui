import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { LucideDynamicIcon } from '@lucide/angular';

import type { TradingAccountDto } from '@core/api/api.types';
import { ModalA11yDirective } from '@shared/directives/modal-a11y.directive';
import { navIcon } from '../../layout/sidebar/nav-icons';
import { AccountScopeService } from './account-scope.service';

/** One choice in the account menu. `value` is a scope sentinel or an account id, as a string. */
export interface ScopeOption {
  value: string;
  title: string;
  meta: string;
  /** Small status words beside the title: "real", "demo", "paper". */
  badges: { text: string; tone: 'real' | 'warn' | 'plain' }[];
  aggregate: boolean;
}

/** "1 real, 2 demo" for the accounts given, by broker account type. */
export function brokerTypeMix(accounts: readonly TradingAccountDto[]): string {
  const counts = new Map<string, number>();
  for (const a of accounts) {
    const t = (a.accountType ?? 'Real').toLowerCase();
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return ['real', 'demo', 'contest']
    .filter((t) => counts.has(t))
    .map((t) => `${counts.get(t)} ${t}`)
    .join(', ');
}

/**
 * "real" in the scope model means NOT engine-paper; it says nothing about the broker. Four demo
 * accounts and one real one used to read "All real (5)", i.e. real money, so the aggregate is only
 * called "real" when every account in it is a broker Real account.
 */
export function aggregateTitle(accounts: readonly TradingAccountDto[]): string {
  const allReal = accounts.every((a) => (a.accountType ?? 'Real') === 'Real');
  return allReal ? 'All real accounts' : 'All accounts';
}

/** The menu's choices: the aggregates first, then each live account. */
export function scopeOptions(
  live: readonly TradingAccountDto[],
  liveReal: readonly TradingAccountDto[],
): ScopeOption[] {
  const plural = (n: number) => `${n} account${n === 1 ? '' : 's'}`;
  const out: ScopeOption[] = [
    {
      value: AccountScopeService.SCOPE_AGGREGATE_REAL,
      title: aggregateTitle(liveReal),
      meta: [plural(liveReal.length), brokerTypeMix(liveReal), 'aggregated']
        .filter(Boolean)
        .join(' · '),
      badges: [],
      aggregate: true,
    },
  ];
  const paper = live.length - liveReal.length;
  if (paper > 0) {
    out.push({
      value: AccountScopeService.SCOPE_AGGREGATE_ALL,
      title: 'All live accounts',
      meta: `${plural(live.length)} · incl. ${paper} paper`,
      badges: [],
      aggregate: true,
    });
  }
  for (const a of live) {
    const badges: ScopeOption['badges'] = [];
    if (a.isPaper) badges.push({ text: 'paper', tone: 'plain' });
    if (a.accountType && a.accountType !== 'Real')
      badges.push({ text: a.accountType.toLowerCase(), tone: 'warn' });
    else if (!a.isPaper) badges.push({ text: 'real', tone: 'real' });
    out.push({
      value: String(a.id),
      title: a.accountName ?? a.accountId ?? `Account ${a.id}`,
      meta: [a.accountId ? `#${a.accountId}` : null, a.brokerName, a.currency]
        .filter(Boolean)
        .join(' · '),
      badges,
      aggregate: false,
    });
  }
  return out;
}

/**
 * Header chrome pill that drives the global account-scope selection.
 * Visible on every page — flipping it reshapes orders, positions,
 * drawdown, and the dashboard tiles in lockstep.
 *
 * Renders nothing when the operator has 0 live accounts, and a static pill for 1 (no choice to
 * make). The menu is the console's own list, not a native <select>: a select is drawn by the
 * operating system, cannot show which accounts are real money, and was the one drop-down in the
 * header that looked nothing like the others.
 */
@Component({
  selector: 'app-account-scope-pill',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideDynamicIcon, ModalA11yDirective],
  host: { '(document:click)': 'onDocumentClick($event)' },
  template: `
    @if (live().length > 1) {
      <div class="scope">
        <button
          type="button"
          class="lx-pill scope-pill"
          aria-haspopup="listbox"
          [attr.aria-expanded]="open()"
          [attr.aria-label]="'Account scope: ' + current().title"
          title="Scope every list and metric in the admin console to a specific trading account or aggregate across the operator's live accounts."
          (click)="toggle()"
          (keydown)="onPillKeydown($event)"
        >
          <span class="lx-tile" aria-hidden="true">
            <svg
              [lucideIcon]="current().aggregate ? icons.Layers : icons.Wallet"
              [size]="13"
              [strokeWidth]="2.25"
            ></svg>
          </span>
          <span class="lx-pill-label scope-label">Account</span>
          <span class="lx-pill-value scope-value">{{ current().title }}</span>
          <svg
            class="lx-pill-caret"
            [lucideIcon]="icons.ChevronDown"
            [size]="14"
            [strokeWidth]="2.25"
            aria-hidden="true"
          ></svg>
        </button>
        @if (open()) {
          <div
            class="lx-menu scope-menu"
            role="listbox"
            tabindex="-1"
            aria-label="Account scope"
            [attr.aria-activedescendant]="'scope-opt-' + activeIndex()"
            appModalA11y
            [appModalA11yTrap]="false"
            (dismiss)="close(true)"
            (keydown)="onMenuKeydown($event)"
          >
            @for (opt of options(); track opt.value; let i = $index) {
              @if (i > 0 && !opt.aggregate && options()[i - 1].aggregate) {
                <div class="lx-menu-divider" role="presentation"></div>
                <div class="lx-menu-heading" aria-hidden="true">Accounts</div>
              } @else if (i === 0) {
                <div class="lx-menu-heading" aria-hidden="true">Scope</div>
              }
              <button
                type="button"
                role="option"
                class="lx-menu-item"
                tabindex="-1"
                [id]="'scope-opt-' + i"
                [attr.aria-selected]="opt.value === selected()"
                [class.lx-active]="i === activeIndex()"
                (click)="pick(opt.value)"
                (mousemove)="activeIndex.set(i)"
              >
                <span
                  class="lx-tile lx-tile-lg"
                  [class.lx-tile-muted]="opt.value !== selected()"
                  aria-hidden="true"
                >
                  <svg
                    [lucideIcon]="opt.aggregate ? icons.Layers : icons.Wallet"
                    [size]="15"
                    [strokeWidth]="2"
                  ></svg>
                </span>
                <span class="lx-menu-text">
                  <span class="lx-menu-title"
                    >{{ opt.title }}
                    @for (b of opt.badges; track b.text) {
                      <span
                        class="lx-badge"
                        [class.lx-badge-real]="b.tone === 'real'"
                        [class.lx-badge-warn]="b.tone === 'warn'"
                        >{{ b.text }}</span
                      >
                    }
                  </span>
                  <span class="lx-menu-meta">{{ opt.meta }}</span>
                </span>
                @if (opt.value === selected()) {
                  <svg
                    class="lx-menu-check"
                    [lucideIcon]="icons.Check"
                    [size]="16"
                    [strokeWidth]="2.5"
                    aria-hidden="true"
                  ></svg>
                }
              </button>
            }
            <p class="lx-menu-footnote">Every list and metric in the console follows this scope.</p>
          </div>
        }
      </div>
    } @else if (live().length === 1) {
      <span
        class="lx-pill lx-pill-static scope-pill"
        title="Only one live trading account — scope is implicit."
      >
        <span class="lx-tile" aria-hidden="true">
          <svg [lucideIcon]="icons.Wallet" [size]="13" [strokeWidth]="2.25"></svg>
        </span>
        <span class="lx-pill-label scope-label">Account</span>
        <span class="lx-pill-value scope-value">{{ options()[1]?.title }}</span>
        @for (b of options()[1]?.badges ?? []; track b.text) {
          <span
            class="lx-badge"
            [class.lx-badge-real]="b.tone === 'real'"
            [class.lx-badge-warn]="b.tone === 'warn'"
            >{{ b.text }}</span
          >
        }
      </span>
    }
  `,
  styles: [
    `
      .scope {
        position: relative;
      }
      .scope-pill {
        max-width: 300px;
      }
      .scope-pill .lx-badge {
        margin-left: 0;
      }
      .scope-menu {
        min-width: 320px;
      }
      /* Below 1280px the label leaves the screen (the button's aria-label still names it) and the
         value is capped, so the header fits a tablet; the open menu still shows every option in
         full. Desktop is unchanged. */
      @media (max-width: 1279.98px) {
        .scope-label {
          display: none;
        }
        .scope-value {
          max-width: 9.5rem;
        }
      }
      @media (max-width: 600px) {
        .scope-value {
          max-width: 6rem;
        }
        .scope-pill .lx-tile {
          display: none;
        }
      }
    `,
  ],
})
export class AccountScopePillComponent {
  protected readonly scope = inject(AccountScopeService);
  private readonly host: HTMLElement = inject(ElementRef<HTMLElement>).nativeElement;

  // Named one by one: scripts/generate-nav-icons.mjs bundles only the `navIcon.<Name>` it can see.
  protected readonly icons = {
    ChevronDown: navIcon.ChevronDown,
    Check: navIcon.Check,
    Layers: navIcon.Layers,
    Wallet: navIcon.Wallet,
  };

  protected readonly live = this.scope.liveAccounts;
  /**
   * What the console is ACTUALLY scoped to, as a string.  Reads
   * `effectiveSelected` rather than the raw `selected` so a persisted id
   * that no longer resolves to a live account shows the real-aggregate
   * fallback the data is already using.
   */
  protected readonly selected = this.scope.effectiveSelected;

  protected readonly options = computed(() =>
    scopeOptions(this.scope.liveAccounts(), this.scope.liveRealAccounts()),
  );
  protected readonly current = computed(
    () => this.options().find((o) => o.value === this.selected()) ?? this.options()[0],
  );

  readonly open = signal(false);
  readonly activeIndex = signal(0);

  toggle(): void {
    if (this.open()) this.close(false);
    else this.openMenu();
  }

  private openMenu(): void {
    const i = this.options().findIndex((o) => o.value === this.selected());
    this.activeIndex.set(Math.max(0, i));
    this.open.set(true);
    queueMicrotask(() => this.menu()?.focus({ preventScroll: true }));
  }

  close(returnFocus: boolean): void {
    this.open.set(false);
    if (returnFocus) queueMicrotask(() => this.pill()?.focus({ preventScroll: true }));
  }

  /** A click anywhere outside the pill closes its menu, as every drop-down does. */
  onDocumentClick(event: MouseEvent): void {
    if (this.open() && !this.host.contains(event.target as Node)) this.open.set(false);
  }

  onPillKeydown(event: KeyboardEvent): void {
    if (!this.open() && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      this.openMenu();
    }
  }

  onMenuKeydown(event: KeyboardEvent): void {
    const n = this.options().length;
    let next: number | null = null;
    switch (event.key) {
      case 'ArrowDown':
        next = (this.activeIndex() + 1) % n;
        break;
      case 'ArrowUp':
        next = (this.activeIndex() - 1 + n) % n;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = n - 1;
        break;
      case 'Enter':
      case ' ': {
        event.preventDefault();
        const opt = this.options()[this.activeIndex()];
        if (opt) this.pick(opt.value);
        return;
      }
      case 'Tab':
        this.close(false);
        return;
      default:
        return;
    }
    event.preventDefault();
    this.activeIndex.set(next);
    queueMicrotask(() =>
      this.host.querySelector(`#scope-opt-${next}`)?.scrollIntoView?.({ block: 'nearest' }),
    );
  }

  protected pick(raw: string): void {
    // Sentinel strings pass through verbatim; numeric ids parse.
    if (
      raw === AccountScopeService.SCOPE_AGGREGATE_REAL ||
      raw === AccountScopeService.SCOPE_AGGREGATE_ALL
    ) {
      this.scope.select(raw);
    } else {
      const n = Number(raw);
      this.scope.select(Number.isFinite(n) ? n : AccountScopeService.SCOPE_AGGREGATE_REAL);
    }
    this.close(true);
  }

  private menu(): HTMLElement | null {
    return this.host.querySelector<HTMLElement>('.scope-menu');
  }

  private pill(): HTMLElement | null {
    return this.host.querySelector<HTMLElement>('button.scope-pill');
  }
}
