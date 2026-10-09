import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

import { ChartIconComponent } from '../icons/chart-icon.component';
import { failureTitle } from './script-run-state';
import type { ScriptAction, ScriptStatusRow } from './script-status';

/**
 * One Pine script's status line (PC-I2), as TradingView draws it at the top of the pane the study
 * is in: its title, its inputs, its values at the bar under the crosshair in their own colours —
 * and, on hover (always on touch), the eye, Settings, source code, Pine Logs and remove; a red mark with the
 * failure when its latest run failed ("Line N" opens the editor there).
 */
@Component({
  selector: 'app-script-status-line',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ChartIconComponent],
  template: `
    @let r = row();
    <div
      class="sl"
      [class.off]="!r.visible || !!r.note"
      role="group"
      [attr.aria-label]="r.title + ' status line'"
      data-testid="script-status-line"
    >
      <span class="title">{{ r.title }}</span>
      @if (r.inputs) {
        <span class="inputs">{{ r.inputs }}</span>
      }
      @if (r.failure; as f) {
        <span
          class="bad"
          [class.stale]="f.kind === 'stale'"
          role="alert"
          [title]="hover(r)"
          >!</span
        >
        @if (f.where && !f.unit) {
          <button
            type="button"
            class="line"
            (click)="act({ key: r.key, kind: 'openAt', where: f.where })"
            [title]="'Open the editor at line ' + f.where.line"
          >
            Line {{ f.where.line }}
          </button>
        }
      }
      @if (r.note) {
        <span class="note">{{ r.note }}</span>
      } @else if (r.visible) {
        @for (v of r.values; track v.key) {
          <span class="val" [style.color]="v.color" [attr.title]="v.title">{{ v.text }}</span>
        }
      }
      <span class="tools">
        <button
          type="button"
          (click)="act({ key: r.key, kind: 'visibility' })"
          [title]="r.visible ? 'Hide' : 'Show'"
          [attr.aria-label]="(r.visible ? 'Hide ' : 'Show ') + r.title"
          [attr.aria-pressed]="r.visible"
        >
          <app-chart-icon [name]="r.visible ? 'eye' : 'eye-off'" [size]="14" />
        </button>
        <button
          type="button"
          (click)="act({ key: r.key, kind: 'settings' })"
          title="Settings"
          [attr.aria-label]="r.title + ' settings'"
        >
          <app-chart-icon name="settings" [size]="14" />
        </button>
        <button
          type="button"
          (click)="act({ key: r.key, kind: 'source' })"
          title="Source code"
          [attr.aria-label]="r.title + ' source code'"
        >
          <app-chart-icon name="pine" [size]="14" />
        </button>
        <button
          type="button"
          (click)="act({ key: r.key, kind: 'logs' })"
          title="Pine Logs"
          [attr.aria-label]="r.title + ' Pine Logs'"
        >
          <app-chart-icon name="logs" [size]="14" />
        </button>
        <button
          type="button"
          (click)="act({ key: r.key, kind: 'remove' })"
          title="Remove"
          [attr.aria-label]="'Remove ' + r.title"
        >
          <app-chart-icon name="close" [size]="12" />
        </button>
      </span>
    </div>
  `,
  styles: `
    :host {
      display: block;
      min-width: 0;
    }
    .sl {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: 2px 8px;
      font-size: 12px;
      line-height: 20px;
      font-variant-numeric: tabular-nums;
      color: var(--tv-ink, #131722);
      pointer-events: auto;
    }
    .sl.off .title,
    .sl.off .inputs {
      opacity: 0.5;
    }
    .title {
      font-weight: 500;
    }
    .inputs,
    .note {
      color: var(--tv-muted, #787b86);
    }
    .bad {
      display: inline-grid;
      place-items: center;
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: var(--danger, #ef5350);
      color: #fff;
      font-size: 10px;
      font-weight: 700;
      line-height: 1;
      align-self: center;
      cursor: help;
    }
    .bad.stale {
      background: var(--warning, #f59e0b);
    }
    .line {
      border: 0;
      padding: 0;
      background: none;
      color: var(--danger, #ef5350);
      font: inherit;
      font-weight: 600;
      text-decoration: underline;
      cursor: pointer;
    }
    .tools {
      display: inline-flex;
      gap: 2px;
      align-self: center;
      opacity: 0;
      transition: opacity var(--dur-fast, 0.15s);
    }
    .sl:hover .tools,
    .sl:focus-within .tools {
      opacity: 1;
    }
    .tools button {
      display: inline-flex;
      align-items: center;
      padding: 1px 3px;
      border: 1px solid transparent;
      border-radius: 3px;
      background: var(--tv-bg, rgba(255, 255, 255, 0.85));
      color: var(--tv-muted, #787b86);
      cursor: pointer;
    }
    .tools button:hover {
      color: var(--tv-ink, #131722);
      border-color: var(--tv-line, #e0e3eb);
    }
    @media (pointer: coarse) {
      .tools {
        opacity: 1;
      }
      .tools button {
        min-width: 32px;
        min-height: 32px;
        justify-content: center;
      }
    }
  `,
})
export class ScriptStatusLineComponent {
  readonly row = input.required<ScriptStatusRow>();
  readonly action = output<ScriptAction>();

  protected act(a: ScriptAction): void {
    this.action.emit(a);
  }

  protected hover(r: ScriptStatusRow): string {
    return r.failure ? failureTitle(r.failure) : '';
  }
}
