import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { Observable, Subject, catchError, map, of, type Subscription } from 'rxjs';

import { EAAdminService } from '@core/services/ea-admin.service';
import { NotificationService } from '@core/notifications/notification.service';
import type { AdminCommandQueueResult, ResponseData } from '@core/api/api.types';
import type {
  EACommandHistoryItem,
  EATerminalJobResult,
  TerminalJobDto,
} from '@core/api/ea-selfheal.types';

import { pollUntilFinal } from './poll-until-final';
import {
  commandStatusText,
  commandStatusTone,
  commandWords,
  isFinalCommandStatus,
  isFinalJobStatus,
  jobStatusText,
  jobStatusTone,
  parseUtcMs,
  type Tone,
} from './selfheal.logic';

/** One action the operator started from this page, followed until the EA / host answers. */
export interface TrackedAction {
  key: string;
  kind: 'command' | 'job' | 'instant';
  id: string;
  label: string;
  status: string;
  text: string;
  tone: Tone;
  startedAt: number;
  finishedAt: number | null;
  final: boolean;
  /** Polling stopped without a final answer (timeout / engine unreachable). */
  gaveUp: boolean;
  /** For a deploy's follow-up restarts: the job that queued them. */
  parentKey?: string;
}

/** Everything the page's buttons and fix links can ask for. */
export type OpsAction =
  | 'force-recovery'
  | 'terminal/start'
  | 'terminal/stop'
  | 'terminal/restart'
  | 'clear-safety-stop'
  | 'release-kill-switch'
  | 'autoheal'
  | 'autoheal-off'
  | 'deploy';

export interface OpsRunOptions {
  reason?: string | null;
  releaseId?: number | null;
  restartAfter?: boolean;
  /** Label shown in the results tray; defaults to the action's own words. */
  label?: string;
}

const ACTION_LABELS: Record<OpsAction, string> = {
  'force-recovery': 'Force recovery',
  'terminal/start': 'Start terminal',
  'terminal/stop': 'Stop terminal',
  'terminal/restart': 'Restart terminal',
  'clear-safety-stop': 'Clear safety stop',
  'release-kill-switch': 'Release kill switch',
  autoheal: 'Turn auto-heal on',
  'autoheal-off': 'Turn auto-heal off',
  deploy: 'Update EA',
};

const MAX_TRACKED = 12;

/**
 * Follows every command / host job started from the EA detail page until it
 * has a real outcome — "Succeeded", "Failed: <the EA's reason>" or "Expired" —
 * instead of the old "Queued command #N" toast. Provided by the detail page,
 * so its panels share one results tray and one `settled$` stream the page
 * uses to refresh what the action changed.
 */
@Injectable()
export class EaOpsService {
  private readonly admin = inject(EAAdminService);
  private readonly notify = inject(NotificationService);

