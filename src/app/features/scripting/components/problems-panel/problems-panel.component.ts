import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';

import type { ScriptDiagnostic, ScriptDiagnosticFix } from '@core/api/scripting.types';
import {
  countDiagnostics,
  inLibrary,
  sortDiagnostics,
  unitLabel,
} from '../../pine/pine-diagnostics';

/** A quick fix the operator picked on a Problems row. */
export interface ProblemFix {
  diagnostic: ScriptDiagnostic;
  fix: ScriptDiagnosticFix;
}

/** An AI request on a Problems row (PE-I6). */
export interface ProblemAsk {
  diagnostic: ScriptDiagnostic;
  mode: 'explain' | 'fix';
}

/**
 * Every diagnostic of the last compile, in reading order — like the Pine Editor's console.
 * Clicking one moves the editor's cursor to it. A row shows the engine's hint under its message and
 * offers its quick fixes as buttons; a diagnostic in an imported library's code names the library
 * (its line numbers are the library's) and does not move the cursor.
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
          <span class="count is-error"
            >{{ counts().errors }} error{{ counts().errors === 1 ? '' : 's' }}</span
          >
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
          <span class="count" [class.is-clean]="compiled()">{{ emptyLabel() }}</span>
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
                [class.in-library]="isLibrary(d)"
                (click)="select(d)"
                [title]="
                  isLibrary(d)
                    ? 'In ' + libraryOf(d) + ' — its line numbers are the library’s'
                    : 'Go to line ' + d.line
                "
              >
                <span class="sev" [attr.aria-label]="d.severity">{{ icon(d.severity) }}</span>
                <span class="msg">
                  {{ d.message }}
                  @if (d.hint) {
                    <span class="hint">{{ d.hint }}</span>
                  }
                </span>
                <span class="code">{{ d.code }}</span>
                <span class="pos">
                  @if (isLibrary(d)) {
                    {{ libraryOf(d) }}, Ln {{ d.line }}
                  } @else {
                    Ln {{ d.line }}, Col {{ d.column }}
                  }
                </span>
              </button>
              @if (fixesOf(d).length > 0 || (assist() && !isLibrary(d))) {
                <div class="fixes">
                  @for (f of fixesOf(d); track $index) {
                    <button
                      type="button"
                      class="fix"
                      [disabled]="readOnly()"
                      (click)="fix.emit({ diagnostic: d, fix: f })"
                      [title]="
                        readOnly()
                          ? 'The editor is read-only'
                          : 'Apply this fix (Ctrl/Cmd-Z undoes it)'
                      "
                    >
                      Fix: {{ f.title }}
                    </button>
                  }
                  @if (assist() && !isLibrary(d)) {
                    <button
                      type="button"
                      class="fix ai"
                      (click)="ask.emit({ diagnostic: d, mode: 'explain' })"
                      title="Ask the AI what this means and how to fix it"
                    >
                      Explain
                    </button>
                    <button
                      type="button"
                      class="fix ai"
                      [disabled]="readOnly()"
                      (click)="ask.emit({ diagnostic: d, mode: 'fix' })"
                      [title]="
                        readOnly()
                          ? 'The editor is read-only'
                          : 'Ask the AI for a fix — shown as a comparison you accept or reject'
                      "
                    >
                      AI fix
                    </button>
                  }
                </div>
              }
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
      .hint {
        display: block;
        margin-top: 2px;
        color: var(--text-secondary);
        font-size: 11px;
      }
      .problem.in-library {
        cursor: default;
      }
      .fixes {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        padding: 0 10px 4px 34px;
      }
      .fix {
        border: 1px solid var(--border);
        border-radius: 6px;
        background: var(--bg-primary);
        color: var(--accent);
        font: inherit;
        font-size: 11px;
        padding: 1px 8px;
        cursor: pointer;
      }
      .fix:hover:not(:disabled),
      .fix:focus-visible {
        background: var(--bg-tertiary);
        outline: none;
      }
      .fix:disabled {
        color: var(--text-tertiary);
        cursor: default;
      }
    `,
  ],
})
export class ProblemsPanelComponent {
  readonly diagnostics = input<readonly ScriptDiagnostic[]>([]);
  /** Shown when there is nothing to list (e.g. "No problems" / "Not compiled yet"). */
  readonly emptyLabel = input('No problems');
  /** A compile has run — an empty list is then a clean bill, shown in green. */
  readonly compiled = input(true);
  /** The editor cannot be changed: quick fixes are shown but not offered. */
  readonly readOnly = input(false);
  /** A row of the script's own code was clicked (library rows do not move the cursor). */
  readonly selected = output<ScriptDiagnostic>();
  /** A quick fix was picked. */
  readonly fix = output<ProblemFix>();
  /** Offer the AI's Explain / AI fix on each row of the script's own code (PE-I6). */
  readonly assist = input(false);
  /** Explain / AI fix was picked on a row. */
  readonly ask = output<ProblemAsk>();

  readonly collapsed = signal(false);
  readonly sorted = computed(() => sortDiagnostics(this.diagnostics()));
  readonly counts = computed(() => countDiagnostics(this.diagnostics()));

  icon(severity: string): string {
    return severity === 'warning' ? '▲' : severity === 'info' ? 'ℹ' : '●';
  }

  isLibrary(d: ScriptDiagnostic): boolean {
    return inLibrary(d);
  }

  libraryOf(d: ScriptDiagnostic): string {
    return unitLabel(d.unit) ?? '';
  }

  /** The row's quick fixes (none for a library's diagnostics — that code is not in this editor). */
  fixesOf(d: ScriptDiagnostic): readonly ScriptDiagnosticFix[] {
    return !inLibrary(d) && Array.isArray(d.fixes) ? d.fixes : [];
  }

  select(d: ScriptDiagnostic): void {
    if (!inLibrary(d)) this.selected.emit(d);
  }
}
