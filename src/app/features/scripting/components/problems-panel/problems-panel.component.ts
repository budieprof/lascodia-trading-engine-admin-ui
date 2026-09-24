import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';

import type { ScriptDiagnostic } from '@core/api/scripting.types';
import { countDiagnostics, sortDiagnostics } from '../../pine/pine-diagnostics';

/**
 * Every diagnostic of the last compile, in reading order — like the Pine Editor's console.
 * Clicking one moves the editor's cursor to it.
 */
@Component({
  selector: 'app-problems-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="problems" [class.is-collapsed]="collapsed()">
      <button
        type="button"
        class="problems-head"
        (click)="collapsed.set(!collapsed())"
        [attr.aria-expanded]="!collapsed()"
      >
        <span class="caret" aria-hidden="true">{{ collapsed() ? '▸' : '▾' }}</span>
        <span class="title">Problems</span>
        @if (counts().errors) {
          <span class="count is-error">{{ counts().errors }} error{{ counts().errors === 1 ? '' : 's' }}</span>
        }
        @if (counts().warnings) {
          <span class="count is-warning">
            {{ counts().warnings }} warning{{ counts().warnings === 1 ? '' : 's' }}
          </span>
        }
        @if (counts().infos) {
          <span class="count is-info">{{ counts().infos }} info</span>
        }
        @if (sorted().length === 0) {
          <span class="count is-clean">{{ emptyLabel() }}</span>
        }
      </button>
      @if (!collapsed() && sorted().length > 0) {
        <ul class="problems-list" role="list">
          @for (d of sorted(); track $index) {
            <li>
              <button
                type="button"
                class="problem"
                [attr.data-severity]="d.severity"
                (click)="selected.emit(d)"
                [title]="'Go to line ' + d.line"
              >
                <span class="sev" [attr.aria-label]="d.severity">{{ icon(d.severity) }}</span>
                <span class="msg">{{ d.message }}</span>
                <span class="code">{{ d.code }}</span>
                <span class="pos">Ln {{ d.line }}, Col {{ d.column }}</span>
              </button>
            </li>
          }
        </ul>
      }
    </section>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .problems {
        border: 1px solid var(--border);
        border-radius: 8px;
        background: var(--bg-secondary);
        overflow: hidden;
      }
      .problems-head {
        width: 100%;
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 10px;
        border: none;
        background: transparent;
        color: var(--text-primary);
        font: inherit;
        font-size: 12px;
        cursor: pointer;
        text-align: left;
      }
      .caret {
        width: 10px;
        color: var(--text-tertiary);
      }
      .title {
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        font-size: 11px;
        color: var(--text-secondary);
      }
      .count {
        font-size: 11px;
        padding: 1px 7px;
        border-radius: 999px;
        background: var(--bg-tertiary);
        color: var(--text-secondary);
      }
      .count.is-error {
        background: rgba(255, 59, 48, 0.14);
        color: var(--loss);
      }
      .count.is-warning {
        background: rgba(255, 149, 0, 0.16);
        color: #b25e00;
      }
      .count.is-clean {
        background: rgba(52, 199, 89, 0.14);
        color: #1f8a3b;
      }
      .problems-list {
        list-style: none;
        margin: 0;
        padding: 0 0 4px;
        max-height: 168px;
        overflow-y: auto;
        border-top: 1px solid var(--border);
      }
      .problem {
        width: 100%;
        display: grid;
        grid-template-columns: 16px 1fr auto auto;
        gap: 8px;
        align-items: baseline;
        padding: 4px 10px;
        border: none;
        background: transparent;
        color: var(--text-primary);
        font: inherit;
        font-size: 12px;
        text-align: left;
        cursor: pointer;
      }
      .problem:hover,
      .problem:focus-visible {
        background: var(--bg-tertiary);
        outline: none;
      }
      .sev {
        text-align: center;
      }
      .problem[data-severity='error'] .sev {
        color: var(--loss);
      }
      .problem[data-severity='warning'] .sev {
        color: var(--warning);
      }
      .problem[data-severity='info'] .sev {
        color: var(--accent);
      }
      .msg {
        min-width: 0;
        overflow-wrap: anywhere;
      }
      .code,
      .pos {
        font-family: ui-monospace, 'SF Mono', Menlo, monospace;
        font-size: 11px;
        color: var(--text-tertiary);
        white-space: nowrap;
      }
    `,
  ],
})
export class ProblemsPanelComponent {
  readonly diagnostics = input<readonly ScriptDiagnostic[]>([]);
  /** Shown when there is nothing to list (e.g. "No problems" / "Not compiled yet"). */
  readonly emptyLabel = input('No problems');
  readonly selected = output<ScriptDiagnostic>();

  readonly collapsed = signal(false);
  readonly sorted = computed(() => sortDiagnostics(this.diagnostics()));
  readonly counts = computed(() => countDiagnostics(this.diagnostics()));

  icon(severity: string): string {
    return severity === 'warning' ? '▲' : severity === 'info' ? 'ℹ' : '●';
  }
}