  private readonly polls = new Map<string, Subscription>();
  private readonly _tracked = signal<TrackedAction[]>([]);
  /** Newest first. */
  readonly tracked = this._tracked.asReadonly();
  /** Fires when an action reaches its outcome (or polling gives up). */
  readonly settled$ = new Subject<TrackedAction>();
  /** Bumped whenever something was sent, so the command history refetches. */
  readonly sentRevision = signal(0);

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      for (const s of this.polls.values()) s.unsubscribe();
      this.polls.clear();
      this.settled$.complete();
    });
  }

  // ── Tracking ────────────────────────────────────────────────────────────

  trackCommand(instanceId: string, commandId: number, label?: string, parentKey?: string): void {
    const key = `cmd:${commandId}`;
    if (this.polls.has(key)) return;
    this.upsert({
      key,
      kind: 'command',
      id: String(commandId),
      label: label ?? `Command #${commandId}`,
      status: 'Pending',
      text: 'Sent — waiting for the EA to pick it up.',
      tone: 'pending',
      startedAt: Date.now(),
      finishedAt: null,
      final: false,
      gaveUp: false,
      parentKey,
    });
    this.sentRevision.update((n) => n + 1);
    const sub = pollUntilFinal<EACommandHistoryItem>(
      () =>
        this.admin.getCommand(instanceId, commandId).pipe(
          map((r) => (r.status ? r.data : null)),
          catchError(() => of(null)),
        ),
      (c) => isFinalCommandStatus(c.status),
    ).subscribe((tick) => {
      const c = tick.value;
      const patch: Partial<TrackedAction> = c
        ? {
            status: String(c.status),
            text: commandStatusText(c),
            tone: commandStatusTone(c.status),
            label: label ?? `${commandWords(c.type)} #${commandId}`,
          }
        : {};
      if (tick.gaveUp) {
        patch.gaveUp = true;
        patch.tone = 'warn';
        patch.text = c
          ? `${commandStatusText(c)} Stopped watching after 15 minutes — see Command history.`
          : 'Could not read the command status from the engine. See Command history.';
      }
      if (tick.final || tick.gaveUp) {
        patch.final = tick.final;
        patch.finishedAt = Date.now();
      }
      const next = this.patch(key, patch);
      if (tick.final || tick.gaveUp) {
        this.polls.delete(key);
        if (next) this.settled$.next(next);
      }
    });
    if (!sub.closed) this.polls.set(key, sub);
  }

  trackJob(instanceId: string, jobId: string, label?: string): void {
    const key = `job:${jobId}`;
    if (this.polls.has(key)) return;
    this.upsert({
      key,
      kind: 'job',
      id: jobId,
      label: label ?? 'Host job',
      status: 'Pending',
      text: 'Sent — waiting for the host to pick it up.',
      tone: 'pending',
      startedAt: Date.now(),
      finishedAt: null,
      final: false,
      gaveUp: false,
    });
    this.sentRevision.update((n) => n + 1);
    const sub = this.watchJob(jobId).subscribe((tick) => {
      const j = tick.value;
      const patch: Partial<TrackedAction> = j
        ? { status: String(j.status), text: jobStatusText(j), tone: jobStatusTone(j.status) }
        : {};
      if (tick.gaveUp) {
        patch.gaveUp = true;
        patch.tone = 'warn';
        patch.text = j
          ? `${jobStatusText(j)} Stopped watching after 15 minutes.`
          : 'Could not read the job status from the engine.';
      }
      if (tick.final || tick.gaveUp) {
        patch.final = tick.final;
        patch.finishedAt = Date.now();
      }
      const next = this.patch(key, patch);
      if (tick.final && j?.status === 'Succeeded') {
        // A deploy with restartAfter queues RestartInstance for every EA on that terminal.
        for (const id of j.followUpCommandIds ?? []) {
          this.trackCommand(instanceId, id, `Restart EA on the new build #${id}`, key);
        }
      }
      if (tick.final || tick.gaveUp) {
        this.polls.delete(key);
        if (next) this.settled$.next(next);
      }
    });
    if (!sub.closed) this.polls.set(key, sub);
  }

  /** Raw job watcher (the host-log viewer reads the result itself). */
  watchJob(jobId: string) {
    return pollUntilFinal<TerminalJobDto>(
      () =>
        this.admin.getTerminalJob(jobId).pipe(
          map((r) => (r.status ? r.data : null)),
          catchError(() => of(null)),
        ),
      (j) => isFinalJobStatus(j.status),
    );
  }

  /**
   * For writes whose answer carries no command id (the config push answers a
   * sentence): find the command it queued in the history and follow it.
   */
  trackLatestCommand(instanceId: string, type: string, label: string): void {
    const sentAt = Date.now();
    const known = new Set(
      this._tracked()
        .filter((t) => t.kind === 'command')
        .map((t) => t.id),
    );
    let tries = 0;
    const look = () => {
      tries++;
      this.admin
        .listCommands(instanceId, 1, 10)
        .pipe(catchError(() => of(null)))
        .subscribe((res) => {
          const rows = res?.data ?? [];
          const hit = rows.find((c) => {
            if (c.type !== type || known.has(String(c.commandId))) return false;
            const created = parseUtcMs(c.createdAt);
            // Allow for the browser and the engine clocks disagreeing a little.
            return created == null || created >= sentAt - 120_000;
          });
          if (hit) this.trackCommand(instanceId, hit.commandId, label);
          else if (tries < 4) setTimeout(look, 1500);
        });
    };
    look();
  }

  dismiss(key: string): void {
    this.polls.get(key)?.unsubscribe();
    this.polls.delete(key);
    this._tracked.update((list) => list.filter((t) => t.key !== key));
  }

  clearFinished(): void {
    this._tracked.update((list) => list.filter((t) => !t.final && !t.gaveUp));
  }

  // ── Actions ─────────────────────────────────────────────────────────────

  /**
   * Sends one action and follows its outcome. Emits `true` once the engine
   * accepted it (the outcome then arrives in the tray), `false` when the
   * engine refused it — its sentence is shown as the error, verbatim.
   */
  run(instanceId: string, action: OpsAction, opts: OpsRunOptions = {}): Observable<boolean> {
    const label = opts.label ?? ACTION_LABELS[action];
    const reason = opts.reason?.trim() || null;

    const queued = (call: Observable<ResponseData<AdminCommandQueueResult>>) =>
      call.pipe(
        map((res) => {
          if (!res.status || !res.data) {
            this.notify.error(res.message ?? `${label} was refused.`);
            return false;
          }
          this.trackCommand(instanceId, res.data.commandId, label);
          return true;
        }),
        catchError((err) => this.failed(label, err)),
      );

    const job = (call: Observable<ResponseData<EATerminalJobResult>>) =>
      call.pipe(
        map((res) => {
          if (!res.status || !res.data) {
            this.notify.error(res.message ?? `${label} was refused.`);
            return false;
          }
          this.trackJob(instanceId, res.data.jobId, label);
          return true;
        }),
        catchError((err) => this.failed(label, err)),
      );

    switch (action) {
      case 'force-recovery':
        return queued(this.admin.forceRecovery(instanceId, { reason }));
      case 'clear-safety-stop':
        return queued(this.admin.clearSafetyStop(instanceId, { reason }));
      case 'release-kill-switch':
        return queued(this.admin.releaseKillSwitch(instanceId, { reason }));
      case 'terminal/start':
        return job(this.admin.terminalAction(instanceId, 'start', reason));
      case 'terminal/stop':
        return job(this.admin.terminalAction(instanceId, 'stop', reason));
      case 'terminal/restart':
        return job(this.admin.terminalAction(instanceId, 'restart', reason));
      case 'deploy':
        return job(
          this.admin.deployEa(instanceId, {
            releaseId: opts.releaseId ?? null,
            restartAfter: opts.restartAfter ?? true,
          }),
        );
      case 'autoheal':
      case 'autoheal-off': {
        const enabled = action === 'autoheal';
        return this.admin.setAutoHeal(instanceId, enabled).pipe(
          map((res) => {
            if (!res.status || !res.data) {
              this.notify.error(res.message ?? `${label} was refused.`);
              return false;
            }
            const d = res.data;
            const text = d.enabled
              ? 'Auto-heal is on for this EA and its terminal.'
              : d.instanceAutoHeal
                ? "Auto-heal is off for this EA's terminal."
                : 'Auto-heal is off: the engine will not recover or restart this EA by itself.';
            const done: TrackedAction = {
              key: `instant:${Date.now()}`,
              kind: 'instant',
              id: '',
              label,
              status: 'Succeeded',
              text,
              tone: 'ok',
              startedAt: Date.now(),
              finishedAt: Date.now(),
              final: true,
              gaveUp: false,
            };
            this.upsert(done);
            this.settled$.next(done);
            return true;
          }),
          catchError((err) => this.failed(label, err)),
        );
      }
    }
  }

  private failed(label: string, err: unknown): Observable<boolean> {
    const body = (err as { error?: { message?: string } } | null)?.error;
    this.notify.error(body?.message ?? `${label} could not be sent — the engine did not answer.`);
    return of(false);
  }

  private upsert(item: TrackedAction): void {
    this._tracked.update((list) => [item, ...list.filter((t) => t.key !== item.key)].slice(0, MAX_TRACKED));
  }

  private patch(key: string, patch: Partial<TrackedAction>): TrackedAction | null {
    let out: TrackedAction | null = null;
    this._tracked.update((list) =>
      list.map((t) => {
        if (t.key !== key) return t;
        out = { ...t, ...patch };
        return out;
      }),
    );
    return out;
  }
}
