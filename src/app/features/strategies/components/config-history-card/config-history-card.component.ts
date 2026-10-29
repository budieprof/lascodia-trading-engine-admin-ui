import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { catchError, of } from 'rxjs';

import { ConfigService, type ConfigChangeDto } from '@core/services/config.service';
import { ago, day } from '../../util/figures';

/**
 * Recent changes of the engine settings under one key prefix (`GET config/history`), newest first, with who
 * (account id), when, old → new and the recorded reason. Says plainly when nothing has changed, and degrades
 * to a one-line note on an engine that does not serve the history yet.
 */
@Component({
  selector: 'app-config-history-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    <section class="card">
      <header class="head">
        <h3>{{ title() }}</h3>
        <span class="muted"
          >settings under <code>{{ prefix() }}</code> · newest first</span
        >
        <span class="spacer"></span>
        <a routerLink="/engine-config" [queryParams]="{ search: prefix() }" class="small"
          >Settings →</a
        >
      </header>
      @if (rows() === undefined) {
        <p class="muted">Loading…</p>
      } @else if (rows() === null) {
        <p class="muted">The change history is not available from this engine build yet.</p>
      } @else if (rows()!.length === 0) {
        <p class="muted">{{ emptyText() }}</p>
      } @else {
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Setting</th>
                <th>Change</th>
                <th>By</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              @for (r of rows(); track $index) {
                <tr>
                  <td class="nowrap">
                    {{ day(r.changedAt) }} <span class="muted">{{ ago(r.changedAt) }}</span>
                  </td>
                  <td class="mono">{{ short(r.key) }}</td>
                  <td class="mono">{{ r.oldValue ?? '(unset)' }} → {{ r.newValue }}</td>
                  <td class="muted">
                    {{ r.changedByAccountId > 0 ? '#' + r.changedByAccountId : 'system' }}
                  </td>
                  <td class="reason">{{ r.reason ?? '—' }}</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
    </section>
  `,
  styles: [
    `
      .card {
        padding: var(--space-4) var(--space-5);
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
        margin-top: var(--space-4);
      }
      .head {
        display: flex;
        align-items: baseline;
        gap: var(--space-2);
        flex-wrap: wrap;
      }
      .spacer {
        flex: 1;
      }
      h3 {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .muted {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
        margin: 0;
      }
      code {
        font-size: var(--text-xs);
      }
      .small {
        font-size: var(--text-xs);
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
        padding: 6px 8px;
        border-bottom: 1px solid var(--border);
        text-align: left;
      }
      th {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        font-weight: normal;
      }
      .mono {
        font-family: var(--font-mono);
        font-size: var(--text-xs);
        overflow-wrap: anywhere;
      }
      .nowrap {
        white-space: nowrap;
      }
      .reason {
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      a {
        color: var(--accent);
        text-decoration: none;
      }
    `,
  ],
})
export class ConfigHistoryCardComponent {
  private readonly config = inject(ConfigService);

  readonly prefix = input.required<string>();
  readonly title = input('Recent changes');
  readonly emptyText = input(
    'No change has been recorded for these settings — they still hold their seeded values.',
  );
  readonly limit = input(15);

  /** undefined = loading, null = endpoint unavailable. */
  protected readonly rows = signal<ConfigChangeDto[] | null | undefined>(undefined);
  protected readonly day = day;
  protected readonly ago = ago;

  constructor() {
    effect(() => {
      const prefix = this.prefix();
      const limit = this.limit();
      untracked(() =>
        this.config
          .getHistory(prefix, limit)
          .pipe(catchError(() => of(null)))
          .subscribe((r) => this.rows.set(r?.status ? (r.data ?? []) : null)),
      );
    });
  }

  protected short(key: string): string {
    return key.startsWith(this.prefix()) && key.length > this.prefix().length
      ? key.slice(this.prefix().length)
      : key;
  }
}
