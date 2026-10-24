import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';

import { errorText, when } from '@features/iam/iam.logic';
import { DealingApiService } from '../dealing-api.service';
import { DealingFiltersStore } from '../dealing-filters.store';
import { isModuleNotInPlan, severityTone } from '../dealing.logic';
import type { DealingAlert } from '../dealing.types';

/** The desk's alerts for the window, computed by the engine on read (nothing is sent anywhere). */
@Component({
  selector: 'app-dealing-alerts-tab',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: '../../iam/shared/iam-page.scss',
  template: `
    <section class="card">
      <header class="card-head"><h3>Alerts</h3></header>
      @if (error(); as err) {
        <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
      }
      @if (alerts(); as list) {
        @if (list.length) {
          <div class="table-wrap">
            <table class="grid">
              <thead>
                <tr>
                  <th>Severity</th>
                  <th>Kind</th>
                  <th>Key</th>
                  <th>What</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                @for (a of list; track a.kind + a.key) {
                  <tr>
                    <td>
                      <span class="chip" [class]="tone(a)">{{ a.severity }}</span>
                    </td>
                    <td class="small">{{ a.kind }}</td>
                    <td>
                      <code>{{ a.key }}</code>
                    </td>
                    <td class="small">{{ a.message }}</td>
                    <td class="small">{{ when(a.atUtc) }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        } @else {
          <p class="pad muted">No alerts for this window.</p>
        }
      } @else if (!error()) {
        <p class="pad muted">Loading…</p>
      }
      <p class="note">
        Toxic clients, latency-arbitrage bursts (3+ matching fills within an hour), net client
        exposure per symbol, silent trade feeds and markout gaps. Computed when you open this tab;
        nothing is sent or changed.
      </p>
    </section>
  `,
})
export class DealingAlertsTabComponent {
  private readonly api = inject(DealingApiService);
  private readonly store = inject(DealingFiltersStore);

  protected readonly tone = severityTone;
  protected readonly when = when;

  readonly alerts = signal<DealingAlert[] | null>(null);
  readonly error = signal<string | null>(null);
  private generation = 0;

  constructor() {
    effect(() => {
      this.store.key();
      untracked(() => this.load());
    });
  }

  load(): void {
    const mine = ++this.generation;
    this.api.alerts(this.store.window()).subscribe({
      next: (a) => {
        if (mine !== this.generation) return;
        this.alerts.set(a);
        this.error.set(null);
      },
      error: (e) => {
        if (mine !== this.generation) return;
        if (isModuleNotInPlan(e)) this.store.moduleMissing.set(true);
        else this.error.set(errorText(e, 'Could not load the alerts.'));
      },
    });
  }
}
