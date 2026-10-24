import { ChangeDetectionStrategy, Component, effect, inject, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';

import { NotificationService } from '@core/notifications/notification.service';
import { errorText, reportable } from '@features/iam/iam.logic';
import { DealingApiService } from '../dealing-api.service';
import { DealingFiltersStore } from '../dealing-filters.store';
import { at, classificationLabel, classificationTone, csvFileName, isModuleNotInPlan, percent, pips, suggestionLabel } from '../dealing.logic';
import type { DealingAbBookReport } from '../dealing.types';

/**
 * The A/B-book suggestion report. ADVISORY ONLY — the platform never changes a client's routing, book or group; the
 * report says so on screen and in its CSV.
 */
@Component({
  selector: 'app-dealing-ab-report-tab',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  styleUrl: '../../iam/shared/iam-page.scss',
  styles: [`td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; } .counts { display: flex; gap: 8px; flex-wrap: wrap; }`],
  template: `
    <section class="card">
      <header class="card-head">
        <h3>A/B-book suggestions</h3>
        <span class="chip warn">Advisory only</span>
        <span class="spacer"></span>
        <button type="button" class="btn btn-sm btn-secondary" [disabled]="busy() || !data()" (click)="download()">
          {{ busy() ? 'Preparing…' : 'Download CSV' }}
        </button>
      </header>
      @if (error(); as err) {
        <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
      }
      @if (data(); as d) {
        <div class="card-body">
          <p class="note warn"><strong>{{ d.disclaimer }}</strong></p>
          <div class="counts">
            <span class="chip bad">A-book candidates: {{ d.countsBySuggestion['a-book-candidate'] ?? 0 }}</span>
            <span class="chip info">B-book candidates: {{ d.countsBySuggestion['b-book-candidate'] ?? 0 }}</span>
            <span class="chip">No change: {{ d.countsBySuggestion['no-change'] ?? 0 }}</span>
            <span class="chip">Too few fills: {{ d.countsBySuggestion['none'] ?? 0 }}</span>
          </div>
          <p class="small muted">
            Thresholds: at least {{ d.parameters.minFills }} fills with a 60 s markout; toxicity ≥ {{ d.parameters.aBookThreshold }} = A-book
            candidate; short hold &lt; {{ d.parameters.shortHoldSeconds }} s.
          </p>
        </div>
        @if (d.rows.length) {
          <div class="table-wrap">
            <table class="grid">
              <thead>
                <tr>
                  <th>Client</th>
                  <th>Suggestion</th>
                  <th>Class</th>
                  <th class="num">Toxicity</th>
                  <th class="num">Fills</th>
                  <th class="num">60 s</th>
                  <th class="num">Lat. arb</th>
                  <th>Why</th>
                </tr>
              </thead>
              <tbody>
                @for (r of d.rows; track r.feedId + ':' + r.login) {
                  <tr>
                    <td>
                      <a [routerLink]="['/dealing/clients', r.feedId, r.login]"><code>{{ r.login }}</code></a>
                      <span class="sub">{{ r.feedId }}</span>
                    </td>
                    <td>{{ suggestion(r.suggestion) }}</td>
                    <td><span class="chip" [class]="tone(r.classification)">{{ cls(r.classification) }}</span></td>
                    <td class="num">{{ r.toxicity ?? '—' }}</td>
                    <td class="num">{{ r.fills }}</td>
                    <td class="num">{{ pips(m60(r.markouts)) }}</td>
                    <td class="num">{{ percent(r.latencyArbShare) }}</td>
                    <td class="small">{{ r.reasons.join(' ') }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
        <details class="pad">
          <summary class="small">Methodology</summary>
          <p class="small muted">{{ d.methodology }}</p>
        </details>
      } @else if (!error()) {
        <p class="pad muted">Loading…</p>
      }
    </section>
  `,
})
export class DealingAbReportTabComponent {
  private readonly api = inject(DealingApiService);
  private readonly store = inject(DealingFiltersStore);
  private readonly notify = inject(NotificationService);

  protected readonly pips = pips;
  protected readonly percent = percent;
  protected readonly tone = classificationTone;
  protected readonly cls = classificationLabel;
  protected readonly suggestion = suggestionLabel;

  readonly data = signal<DealingAbBookReport | null>(null);
  readonly error = signal<string | null>(null);
  readonly busy = signal(false);
  private generation = 0;

  constructor() {
    effect(() => {
      this.store.key();
      untracked(() => this.load());
    });
  }

  m60(markouts: DealingAbBookReport['rows'][number]['markouts']): number | null {
    return at(markouts, 60_000)?.mean ?? null;
  }

  load(): void {
    const mine = ++this.generation;
    this.api.abBookReport(this.store.window()).subscribe({
      next: (d) => {
        if (mine !== this.generation) return;
        this.data.set(d);
        this.error.set(null);
      },
      error: (e) => {
        if (mine !== this.generation) return;
        if (isModuleNotInPlan(e)) this.store.moduleMissing.set(true);
        else this.error.set(errorText(e, 'Could not load the report.'));
      },
    });
  }

  download(): void {
    if (this.busy()) return;
    const w = this.store.window();
    this.busy.set(true);
    this.api.abBookReportCsv(w).subscribe({
      next: (blob) => {
        this.busy.set(false);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = csvFileName(w);
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1_000);
      },
      error: (e) => {
        this.busy.set(false);
        if (reportable(e)) this.notify.error(errorText(e, 'The CSV could not be prepared.'));
      },
    });
  }
}
