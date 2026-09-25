import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import type { ScriptDeclaration } from '@core/api/scripting.types';

import { declarationRows } from './declaration-summary.model';

/**
 * The script's declaration statement as compiled: kind and title, and for strategies every
 * `strategy()` property the backtest and the live emulator will use. The capital and the margins
 * say whether the script declares them, as the compiler reports it (see `declarationRows`).
 */
@Component({
  selector: 'app-declaration-summary',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (declaration(); as d) {
      <div class="decl">
        <div class="decl-head">
          <span class="kind">{{ d.kind }}</span>
          <span class="title">{{ d.title }}</span>
          @if (d.shortTitle && d.shortTitle !== d.title) {
            <span class="short">({{ d.shortTitle }})</span>
          }
        </div>
        <dl class="props">
          @for (row of rows(); track row.label) {
            <div class="prop" [class.is-set]="row.set" [attr.title]="row.hint ?? null">
              <dt>{{ row.label }}</dt>
              <dd>{{ row.value }}</dd>
            </div>
          }
        </dl>
        @if (d.strategyAlertMessage) {
          <p class="alert-msg">
            <span class="muted">Default alert message:</span> {{ d.strategyAlertMessage }}
          </p>
        }
      </div>
    } @else {
      <p class="empty">{{ emptyText() }}</p>
    }
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .decl-head {
        display: flex;
        align-items: baseline;
        gap: 8px;
        margin-bottom: 8px;
        flex-wrap: wrap;
      }
      .kind {
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        padding: 2px 7px;
        border-radius: 4px;
        background: rgba(0, 113, 227, 0.12);
        color: var(--accent);
      }
      .title {
        font-size: 14px;
        font-weight: 600;
        color: var(--text-primary);
      }
      .short {
        font-size: 12px;
        color: var(--text-secondary);
      }
      .props {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
        gap: 4px 16px;
        margin: 0;
      }
      .prop {
        display: flex;
        justify-content: space-between;
        gap: 8px;
        padding: 3px 0;
        border-bottom: 1px dashed var(--border);
        font-size: 12px;
      }
      dt {
        color: var(--text-secondary);
      }
      dd {
        margin: 0;
        color: var(--text-primary);
        font-variant-numeric: tabular-nums;
        text-align: right;
      }
      .prop.is-set dd {
        font-weight: 600;
      }
      .alert-msg {
        margin: 8px 0 0;
        font-size: 12px;
      }
      .muted {
        color: var(--text-secondary);
      }
      .empty {
        margin: 0;
        font-size: 12px;
        color: var(--text-tertiary);
      }
    `,
  ],
})
export class DeclarationSummaryComponent {
  readonly declaration = input<ScriptDeclaration | null>(null);
  readonly emptyText = input('Compile the script to read its declaration.');

  readonly rows = computed(() => declarationRows(this.declaration()));
}
