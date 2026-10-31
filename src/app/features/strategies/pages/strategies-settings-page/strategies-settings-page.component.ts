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
          Save {{ dirtyCount() ? '(' + dirtyCount() + ')' : '' }}
        </button>
      </app-page-header>

      @if (loading()) {
        <div class="note">Loading settings…</div>
      } @else {
        @for (group of groupedEntries(); track group.label) {
          <section class="card">
            <header class="card-head">
              <h3>{{ group.label }}</h3>
              <span class="count">{{ group.entries.length }}</span>
              <span class="head-hint">{{ groupHint(group.entries) }}</span>
            </header>
            <!-- Fixed column template shared by every section so the label, value
                 and status columns line up across cards. -->
            <table class="table">
              <colgroup>
                <col class="col-key" />
                <col class="col-value" />
                <col class="col-status" />
                <col class="col-updated" />
              </colgroup>
              <thead>
                <tr>
                  <th>Setting</th>
                  <th>Value</th>
                  <th>Reload</th>
                  <th class="right">Last updated</th>
                </tr>
              </thead>
              <tbody>
                @for (e of group.entries; track e.key) {
                  <tr [class.dirty]="e.isDirty">
                    <td class="setting">
                      <div class="label">
                        {{ humanLabel(e.key) }}
                        @if (e.isDirty) {
                          <span class="edited">edited</span>
                        }
                      </div>
                      <!-- The raw key stays visible (and selectable) for searching configs and logs. -->
                      <div class="key-line">
                        <span class="raw-key" [title]="e.key">{{ keyLabel(e.key) }}</span>
                        @if (isAutoSeeded(e)) {
                          <span
                            class="seeded"
                            title="Seeded from the code default by the engine; no operator has changed it yet."
                            >code default</span
                          >
                        }
                      </div>
                      @if (!isAutoSeeded(e) && e.description) {
                        <p class="description">{{ e.description }}</p>
                      }
                    </td>
                    <td>
                      <div class="value-cell">
                        @if (e.dataType === 'Bool') {
                          <select
                            class="value-input"
                            [attr.aria-label]="humanLabel(e.key)"
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
                            [attr.aria-label]="humanLabel(e.key)"
                            [(ngModel)]="e.editedValue"
                            (ngModelChange)="markDirty(e)"
                          />
                        }
                        <span class="type">{{ typeLabel(e.dataType) }}</span>
                      </div>
                    </td>
                    <td>
                      @if (e.isHotReloadable) {
                        <span
                          class="reload hot"
                          title="Applied on the next cycle — no restart needed"
                          >Live</span
                        >
                      } @else {
                        <span class="reload cold" title="Takes effect after an engine restart"
                          >Restart</span
                        >
                      }
                    </td>
                    <!-- An auto-seeded row's timestamp is the seed time, not an
                         operator edit — say so instead of pairing "not yet
                         customised" with an edit date. -->
                    <td class="updated">
                      @if (e.lastUpdatedAt === '0001-01-01T00:00:00') {
                        never
                      } @else if (isAutoSeeded(e)) {
                        seeded {{ e.lastUpdatedAt | date: 'MMM d, yyyy' }}
                      } @else {
                        <span class="customised">{{
                          e.lastUpdatedAt | date: 'MMM d, yyyy HH:mm'
                        }}</span>
                      }
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
        height: 34px;
        padding: 0 var(--space-4);
        border-radius: var(--radius-full);
        border: none;
        background: var(--bg-tertiary);
        color: var(--text-primary);
        font: inherit;
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        cursor: pointer;
      }
      .btn-refresh:hover {
        filter: brightness(0.97);
      }
      .btn-save {
        background: var(--accent);
        color: #fff;
      }
      .btn-save:hover:not(:disabled) {
        background: var(--accent-hover);
      }
      .btn-save:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
      .card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        box-shadow: var(--shadow-sm);
        overflow: hidden;
      }
      .card-head {
        padding: var(--space-3) var(--space-4);
        border-bottom: 1px solid var(--border);
        display: flex;
        align-items: center;
        gap: var(--space-2);
      }
      .card-head h3 {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .count {
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        color: var(--text-secondary);
        background: var(--bg-tertiary);
        border-radius: var(--radius-full);
        padding: 1px 8px;
        font-variant-numeric: tabular-nums;
      }
      .head-hint {
        margin-left: auto;
        font-size: var(--text-xs);
        color: var(--text-tertiary);
      }
      .table {
        width: 100%;
        border-collapse: collapse;
        table-layout: fixed;
      }
      .table th,
      .table td {
        padding: 10px var(--space-3);
        font-size: var(--text-sm);
        border-bottom: 1px solid var(--border);
        text-align: left;
        vertical-align: top;
      }
      .table th:first-child,
      .table td:first-child {
        padding-left: var(--space-4);
      }
      .table th:last-child,
      .table td:last-child {
        padding-right: var(--space-4);
      }
      .table tbody tr:last-child td {
        border-bottom: none;
      }
      .table th {
        padding-top: 8px;
        padding-bottom: 8px;
        background: var(--bg-primary);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        font-size: 10.5px;
        font-weight: var(--font-semibold);
      }
      .table .right {
        text-align: right;
      }
      .table tbody tr:hover td {
        background: var(--bg-primary);
      }
      .table tr.dirty td,
      .table tr.dirty:hover td {
        background: rgba(255, 149, 0, 0.06);
      }
      .table tr.dirty td:first-child {
        box-shadow: inset 3px 0 0 #ff9500;
      }
      .col-key {
        width: 44%;
      }
      .col-value {
        width: 28%;
      }
      .col-status {
        width: 12%;
      }
      .col-updated {
        width: 16%;
      }
      .label {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        font-weight: var(--font-medium);
        color: var(--text-primary);
        line-height: 1.35;
      }
      .edited {
        font-size: 10.5px;
        font-weight: var(--font-semibold);
        color: #b25000;
        background: rgba(255, 149, 0, 0.14);
        border-radius: var(--radius-full);
        padding: 0 7px;
        line-height: 17px;
      }
      .key-line {
        display: flex;
        align-items: center;
        gap: 10px;
        min-width: 0;
        margin-top: 2px;
      }
      .raw-key {
        min-width: 0;
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: 11px;
        color: var(--text-tertiary);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        user-select: all;
      }
      .description {
        margin: 6px 0 0;
        max-width: 64ch;
        font-size: var(--text-xs);
        color: var(--text-secondary);
        line-height: 1.5;
      }
      .value-cell {
        display: flex;
        align-items: center;
        gap: var(--space-2);
      }
      .value-input {
        flex: 1;
        min-width: 0;
        height: 32px;
        padding: 0 var(--space-3);
        font-size: var(--text-sm);
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-variant-numeric: tabular-nums;
      }
      .value-input:focus {
        outline: none;
        border-color: var(--accent);
        box-shadow: 0 0 0 3px rgba(0, 113, 227, 0.12);
      }
      tr.dirty .value-input {
        border-color: #ff9500;
      }
      .type {
        flex: none;
        width: 52px;
        font-size: 11px;
        color: var(--text-tertiary);
      }
      .seeded {
        display: inline-flex;
        align-items: center;
        flex: none;
        gap: 5px;
        font-size: 11px;
        color: var(--text-tertiary);
        cursor: help;
      }
      .seeded::before {
        content: '';
        width: 5px;
        height: 5px;
        border-radius: 50%;
        background: var(--text-tertiary);
        opacity: 0.6;
      }
      .reload {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        margin-top: 7px;
        font-size: var(--text-xs);
        color: var(--text-secondary);
        cursor: help;
      }
      .reload::before {
        content: '';
        width: 6px;
        height: 6px;
        border-radius: 50%;
      }
      .reload.hot::before {
        background: #34c759;
      }
      .reload.cold {
        color: #b25000;
      }
      .reload.cold::before {
        background: #ff9500;
      }
      .table td.updated {
        text-align: right;
        padding-top: 18px;
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        white-space: nowrap;
        font-variant-numeric: tabular-nums;
      }
      .customised {
        color: var(--text-secondary);
        font-weight: var(--font-medium);
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
            editedValue: displayValue(r),
            isDirty: false,
          })),
        );
      });
  }

  markDirty(entry: EditableEntry): void {
    entry.isDirty = !sameValue(entry.dataType, entry.editedValue, entry.value);
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

  /** Rows the engine's self-seed worker wrote from the code default and nobody has edited. */
  isAutoSeeded(e: EditableEntry): boolean {
    return (e.description ?? '').trim() === AUTO_SEED_DESCRIPTION;
  }

  /** "9 code defaults · 1 customised" — the per-row default marker summarised once per section. */
  groupHint(entries: EditableEntry[]): string {
    const seeded = entries.filter((e) => this.isAutoSeeded(e)).length;
    const custom = entries.length - seeded;
    const parts: string[] = [];
    if (seeded > 0) parts.push(`${seeded} code default${seeded === 1 ? '' : 's'}`);
    if (custom > 0) parts.push(`${custom} customised`);
    return parts.join(' · ');
  }

  /** "PollIntervalMinutes" → "Poll interval (minutes)". The raw key is shown beside it. */
  humanLabel(key: string): string {
    return this.keyLabel(key).split(':').map(humanizeKey).join(' › ');
  }

  /** Strip the StrategyPromotion: prefix on display since every key in
   *  this page shares it — keeps the key column readable. */
  keyLabel(key: string): string {
    return key.startsWith('StrategyPromotion:') ? key.substring('StrategyPromotion:'.length) : key;
  }
}

