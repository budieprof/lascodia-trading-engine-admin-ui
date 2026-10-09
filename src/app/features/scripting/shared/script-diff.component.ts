import { ChangeDetectionStrategy, Component, computed, input, linkedSignal } from '@angular/core';

import {
  collapseUnchanged,
  diffInputValues,
  diffLines,
  formatInputValue,
  inputLabel,
  sideBySide,
  type DiffBlock,
  type DiffRow,
} from './text-diff';

/**
 * Two versions of a Pine script side by side: the source line by line (changed characters marked,
 * long unchanged stretches folded — click to unfold), then the input overrides and the name when
 * they differ. Used by save conflicts, version history and library versions.
 */
@Component({
  selector: 'app-script-diff',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="sdiff">
      <div class="sdiff-head">
        <span class="sdiff-label">{{ beforeLabel() }}</span>
        <span class="sdiff-counts">
          @if (diff().removed || diff().added) {
            <span class="sdiff-removed">−{{ diff().removed }}</span>
            <span class="sdiff-added">+{{ diff().added }}</span>
            lines
          } @else {
            Same source
          }
        </span>
        <span class="sdiff-label">{{ afterLabel() }}</span>
      </div>

      @if (nameChange(); as n) {
        <p class="sdiff-note">
          Name: <span class="sdiff-old">{{ n.before }}</span> →
          <span class="sdiff-new">{{ n.after }}</span>
        </p>
      }
      @if (diff().approximate) {
        <p class="sdiff-note">
          The two sources differ in too many lines to line up one by one: the differing part is
          shown as removed and re-added.
        </p>
      }

      @if (diff().removed || diff().added || showUnchangedSource()) {
        <div class="sdiff-scroll" [style.max-height]="maxHeight()">
          <table class="sdiff-table">
            <colgroup>
              <col class="c-no" />
              <col class="c-text" />
              <col class="c-no" />
              <col class="c-text" />
            </colgroup>
            <tbody>
              @for (block of blocks(); track $index) {
                @if (block.kind === 'gap' && !expanded().has(block.index)) {
                  <tr class="sdiff-gap">
                    <td colspan="4">
                      <button type="button" (click)="expand(block.index)">
                        Show {{ block.rows.length }} unchanged line{{
                          block.rows.length === 1 ? '' : 's'
                        }}
                      </button>
                    </td>
                  </tr>
                } @else {
                  @for (row of block.rows; track $index) {
                    <tr [class]="'sdiff-row is-' + row.kind">
                      <td class="no">{{ row.left?.no ?? '' }}</td>
                      <td class="text left">
                        @if (row.left; as c) {
                          @if (c.segments) {
                            <code
                              >@for (s of c.segments; track $index) {<span
                                  [class.mark]="s.changed"
                                  >{{ s.text }}</span
                                >}</code
                            >
                          } @else {
                            <code>{{ c.text }}</code>
                          }
                        }
                      </td>
                      <td class="no">{{ row.right?.no ?? '' }}</td>
                      <td class="text right">
                        @if (row.right; as c) {
                          @if (c.segments) {
                            <code
                              >@for (s of c.segments; track $index) {<span
                                  [class.mark]="s.changed"
                                  >{{ s.text }}</span
                                >}</code
                            >
                          } @else {
                            <code>{{ c.text }}</code>
                          }
                        }
                      </td>
                    </tr>
                  }
                }
              }
            </tbody>
          </table>
        </div>
      }

      @if (inputChanges().length > 0) {
        <table class="sdiff-inputs">
          <caption>
            Input overrides
          </caption>
          <thead>
            <tr>
              <th scope="col">Input</th>
              <th scope="col">{{ beforeLabel() }}</th>
              <th scope="col">{{ afterLabel() }}</th>
            </tr>
          </thead>
          <tbody>
            @for (c of inputChanges(); track c.id) {
              <tr [class]="'is-' + c.kind">
                <th scope="row" [title]="c.id">{{ label(c.id) }}</th>
                <td>{{ value(c.before) }}</td>
                <td>{{ value(c.after) }}</td>
              </tr>
            }
          </tbody>
        </table>
      } @else if (comparesInputs()) {
        <p class="sdiff-note">The input overrides are the same.</p>
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
        min-width: 0;
      }
      .sdiff {
        display: flex;
        flex-direction: column;
        gap: 6px;
        font-size: 12px;
      }
      .sdiff-head {
        display: grid;
        grid-template-columns: 1fr auto 1fr;
        gap: 8px;
        align-items: center;
        color: var(--text-secondary);
      }
      .sdiff-head .sdiff-label:last-child {
        text-align: right;
      }
      .sdiff-label {
        font-weight: 600;
        color: var(--text-primary);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .sdiff-counts {
        font-family: ui-monospace, 'SF Mono', Menlo, monospace;
        font-size: 11px;
      }
      .sdiff-removed,
      .sdiff-old {
        color: var(--loss, #d70015);
      }
      .sdiff-added,
      .sdiff-new {
        color: var(--profit, #248a3d);
      }
      .sdiff-note {
        margin: 0;
        color: var(--text-secondary);
      }
      .sdiff-scroll {
        overflow: auto;
        border: 1px solid var(--border);
        border-radius: 8px;
        background: var(--bg-primary);
      }
      .sdiff-table {
        width: 100%;
        border-collapse: collapse;
        table-layout: fixed;
        font-family: ui-monospace, 'SF Mono', SFMono-Regular, Menlo, monospace;
        font-size: 12px;
        line-height: 1.5;
      }
      .c-no {
        width: 44px;
      }
      td {
        vertical-align: top;
        padding: 0 6px;
      }
      td.no {
        text-align: right;
        color: var(--text-tertiary);
        user-select: none;
        border-right: 1px solid var(--border);
      }
      td.text code {
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        font: inherit;
      }
      td.left {
        border-right: 1px solid var(--border);
      }
      .is-removed td.left,
      .is-changed td.left {
        background: rgba(255, 59, 48, 0.08);
      }
      .is-added td.right,
      .is-changed td.right {
        background: rgba(52, 199, 89, 0.1);
      }
      .is-changed td.left .mark {
        background: rgba(255, 59, 48, 0.28);
        border-radius: 2px;
      }
      .is-changed td.right .mark {
        background: rgba(52, 199, 89, 0.32);
        border-radius: 2px;
      }
      .sdiff-gap td {
        padding: 2px 6px;
        background: var(--bg-secondary);
        text-align: center;
      }
      .sdiff-gap button {
        border: none;
        background: none;
        color: var(--accent);
        font: inherit;
        font-size: 11px;
        cursor: pointer;
      }
      .sdiff-inputs {
        width: 100%;
        border-collapse: collapse;
        font-size: 12px;
      }
      .sdiff-inputs caption {
        text-align: left;
        font-weight: 600;
        padding: 4px 0;
        color: var(--text-secondary);
      }
      .sdiff-inputs th,
      .sdiff-inputs td {
        text-align: left;
        padding: 3px 6px;
        border-top: 1px solid var(--border);
        font-weight: 400;
        overflow-wrap: anywhere;
      }
      .sdiff-inputs th[scope='col'] {
        font-weight: 600;
        color: var(--text-secondary);
      }
      .sdiff-inputs .is-removed td:nth-of-type(1),
      .sdiff-inputs .is-changed td:nth-of-type(1) {
        color: var(--loss, #d70015);
      }
      .sdiff-inputs .is-added td:nth-of-type(2),
      .sdiff-inputs .is-changed td:nth-of-type(2) {
        color: var(--profit, #248a3d);
      }
    `,
  ],
})
export class ScriptDiffComponent {
  readonly before = input<string | null>('');
  readonly after = input<string | null>('');
  readonly beforeLabel = input('Before');
  readonly afterLabel = input('After');
  /** Saved input overrides of each side; leave both null to not compare inputs. */
  readonly beforeInputs = input<Readonly<Record<string, unknown>> | null>(null);
  readonly afterInputs = input<Readonly<Record<string, unknown>> | null>(null);
  readonly beforeName = input<string | null>(null);
  readonly afterName = input<string | null>(null);
  /** Unchanged lines kept around each change. */
  readonly context = input(3);
  readonly maxHeight = input('420px');
  /** Show the (folded) source even when it did not change. */
  readonly showUnchangedSource = input(false);

  readonly diff = computed(() => diffLines(this.before() ?? '', this.after() ?? ''));
  readonly blocks = computed<DiffBlock[]>(() =>
    collapseUnchanged(sideBySide(this.diff()), this.context()),
  );
  readonly comparesInputs = computed(
    () => this.beforeInputs() !== null || this.afterInputs() !== null,
  );
  readonly inputChanges = computed(() =>
    this.comparesInputs() ? diffInputValues(this.beforeInputs(), this.afterInputs()) : [],
  );
  readonly nameChange = computed(() => {
    const b = this.beforeName();
    const a = this.afterName();
    return b !== null && a !== null && b.trim() !== a.trim() ? { before: b, after: a } : null;
  });

  /** Folds the operator opened; all closed again when the texts change. */
  readonly expanded = linkedSignal<DiffBlock[], ReadonlySet<number>>({
    source: this.blocks,
    computation: () => new Set<number>(),
  });

  expand(index: number): void {
    this.expanded.set(new Set([...this.expanded(), index]));
  }

  label(id: string): string {
    return inputLabel(id);
  }

  value(v: unknown): string {
    return v === undefined ? '—' : formatInputValue(v);
  }

  /** For specs and hosts: the rows as shown (folds closed). */
  visibleRows(): DiffRow[] {
    return this.blocks().flatMap((b) => (b.kind === 'gap' ? [] : b.rows));
  }
}
