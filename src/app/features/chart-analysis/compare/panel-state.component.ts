import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import type { PanelLoad } from './split-panels';

/**
 * US03: what a split panel says while its bars load, when there are none and why, or when the request
 * failed — with a retry for the last two. Ready draws nothing (the chart is the answer).
 */
@Component({
  selector: 'app-panel-state',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @switch (load()?.kind) {
      @case ('loading') {
        <div class="state" role="status">Loading {{ symbol() }}…</div>
      }
      @case ('empty') {
        <div class="state" role="status">
          <span>{{ message() }}</span>
          <button type="button" (click)="retry.emit()">Retry</button>
        </div>
      }
      @case ('error') {
        <div class="state error" role="alert">
          <span>{{ message() }}</span>
          <button type="button" (click)="retry.emit()">Retry</button>
        </div>
      }
    }
  `,
  styles: `
    :host {
      position: absolute;
      inset: auto 0 50% 0;
      z-index: 12;
      display: flex;
      justify-content: center;
      pointer-events: none;
    }
    .state {
      display: flex;
      align-items: center;
      gap: 8px;
      max-width: 90%;
      color: var(--text-muted, #787b86);
      font-size: 13px;
      text-align: center;
    }
    .state.error {
      color: var(--danger, #ef5350);
    }
    button {
      pointer-events: auto;
      padding: 2px 8px;
      border: 1px solid var(--border, #e6e9ef);
      border-radius: 4px;
      background: var(--surface, #fff);
      color: inherit;
      font: inherit;
      cursor: pointer;
    }
  `,
})
export class PanelStateComponent {
  readonly load = input<PanelLoad | undefined>(undefined);
  readonly symbol = input('');
  readonly retry = output<void>();

  message(): string {
    const l = this.load();
    return l && (l.kind === 'empty' || l.kind === 'error') ? l.message : '';
  }
}
