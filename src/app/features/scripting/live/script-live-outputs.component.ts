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
import { firstValueFrom } from 'rxjs';

import { PineChartComponent } from '@shared/pine-chart/components/pine-chart.component';

import { ScriptStrategyService } from '../api/script-strategy.service';
import type { ScriptLiveOutputs } from '../api/scripting-api.types';
import { describeFailure, isOk } from '../shared/api-error';
import { liveOutputsCaption, liveOutputsChartData, resolveMember } from './live-outputs.model';

/**
 * §8a / SS-I7 — what the running live session itself computed on its chart (plots, markers, drawings, tables), read
 * from `GET strategy/{id}/script/live/outputs`: not a re-run of the script, which can differ (its history starts
 * elsewhere, it never saw the realtime ticks, it runs the current inputs).
 *
 * CONTRACT K2: a portfolio strategy answers `portfolioMembers`; the card then shows a member selector and asks for one
 * member's outputs (`?member=`). Opt-in (a button) — up to 5,000 bars of outputs is not fetched on every Live-tab open.
 */
@Component({
  selector: 'app-script-live-outputs',
  standalone: true,
  imports: [PineChartComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="block" aria-labelledby="slo-title" data-testid="live-outputs">
      <header class="head">
        <h4 class="block-title" id="slo-title">Live session outputs</h4>
        @if (members(); as ms) {
          <label class="member">
            <span class="muted small">Member</span>
            <select
              data-testid="live-outputs-member"
              [value]="member() ?? ''"
              (change)="pickMember($any($event.target).value)"
              [disabled]="loading()"
            >
              @for (m of ms; track m) {
                <option [value]="m" [selected]="m === member()">{{ m }}</option>
              }
            </select>
          </label>
        }
        <button type="button" class="btn" (click)="refresh()" [disabled]="loading()">
          {{ requested() ? (loading() ? 'Loading…' : 'Refresh') : 'Show live outputs' }}
        </button>
      </header>
      @if (!requested()) {
        <p class="hint">
          The plots, markers and drawings the running session computed — what the live strategy
          sees, not a re-run of the script.
        </p>
      } @else {
        @if (caption(); as c) {
          <p class="hint" data-testid="live-outputs-caption">{{ c }}</p>
        }
        @if (note(); as n) {
          <p class="hint note" role="note">{{ n }}</p>
        }
        @if (chart(); as d) {
          <div class="chart-host">
            <app-pine-chart
              class="chart"
              [result]="d"
              [symbol]="dto()?.symbol ?? ''"
              [timeframe]="dto()?.timeframe ?? ''"
              [showTrades]="false"
              emptyText="No bars in this answer."
            />
          </div>
        }
      }
    </section>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .block {
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
      }
      .head {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--space-2) var(--space-3);
      }
      .block-title {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .member {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .btn {
        margin-left: auto;
        padding: 4px 10px;
        font-size: var(--text-sm);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: transparent;
        color: var(--text-primary);
        cursor: pointer;
      }
      .hint {
        margin: 0;
        font-size: var(--text-xs);
        color: var(--text-secondary);
        line-height: 1.5;
      }
      .note {
        color: var(--warning);
      }
      .chart-host {
        height: 380px;
        display: flex;
      }
      .chart {
        flex: 1;
        min-width: 0;
      }
      .muted {
        color: var(--text-secondary);
      }
      .small {
        font-size: var(--text-xs);
      }
    `,
  ],
})
export class ScriptLiveOutputsComponent {
  private readonly api = inject(ScriptStrategyService);

  readonly strategyId = input.required<number>();

  /** The operator asked for the outputs (the card fetches nothing before that). */
  readonly requested = signal(false);
  readonly loading = signal(false);
  readonly dto = signal<ScriptLiveOutputs | null>(null);
  readonly error = signal<string | null>(null);
  /** K2: the portfolio's members (null for a single-symbol strategy or an engine without K2). */
  readonly members = signal<string[] | null>(null);
  readonly member = signal<string | null>(null);

  readonly chart = computed(() => liveOutputsChartData(this.dto()));
  readonly caption = computed(() => {
    const c = liveOutputsCaption(this.dto());
    const m = this.member();
    return m && c ? `${m} · ${c}` : c;
  });
  readonly note = computed(() => {
    const err = this.error();
    if (err) return err;
    const d = this.dto();
    if (!d) return null;
    if (d.note) return d.note;
    if (!this.chart()) return 'The session has no bars to show yet.';
    return null;
  });

  constructor() {
    // A different strategy: forget the previous one's answer and member.
    effect(() => {
      this.strategyId();
      untracked(() => {
        this.requested.set(false);
        this.dto.set(null);
        this.error.set(null);
        this.members.set(null);
        this.member.set(null);
      });
    });
  }

  refresh(): void {
    this.requested.set(true);
    void this.load(this.member());
  }

  pickMember(symbol: string): void {
    if (!symbol || symbol === this.member()) return;
    this.member.set(symbol);
    void this.load(symbol);
  }

  private async load(member: string | null, hop = 0): Promise<void> {
    const id = this.strategyId();
    this.loading.set(true);
    this.error.set(null);
    try {
      const res = await firstValueFrom(this.api.getLiveOutputs(id, member));
      if (id !== this.strategyId()) return;
      if (!isOk(res) || !res.data) {
        this.dto.set(null);
        this.error.set(res?.message || 'The live outputs could not be read.');
        return;
      }
      const ms = Array.isArray(res.data.portfolioMembers) ? res.data.portfolioMembers : null;
      this.members.set(ms && ms.length > 0 ? ms : null);
      const want = resolveMember(ms, member);
      if (want !== member && hop === 0) {
        // A portfolio answer to a request without (or with a stale) member: ask for one member's outputs.
        this.member.set(want);
        await this.load(want, 1);
        return;
      }
      this.member.set(want);
      this.dto.set(res.data);
    } catch (e) {
      if (id === this.strategyId()) {
        this.dto.set(null);
        this.error.set(describeFailure(e, 'The live outputs could not be read.'));
      }
    } finally {
      if (id === this.strategyId()) this.loading.set(false);
    }
  }
}
