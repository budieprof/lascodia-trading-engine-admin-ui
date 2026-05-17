import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  OnInit,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule, DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { catchError, of } from 'rxjs';

import { StrategiesService } from '@core/services/strategies.service';
import { NotificationService } from '@core/notifications/notification.service';
import { StrategyPromotionConfigEntryDto, ConfigDataType } from '@core/api/api.types';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';

interface EditableEntry extends StrategyPromotionConfigEntryDto {
  editedValue: string;
  isDirty: boolean;
}

@Component({
  selector: 'app-strategies-settings-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, DatePipe, FormsModule, PageHeaderComponent],
  template: `
    <div class="page">
      <app-page-header
        title="Strategy Settings"
        subtitle="StrategyPromotionWorker tuning — cadence, promotion gates, activation gates, and champion/challenger. Every value lives in EngineConfig and (where flagged) hot-reloads without a restart."
      >
        <button type="button" class="btn-refresh" (click)="reload()">↻ Reload</button>
        <button type="button" class="btn-save" [disabled]="dirtyCount() === 0" (click)="save()">
          💾 Save {{ dirtyCount() ? '(' + dirtyCount() + ')' : '' }}
        </button>
      </app-page-header>

      @if (loading()) {
        <div class="note">Loading settings…</div>
      } @else {
        @for (group of groupedEntries(); track group.label) {
          <section class="card">
            <header class="card-head">
              <h3>{{ group.label }}</h3>
              <span class="muted small">{{ group.entries.length }} key(s)</span>
            </header>
            <table class="table">
              <thead>
                <tr>
                  <th>Key</th>
                  <th>Value</th>
                  <th>Type</th>
                  <th>Hot-reload?</th>
                  <th>Last updated</th>
                </tr>
              </thead>
              <tbody>
                @for (e of group.entries; track e.key) {
                  <tr [class.dirty]="e.isDirty">
                    <td class="mono key">{{ keyLabel(e.key) }}</td>
                    <td>
                      @if (e.dataType === 'Bool') {
                        <select
                          class="value-input"
                          [(ngModel)]="e.editedValue"
                          (ngModelChange)="markDirty(e)"
                        >
                          <option value="true">true</option>
                          <option value="false">false</option>
                        </select>
                      } @else {
                        <input
                          class="value-input"
                          type="text"
                          [(ngModel)]="e.editedValue"
                          (ngModelChange)="markDirty(e)"
                        />
                      }
                      @if (e.description) {
                        <div class="description">{{ e.description }}</div>
                      }
                    </td>
                    <td class="mono">{{ typeLabel(e.dataType) }}</td>
                    <td>
                      @if (e.isHotReloadable) {
                        <span class="badge hot">hot</span>
                      } @else {
                        <span class="badge cold">restart</span>
                      }
                    </td>
                    <td class="mono nowrap">
                      {{
                        e.lastUpdatedAt === '0001-01-01T00:00:00'
                          ? 'never'
                          : (e.lastUpdatedAt | date: 'MMM d, HH:mm')
                      }}
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </section>
        }

        <div class="note info">
          Promotion-worker knobs control the automated Draft → Approved → Active lifecycle for every
          strategy, including LLM-auto-promoted ones. Pair this page with
          <a href="/llm/settings">LLM Settings</a> for the proposer-side knobs.
        </div>
      }
    </div>
  `,
  styles: [
    `
      .page {
        padding: var(--space-2) 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
      }
      .btn-refresh,
      .btn-save {
        height: 32px;
        padding: 0 var(--space-3);
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-secondary);
        color: var(--text-primary);
        font-size: var(--text-sm);
        cursor: pointer;
      }
      .btn-save {
        background: #0071e3;
        color: #fff;
        border-color: #0071e3;
      }
      .btn-save:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
      .card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
      }
      .card-head {
        padding: var(--space-3) var(--space-5);
        border-bottom: 1px solid var(--border);
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: var(--space-3);
      }
      .card-head h3 {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .muted {
        color: var(--text-tertiary);
      }
      .small {
        font-size: var(--text-xs);
      }
      .table {
        width: 100%;
        border-collapse: collapse;
      }
      .table th,
      .table td {
        padding: var(--space-2) var(--space-4);
        font-size: var(--text-sm);
        border-bottom: 1px solid var(--border);
        text-align: left;
        vertical-align: top;
      }
      .table th {
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
      }
      .table td.mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: var(--text-xs);
      }
      .table tr.dirty {
        background: rgba(255, 149, 0, 0.06);
      }
      .key {
        max-width: 340px;
        word-break: break-all;
      }
      .value-input {
        width: 100%;
        height: 30px;
        padding: 0 var(--space-2);
        font-size: var(--text-sm);
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-family: 'SF Mono', 'Fira Code', monospace;
      }
      .description {
        margin-top: 4px;
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        line-height: 1.4;
      }
      .badge {
        padding: 2px 6px;
        border-radius: 3px;
        font-size: 10px;
        font-weight: var(--font-semibold);
        letter-spacing: 0.04em;
        text-transform: uppercase;
        font-family: 'SF Mono', 'Fira Code', monospace;
      }
      .badge.hot {
        background: rgba(52, 199, 89, 0.14);
        color: #34c759;
      }
      .badge.cold {
        background: rgba(142, 142, 147, 0.18);
        color: #6e6e73;
      }
      .nowrap {
        white-space: nowrap;
      }
      .note {
        padding: var(--space-4) var(--space-5);
        font-size: var(--text-sm);
        color: var(--text-secondary);
        background: var(--bg-secondary);
        border: 1px dashed var(--border);
        border-radius: var(--radius-md);
      }
      .note.info {
        background: rgba(0, 113, 227, 0.04);
        border-color: rgba(0, 113, 227, 0.2);
      }
    `,
  ],
})
export class StrategiesSettingsPageComponent implements OnInit {
  private readonly strategies = inject(StrategiesService);
  private readonly notifications = inject(NotificationService);
  private readonly destroyRef = inject(DestroyRef);

