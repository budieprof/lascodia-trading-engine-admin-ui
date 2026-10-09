import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { SCRIPTING_UI_STYLES } from '../components/scripting-ui.styles';
import { formatDateTime } from '../report/report-format';
import { describeFailure } from '../shared/api-error';
import { ScreensApiService } from './screens-api.service';
import { isoText, runSummary, timeframeName } from './screens.model';
import type { ScreenAlertDto, ScreenRunDto } from './screens.types';

type Tab = 'runs' | 'alerts';

/**
 * SS-I6 — a saved screen's history: its runs (scheduled at bar close, or "Run now"), who entered and left the matches
 * on each, and the alert log — every alert per channel with whether it was delivered, skipped or failed.
 */
@Component({
  selector: 'app-screen-history',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card" aria-labelledby="scr-history-title" data-testid="screen-history">
      <header class="head">
        <h2 class="card-title" id="scr-history-title">History</h2>
        <div class="tabs" role="tablist" aria-label="Screen history">
          <button
            type="button"
            role="tab"
            class="tab"
            data-testid="tab-runs"
            [attr.aria-selected]="tab() === 'runs'"
            [class.active]="tab() === 'runs'"
            (click)="tab.set('runs')"
          >
            Runs
          </button>
          <button
            type="button"
            role="tab"
            class="tab"
            data-testid="tab-alerts"
            [attr.aria-selected]="tab() === 'alerts'"
            [class.active]="tab() === 'alerts'"
            (click)="showAlerts()"
          >
            Alerts
          </button>
        </div>
        <button type="button" class="btn btn-ghost btn-sm refresh" (click)="reload()">
          Refresh
        </button>
      </header>
      @if (problem(); as p) {
        <p class="error-box" role="alert">{{ p }}</p>
      }

      @if (tab() === 'runs') {
        @if (runs().length === 0) {
          <p class="muted small">{{ loading() ? 'Loading runs…' : 'No runs yet.' }}</p>
        } @else {
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Run</th>
                  <th scope="col">Bar (UTC)</th>
                  <th scope="col">Result</th>
                  <th scope="col">Entered</th>
                  <th scope="col">Left</th>
                  <th scope="col">Alerts</th>
                  <th scope="col"><span class="sr-only">Rows</span></th>
                </tr>
              </thead>
              <tbody>
                @for (r of runs(); track r.id) {
                  <tr [attr.data-run]="r.id">
                    <td class="small">
                      {{ when(r.startedAt) }}
                      <span class="chip" [class.chip-accent]="r.trigger === 'Scheduled'">{{
                        r.trigger
                      }}</span>
                    </td>
                    <td class="small">{{ bar(r.barTimeMs) }}</td>
                    <td class="small">
                      @if (r.error) {
                        <span class="chip chip-error" [attr.title]="r.error">failed</span>
                        {{ r.error }}
                      } @else {
                        {{ summary(r) }}
                      }
                      @for (n of r.notes; track $index) {
                        <span class="note">{{ n }}</span>
                      }
                    </td>
                    <td class="small sym">{{ r.enteredSymbols.join(', ') }}</td>
                    <td class="small sym">{{ r.leftSymbols.join(', ') }}</td>
                    <td class="small">{{ r.alertsQueued || '' }}</td>
                    <td class="actions">
                      @if (r.hasRows) {
                        <button
                          type="button"
                          class="btn btn-sm"
                          [disabled]="opening() === r.id"
                          (click)="open(r)"
                        >
                          Show rows
                        </button>
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      } @else {
        @if (alerts().length === 0) {
          <p class="muted small">
            {{
              loading()
                ? 'Loading alerts…'
                : 'No alerts yet. Scheduled runs alert when a symbol starts or stops matching.'
            }}
          </p>
        } @else {
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Written</th>
                  <th scope="col">Symbol</th>
                  <th scope="col">Change</th>
                  <th scope="col">Channel</th>
                  <th scope="col">Status</th>
                  <th scope="col">Message</th>
                </tr>
              </thead>
              <tbody>
                @for (a of alerts(); track a.id) {
                  <tr [attr.data-alert]="a.id">
                    <td class="small">{{ when(a.createdAt) }}</td>
                    <td class="small mono">{{ a.symbol }} {{ tf(a.timeframe) }}</td>
                    <td class="small">
                      {{ a.kind === 'Left' ? 'Stopped matching' : 'Started matching' }}
                    </td>
                    <td class="small">{{ a.channel }}</td>
                    <td class="small">
                      <span
                        class="chip"
                        [class.chip-ok]="a.status === 'Delivered'"
                        [class.chip-warn]="a.status === 'Pending' || a.status === 'Skipped'"
                        [class.chip-error]="a.status === 'Failed' || a.status === 'Expired'"
                        [attr.title]="a.lastError"
                        >{{ a.status }}</span
                      >
                      @if (a.lastError) {
                        <span class="note">{{ a.lastError }}</span>
                      }
                    </td>
                    <td class="small">{{ a.message }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      }
    </section>
  `,
  styles: [
    SCRIPTING_UI_STYLES,
    `
      :host {
        display: block;
      }
      .card {
        padding: var(--space-4) var(--space-5);
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
        min-width: 0;
      }
      .head {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 12px;
      }
      .card-title {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .tabs {
        display: inline-flex;
        gap: 4px;
      }
      .tab {
        border: 1px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-secondary);
        border-radius: var(--radius-full);
        padding: 2px 12px;
        font: inherit;
        font-size: var(--text-xs);
        cursor: pointer;
      }
      .tab.active {
        border-color: var(--accent);
        color: var(--accent);
      }
      .refresh {
        margin-left: auto;
      }
      .table-wrap {
        overflow-x: auto;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-sm);
      }
      th,
      td {
        text-align: left;
        padding: 6px 8px;
        border-bottom: 1px solid var(--border);
        vertical-align: top;
      }
      th {
        font-weight: var(--font-medium);
        color: var(--text-secondary);
        font-size: var(--text-xs);
      }
      .sym {
        font-family: 'SF Mono', 'Fira Code', monospace;
        max-width: 220px;
      }
      .note {
        display: block;
        color: var(--text-secondary);
      }
      .actions {
        text-align: right;
        white-space: nowrap;
      }
      p {
        margin: 0;
      }
      .sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border: 0;
      }
    `,
  ],
})
export class ScreenHistoryComponent {
  private readonly api = inject(ScreensApiService);

  readonly screenId = input.required<number>();
  /** Bumped by the page after a run or a save so the history reads again. */
  readonly refreshKey = input(0);
  /** A run's rows, to show in the results grid. */
  readonly runOpened = output<ScreenRunDto>();

  readonly tab = signal<Tab>('runs');
  readonly runs = signal<ScreenRunDto[]>([]);
  readonly alerts = signal<ScreenAlertDto[]>([]);
  readonly loading = signal(false);
  readonly problem = signal<string | null>(null);
  readonly opening = signal<number | null>(null);
  private alertsLoaded = false;

  constructor() {
    effect(() => {
      this.screenId();
      this.refreshKey();
      untracked(() => {
        this.alertsLoaded = false;
        this.alerts.set([]);
        void this.loadRuns();
        if (this.tab() === 'alerts') void this.loadAlerts();
      });
    });
  }

  when(iso: string | null): string {
    return isoText(iso);
  }

  bar(ms: number | null): string {
    return ms === null ? '—' : formatDateTime(ms);
  }

  tf(t: string): string {
    return timeframeName(t);
  }

  summary(r: ScreenRunDto): string {
    return runSummary(r);
  }

  reload(): void {
    void this.loadRuns();
    if (this.tab() === 'alerts') void this.loadAlerts();
  }

  showAlerts(): void {
    this.tab.set('alerts');
    if (!this.alertsLoaded) void this.loadAlerts();
  }

  async open(r: ScreenRunDto): Promise<void> {
    this.opening.set(r.id);
    this.problem.set(null);
    try {
      const res = await firstValueFrom(this.api.runDetail(this.screenId(), r.id));
      if (!res?.status || !res.data) throw res;
      this.runOpened.emit(res.data);
    } catch (err) {
      this.problem.set(describeFailure(err, 'That run could not be read.'));
    } finally {
      this.opening.set(null);
    }
  }

  private async loadRuns(): Promise<void> {
    const id = this.screenId();
    this.loading.set(true);
    try {
      const res = await firstValueFrom(this.api.runs(id));
      if (id !== this.screenId()) return;
      if (!res?.status) throw res;
      this.runs.set(res.data ?? []);
      this.problem.set(null);
    } catch (err) {
      this.problem.set(describeFailure(err, 'The runs could not be loaded.'));
    } finally {
      this.loading.set(false);
    }
  }

  private async loadAlerts(): Promise<void> {
    const id = this.screenId();
    this.loading.set(true);
    try {
      const res = await firstValueFrom(this.api.alerts(id));
      if (id !== this.screenId()) return;
      if (!res?.status) throw res;
      this.alerts.set(res.data ?? []);
      this.alertsLoaded = true;
      this.problem.set(null);
    } catch (err) {
      this.problem.set(describeFailure(err, 'The alerts could not be loaded.'));
    } finally {
      this.loading.set(false);
    }
  }
}
