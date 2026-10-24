import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import type { EChartsOption } from 'echarts';

import { errorText, when } from '@features/iam/iam.logic';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { DealingApiService } from '../dealing-api.service';
import { DealingFiltersStore } from '../dealing-filters.store';
import {
  HORIZONS_MS,
  classificationLabel,
  classificationTone,
  curveChart,
  holdText,
  horizonLabel,
  isModuleNotInPlan,
  percent,
  pips,
  suggestionLabel,
} from '../dealing.logic';
import type { DealingClientDetail } from '../dealing.types';

/** One client: profile, markout curve per symbol, scalping histogram, latency-arbitrage fills, recent fills, open trades. */
@Component({
  selector: 'app-dealing-client-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, PageHeaderComponent, ChartCardComponent],
  styleUrl: '../../iam/shared/iam-page.scss',
  styles: [
    `
      td.num,
      th.num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .facts {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
        gap: var(--space-2);
      }
      .facts div {
        display: flex;
        flex-direction: column;
      }
      .charts {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(22rem, 1fr));
        gap: var(--space-3);
      }
    `,
  ],
  template: `
    <div class="page">
      <app-page-header
        [title]="'Client ' + login()"
        [subtitle]="feedId() === 'own' ? 'Own account' : 'Trade feed ' + feedId()"
      >
        <a class="btn btn-secondary" routerLink="/dealing">Dealing desk</a>
      </app-page-header>
      @if (missing()) {
        <p class="note warn">The dealing desk is not in your organisation's plan.</p>
      }
      @if (error(); as err) {
        <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
      }
      @if (data(); as d) {
        <section class="card">
          <div class="card-body">
            <div class="facts">
              <div>
                <span class="label">Class</span
                ><span class="chip" [class]="tone(d.profile.classification)">{{
                  cls(d.profile.classification)
                }}</span>
              </div>
              <div>
                <span class="label">Toxicity</span><span>{{ d.profile.toxicity ?? '—' }}</span>
              </div>
              <div>
                <span class="label">Suggestion (advisory)</span
                ><span>{{ suggestion(d.profile.suggestion) }}</span>
              </div>
              <div>
                <span class="label">Fills / lots</span
                ><span>{{ d.profile.fills }} / {{ d.profile.volumeLots }}</span>
              </div>
              <div>
                <span class="label">Paid vs mid</span
                ><span>{{ pips(d.profile.meanFillVsMidPips) }} pips</span>
              </div>
              <div>
                <span class="label">Latency arbitrage</span
                ><span
                  >{{ d.profile.latencyArbFills }} ({{ percent(d.profile.latencyArbShare) }})</span
                >
              </div>
              <div>
                <span class="label">Short holds</span
                ><span>{{ d.profile.shortHolds }} of {{ d.profile.closedTrades }}</span>
              </div>
              <div>
                <span class="label">Median hold</span
                ><span>{{ hold(d.profile.medianHoldSeconds) }}</span>
              </div>
            </div>
            @for (r of d.profile.reasons; track r) {
              <p class="small">{{ r }}</p>
            }
            <p class="note warn">
              <strong>{{ d.disclaimer }}</strong>
            </p>
          </div>
        </section>

        <div class="charts">
          <app-chart-card
            title="Markout by symbol"
            subtitle="Mean pips after the fill (client +)"
            [options]="curve()"
            height="280px"
          />
          <app-chart-card
            title="Holding time (closed trades)"
            subtitle="Scalping profile"
            [options]="holds()"
            height="280px"
          />
        </div>

        @if (d.latencyArbFills.length) {
          <section class="card">
            <header class="card-head"><h3>Fills matching the latency-arbitrage pattern</h3></header>
            <div class="table-wrap">
              <table class="grid">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Symbol</th>
                    <th>Side</th>
                    <th class="num">Lots</th>
                    <th class="num">Lead gap</th>
                    <th>Lead source</th>
                    <th class="num">5 s</th>
                    <th class="num">60 s</th>
                  </tr>
                </thead>
                <tbody>
                  @for (f of d.latencyArbFills; track f.id) {
                    <tr>
                      <td class="small">{{ when(f.fillTimeUtc) }}</td>
                      <td>{{ f.symbol }}</td>
                      <td>{{ f.side }}</td>
                      <td class="num">{{ f.volumeLots }}</td>
                      <td class="num">{{ pips(f.leadGapPips) }}</td>
                      <td class="small">
                        <code>{{ f.leadSourceId }}</code>
                      </td>
                      <td class="num">{{ pips(f.markout5s) }}</td>
                      <td class="num">{{ pips(f.markout60s) }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </section>
        }

        <section class="card">
          <header class="card-head"><h3>Recent fills</h3></header>
          <div class="table-wrap">
            <table class="grid">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Symbol</th>
                  <th>Leg</th>
                  <th>Side</th>
                  <th class="num">Lots</th>
                  <th class="num">Price</th>
                  <th class="num">vs mid</th>
                  @for (h of horizons; track h) {
                    <th class="num">{{ label(h) }}</th>
                  }
                  <th>Source</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                @for (f of d.recentFills; track f.id) {
                  <tr>
                    <td class="small">{{ when(f.fillTimeUtc) }}</td>
                    <td>{{ f.symbol }}</td>
                    <td>{{ f.leg }}</td>
                    <td>{{ f.side }}</td>
                    <td class="num">{{ f.volumeLots }}</td>
                    <td class="num">{{ f.fillPrice }}</td>
                    <td class="num">{{ pips(f.fillVsMidPips) }}</td>
                    <td class="num">{{ pips(f.markout1s) }}</td>
                    <td class="num">{{ pips(f.markout5s) }}</td>
                    <td class="num">{{ pips(f.markout30s) }}</td>
                    <td class="num">{{ pips(f.markout60s) }}</td>
                    <td class="num">{{ pips(f.markout300s) }}</td>
                    <td class="small">
                      <code>{{ f.sourceId ?? '—' }}</code>
                    </td>
                    <td class="small" [title]="f.note ?? ''">{{ f.status }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </section>

        @if (d.openTrades.length) {
          <section class="card">
            <header class="card-head"><h3>Open trades</h3></header>
            <div class="table-wrap">
              <table class="grid">
                <thead>
                  <tr>
                    <th>Trade</th>
                    <th>Symbol</th>
                    <th>Side</th>
                    <th class="num">Lots</th>
                    <th class="num">Open price</th>
                    <th>Opened</th>
                  </tr>
                </thead>
                <tbody>
                  @for (t of d.openTrades; track t.externalId) {
                    <tr>
                      <td>
                        <code>{{ t.externalId }}</code>
                      </td>
                      <td>{{ t.symbol }}</td>
                      <td>{{ t.side }}</td>
                      <td class="num">{{ t.volumeLots }}</td>
                      <td class="num">{{ t.openPrice }}</td>
                      <td class="small">{{ when(t.openTimeUtc) }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </section>
        }
      } @else if (!error() && !missing()) {
        <p class="pad muted">Loading…</p>
      }
    </div>
  `,
})
export class DealingClientPageComponent {
  private readonly api = inject(DealingApiService);
  private readonly store = inject(DealingFiltersStore);
  private readonly route = inject(ActivatedRoute);

