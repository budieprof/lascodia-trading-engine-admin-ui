import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { catchError, map, of } from 'rxjs';

import { AutoTuneService, type AutoTuneStatusDto } from '@core/services/auto-tune.service';
import {
  FeatureStateComponent,
  type FeatureRequirement,
} from '@shared/components/feedback/feature-state.component';
import {
  FactTilesComponent,
  type FactTile,
} from '@features/strategies/components/fact-tiles/fact-tiles.component';
import { ago, count, day } from '@features/strategies/util/figures';
import { ConfigHistoryCardComponent } from '@features/strategies/components/config-history-card/config-history-card.component';

/**
 * Why the auto-tune queue holds what it holds, from `GET auto-tune/status`: the tuner worker's switches,
 * the evidence its PPO tuner can see against its floor, proposal counts and the worker's last cycle.
 * `mode` = 'proposals' (the review queue) or 'auto-apply' (the per-knob config page).
 */
@Component({
  selector: 'app-auto-tune-status-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FeatureStateComponent, FactTilesComponent, ConfigHistoryCardComponent],
  template: `
    @if (status(); as s) {
      <app-fact-tiles [tiles]="tiles()" />
      @if (showCard()) {
        <app-feature-state
          [kind]="s.workerEnabled && s.ppoTunerEnabled ? 'waiting' : 'off'"
          [title]="
            mode() === 'proposals'
              ? 'The tuner has not proposed anything yet'
              : 'No knob may be applied without review'
          "
          switchKey="CompositeMLAutoTuningOptions:Enabled"
          [summary]="summary()"
          [detail]="detail()"
          [requirements]="requirements()"
          [links]="[
            { label: 'CompositeML', route: '/composite-ml' },
            { label: 'Worker health', route: '/worker-health' },
            mode() === 'proposals'
              ? { label: 'Auto-apply configs', route: '/auto-tune/auto-apply' }
              : { label: 'Proposals', route: '/auto-tune' },
          ]"
        />
        <section class="knobs">
          <h3>Knobs the tuner can propose</h3>
          <table>
            <thead>
              <tr>
                <th>Setting</th>
                <th>What it controls</th>
                <th>Tuner</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td class="mono">CompositeMLReinforceTraining:PpoSaturationThresholdLow</td>
                <td>
                  Below this saturation (how far a policy step pushes its knobs against their
                  per-cycle cap) the CompositeML trainer skips PPO and takes one plain step. Default
                  0.3.
                </td>
                <td>PPO</td>
              </tr>
              <tr>
                <td class="mono">CompositeMLReinforceTraining:PpoSaturationThresholdHigh</td>
                <td>
                  At and above this saturation PPO runs at full intensity; in between it runs about
                  half its inner iterations. Default 0.7.
                </td>
                <td>PPO</td>
              </tr>
            </tbody>
          </table>
        </section>
        <app-config-history-card
          prefix="CompositeMLReinforceTraining:"
          title="Changes to these knobs"
          emptyText="Neither knob has been changed — applying a proposal (or editing the setting) records a row here."
        />
      }
    } @else if (failed()) {
      <p class="muted">
        The tuner's status is not available from this engine build yet. Proposals are written by
        CompositeMLAutoTuningWorker once a day when its PPO tuner has enough realised A/B evidence.
      </p>
    }
  `,
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .knobs {
        padding: var(--space-4) var(--space-5);
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
      }
      .knobs h3 {
        margin: 0 0 var(--space-2);
        font-size: var(--text-base);
      }
      .knobs table {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-sm);
      }
      .knobs th,
      .knobs td {
        padding: 6px 8px;
        border-bottom: 1px solid var(--border);
        text-align: left;
      }
      .knobs th {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        font-weight: normal;
      }
      .mono {
        font-family: var(--font-mono);
        font-size: var(--text-xs);
      }
      .muted {
        margin: 0;
        color: var(--text-tertiary);
        font-size: var(--text-sm);
      }
    `,
  ],
})
export class AutoTuneStatusPanelComponent {
  private readonly api = inject(AutoTuneService);

  readonly mode = input<'proposals' | 'auto-apply'>('proposals');
  /** Show the explanation card (the host shows it when its list is empty). */
  readonly showCard = input(true);

  protected readonly status = signal<AutoTuneStatusDto | null>(null);
  protected readonly failed = signal(false);

  constructor() {
    this.api
      .getStatus()
      .pipe(
        map((r) => (r?.status && r.data ? r.data : null)),
        catchError(() => of(null)),
      )
      .subscribe((s) => {
        this.status.set(s);
        this.failed.set(s === null);
      });
  }

  private total(s: AutoTuneStatusDto): number {
    return Object.values(s.proposalsByStatus ?? {}).reduce((a, b) => a + b, 0);
  }

  protected readonly tiles = computed<FactTile[]>(() => {
    const s = this.status();
    if (!s) return [];
    const total = this.total(s);
    return [
      {
        label: 'Proposals ever',
        value: count(total),
        caption: total
          ? Object.entries(s.proposalsByStatus)
              .map(([k, v]) => `${v} ${k.toLowerCase()}`)
              .join(' · ')
          : 'the tuner has written none',
      },
      {
        label: 'PPO evidence',
        value: `${count(s.ppoObservations)} / ${count(s.ppoMinObservations)}`,
        caption: `realised A/B observations in ${s.ppoLookbackDays} d vs the floor`,
        tone: s.ppoObservations >= s.ppoMinObservations ? 'good' : 'warn',
        title:
          'CompositeML generations whose A/B-tagged policy produced closed positions with realised P&L',
      },
      {
        label: 'Generations, last ' + s.ppoLookbackDays + ' d',
        value: count(s.generationAuditsInWindow),
        caption: `${count(s.auditsWithRealisedPnl)} with realised P&L · ${count(s.abTaggedPolicySnapshots)} A/B-tagged policies`,
      },
      {
        label: 'Tuner last ran',
        value: s.workerLastSuccessAtUtc ? ago(s.workerLastSuccessAtUtc) : 'not recorded',
        caption: `runs once every ${Math.round(s.pollIntervalSeconds / 3600)} h${s.workerLastError ? ' · last error: ' + s.workerLastError : ''}`,
        tone: s.workerLastError ? 'bad' : null,
      },
      {
        label: 'Auto-apply configs',
        value: `${count(s.autoApplyEnabledConfigs)} / ${count(s.autoApplyConfigs)}`,
        caption: 'enabled / configured knobs',
        route: '/auto-tune/auto-apply',
      },
    ];
  });

  protected readonly summary = computed(() =>
    this.mode() === 'proposals'
      ? 'CompositeMLAutoTuningWorker recommends better values for engine knobs from realised results and writes them here for review; it never changes a setting itself. Its first tuner, PPO, picks the saturation thresholds of the CompositeML policy trainer from A/B results of CompositeML-generated strategies.'
      : 'An auto-apply config lets one knob change without review once the tuner has proposed the same value several times in a row, within bounds you set and outside a quiet period. With no config every proposal waits for a person — the safe default.',
  );

  protected readonly detail = computed(() => {
    const s = this.status();
    if (!s) return null;
    if (s.ppoObservations < s.ppoMinObservations)
      return `It needs ${s.ppoMinObservations} realised observations in ${s.ppoLookbackDays} days and has ${s.ppoObservations}: ${
        s.generationAuditsInWindow
      } CompositeML generations in the window, none of them A/B-tagged with closed positions yet. Proposals start once CompositeML-generated strategies trade.`;
    return 'The evidence floor is met; a proposal appears after the next daily cycle if the tuner finds a better threshold.';
  });

  protected readonly requirements = computed<FeatureRequirement[]>(() => {
    const s = this.status();
    if (!s) return [];
    const reqs: FeatureRequirement[] = [
      {
        label: 'Tuner worker switched on',
        ok: s.workerEnabled,
        detail: `CompositeMLAutoTuningOptions:Enabled = ${s.workerEnabled}${
          s.workerLastSuccessAtUtc ? ` · last cycle ${day(s.workerLastSuccessAtUtc)}` : ''
        }`,
        route: '/worker-health',
      },
      {
        label: 'PPO tuner switched on',
        ok: s.ppoTunerEnabled,
        detail: `CompositeMLAutoTuningOptions:PpoTunerEnabled = ${s.ppoTunerEnabled}`,
      },
      {
        label: `At least ${s.ppoMinObservations} realised A/B observations in ${s.ppoLookbackDays} days`,
        ok: s.ppoObservations >= s.ppoMinObservations,
        detail: `${s.ppoObservations} now (${s.abTaggedPolicySnapshots} A/B-tagged policy snapshots, ${s.auditsWithRealisedPnl} generations with realised P&L)`,
        route: '/composite-ml',
      },
    ];
    if (this.mode() === 'auto-apply')
      reqs.push({
        label: 'A proposal to apply',
        ok: this.total(s) > 0,
        detail:
          this.total(s) > 0
            ? `${this.total(s)} written so far`
            : 'none written yet — a config would have nothing to act on',
        route: '/auto-tune',
      });
    return reqs;
  });
}
