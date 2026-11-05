import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { catchError, map, of } from 'rxjs';

import { EAAdminService } from '@core/services/ea-admin.service';
import type { EADiag, EAHealthDto, EAHealthProblem } from '@core/api/ea-selfheal.types';
import { createPolledResource } from '@core/polling/polled-resource';

import { EaActionDialogComponent } from './ea-action-dialog.component';
import { EaPruneFilesDialogComponent } from './ea-prune-files-dialog.component';
import { EaOpsService, type OpsAction } from './ea-ops.service';
import {
  PRUNE_FILES_ACTION,
  actionCopy,
  agoText,
  formatDuration,
  healOutcomeText,
  healOutcomeTone,
  healStepLabel,
  severityTone,
  sortProblems,
  stateTone,
  stateWords,
  verdictHeadline,
  verdictTone,
  type ActionCopy,
} from './selfheal.logic';
import { SELFHEAL_PANEL_STYLES } from './selfheal-styles';

type HealthAnswer = { ok: true; dto: EAHealthDto } | { ok: false; message: string };

/**
 * The detail page's top card: the engine's verdict (Healthy / Degraded / Down
 * / Stopped), every problem in plain language with its one-click fix, how long
 * the EA has been in its state and why, and what auto-heal last did.
 */
@Component({
  selector: 'app-ea-health-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [EaActionDialogComponent, EaPruneFilesDialogComponent],
  template: `
    <section class="panel health" [attr.data-tone]="tone()" aria-label="EA health">
      @if (answer(); as a) {
        @if (a.ok) {
          <header class="head">
            <span class="verdict" [attr.data-tone]="tone()">{{ a.dto.verdict }}</span>
            <h3>{{ headline() }}</h3>
            <span class="meta">checked {{ checkedAgo() }}</span>
          </header>

          <dl class="facts">
            <div>
              <dt>Last heard from</dt>
              <dd [class.tone-bad]="heartbeatOld()">
                {{ heartbeatText() }}
              </dd>
            </div>
            <div>
              <dt>State</dt>
              <dd>
                <span class="pill" [attr.data-tone]="stateToneValue()">{{ stateText() }}</span>
                @if (stateFor()) {
                  <span class="muted"> for {{ stateFor() }}</span>
                }
                @if (heartbeatOld()) {
                  <span class="muted"> (last known)</span>
                }
                @if (a.dto.stateReason) {
                  <div class="reason">{{ a.dto.stateReason }}</div>
                }
              </dd>
            </div>
            <div>
              <dt>Auto-heal</dt>
              <dd>
                <span class="pill" [attr.data-tone]="a.dto.autoHeal ? 'ok' : 'muted'">{{
                  a.dto.autoHeal ? 'On' : 'Off'
                }}</span>
                @if (a.dto.lastHealEvent; as ev) {
                  <div class="reason">
                    Last step: {{ healStep(ev) }} ·
                    <span [class]="'tone-' + healTone(ev.outcome)">{{ healOutcome(ev.outcome) }}</span>
                    · {{ ago(ev.atUtc) }}
                  </div>
                }
              </dd>
            </div>
          </dl>

          @if (problems().length > 0) {
            <ul class="problems">
              @for (p of problems(); track p.code) {
                <li [attr.data-tone]="sevTone(p.severity)">
                  <span class="dot" [attr.data-tone]="sevTone(p.severity)"></span>
                  <span class="text">{{ p.text }}</span>
                  @if (p.fix) {
                    <button
                      type="button"
                      class="btn btn-sm"
                      [class.btn-primary]="p.severity === 'error'"
                      [class.btn-secondary]="p.severity !== 'error'"
                      (click)="askFix(p)"
                      [disabled]="busy()"
                    >
                      {{ p.fix.label }}
                    </button>
                  }
                </li>
              }
            </ul>
          }

          @if (transitions().length > 0) {
            <details class="transitions">
              <summary>Recent state changes ({{ transitions().length }})</summary>
              <ol>
                @for (t of transitions(); track $index) {
                  <li>
                    <span class="mono small">{{ ago(t.atUtc) || t.atUtc }}</span>
                    <span>{{ words(t.from) }} → <strong>{{ words(t.to) }}</strong></span>
                    @if (t.reason) {
                      <span class="muted"> — {{ t.reason }}</span>
                    }
                  </li>
                }
              </ol>
            </details>
          }
        } @else {
          <header class="head">
            <span class="verdict" data-tone="muted">Unknown</span>
            <h3>Health check unavailable</h3>
          </header>
          <p class="empty">{{ a.message }}</p>
        }
      } @else {
        <header class="head">
          <span class="verdict" data-tone="muted">…</span>
          <h3>Checking health…</h3>
        </header>
      }
    </section>

    <app-ea-action-dialog
      [open]="!!pending()"
      [title]="pendingCopy()?.title ?? ''"
      [description]="pendingCopy()?.description ?? ''"
      [warning]="pendingCopy()?.warning ?? null"
      [confirmLabel]="pendingCopy()?.confirmLabel ?? 'Confirm'"
      [tone]="pendingCopy()?.tone ?? 'warn'"
      [askReason]="pendingCopy()?.askReason ?? false"
      [reasonRequired]="pendingCopy()?.reasonRequired ?? false"
      [busy]="busy()"
      (confirmed)="confirmFix($event)"
      (cancelled)="pending.set(null)"
    />

    <app-ea-prune-files-dialog
      [instanceId]="instanceId()"
      [open]="pruneOpen()"
      (closed)="pruneOpen.set(false); resource.refresh()"
    />
  `,
  styles: [
    SELFHEAL_PANEL_STYLES,
    `
      .health {
        border-left: 4px solid var(--border);
      }
      .health[data-tone='ok'] {
        border-left-color: var(--tone-green);
      }
      .health[data-tone='warn'] {
        border-left-color: var(--tone-amber);
      }
      .health[data-tone='bad'] {
        border-left-color: var(--tone-red);
      }
      .head {
        display: flex;
        align-items: center;
        gap: var(--space-3);
        flex-wrap: wrap;
      }
      .head h3 {
        margin: 0;
        font-size: var(--text-base, 15px);
        font-weight: var(--font-semibold);
        flex: 1;
      }
      .verdict {
        font-size: var(--text-sm);
        font-weight: var(--font-bold, 700);
        padding: 4px 12px;
        border-radius: var(--radius-full);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        background: rgba(120, 120, 128, 0.16);
        color: var(--text-secondary);
      }
      .verdict[data-tone='ok'] {
        background: rgba(52, 199, 89, 0.16);
        color: var(--tone-green);
      }
      .verdict[data-tone='warn'] {
        background: rgba(255, 149, 0, 0.16);
        color: var(--tone-amber);
      }
      .verdict[data-tone='bad'] {
        background: rgba(255, 59, 48, 0.16);
        color: var(--tone-red);
      }
      .facts {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(min(220px, 100%), 1fr));
        gap: var(--space-3);
        margin: 0;
      }
      .facts dt {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        margin-bottom: 4px;
      }
      .facts dd {
        margin: 0;
        font-size: var(--text-sm);
      }
      .reason {
        margin-top: 4px;
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .problems {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .problems li {
        display: flex;
        align-items: center;
        gap: var(--space-3);
        padding: 8px 10px;
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        border: 1px solid var(--border);
        font-size: var(--text-sm);
      }
      .problems li[data-tone='bad'] {
        border-color: rgba(255, 59, 48, 0.35);
      }
      .problems li[data-tone='warn'] {
        border-color: rgba(255, 149, 0, 0.35);
      }
      .problems .text {
        flex: 1;
      }
      .transitions summary {
        cursor: pointer;
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .transitions ol {
        margin: 6px 0 0;
        padding-left: 18px;
        display: flex;
        flex-direction: column;
        gap: 4px;
        font-size: var(--text-sm);
      }
      .transitions li span + span {
        margin-left: 8px;
      }
    `,
  ],
})
export class EaHealthCardComponent {
  readonly instanceId = input<string>('');
  /** C1 diag from the latest heartbeat (recent transitions). */
  readonly diag = input<EADiag | null>(null);
  /** Bumped by the page's Refresh button. */
  readonly refreshTick = input(0);

