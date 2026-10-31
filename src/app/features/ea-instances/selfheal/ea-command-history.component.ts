import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { catchError, map, of } from 'rxjs';

import { EAAdminService } from '@core/services/ea-admin.service';
import type { EACommandHistoryItem } from '@core/api/ea-selfheal.types';
import { createPolledResource } from '@core/polling/polled-resource';

import { EaOpsService } from './ea-ops.service';
import {
  ackReason,
  commandStatusTone,
  commandWords,
  parseUtcMs,
  requesterWords,
} from './selfheal.logic';
import { SELFHEAL_PANEL_STYLES } from './selfheal-styles';

type Page = { ok: true; rows: EACommandHistoryItem[] } | { ok: false; message: string };

const PAGE_SIZE = 25;

/** Every command sent to this instance — by an operator, auto-heal or a host job — with its real outcome. */
@Component({
  selector: 'app-ea-command-history',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe],
  template: `
    <section class="panel" aria-label="Command history">
      <header class="panel-head">
        <h3>Command history</h3>
        <span class="meta">Newest first · page {{ page() }}</span>
      </header>

      @if (resource.value(); as p) {
        @if (!p.ok) {
          <p class="error-line">{{ p.message }}</p>
        } @else if (p.rows.length === 0) {
          <p class="empty">
            {{ page() === 1 ? 'No commands have been sent to this instance.' : 'No older commands.' }}
          </p>
        } @else {
          <div class="table-scroll">
            <table class="rows">
              <thead>
                <tr>
                  <th>Sent</th>
                  <th>Command</th>
                  <th>Status</th>
                  <th>Outcome</th>
                  <th>By</th>
                </tr>
              </thead>
              <tbody>
                @for (c of p.rows; track c.commandId) {
                  <tr>
                    <td class="mono small" [title]="c.createdAt">
                      {{ asDate(c.createdAt) | date: 'MMM d HH:mm:ss' }}
                    </td>
                    <td>
                      {{ words(c.type) }}
                      <span class="muted small mono">#{{ c.commandId }}</span>
                      @if (c.parameters && c.parameters !== '{}') {
                        <details class="params">
                          <summary class="small muted">parameters</summary>
                          <code class="small">{{ c.parameters }}</code>
                        </details>
                      }
                    </td>
                    <td>
                      <span class="pill" [attr.data-tone]="tone(c.status)">{{ c.status }}</span>
                      @if (c.retries > 0) {
                        <div class="muted small">{{ c.retries }} retr{{ c.retries === 1 ? 'y' : 'ies' }}</div>
                      }
                    </td>
                    <td class="outcome">
                      @if (c.ackResult) {
                        {{ reason(c.ackResult) || c.ackResult }}
                        @if (c.ackAt) {
                          <div class="muted small">
                            answered {{ asDate(c.ackAt) | date: 'HH:mm:ss' }}
                          </div>
                        }
                      } @else {
                        <span class="muted">{{
                          c.status === 'Delivered'
                            ? 'Waiting for the EA to answer'
                            : c.status === 'Pending'
                              ? 'Not picked up yet'
                              : '—'
                        }}</span>
                      }
                    </td>
                    <td class="small">{{ by(c.requestedBy) }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      } @else {
        <p class="empty">Loading…</p>
      }

      <div class="pager">
        <button
          type="button"
          class="btn btn-secondary btn-sm"
          [disabled]="page() === 1"
          (click)="page.set(page() - 1)"
        >
          ← Newer
        </button>
        <button
          type="button"
          class="btn btn-secondary btn-sm"
          [disabled]="!hasMore()"
          (click)="page.set(page() + 1)"
        >
          Older →
        </button>
      </div>
    </section>
  `,
  styles: [
    SELFHEAL_PANEL_STYLES,
    `
      .outcome {
        max-width: 420px;
        overflow-wrap: anywhere;
      }
      .params code {
        display: block;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        max-width: 360px;
      }
    `,
  ],
})
export class EaCommandHistoryComponent {
  readonly instanceId = input<string>('');
  readonly refreshTick = input(0);

  private readonly admin = inject(EAAdminService);
  private readonly ops = inject(EaOpsService);
  protected readonly page = signal(1);

  protected readonly resource = createPolledResource<Page | null>(
    () => {
      const id = this.instanceId();
      const page = this.page();
      if (!id) return of(null);
      return this.admin.listCommands(id, page, PAGE_SIZE).pipe(
        map((r): Page =>
          r.status ? { ok: true, rows: r.data ?? [] } : { ok: false, message: r.message ?? 'Could not load commands.' },
        ),
        catchError(() => of<Page>({ ok: false, message: 'The engine did not answer.' })),
      );
    },
    { intervalMs: 15_000 },
  );

  protected readonly hasMore = computed(() => {
    const p = this.resource.value();
    return !!p && p.ok && p.rows.length === PAGE_SIZE;
  });

  constructor() {
    this.ops.settled$.pipe(takeUntilDestroyed()).subscribe(() => this.resource.refresh());
    // instanceId arrives after construction (the first poll ran with ''), so fetch as soon as it is known.
    let lastId = '';
    effect(() => {
      const id = this.instanceId();
      if (id && id !== lastId) {
        lastId = id;
        untracked(() => this.resource.refresh());
      }
    });
    let first = true;
    effect(() => {
      this.page();
      this.refreshTick();
      this.ops.sentRevision();
      if (first) {
        first = false;
        return;
      }
      untracked(() => this.resource.refresh());
    });
  }

  protected asDate(iso: string | null): number | null {
    return parseUtcMs(iso);
  }
  protected words = commandWords;
  protected tone = commandStatusTone;
  protected reason = ackReason;
  protected by = requesterWords;
}
