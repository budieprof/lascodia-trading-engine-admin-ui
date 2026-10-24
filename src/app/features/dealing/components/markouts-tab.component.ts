import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { errorText } from '@features/iam/iam.logic';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { DealingApiService } from '../dealing-api.service';
import { DealingFiltersStore } from '../dealing-filters.store';
import { HORIZONS_MS, at, curveChart, horizonLabel, isModuleNotInPlan, pips } from '../dealing.logic';
import type { CurveDimension, DealingCurves } from '../dealing.types';

/** Markout curves (1 s → 5 min) per client, group, symbol, feed or leg, with the 95 % band of all fills. */
@Component({
  selector: 'app-dealing-markouts-tab',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, ChartCardComponent],
  styleUrl: '../../iam/shared/iam-page.scss',
  styles: [`td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }`],
  template: `
    <section class="card">
      <header class="card-head">
        <h3>Markout curves</h3>
        <select class="select" aria-label="Group curves by" [ngModel]="dimension()" (ngModelChange)="dimension.set($event)">
          <option value="symbol">by symbol</option>
          <option value="client">by client</option>
          <option value="group">by group</option>
          <option value="feed">by feed</option>
          <option value="leg">opening vs closing fills</option>
        </select>
      </header>
      @if (error(); as err) {
        <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
      }
      <div class="card-body">
        <app-chart-card
          title="Mean markout after the fill"
          subtitle="Pips, positive = the price moved in the client's favour; shaded = 95% interval of all fills"
          [options]="chart()"
          [loading]="loading() && !data()"
          [emptyMessage]="data() && !data()!.all.fills ? 'No marked-out fills in this window.' : null"
          height="320px"
        />
        @if (data(); as d) {
          <div class="table-wrap">
            <table class="grid">
              <thead>
                <tr>
                  <th>{{ d.dimension }}</th>
                  <th class="num">Fills</th>
                  <th class="num">Lots</th>
                  @for (h of horizons; track h) {
                    <th class="num">{{ label(h) }}</th>
                  }
                  <th class="num" title="t-statistic of the 60 s mean">t (60 s)</th>
                </tr>
              </thead>
              <tbody>
                @for (s of rows(); track s.key) {
                  <tr>
                    <td><code>{{ s.key }}</code></td>
                    <td class="num">{{ s.fills }}</td>
                    <td class="num">{{ s.volumeLots }}</td>
                    @for (h of horizons; track h) {
                      <td class="num" [title]="'± ' + (stat(s, h)?.ci95 ?? '—') + ' (95%)'">{{ pips(stat(s, h)?.mean) }}</td>
                    }
                    <td class="num">{{ stat(s, 60000)?.tStat ?? '—' }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          <p class="note">{{ d.methodology }}</p>
        }
      </div>
    </section>
  `,
})
export class DealingMarkoutsTabComponent {
  private readonly api = inject(DealingApiService);
  private readonly store = inject(DealingFiltersStore);

  protected readonly horizons = HORIZONS_MS;
  protected readonly label = horizonLabel;
  protected readonly pips = pips;

  readonly dimension = signal<CurveDimension>('symbol');
  readonly data = signal<DealingCurves | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly chart = computed(() => {
    const d = this.data();
    return curveChart(d?.all ?? null, d?.series ?? []);
  });
  readonly rows = computed(() => {
    const d = this.data();
    return d ? [d.all, ...d.series] : [];
  });
  private generation = 0;

  constructor() {
    effect(() => {
      this.store.key();
      this.dimension();
      untracked(() => this.load());
    });
  }

  stat(s: { markouts: DealingCurves['all']['markouts'] }, h: number) {
    return at(s.markouts, h);
  }

  load(): void {
    const mine = ++this.generation;
    this.loading.set(true);
    this.api.curves(this.store.window(), this.dimension(), 10).subscribe({
      next: (d) => {
        if (mine !== this.generation) return;
        this.data.set(d);
        this.error.set(null);
        this.loading.set(false);
      },
      error: (e) => {
        if (mine !== this.generation) return;
        this.loading.set(false);
        if (isModuleNotInPlan(e)) this.store.moduleMissing.set(true);
        else this.error.set(errorText(e, 'Could not load the markout curves.'));
      },
    });
  }
}