  private readonly admin = inject(EAAdminService);
  private readonly ops = inject(EaOpsService);

  /** Wall clock, ticking each second so "N s ago" stays true between polls. */
  protected readonly now = signal(Date.now());

  protected readonly resource = createPolledResource<HealthAnswer | null>(
    () => {
      const id = this.instanceId();
      if (!id) return of(null);
      return this.admin.getHealth(id).pipe(
        map((r): HealthAnswer =>
          r.status && r.data
            ? { ok: true, dto: r.data }
            : { ok: false, message: r.message ?? 'The engine could not judge this instance.' },
        ),
        catchError((err: { status?: number }) =>
          of<HealthAnswer>({
            ok: false,
            message:
              err?.status === 404
                ? 'This engine version has no health check yet.'
                : 'The engine did not answer the health check.',
          }),
        ),
      );
    },
    { intervalMs: 15_000 },
  );

  protected readonly answer = this.resource.value;
  private readonly dto = computed(() => {
    const a = this.answer();
    return a && a.ok ? a.dto : null;
  });

  protected readonly tone = computed(() => verdictTone(this.dto()?.verdict));
  protected readonly problems = computed(() => sortProblems(this.dto()?.problems ?? []));
  protected readonly headline = computed(() =>
    verdictHeadline(this.dto()?.verdict, this.problems().filter((p) => p.severity !== 'info').length),
  );
  protected readonly checkedAgo = computed(() => {
    const at = this.resource.lastUpdated();
    if (!at) return '—';
    const s = (this.now() - at) / 1000;
    return s < 5 ? 'just now' : `${formatDuration(s)} ago`;
  });

