import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import type { EADiag } from '@core/api/ea-selfheal.types';

import { diagRows } from './selfheal.logic';
import { SELFHEAL_PANEL_STYLES } from './selfheal-styles';

/**
 * The EA's own view of what can stop it (heartbeat C1 `diag`): terminal
 * permissions, saved templates, sign-in, recovery, the WebRequest allowlist,
 * undeliverable reports, its folder size — each with what to do about it.
 */
@Component({
  selector: 'app-ea-diagnostics',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="panel" aria-label="Diagnostics">
      <header class="panel-head">
        <h3>Diagnostics</h3>
        @if (stale()) {
          <span class="meta tone-warn">{{ staleLabel() }} — may no longer be true</span>
        } @else {
          <span class="meta">From the EA's latest heartbeat</span>
        }
      </header>
      @if (rows().length === 0) {
        <p class="empty">
          This EA build does not report diagnostics yet (they arrive with EA v8.47.259). Update the
          EA from the Terminal card to get them.
        </p>
      } @else {
        <ul class="rows-list" [class.is-stale]="stale()">
          @for (r of rows(); track r.key) {
            <li>
              <span class="dot" [attr.data-tone]="r.tone"></span>
              <span class="label">{{ r.label }}</span>
              <span class="value" [class]="'value tone-' + r.tone">{{ r.value }}</span>
              @if (r.hint) {
                <span class="hint">{{ r.hint }}</span>
              }
            </li>
          }
        </ul>
      }
    </section>
  `,
  styles: [
    SELFHEAL_PANEL_STYLES,
    `
      .rows-list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(min(320px, 100%), 1fr));
        gap: 6px var(--space-4);
      }
      .rows-list.is-stale {
        opacity: 0.7;
      }
      li {
        display: grid;
        grid-template-columns: 10px minmax(140px, max-content) 1fr;
        gap: 4px 8px;
        align-items: baseline;
        font-size: var(--text-sm);
        padding: 4px 0;
        border-bottom: 1px solid var(--border);
      }
      .label {
        color: var(--text-secondary);
      }
      .value.tone-muted {
        color: var(--text-primary);
      }
      .hint {
        grid-column: 2 / -1;
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
    `,
  ],
})
export class EaDiagnosticsComponent {
  readonly diag = input<EADiag | null>(null);
  readonly stale = input(false);
  readonly staleLabel = input('');
  /** Used for "N min ago" on the web-request error; the page passes its clock. */
  readonly nowMs = input(Date.now());

  protected readonly rows = computed(() => diagRows(this.diag(), this.nowMs()));
}
