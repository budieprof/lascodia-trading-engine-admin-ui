import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import {
  ResearchApiService,
  type WalkForwardRun,
} from '@features/scripting/research/research-api.service';
import { describeFailure } from '@features/scripting/shared/api-error';

import { COCKPIT_CARD_STYLES } from './cockpit.styles';
import { ConfigHashBadgeComponent } from '../components/config-hash-badge/config-hash-badge.component';
import { hasStitched, stitchedRows, type StitchedRun } from './research-cockpit.model';

/**
 * U12 / C10 — the newest completed walk-forward's stitched out-of-sample verdict: expectancy and Sharpe in R over every
 * fold's OOS trades, walk-forward efficiency, parameter drift, zero-trade folds — the numbers the `walk_forward` gate
 * judges. A run made before C10 (or by an older engine) has none: the card says so rather than deriving them.
 */
@Component({
  selector: 'app-wf-stitched-card',
  standalone: true,
  imports: [RouterLink, ConfigHashBadgeComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card" aria-labelledby="wfs-title" data-testid="wf-stitched">
      <header class="head">
        <h3 id="wfs-title" class="title">Walk-forward — stitched out of sample</h3>
        @if (run(); as r) {
          <a class="small" [routerLink]="['/walk-forward', r.id]">run #{{ r.id }}</a>
          <app-config-hash-badge
            [hash]="r.strategyConfigHash ?? null"
            [currentHash]="currentHash()"
          />
        }
      </header>
      @if (error(); as e) {
        <p class="error-box" role="alert">{{ e }}</p>
      } @else if (run(); as r) {
        @if (stitched()) {
          <table aria-label="Stitched out-of-sample metrics">
            <tbody>
              @for (row of rows(); track row.label) {
                <tr>
                  <th scope="row">{{ row.label }}</th>
                  <td class="num">{{ row.value }}</td>
                  <td class="muted small">{{ row.note }}</td>
                </tr>
              }
            </tbody>
          </table>
        } @else {
          <p class="muted small">
            Run #{{ r.id }} predates the stitched metrics (or this engine does not send them); open
            it for the per-fold analysis.
          </p>
        }
      } @else if (!loading()) {
        <p class="muted">No completed walk-forward for this strategy.</p>
      }
    </section>
  `,
  styles: [COCKPIT_CARD_STYLES],
})
export class WfStitchedCardComponent {
  private readonly research = inject(ResearchApiService);

  readonly strategyId = input.required<number>();
  readonly currentHash = input<string | null>(null);

  readonly run = signal<(WalkForwardRun & StitchedRun) | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  readonly stitched = computed(() => {
    const r = this.run();
    return !!r && hasStitched(r);
  });
  readonly rows = computed(() => {
    const r = this.run();
    return r ? stitchedRows(r) : [];
  });

  constructor() {
    effect(() => {
      const id = this.strategyId();
      untracked(() => void this.load(id));
    });
  }

  private async load(id: number): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const res = await firstValueFrom(this.research.walkForwardRuns(id, 20));
      if (id !== this.strategyId()) return;
      const runs = (res?.data?.data ?? []) as (WalkForwardRun & StitchedRun)[];
      this.run.set(runs.find((r) => String(r.status) === 'Completed') ?? null);
    } catch (err) {
      if (id === this.strategyId())
        this.error.set(describeFailure(err, 'The walk-forward runs could not be read.'));
    } finally {
      this.loading.set(false);
    }
  }
}