  protected readonly horizons = HORIZONS_MS;
  protected readonly label = horizonLabel;
  protected readonly pips = pips;
  protected readonly percent = percent;
  protected readonly hold = holdText;
  protected readonly when = when;
  protected readonly tone = classificationTone;
  protected readonly cls = classificationLabel;
  protected readonly suggestion = suggestionLabel;

  readonly feedId = signal(this.route.snapshot.paramMap.get('feedId') ?? '');
  readonly login = signal(this.route.snapshot.paramMap.get('login') ?? '');
  readonly data = signal<DealingClientDetail | null>(null);
  readonly error = signal<string | null>(null);
  readonly missing = signal(false);

  readonly curve = computed<EChartsOption>(() => {
    const d = this.data();
    return curveChart(
      null,
      (d?.symbols ?? [])
        .slice(0, 8)
        .map((s) => ({
          key: s.symbol,
          fills: s.fills,
          volumeLots: s.volumeLots,
          markouts: s.markouts,
        })),
    );
  });

  readonly holds = computed<EChartsOption>(() => {
    const b = this.data()?.holdHistogram ?? [];
    return {
      tooltip: { trigger: 'axis' },
      grid: { left: 40, right: 40, top: 24, bottom: 32 },
      xAxis: { type: 'category', data: b.map((x) => x.label) },
      yAxis: [
        { type: 'value', name: 'trades' },
        { type: 'value', name: '60 s pips', axisLabel: { formatter: (v: number) => pips(v, 1) } },
      ],
      series: [
        { name: 'Closed trades', type: 'bar', data: b.map((x) => x.trades) },
        {
          name: 'Mean 60 s markout of the close',
          type: 'line',
          yAxisIndex: 1,
          data: b.map((x) => x.meanCloseMarkout60s),
        },
      ],
    };
  });

  constructor() {
    effect(() => {
      this.store.key();
      untracked(() => this.load());
    });
  }

  load(): void {
    this.api.clientDetail(this.store.window(), this.feedId(), this.login()).subscribe({
      next: (d) => {
        this.data.set(d);
        this.error.set(null);
      },
      error: (e) => {
        if (isModuleNotInPlan(e)) this.missing.set(true);
        else this.error.set(errorText(e, 'Could not load the client.'));
      },
    });
  }
}