  readonly entries = signal<EditableEntry[]>([]);
  readonly loading = signal(true);
  readonly dirtyCount = computed(() => this.entries().filter((e) => e.isDirty).length);

  /** Group order matches the catalog's narrative: master → promotion gates →
   *  activation gates → champion/challenger → anything uncatalogued. */
  readonly groupedEntries = computed(() => {
    const buckets = new Map<string, EditableEntry[]>();
    for (const e of this.entries()) {
      const list = buckets.get(e.group) ?? [];
      list.push(e);
      buckets.set(e.group, list);
    }
    const order = ['Master', 'Promotion gates', 'Activation', 'Champion/Challenger', 'Other'];
    return order
      .filter((label) => buckets.has(label))
      .map((label) => ({ label, entries: buckets.get(label)! }));
  });

  ngOnInit(): void {
    this.reload();
  }

  reload(): void {
    this.loading.set(true);
    this.strategies
      .getPromotionSettings()
      .pipe(
        catchError(() => of(null)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((res) => {
        this.loading.set(false);
        const rows = res?.data ?? [];
        this.entries.set(
          rows.map((r) => ({
            ...r,
            editedValue: r.value,
            isDirty: false,
          })),
        );
      });
  }

  markDirty(entry: EditableEntry): void {
    entry.isDirty = entry.editedValue !== entry.value;
    // Re-emit the array so the `dirtyCount` computed picks up the change
    // — mutating in place doesn't notify signals.
    this.entries.set([...this.entries()]);
  }

  save(): void {
    const dirty = this.entries().filter((e) => e.isDirty);
    if (dirty.length === 0) return;
    this.strategies
      .updatePromotionSettings(dirty.map((e) => ({ key: e.key, value: e.editedValue })))
      .pipe(
        catchError((err) => {
          this.notifications.error?.(`Save failed: ${err?.message ?? err}`);
          return of(null);
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((res) => {
        if (res?.status) {
          this.notifications.success?.(`Saved ${res.data} setting(s).`);
          this.reload();
        } else if (res) {
          this.notifications.error?.(res.message ?? 'Save refused.');
        }
      });
  }

  typeLabel(t: ConfigDataType): string {
    return t.toLowerCase();
  }

  /** Strip the StrategyPromotion: prefix on display since every key in
   *  this page shares it — keeps the key column readable. */
  keyLabel(key: string): string {
    return key.startsWith('StrategyPromotion:') ? key.substring('StrategyPromotion:'.length) : key;
  }
}
