import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

import { ChartIconComponent } from '../icons/chart-icon.component';
import { failureTitle, type ScriptFailure } from './script-run-state';

/** One Pine script in the chart's studies row, with everything about its runs (PC-13, PC-I7). */
export interface ScriptChip {
  key: string;
  name: string;
  kind: 'indicator' | 'strategy' | 'library';
  /** On the chart (a run landed); false while its first run is on its way or failed. */
  placed: boolean;
  /** The eye: false draws nothing. */
  visible: boolean;
  /** An explicit run of it is in flight (added, new inputs, Update on chart). */
  running: boolean;
  /** The engine was busy: its run is sent again at this time (client ms). */
  waitingUntil: number | null;
  /** Why its latest run did not land; null when it did. */
  failure: ScriptFailure | null;
  /** When the run on the chart landed (client ms), for a stale chip's hover. */
  lastGoodMs: number | null;
  /** Why it is not drawn on this chart type; null when it is. */
  unavailable: string | null;
  /**
   * Bar Replay (PC-08): `ahead` — its run reaches past the head, so it is not drawn until its run
   * to the head lands; `behind` — it is drawn up to an earlier bar while that run comes. Null
   * outside replay, at the head, and when no run to the head is due (hidden, failed, unavailable).
   */
  replay: 'ahead' | 'behind' | null;
}

/**
 * A Pine script's chip: eye, name, its run's state — running, waiting for a busy engine, running
 * to Bar Replay's head, failed (with the line to open the editor at, the library it is in and the
 * call stack on hover), stale (a re-run failed: the chart shows the last run that worked), not
 * available on this chart type — and Settings, source, Strategy Tester and remove.
 */
