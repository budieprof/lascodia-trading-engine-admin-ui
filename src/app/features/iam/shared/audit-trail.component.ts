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
import { RouterLink } from '@angular/router';
import { catchError, forkJoin, map, of } from 'rxjs';

import { ApiService } from '@core/api/api.service';
import { AuthService } from '@core/auth/auth.service';
import { Permission } from '@core/auth/permissions.generated';

import { errorText, when } from '../iam.logic';
import {
  ago,
  auditActionLabel,
  auditActorLabel,
  mergeTrail,
  type TrailEvent,
} from './admin-context.logic';

/**
 * "Recent activity" for one subject — the newest audit events whose action starts with any of `actions`
 * (`GET /admin/audit-events?action=…`, `audit.read`). Shows the engine's own record, never a guess: no events
 * yet is said in plain words with what writes them (`empty`). People without `audit.read` see one line.
 */
@Component({
  selector: 'app-audit-trail',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  styleUrl: './iam-page.scss',
  template: `
    <section class="card">
      <header class="card-head">
        <h3>{{ heading() }}</h3>
        <span class="spacer"></span>
        @if (canRead()) {
          <a class="small" routerLink="/admin/audit" [queryParams]="{ action: actions()[0] }"
            >Open in the audit log</a
          >
        }
      </header>
      @if (!canRead()) {
        <p class="pad small muted">
          The audit log needs the audit permission (<code>audit.read</code>); ask an administrator
          to see who changed what here.
        </p>
      } @else if (error(); as err) {
        <p class="pad small" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
      } @else if (loaded() && rows().length === 0) {
        <p class="pad small muted">{{ empty() }}</p>
      } @else if (rows().length > 0) {
        <ul class="trail">
          @for (e of rows(); track e.id) {
            <li>
              <span class="t-when" [title]="when(e.occurredAtUtc)">{{ ago(e.occurredAtUtc) }}</span>
              <span class="t-what">
                {{ label(e.action) }}
                @if (e.outcome !== 'Succeeded') {
                  <span
                    class="chip"
                    [class.bad]="e.outcome === 'Failed'"
                    [class.warn]="e.outcome === 'Denied'"
                    >{{ e.outcome === 'Denied' ? 'refused' : 'failed' }}</span
                  >
                }
                <span class="sub"
                  >{{ actorLabel(e) }}{{ e.resourceType ? ' · ' + e.resourceType : ''
                  }}{{ e.resourceId ? ' ' + e.resourceId : ''
                  }}{{ e.reason ? ' · ' + e.reason : '' }}</span
                >
              </span>
            </li>
          }
        </ul>
      } @else {
        <p class="pad small muted">Loading…</p>
      }
    </section>
  `,
  styles: [
    `
      .trail {
        list-style: none;
        margin: 0;
        padding: 0;
      }
      .trail li {
        display: grid;
        grid-template-columns: 7.5rem 1fr;
        gap: var(--space-3);
        padding: 7px var(--space-4);
        border-bottom: 1px solid var(--border);
        font-size: var(--text-sm);
      }
      .trail li:last-child {
        border-bottom: none;
      }
      .t-when {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        white-space: nowrap;
      }
      .t-what {
        min-width: 0;
        overflow-wrap: anywhere;
      }
      .sub {
        display: block;
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
    `,
  ],
})
export class AuditTrailComponent {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);

  readonly heading = input('Recent activity');
  /** Action key prefixes (`platform.elevation.`, `iam.team`); the first one is the audit-log link's filter. */
  readonly actions = input.required<string[]>();
  /** What the empty list means and what writes these events. */
  readonly empty = input('Nothing recorded yet.');
  readonly limit = input(8);
  /** Only this actor's events (`admin-user:5`), e.g. "your own sign-ins". */
  readonly actor = input<string | null>(null);

  protected readonly when = when;
  protected readonly ago = (utc: string) => ago(utc);
  protected readonly label = auditActionLabel;
  protected readonly actorLabel = auditActorLabel;

  readonly canRead = computed(() => this.auth.hasPermission(Permission.AuditRead));
  readonly rows = signal<TrailEvent[]>([]);
  readonly loaded = signal(false);
  readonly error = signal<string | null>(null);

  constructor() {
    effect(() => {
      const prefixes = this.actions();
      const limit = this.limit();
      this.actor();
      const allowed = this.canRead();
      untracked(() => {
        if (allowed) this.load(prefixes, limit);
      });
    });
  }

  reload(): void {
    if (this.canRead()) this.load(this.actions(), this.limit());
  }

  private load(prefixes: readonly string[], limit: number): void {
    if (prefixes.length === 0) {
      this.rows.set([]);
      this.loaded.set(true);
      return;
    }
    const actor = this.actor();
    const who = actor ? `&actor=${encodeURIComponent(actor)}` : '';
    forkJoin(
      prefixes.map((p) =>
        this.api
          .getEnvelope<{
            items: TrailEvent[];
          }>(`/admin/audit-events?action=${encodeURIComponent(p)}&limit=${limit}${who}`, {
            silent: true,
          })
          .pipe(map((page) => page?.items ?? [])),
      ),
    )
      .pipe(
        map((pages) => ({ ok: mergeTrail(pages, limit) as TrailEvent[] | null, err: null })),
        catchError((e) =>
          of({ ok: null, err: errorText(e, 'Could not read the audit log.') as string | null }),
        ),
      )
      .subscribe(({ ok, err }) => {
        if (ok) this.rows.set(ok);
        this.error.set(err);
        this.loaded.set(true);
      });
  }
}