  /** heartbeatAgeSeconds is as of the check; age it with the clock. */
  private readonly heartbeatAge = computed(() => {
    const d = this.dto();
    const at = this.resource.lastUpdated();
    if (!d || at == null) return null;
    return d.heartbeatAgeSeconds + (this.now() - at) / 1000;
  });
  protected readonly heartbeatOld = computed(() => (this.heartbeatAge() ?? 0) > 120);
  protected readonly heartbeatText = computed(() => {
    const age = this.heartbeatAge();
    if (age == null) return '—';
    return age < 5 ? 'just now' : `${formatDuration(age)} ago`;
  });

  protected readonly stateText = computed(() => stateWords(this.dto()?.state));
  protected readonly stateToneValue = computed(() =>
    this.heartbeatOld() ? 'muted' : stateTone(this.dto()?.state),
  );
  protected readonly stateFor = computed(() => {
    const since = this.dto()?.stateSinceUtc;
    const t = agoText(since, this.now());
    return t && t !== 'just now' ? t.replace(/ ago$/, '') : '';
  });
  protected readonly transitions = computed(() => (this.diag()?.recentTransitions ?? []).slice(0, 5));

  // Fix flow ---------------------------------------------------------------
  protected readonly pending = signal<EAHealthProblem | null>(null);
  protected readonly busy = signal(false);
  /** The clean-up fix runs its own dry-run → review → confirm dialog. */
  protected readonly pruneOpen = signal(false);
  protected readonly pendingCopy = computed<ActionCopy | null>(() => {
    const p = this.pending();
    if (!p?.fix) return null;
    const copy = actionCopy(p.fix.action);
    return p.fix.action === 'deploy' ? { ...copy, title: p.fix.label, confirmLabel: p.fix.label } : copy;
  });

  constructor() {
    const destroyRef = inject(DestroyRef);
    const tick = setInterval(() => this.now.set(Date.now()), 1000);
    destroyRef.onDestroy(() => clearInterval(tick));
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
    let firstTick = true;
    effect(() => {
      this.refreshTick();
      if (firstTick) {
        firstTick = false;
        return;
      }
      untracked(() => this.resource.refresh());
    });
  }

  protected askFix(p: EAHealthProblem): void {
    if (p.fix?.action === PRUNE_FILES_ACTION) {
      this.pruneOpen.set(true);
      return;
    }
    this.pending.set(p);
  }

  protected confirmFix(reason: string): void {
    const p = this.pending();
    if (!p?.fix) return;
    this.busy.set(true);
    this.ops
      .run(this.instanceId(), p.fix.action as OpsAction, {
        reason: reason || `Health card fix: ${p.code}`,
        label: p.fix.label,
      })
      .subscribe((ok) => {
        this.busy.set(false);
        if (ok) this.pending.set(null);
        this.resource.refresh();
      });
  }

  protected sevTone(s: string) {
    return severityTone(s);
  }
  protected ago(iso: string | null | undefined): string {
    return agoText(iso, this.now());
  }
  protected words(state: string): string {
    return stateWords(state);
  }
  protected healStep = healStepLabel;
  protected healOutcome = healOutcomeText;
  protected healTone = healOutcomeTone;
}
