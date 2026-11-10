import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';

import { AssistantOpsApiService } from '../assistant-ops-api.service';
import {
  compareRows,
  compareWindowsProblem,
  defaultCompareWindows,
  type CompareWindows,
} from '../assistant-quality.logic';
import type { AssistantMetricsCompare } from '../assistant-ops.types';

/**
 * Before / after: the same figures over two windows (`GET assistant/metrics/compare`), by default
 * the 30 days before the 2026-11-10 harness changes against everything since. Both windows are
 * re-derived from the conversations the same way, so they compare like with like; figures the
 * engine can only approximate that way are marked.
 */
@Component({
  selector: 'app-assistant-compare-section',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CardSkeletonComponent],
  template: `
    <section class="card" aria-label="Before and after">
      <header class="card-head">
        <h3>Before / after</h3>
        <span class="sub"
          >The same figures over two periods — e.g. before and after a change to the assistant</span
        >
      </header>
      <form class="dates" (submit)="$event.preventDefault(); load()">
        <fieldset>
          <legend>Before</legend>
          <input
            type="date"
            aria-label="Before: from"
            [value]="w().baselineFrom"
            (change)="patch('baselineFrom', $event)"
          />
          <span>to</span>
          <input
            type="date"
            aria-label="Before: to"
            [value]="w().baselineTo"
            (change)="patch('baselineTo', $event)"
          />
        </fieldset>
        <fieldset>
          <legend>After</legend>
          <input
            type="date"
            aria-label="After: from"
            [value]="w().from"
            (change)="patch('from', $event)"
          />
          <span>to</span>
          <input
            type="date"
            aria-label="After: to"
            [value]="w().to"
            (change)="patch('to', $event)"
          />
        </fieldset>
        <button type="submit" class="btn" [disabled]="loading() || !!problem()">Compare</button>
        <button type="button" class="link" (click)="reset()">Reset</button>
      </form>
      @if (problem(); as p) {
        <p class="pad bad">{{ p }}</p>
      }

      @if (loading()) {
        <div class="pad"><app-card-skeleton [lines]="5" /></div>
      } @else if (error(); as e) {
        <p class="pad bad" role="alert">
          Could not compare: {{ e }}
          <button type="button" class="link" (click)="load()">Try again</button>
        </p>
      } @else if (data(); as d) {
        @if (d.baseline.history.questions === 0 && d.current.history.questions === 0) {
          <p class="pad muted">No operator questions in either period.</p>
        } @else {
          <div class="scroll">
            <table>
              <thead>
                <tr>
                  <th>Figure</th>
                  <th class="num">Before</th>
                  <th class="num">After</th>
                  <th class="num">Change</th>
                </tr>
              </thead>
              <tbody>
                @for (r of rows(); track r.key) {
                  <tr>
                    <td>
                      {{ r.label }}
                      @if (r.approx) {
                        <span
                          class="approx"
                          title="Approximate: re-derived from the conversations (see the notes below)"
                          >≈ approx.</span
                        >
                      }
                      <div class="hint">{{ r.hint }}</div>
                    </td>
                    <td class="num">{{ r.baseline }}</td>
                    <td class="num">{{ r.current }}</td>
                    <td class="num" [attr.data-tone]="r.tone">
                      {{ r.change }}
                      @if (r.tone === 'good') {
                        <span class="sr"> (better)</span> ▲
                      } @else if (r.tone === 'bad') {
                        <span class="sr"> (worse)</span> ▼
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          @if (d.baseline.history.truncated || d.current.history.truncated) {
            <p class="pad muted">
              A period held more messages than the engine reads at once; its figures cover the
              newest only.
            </p>
          }
          @if (d.notes.length) {
            <details class="pad notes">
              <summary>How these figures are worked out</summary>
              <ul>
                @for (n of d.notes; track $index) {
                  <li>{{ n }}</li>
                }
              </ul>
            </details>
          }
        }
      }
    </section>
  `,
  styles: [
    `
      .card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-lg);
        padding-bottom: var(--space-3);
      }
      .card-head {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-1) var(--space-3);
        align-items: baseline;
        padding: var(--space-3) var(--space-4);
      }
      h3 {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .sub,
      .hint {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
      }
      .pad {
        padding: 0 var(--space-4);
        margin: 0 0 var(--space-2);
      }
      .dates {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-2) var(--space-4);
        align-items: flex-end;
        padding: 0 var(--space-4) var(--space-3);
        font-size: var(--text-sm);
      }
      fieldset {
        border: none;
        margin: 0;
        padding: 0;
        display: flex;
        gap: 6px;
        align-items: center;
      }
      legend {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        padding: 0;
        margin-bottom: 2px;
      }
      input[type='date'] {
        font: inherit;
        padding: 3px 6px;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-primary);
      }
      .btn {
        padding: 4px 12px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--accent);
        background: var(--accent);
        color: var(--accent-contrast, #fff);
        cursor: pointer;
      }
      .btn:disabled {
        opacity: 0.55;
      }
      .link {
        border: none;
        background: none;
        color: var(--accent);
        cursor: pointer;
        padding: 0;
        font: inherit;
      }
      .scroll {
        overflow-x: auto;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: 13px;
      }
      th,
      td {
        padding: 6px 12px;
        text-align: left;
        border-top: 1px solid var(--border);
      }
      th {
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.03em;
        color: var(--text-secondary);
      }
      .num {
        text-align: right;
        white-space: nowrap;
        font-variant-numeric: tabular-nums;
      }
      td[data-tone='good'] {
        color: var(--profit);
      }
      td[data-tone='bad'] {
        color: var(--loss);
      }
      .approx {
        margin-left: 6px;
        font-size: 11px;
        color: var(--warning);
        cursor: help;
      }
      .sr {
        position: absolute;
        width: 1px;
        height: 1px;
        overflow: hidden;
        clip: rect(0 0 0 0);
      }
      .bad {
        color: var(--loss);
        font-size: var(--text-sm);
      }
      .muted {
        color: var(--text-tertiary);
        font-size: var(--text-sm);
      }
      .notes {
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .notes ul {
        margin: 4px 0 0;
        padding-left: 18px;
        display: grid;
        gap: 4px;
      }
    `,
  ],
})
export class AssistantCompareSectionComponent {
  private readonly api = inject(AssistantOpsApiService);

  protected readonly w = signal<CompareWindows>(defaultCompareWindows());
  protected readonly data = signal<AssistantMetricsCompare | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly problem = computed(() => compareWindowsProblem(this.w()));
  protected readonly rows = computed(() => compareRows(this.data()));

  private seq = 0;

  constructor() {
    this.load();
  }

  protected patch(key: keyof CompareWindows, ev: Event): void {
    const value = (ev.target as HTMLInputElement).value;
    this.w.update((w) => ({ ...w, [key]: value }));
  }

  protected reset(): void {
    this.w.set(defaultCompareWindows());
    this.load();
  }

  protected load(): void {
    if (this.problem()) return;
    const w = this.w();
    const seq = ++this.seq;
    this.loading.set(true);
    this.error.set(null);
    const iso = (d: string) => `${d}T00:00:00Z`;
    this.api.compare(iso(w.baselineFrom), iso(w.baselineTo), iso(w.from), iso(w.to)).subscribe({
      next: (d) => {
        if (seq !== this.seq) return;
        this.data.set(d);
        this.loading.set(false);
      },
      error: (e: { message?: string }) => {
        if (seq !== this.seq) return;
        this.loading.set(false);
        this.error.set(e?.message || 'the engine did not answer GET assistant/metrics/compare.');
      },
    });
  }
}
