import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  inject,
  signal,
} from '@angular/core';
import { catchError, forkJoin, map, of } from 'rxjs';

import { BrokersService } from '@core/services/brokers.service';
import { RateLimitService } from '@core/services/rate-limit.service';
import type { ApiQuotaStatusDto } from '@core/api/api.types';

interface QuotaRow extends ApiQuotaStatusDto {
  pct: number;
  level: 'ok' | 'warn' | 'crit';
}

@Component({
  selector: 'app-rate-limit-strip',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (rows().length > 0) {
      <div class="strip" role="status" aria-label="Broker API quota">
        @for (r of rows(); track r.brokerKey) {
          <div class="item" [attr.data-level]="r.level">
            <span class="label">{{ r.brokerKey }}</span>
            <div class="bar"><div class="fill" [style.width]="r.pct + '%'"></div></div>
            <span class="pct">{{ r.remainingRequests }}/{{ r.maxRequests }}</span>
            @if (r.isThrottled) {
              <span class="pill">Throttled</span>
            }
          </div>
        }
      </div>
    }
  `,
  styles: [
    `
      .strip {
        display: flex;
        align-items: center;
        gap: var(--space-3);
        padding: 6px var(--space-4);
        background: var(--bg-secondary);
        border-bottom: 1px solid var(--border);
        font-size: 11px;
        overflow-x: auto;
      }
      .item {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        padding: 2px 10px;
        border-radius: var(--radius-full);
        background: var(--bg-primary);
        border: 1px solid var(--border);
        white-space: nowrap;
      }
      .label {
        font-weight: var(--font-semibold);
        color: var(--text-primary);
      }
      .bar {
        width: 60px;
        height: 4px;
        background: var(--bg-tertiary);
        border-radius: 2px;
        overflow: hidden;
      }
      .fill {
        height: 100%;
        background: var(--profit);
        transition: width 0.3s ease;
      }
      .item[data-level='warn'] .fill {
        background: var(--warning);
      }
      .item[data-level='crit'] .fill {
        background: var(--loss);
      }
      .pct {
        font-family: 'SF Mono', 'Fira Code', monospace;
        color: var(--text-tertiary);
      }
      .pill {
        padding: 0 6px;
        border-radius: var(--radius-full);
        background: rgba(255, 59, 48, 0.12);
        color: #d70015;
        font-weight: var(--font-semibold);
        font-size: 10px;
      }
    `,
  ],
})
export class RateLimitStripComponent implements OnInit {
  private readonly brokers = inject(BrokersService);
  private readonly rateLimit = inject(RateLimitService);
  private readonly destroyRef = inject(DestroyRef);

  readonly rows = signal<QuotaRow[]>([]);
  private intervalId: ReturnType<typeof setInterval> | null = null;

  ngOnInit(): void {
    this.load();
    this.intervalId = setInterval(() => this.load(), 60_000);
    this.destroyRef.onDestroy(() => {
      if (this.intervalId !== null) clearInterval(this.intervalId);
    });
  }

  private load(): void {
    this.brokers
      .list({ currentPage: 1, itemCountPerPage: 20 })
      .pipe(
        map((r) => r.data?.data ?? []),
        catchError(() => of([])),
      )
      .subscribe((brokers) => {
        const keys = brokers.map((b) => b.name ?? b.brokerType).filter((k): k is string => !!k);
        if (keys.length === 0) {
          this.rows.set([]);
          return;
        }
        forkJoin(
          keys.map((key) =>
            this.rateLimit.getQuota(key).pipe(
              map((res) => res.data as ApiQuotaStatusDto | null),
              catchError(() => of(null as ApiQuotaStatusDto | null)),
            ),
          ),
        ).subscribe((quotas) => {
          const rows = quotas
            .filter((q): q is ApiQuotaStatusDto => q !== null)
            .map((q) => {
              const total = q.maxRequests || 1;
              const used = total - q.remainingRequests;
              const pct = Math.max(0, Math.min(100, (used / total) * 100));
              const level: 'ok' | 'warn' | 'crit' = pct > 85 ? 'crit' : pct > 60 ? 'warn' : 'ok';
              return { ...q, pct, level };
            });
          this.rows.set(rows);
        });
      });
  }
}
