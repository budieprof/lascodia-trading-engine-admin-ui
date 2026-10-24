import { ChangeDetectionStrategy, Component, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { errorText } from '@features/iam/iam.logic';
import { DealingApiService } from '../dealing-api.service';
import { DealingFiltersStore } from '../dealing-filters.store';
import {
  at,
  classificationLabel,
  classificationTone,
  holdText,
  isModuleNotInPlan,
  netLotsText,
  percent,
  pips,
  suggestionLabel,
} from '../dealing.logic';
import type { DealingClientRow, DealingClients } from '../dealing.types';

/**
 * The client risk table: every client (feed + login) with fills in the window — markouts, toxicity, latency-arbitrage
 * and scalping signs, open exposure, realised P&L and the ADVISORY A/B suggestion. A row opens the client's page.
 */
@Component({
  selector: 'app-dealing-clients-tab',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, RouterLink],
  styleUrl: '../../iam/shared/iam-page.scss',
  styles: [
    `
      td.num,
      th.num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .pos {
        color: var(--loss);
      }
      .neg {
        color: var(--profit);
      }
    `,
  ],
  template: `
    <section class="card">
      <header class="card-head">
        <h3>Clients</h3>
        <input
          class="input search"
          type="search"
          placeholder="Login or group"
          aria-label="Search clients"
          [ngModel]="search()"
          (ngModelChange)="search.set($event)"
          (keyup.enter)="load()"
        />
        <select class="select" aria-label="Sort by" [ngModel]="sortBy()" (ngModelChange)="sortBy.set($event); load()">
          <option value="toxicity">Toxicity</option>
          <option value="volume">Volume</option>
          <option value="fills">Fills</option>
          <option value="markout60">60 s markout</option>
        </select>
        <span class="spacer"></span>
        @if (data(); as d) {
          <span class="small muted">{{ d.rows.length }} of {{ d.totalClients }} clients · {{ d.fillsRead }} fills</span>
        }
      </header>
      @if (error(); as err) {
        <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
      }
      @if (loading() && !data()) {
        <p class="pad muted">Loading…</p>
      }
      @if (data(); as d) {
        @if (d.truncated) {
          <p class="note warn">The window holds more fills than one read takes; the newest are shown. Narrow the window.</p>
        }
        @if (d.rows.length) {
          <div class="table-wrap">
            <table class="grid">
              <thead>
                <tr>
                  <th>Client</th>
                  <th>Class</th>
                  <th class="num">Toxicity</th>
                  <th class="num">Fills</th>
                  <th class="num">Lots</th>
                  <th class="num" title="Mean markout after 5 s, pips (client +)">5 s</th>
                  <th class="num" title="Mean markout after 60 s, pips (client +)">60 s</th>
                  <th class="num" title="Mean markout after 5 min, pips (client +)">5 min</th>
                  <th class="num" title="Share of fills matching the latency-arbitrage pattern">Lat. arb</th>
                  <th class="num" title="Share of closed trades held under the short-hold threshold">Short holds</th>
                  <th class="num">Median hold</th>
                  <th>Open (net lots)</th>
                  <th class="num">Realised P&amp;L</th>
                  <th>Suggestion (advisory)</th>
                </tr>
              </thead>
              <tbody>
                @for (r of d.rows; track r.profile.feedId + ':' + r.profile.login) {
                  <tr>
                    <td>
                      <a [routerLink]="['/dealing/clients', r.profile.feedId, r.profile.login]"
                        ><code>{{ r.profile.login }}</code></a
                      >
                      <span class="sub">{{ r.profile.feedId === 'own' ? 'own account' : r.profile.feedId }}{{ r.profile.group ? ' · ' + r.profile.group : '' }}</span>
                    </td>
                    <td><span class="chip" [class]="tone(r.profile.classification)">{{ cls(r.profile.classification) }}</span></td>
                    <td class="num">{{ r.profile.toxicity ?? '—' }}</td>
                    <td class="num">{{ r.profile.fills }}</td>
                    <td class="num">{{ r.profile.volumeLots }}</td>
                    <td class="num" [class.pos]="(mean(r, 5000) ?? 0) > 0" [class.neg]="(mean(r, 5000) ?? 0) < 0">{{ pips(mean(r, 5000)) }}</td>
                    <td class="num" [class.pos]="(mean(r, 60000) ?? 0) > 0" [class.neg]="(mean(r, 60000) ?? 0) < 0">{{ pips(mean(r, 60000)) }}</td>
                    <td class="num">{{ pips(mean(r, 300000)) }}</td>
                    <td class="num">{{ percent(r.profile.latencyArbShare) }}</td>
                    <td class="num">{{ r.profile.closedTrades ? percent(r.profile.shortHoldShare) : '—' }}</td>
                    <td class="num">{{ hold(r.profile.medianHoldSeconds) }}</td>
                    <td class="small">{{ net(r.openNetLots) }}</td>
                    <td class="num">{{ r.realisedProfit ?? '—' }}</td>
                    <td class="small">{{ suggestion(r.profile.suggestion) }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        } @else {
          <p class="pad muted">No client fills with markouts in this window yet. Fills are marked out about six minutes after they happen.</p>
        }
        <p class="note">
          Markouts are pips after each fill on the price source's mid; positive = the price moved in the client's favour
          (adverse for a dealer on the other side). <strong>{{ d.disclaimer }}</strong>
        </p>
      }
    </section>
  `,
})
export class DealingClientsTabComponent {
  private readonly api = inject(DealingApiService);
  private readonly store = inject(DealingFiltersStore);

  protected readonly pips = pips;
  protected readonly percent = percent;
  protected readonly hold = holdText;
  protected readonly net = netLotsText;
  protected readonly tone = classificationTone;
  protected readonly cls = classificationLabel;
  protected readonly suggestion = suggestionLabel;

  readonly data = signal<DealingClients | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly search = signal('');
  readonly sortBy = signal('toxicity');
  private generation = 0;

  constructor() {
    effect(() => {
      this.store.key();
      untracked(() => this.load());
    });
  }

  mean(r: DealingClientRow, h: number): number | null {
    return at(r.profile.markouts, h)?.mean ?? null;
  }

  load(): void {
    const mine = ++this.generation;
    this.loading.set(true);
    this.api.clients(this.store.window(), { search: this.search().trim() || undefined, sortBy: this.sortBy(), limit: 500 }).subscribe({
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
        else this.error.set(errorText(e, 'Could not load the clients.'));
      },
    });
  }
}
