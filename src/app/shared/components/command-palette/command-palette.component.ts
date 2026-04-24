import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { fromEvent } from 'rxjs';

interface Command {
  label: string;
  group: string;
  route: string;
  keywords?: string;
}

/**
 * Global command palette bound to ⌘K / Ctrl+K. Renders a centred modal with a search input
 * and a filterable list of navigation targets.
 */
@Component({
  selector: 'app-command-palette',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    @if (open()) {
      <div
        class="overlay"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        (click)="close()"
      >
        <div class="palette" (click)="$event.stopPropagation()">
          <div class="search">
            <span class="prefix" aria-hidden="true">⌘K</span>
            <input
              #searchInput
              type="text"
              class="input"
              [ngModel]="query()"
              (ngModelChange)="onQuery($event)"
              (keydown)="onKeydown($event)"
              placeholder="Go to a page — start typing…"
              autocomplete="off"
              spellcheck="false"
              aria-label="Search pages"
            />
            <kbd class="hint">ESC</kbd>
          </div>
          <ul class="list" role="listbox" aria-label="Matching pages">
            @for (cmd of filtered(); track cmd.route; let i = $index) {
              <li
                role="option"
                [attr.aria-selected]="i === activeIndex()"
                class="item"
                [class.active]="i === activeIndex()"
                (click)="run(cmd)"
                (mouseenter)="activeIndex.set(i)"
              >
                <span class="group">{{ cmd.group }}</span>
                <span class="label">{{ cmd.label }}</span>
                <span class="route">{{ cmd.route }}</span>
              </li>
            } @empty {
              <li class="empty">No matches — press Esc to close.</li>
            }
          </ul>
        </div>
      </div>
    }
  `,
  styles: [
    `
      .overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.35);
        display: flex;
        align-items: flex-start;
        justify-content: center;
        padding: 12vh var(--space-4) var(--space-4);
        z-index: 1200;
        backdrop-filter: blur(6px);
        animation: fadeIn 0.15s ease-out;
      }
      .palette {
        width: min(640px, 100%);
        background: var(--bg-glass);
        backdrop-filter: var(--blur-lg);
        -webkit-backdrop-filter: var(--blur-lg);
        border: 1px solid var(--border);
        border-radius: var(--radius-lg);
        box-shadow: var(--shadow-lg);
        overflow: hidden;
        animation: slideUp var(--dur-base) var(--ease-out-soft);
      }
      .search {
        display: flex;
        align-items: center;
        gap: var(--space-3);
        padding: var(--space-3) var(--space-4);
        border-bottom: 1px solid var(--border);
      }
      .prefix {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: 12px;
        color: var(--text-tertiary);
        background: var(--bg-tertiary);
        padding: 2px 8px;
        border-radius: var(--radius-sm);
      }
      .input {
        flex: 1;
        height: 36px;
        border: none;
        outline: none;
        background: transparent;
        color: var(--text-primary);
        font-size: var(--text-base);
      }
      .input::placeholder {
        color: var(--text-tertiary);
      }
      .hint {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: 11px;
        color: var(--text-tertiary);
        background: var(--bg-tertiary);
        padding: 2px 6px;
        border-radius: 4px;
        border: 1px solid var(--border);
      }
      .list {
        list-style: none;
        margin: 0;
        padding: var(--space-2);
        max-height: 50vh;
        overflow-y: auto;
      }
      .item {
        display: grid;
        grid-template-columns: 110px 1fr auto;
        align-items: center;
        gap: var(--space-3);
        padding: var(--space-3) var(--space-3);
        border-radius: var(--radius-sm);
        cursor: pointer;
        font-size: var(--text-sm);
        color: var(--text-primary);
      }
      .item.active {
        background: rgba(0, 113, 227, 0.1);
        color: var(--accent);
      }
      .item .group {
        font-size: 11px;
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      .item .label {
        font-weight: var(--font-medium);
      }
      .item .route {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: 11px;
        color: var(--text-tertiary);
      }
      .empty {
        padding: var(--space-5);
        text-align: center;
        color: var(--text-tertiary);
        font-size: var(--text-sm);
      }
      @keyframes fadeIn {
        from {
          opacity: 0;
        }
        to {
          opacity: 1;
        }
      }
      @keyframes slideUp {
        from {
          transform: translateY(-12px);
          opacity: 0.5;
        }
        to {
          transform: translateY(0);
          opacity: 1;
        }
      }
    `,
  ],
})
export class CommandPaletteComponent implements OnInit {
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  readonly open = signal(false);
  readonly query = signal('');
  readonly activeIndex = signal(0);

  readonly commands: Command[] = [
    { group: 'Trading', label: 'Dashboard', route: '/dashboard' },
    { group: 'Trading', label: 'Orders', route: '/orders', keywords: 'order list trade' },
    { group: 'Trading', label: 'Positions', route: '/positions' },
    {
      group: 'Trading',
      label: 'Trade Signals',
      route: '/trade-signals',
      keywords: 'approve reject pending',
    },
    {
      group: 'Trading',
      label: 'Market Data',
      route: '/market-data',
      keywords: 'prices candles live quotes',
    },

    { group: 'Configuration', label: 'Strategies', route: '/strategies' },
    { group: 'Configuration', label: 'Trading Accounts', route: '/trading-accounts' },
    { group: 'Configuration', label: 'Brokers', route: '/brokers' },
    { group: 'Configuration', label: 'Risk Profiles', route: '/risk-profiles' },
    { group: 'Configuration', label: 'Currency Pairs', route: '/currency-pairs' },
    { group: 'Configuration', label: 'Alerts', route: '/alerts' },

    { group: 'ML', label: 'ML Models', route: '/ml-models', keywords: 'training shadow ab test' },
    {
      group: 'ML',
      label: 'Optimizations',
      route: '/optimizations',
      keywords: 'bayesian hyperparam sharpe',
    },
    { group: 'ML', label: 'Backtests', route: '/backtests' },
    { group: 'ML', label: 'Walk-Forward', route: '/walk-forward', keywords: 'oos out-of-sample' },

    {
      group: 'Analysis',
      label: 'Performance',
      route: '/performance',
      keywords: 'pnl sharpe sortino',
    },
    {
      group: 'Analysis',
      label: 'Execution Quality',
      route: '/execution-quality',
      keywords: 'slippage latency tca',
    },
    { group: 'Analysis', label: 'Sentiment', route: '/sentiment', keywords: 'regime cot' },
    {
      group: 'Analysis',
      label: 'Strategy Ensemble',
      route: '/strategy-ensemble',
      keywords: 'allocation rebalance',
    },

    { group: 'System', label: 'System Health', route: '/system-health' },
    {
      group: 'System',
      label: 'Worker Health',
      route: '/worker-health',
      keywords: 'workers cycle error backlog',
    },
    {
      group: 'System',
      label: 'EA Instances',
      route: '/ea-instances',
      keywords: 'expert advisor heartbeat mt5',
    },
    { group: 'System', label: 'Engine Config', route: '/engine-config' },
    { group: 'System', label: 'Audit Trail', route: '/audit-trail' },
    { group: 'System', label: 'Drawdown Recovery', route: '/drawdown-recovery' },
    { group: 'System', label: 'Paper Trading', route: '/paper-trading' },
    { group: 'System', label: 'Economic Events', route: '/economic-events' },

    { group: 'Ops', label: 'Kill Switches', route: '/kill-switches' },
    { group: 'Ops', label: 'Dead Letters', route: '/dead-letter', keywords: 'dlq replay' },
    {
      group: 'Ops',
      label: 'Tuning / Calibration',
      route: '/calibration',
      keywords: 'screening gates rejections',
    },
  ];

  readonly filtered = computed<Command[]>(() => {
    const q = this.query().trim().toLowerCase();
    if (!q) return this.commands.slice(0, 20);
    return this.commands
      .filter((c) => {
        const hay = `${c.group} ${c.label} ${c.route} ${c.keywords ?? ''}`.toLowerCase();
        // Simple space-separated all-match
        return q.split(/\s+/).every((token) => hay.includes(token));
      })
      .slice(0, 40);
  });

  ngOnInit(): void {
    fromEvent<KeyboardEvent>(document, 'keydown')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((event) => {
        const isMod = event.metaKey || event.ctrlKey;
        if (isMod && event.key.toLowerCase() === 'k') {
          event.preventDefault();
          this.toggle();
        }
      });
  }

  toggle(): void {
    if (this.open()) {
      this.close();
    } else {
      this.openPalette();
    }
  }

  openPalette(): void {
    this.query.set('');
    this.activeIndex.set(0);
    this.open.set(true);
    queueMicrotask(() => {
      const el = document.querySelector<HTMLInputElement>('app-command-palette input');
      el?.focus();
    });
  }

  close(): void {
    this.open.set(false);
  }

  onQuery(value: string): void {
    this.query.set(value);
    this.activeIndex.set(0);
  }

  onKeydown(event: KeyboardEvent): void {
    const matches = this.filtered();
    if (event.key === 'Escape') {
      event.preventDefault();
      this.close();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      this.activeIndex.set(Math.min(this.activeIndex() + 1, Math.max(0, matches.length - 1)));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      this.activeIndex.set(Math.max(0, this.activeIndex() - 1));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const pick = matches[this.activeIndex()];
      if (pick) this.run(pick);
    }
  }

  run(command: Command): void {
    this.close();
    this.router.navigateByUrl(command.route);
  }
}