@Component({
  selector: 'app-script-chip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ChartIconComponent],
  template: `
    @let c = chip();
    <div
      class="chip"
      role="group"
      [attr.aria-label]="c.name"
      [class.off]="!c.visible || !!c.unavailable"
      [class.failed]="c.failure?.kind === 'error'"
      data-testid="script-chip"
    >
      @if (c.placed) {
        <button
          type="button"
          class="ic"
          (click)="visibility.emit()"
          [attr.aria-pressed]="c.visible"
          [title]="c.visible ? 'Hide' : 'Show'"
          [attr.aria-label]="(c.visible ? 'Hide ' : 'Show ') + c.name"
        >
          <app-chart-icon [name]="c.visible ? 'eye' : 'eye-off'" [size]="16" />
        </button>
      }
      <span class="label" (dblclick)="c.placed && settings.emit()">
        <span class="tag">{{ c.kind === 'strategy' ? 'Strategy' : 'Pine' }}</span>
        {{ c.name }}
      </span>
      @if (c.running) {
        <span class="state" role="status"
          ><span class="spin" aria-hidden="true"></span
          >{{ c.placed ? 'Updating…' : 'Running…' }}</span
        >
      } @else if (c.waitingUntil !== null) {
        <span
          class="state"
          role="status"
          title="The engine is busy with other runs: this one is sent again in a moment"
          ><span class="spin" aria-hidden="true"></span>Waiting for the engine…</span
        >
      } @else if (c.replay === 'ahead') {
        <span
          class="state"
          role="status"
          data-testid="script-replay"
          title="Its run reaches past the replay head: it shows again once its run to the head comes back"
          ><span class="spin" aria-hidden="true"></span>To the replay head…</span
        >
      } @else if (c.replay === 'behind') {
        <span
          class="state"
          role="status"
          data-testid="script-replay"
          title="It shows its run up to an earlier bar while its run to the replay head comes"
          ><span class="spin" aria-hidden="true"></span>Catching up…</span
        >
      }
      @if (c.unavailable; as u) {
        <span class="state muted" data-testid="script-unavailable">{{ u }}</span>
      }
      @if (c.failure; as f) {
        <span
          class="badge"
          [class.stale]="f.kind === 'stale'"
          [title]="hover(f, c.lastGoodMs)"
          role="alert"
          data-testid="script-failure"
        >
          <app-chart-icon name="warning" [size]="14" />
          @if (f.where && !f.unit) {
            <button
              type="button"
              class="line"
              (click)="openAt.emit(f.where)"
              [title]="'Open the editor at line ' + f.where.line"
            >
              Line {{ f.where.line }}
            </button>
          } @else if (f.where) {
            <span class="muted">{{ f.unit }}, line {{ f.where.line }}</span>
          }
          <span class="msg">{{ f.kind === 'stale' ? 'Not updated: ' : '' }}{{ f.message }}</span>
        </span>
      }
      @if (c.placed) {
        <button
          type="button"
          class="ic"
          (click)="settings.emit()"
          title="Settings"
          [attr.aria-label]="c.name + ' settings'"
          data-testid="script-settings"
        >
          <app-chart-icon name="settings" [size]="16" />
        </button>
      }
      <button
        type="button"
        class="ic"
        (click)="source.emit()"
        title="Source code"
        [attr.aria-label]="c.name + ' source code'"
      >
        <app-chart-icon name="pine" [size]="16" />
      </button>
      @if (c.kind === 'strategy' && c.placed) {
        <button type="button" class="ic" (click)="tester.emit()" title="Strategy tester">
          <app-chart-icon name="tester" [size]="16" />
        </button>
      }
      <button
        type="button"
        class="ic"
        (click)="removed.emit()"
        title="Remove"
        [attr.aria-label]="'Remove ' + c.name"
      >
        <app-chart-icon name="close" [size]="14" />
      </button>
    </div>
  `,
  styles: `
    :host {
      display: inline-flex;
      min-width: 0;
      max-width: 100%;
    }
    .chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      max-width: 100%;
      padding: 3px 6px 3px 4px;
      border: 1px solid var(--tv-line, var(--border, #e6e9ef));
      border-radius: 4px;
      font-size: 12px;
    }
    .chip.off .label,
    .chip.off .tag {
      opacity: 0.5;
    }
    .chip.failed {
      border-color: var(--danger, #ef5350);
    }
    .label {
      font-weight: 600;
      white-space: nowrap;
    }
    .tag {
      font-size: 10px;
      font-weight: 500;
      padding: 1px 5px;
      margin-right: 4px;
      border-radius: 4px;
      background: var(--accent-soft, rgba(41, 98, 255, 0.12));
      color: var(--accent, #2962ff);
    }
    .ic {
      display: inline-flex;
      align-items: center;
      border: 0;
      background: transparent;
      color: var(--text-muted, #787b86);
      cursor: pointer;
      padding: 2px 4px;
      line-height: 1;
    }
    .ic:hover {
      color: inherit;
    }
    .state {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      color: var(--text-muted, #787b86);
      white-space: nowrap;
    }
    .muted {
      color: var(--text-muted, #787b86);
    }
    .spin {
      width: 10px;
      height: 10px;
      border: 2px solid currentColor;
      border-right-color: transparent;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin {
      to {
        transform: rotate(360deg);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .spin {
        animation: none;
      }
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      min-width: 0;
      color: var(--danger, #ef5350);
    }
    .badge.stale {
      color: var(--warning, #f59e0b);
    }
    .msg {
      max-width: 320px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .line {
      border: 0;
      padding: 0;
      background: none;
      color: inherit;
      font: inherit;
      font-weight: 600;
      text-decoration: underline;
      cursor: pointer;
      white-space: nowrap;
    }
    @media (pointer: coarse) {
      .ic {
        justify-content: center;
        min-width: 40px;
        min-height: 40px;
      }
    }
  `,
})
export class ScriptChipComponent {
  readonly chip = input.required<ScriptChip>();

  readonly visibility = output<void>();
  readonly settings = output<void>();
  readonly source = output<void>();
  readonly tester = output<void>();
  readonly removed = output<void>();
  /** The failure's line: open the editor there (PC-I7). */
  readonly openAt = output<{ line: number; column: number }>();

  protected hover(f: ScriptFailure, lastGoodMs: number | null): string {
    return failureTitle(f, lastGoodMs);
  }
}
