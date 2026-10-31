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
import type { EAHealEventDto } from '@core/api/ea-selfheal.types';
import { createPolledResource } from '@core/polling/polled-resource';

import { EaOpsService } from './ea-ops.service';
import { healOutcomeText, healOutcomeTone, healStepLabel, parseUtcMs } from './selfheal.logic';
import { SELFHEAL_PANEL_STYLES } from './selfheal-styles';

type Answer = { ok: true; rows: EAHealEventDto[] } | { ok: false; message: string };

const PAGE_SIZE = 50;

/** What the engine's auto-heal ladder did for this instance, newest first. */
@Component({
  selector: 'app-ea-heal-timeline',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe],
  template: `
    <section class="panel" aria-label="Auto-heal timeline">
      <header class="panel-head">
        <h3>Auto-heal timeline</h3>
        <span class="meta">
          Step 1 force recovery → 2 restart the EA → 3 restart the terminal → 4 start it · at most 3
          terminal restarts an hour
        </span>
      </header>
      @if (resource.value(); as a) {
        @if (!a.ok) {
          <p class="error-line">{{ a.message }}</p>
        } @else if (a.rows.length === 0) {
          <p class="empty">
            {{
              page() === 1
                ? 'Auto-heal has not had to do anything for this instance.'
                : 'No older steps.'
            }}
          </p>
        } @else {
          <ol class="timeline">
            @for (e of a.rows; track e.id) {
              <li [attr.data-tone]="tone(e.outcome)">
                <span class="dot" [attr.data-tone]="tone(e.outcome)"></span>
                <div class="body">
                  <div class="line">
                    <strong>{{ step(e) }}</strong>
                    <span class="pill" [attr.data-tone]="tone(e.outcome)">{{ outcome(e.outcome) }}</span>
                    <span class="muted small mono" [title]="e.atUtc">{{
                      asDate(e.atUtc) | date: 'MMM d HH:mm:ss'
                    }}</span>
                  </div>
                  <div class="reason">{{ e.reason }}</div>
                  @if (e.commandId || e.jobId) {
                    <div class="muted small mono">
                      @if (e.commandId) {
                        command #{{ e.commandId }}
                      }
                      @if (e.jobId) {
                        host job {{ e.jobId.slice(0, 8) }}
                      }
                    </div>
                  }
                </div>
              </li>
            }
          </ol>
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
      .timeline {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 2px;
        max-height: 420px;
        overflow-y: auto;
      }
      .timeline li {
        display: flex;
        gap: var(--space-3);
        padding: 6px 4px;
        border-bottom: 1px solid var(--border);
      }
      .timeline li:last-child {
        border-bottom: none;
      }
      .timeline .dot {
        margin-top: 6px;
      }
      .body {
        flex: 1;
        min-width: 0;
      }
      .line {
        display: flex;
        gap: var(--space-2);
        flex-wrap: wrap;
        align-items: center;
        font-size: var(--text-sm);
      }
      .reason {
        font-size: var(--text-sm);
        color: var(--text-secondary);
        overflow-wrap: anywhere;
      }
    `,
  ],
})
export class EaHealTimelineComponent {
  readonly instanceId = input.required<string>();
  readonly refreshTick = input(0);

  private readonly admin = inject(EAAdminService);
  private readonly ops = inject(EaOpsService);
  protected readonly page = signal(1);

  protected readonly resource = createPolledResource<Answer | null>(
    () => {
      const id = this.instanceId();
      const page = this.page();
      if (!id) return of(null);
      return this.admin.listHealEvents(id, page, PAGE_SIZE).pipe(
        map((r): Answer =>
          r.status
            ? { ok: true, rows: r.data ?? [] }
            : { ok: false, message: r.message ?? 'Could not load the auto-heal timeline.' },
        ),
        catchError((err: { status?: number }) =>
          of<Answer>({
            ok: false,
            message:
              err?.status === 404
                ? 'This engine version has no auto-heal yet.'
                : 'The engine did not answer.',
          }),
        ),
      );
    },
    { intervalMs: 30_000 },
  );

  protected readonly hasMore = computed(() => {
    const a = this.resource.value();
    return !!a && a.ok && a.rows.length === PAGE_SIZE;
  });

  constructor() {
    this.ops.settled$.pipe(takeUntilDestroyed()).subscribe(() => this.resource.refresh());
    let first = true;
    effect(() => {
      this.page();
      this.refreshTick();
      if (first) {
        first = false;
        return;
      }
      untracked(() => this.resource.refresh());
    });
  }

  protected asDate(iso: string): number | null {
    return parseUtcMs(iso);
  }
  protected step = healStepLabel;
  protected outcome = healOutcomeText;
  protected tone = healOutcomeTone;
}