/** Description the engine's EngineConfigSelfSeedWorker stamps on auto-seeded rows. */
const AUTO_SEED_DESCRIPTION = 'Code default — not yet customised.';

/** Words that keep their casing when a PascalCase key is turned into a sentence. */
const KEEP_CASE: Record<string, string> = {
  ml: 'ML',
  db: 'DB',
  cpcv: 'CPCV',
  llm: 'LLM',
  id: 'ID',
};
const PROPER: Record<string, string> = { sharpe: 'Sharpe', sortino: 'Sortino' };
const UNITS = new Set(['seconds', 'minutes', 'hours', 'days', 'ms', 'pct', 'percent']);

/** "MinLiveVsBacktestSharpeRatio" → "Min live vs backtest Sharpe ratio"; a trailing unit goes in brackets. */
function humanizeKey(segment: string): string {
  const words = segment
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_]+/)
    .filter(Boolean)
    .map((w) => {
      const lower = w.toLowerCase();
      return KEEP_CASE[lower] ?? PROPER[lower] ?? lower;
    });
  if (words.length === 0) return segment;
  let unit = '';
  if (words.length > 1 && UNITS.has(words[words.length - 1])) {
    unit = words.pop()!;
    if (unit === 'pct') unit = '%';
  }
  const first = words[0];
  words[0] = first === first.toLowerCase() ? first[0].toUpperCase() + first.slice(1) : first;
  return unit ? `${words.join(' ')} (${unit})` : words.join(' ');
}

/** Decimals render with two places so "0", "0.5" and "0.55" read as one format. */
function displayValue(r: StrategyPromotionConfigEntryDto): string {
  if (r.dataType !== 'Decimal') return r.value;
  const n = Number(r.value);
  return Number.isFinite(n) && r.value.trim() !== '' ? n.toFixed(2) : r.value;
}

/** Numeric types compare by value so "0.50" against a stored "0.5" is not a dirty edit. */
function sameValue(type: ConfigDataType, a: string, b: string): boolean {
  if (type === 'Decimal' || type === 'Int') {
    const x = Number(a);
    const y = Number(b);
    if (Number.isFinite(x) && Number.isFinite(y)) return x === y;
  }
  return a === b;
}
