import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { catchError, finalize, of, switchMap } from 'rxjs';

import { EAAdminService } from '@core/services/ea-admin.service';
import { EAInstancesService } from '@core/services/ea-instances.service';
import { AuditTrailService } from '@core/services/audit-trail.service';
import { NotificationService } from '@core/notifications/notification.service';
import type { EAPendingSignalRevalConfig } from '@core/api/api.types';

/**
 * Engine-wide park-and-revalidate config for LLM signals whose entry is
 * far from market at generation time (in ATR units). When enabled, the
 * engine parks these signals in PendingReval status instead of placing
 * stale limits; when price reaches the recommended entry, a fresh
 * condensed LLM analysis decides whether to promote (back to Approved
 * with rewritten entry, fills at market) or kill.
 *
 * Lives on the EA Instances page because that's the operator's EA
 * control surface — but the setting is fleet-wide (single set of values
 * applies to every account). The per-EA admin endpoint is used to read
 * and write the config; the panel resolves any registered instance id
 * to call it (instance is ignored by the engine for this engine-wide
 * row group).
 */
@Component({
  selector: 'app-ea-pending-signal-reval-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="psr-panel" [attr.data-arm]="draft()?.enabled ? 'on' : 'off'">
      <div class="psr-info">
        <div class="psr-headline">
          <span class="psr-label">Pending-signal re-validation</span>
          <span
            class="psr-pill muted small"
            title="One setting applies to every account on this engine."
            >engine-wide</span
          >
          @if (server() === null) {
            <span class="psr-pill muted">…</span>
          } @else if (server()?.enabled) {
            <span class="psr-pill warn">Armed</span>
          } @else {
            <span class="psr-pill muted">Off</span>
          }
        </div>
        <span class="psr-desc muted small">
          Park LLM recs whose entry is far from market and re-validate when price reaches it.
          Threshold is a fraction of the signal-generation ATR. Hot-reloads on the next gate/worker
          cycle.
        </span>
      </div>
      <div class="psr-actions">
        @if (resolveError()) {
          <span class="muted small">{{ resolveError() }}</span>
        } @else if (draft() !== null) {
          <div class="psr-section">
            <label class="psr-row">
              <input
                type="checkbox"
                [checked]="draft()!.enabled"
                [disabled]="saving()"
                (change)="
                  updateDraft({
                    enabled: $any($event.target).checked,
                  })
                "
              />
              <span class="psr-section-name">Enable park &amp; re-validate</span>
            </label>
            <div class="psr-fields" [class.disabled]="!draft()!.enabled">
              <label class="psr-field">
                <span>ATR trigger</span>
                <input
                  type="number"
                  step="0.1"
                  min="0.1"
                  max="3.0"
                  [value]="draft()!.atrTrigger"
                  [disabled]="!draft()!.enabled || saving()"
                  (input)="
                    updateDraft({
                      atrTrigger: $any($event.target).valueAsNumber,
                    })
                  "
                />
                <span class="psr-unit">× ATR</span>
              </label>
              <label class="psr-field">
                <span>TTL</span>
                <input
                  type="number"
                  step="1"
                  min="1"
                  max="24"
                  [value]="draft()!.ttlHours"
                  [disabled]="!draft()!.enabled || saving()"
                  (input)="
                    updateDraft({
                      ttlHours: $any($event.target).valueAsNumber,
                    })
                  "
                />
                <span class="psr-unit">h</span>
              </label>
              <label class="psr-field">
                <span>Cooldown</span>
                <input
                  type="number"
                  step="1"
                  min="1"
                  max="60"
                  [value]="draft()!.cooldownMinutes"
                  [disabled]="!draft()!.enabled || saving()"
                  (input)="
                    updateDraft({
                      cooldownMinutes: $any($event.target).valueAsNumber,
                    })
                  "
                />
                <span class="psr-unit">min</span>
              </label>
              <label class="psr-field">
                <span>Max attempts</span>
                <input
                  type="number"
                  step="1"
                  min="1"
                  max="10"
                  [value]="draft()!.maxAttempts"
                  [disabled]="!draft()!.enabled || saving()"
                  (input)="
                    updateDraft({
                      maxAttempts: $any($event.target).valueAsNumber,
                    })
                  "
                />
                <span class="psr-unit">tries</span>
              </label>
            </div>
            <p class="psr-desc muted small">
              Park if <code>|entry − live| / ATR ≥ trigger</code>. Re-validate when price returns
              within trigger; cap retries with <em>Max attempts</em>; auto-expire after
              <em>TTL</em>.
            </p>
          </div>

          <div class="psr-section">
            <label class="psr-row">
              <input
                type="checkbox"
                [checked]="draft()!.siblingValidationEnabled"
                [disabled]="!draft()!.enabled || saving()"
                (change)="
                  updateDraft({
                    siblingValidationEnabled: $any($event.target).checked,
                  })
                "
              />
              <span class="psr-section-name">Sibling validation (skip LLM)</span>
            </label>
            <div
              class="psr-fields"
              [class.disabled]="!draft()!.enabled || !draft()!.siblingValidationEnabled"
            >
              <label class="psr-field">
                <span>Window</span>
                <input
                  type="number"
                  step="1"
                  min="5"
                  max="240"
                  [value]="draft()!.siblingWindowMinutes"
                  [disabled]="!draft()!.enabled || !draft()!.siblingValidationEnabled || saving()"
                  (input)="
                    updateDraft({
                      siblingWindowMinutes: $any($event.target).valueAsNumber,
                    })
                  "
                />
                <span class="psr-unit">min</span>
              </label>
              <label class="psr-field">
                <span>Min confidence</span>
                <input
                  type="number"
                  step="0.05"
                  min="0"
                  max="1"
                  [value]="draft()!.minSiblingConfidence"
                  [disabled]="!draft()!.enabled || !draft()!.siblingValidationEnabled || saving()"
                  (input)="
                    updateDraft({
                      minSiblingConfidence: $any($event.target).valueAsNumber,
                    })
                  "
                />
                <span class="psr-unit">(0–1)</span>
              </label>
            </div>
            <p class="psr-desc muted small">
              Skip the re-validation LLM call when a recent same-direction sibling rec exists within
              <em>Window</em> at or above <em>Min confidence</em>. Older recs validate newer ones at
              park time (when the newer entry is closer to live); newer recs validate older ones at
              the touch. Neither validator is consumed.
            </p>
          </div>

          <div class="psr-status small">
            @if (saving()) {
              <span class="muted">Saving…</span>
            } @else if (saveError()) {
              <span class="bad">{{ saveError() }}</span>
            } @else if (saved()) {
              <span class="ok">Saved · takes effect on next gate/worker cycle</span>
            } @else if (dirty()) {
              <span class="muted">Unsaved change</span>
            } @else {
              <span class="muted">Default · off</span>
            }
          </div>
          <div class="psr-buttons">
            <button
              type="button"
              class="btn btn-secondary"
              (click)="reset()"
              [disabled]="!dirty() || saving()"
            >
              Revert
            </button>
            <button
              type="button"
              class="btn btn-primary"
              (click)="save()"
              [disabled]="!dirty() || saving()"
            >
              {{ saving() ? 'Saving…' : 'Save' }}
            </button>
          </div>
        } @else {
          <span class="muted small">Loading…</span>
        }
      </div>
    </section>
  `,
  styles: [
    `
      .psr-panel {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: var(--space-4);
        flex-wrap: wrap;
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-left-width: 3px;
        border-left-color: var(--border);
        border-radius: var(--radius-md);
        padding: var(--card-padding);
        height: 100%;
      }
      .psr-panel[data-arm='on'] {
        border-left-color: #ff9500;
      }
      .psr-info {
        display: flex;
        flex-direction: column;
        gap: 4px;
        min-width: 240px;
        max-width: 32ch;
      }
      .psr-headline {
        display: flex;
        align-items: center;
        gap: var(--space-2);
      }
      .psr-label {
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
      }
      .psr-pill {
        font-size: var(--text-xs);
        padding: 2px 8px;
        border-radius: var(--radius-full);
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .psr-pill.warn {
        background: rgba(255, 149, 0, 0.12);
        color: #c93400;
      }
      .psr-pill.muted {
        background: rgba(0, 0, 0, 0.06);
        color: var(--text-tertiary);
      }
      .psr-desc {
        max-width: 60ch;
      }
      .psr-actions {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
        flex-grow: 1;
        min-width: 280px;
        max-width: 520px;
      }
      .psr-section {
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: 8px 12px;
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
      }
      .psr-row {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        cursor: pointer;
        user-select: none;
      }
      .psr-section-name {
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
      }
      .psr-fields {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-3);
        padding-left: 24px;
      }
      .psr-fields.disabled {
        opacity: 0.5;
      }
      .psr-field {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .psr-field input {
        width: 70px;
        padding: 4px 6px;
        font-size: var(--text-sm);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-primary);
      }
      .psr-field input:disabled {
        background: var(--bg-secondary);
        cursor: not-allowed;
      }
      .psr-unit {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        font-weight: var(--font-medium);
      }
      .psr-status {
        min-height: 1.2em;
      }
      .psr-status .ok {
        color: #248a3d;
      }
      .psr-status .bad {
        color: #d70015;
      }
      .psr-buttons {
        display: flex;
        gap: var(--space-2);
        align-self: flex-end;
      }
      .muted {
        color: var(--text-tertiary);
      }
      .small {
        font-size: 12px;
      }
      .btn {
        height: 30px;
        padding: 0 14px;
        border-radius: var(--radius-sm);
        font-weight: var(--font-semibold);
        font-size: 12px;
        cursor: pointer;
        font-family: inherit;
      }
      .btn-primary {
        background: var(--accent);
        color: #fff;
        border: 1px solid var(--accent);
      }
      .btn-secondary {
        background: var(--bg-primary);
        color: var(--text-primary);
        border: 1px solid var(--border);
      }
      .btn:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }
    `,
  ],
})
export class EAPendingSignalRevalPanelComponent implements OnInit {
  private readonly admin = inject(EAAdminService);
  private readonly instances = inject(EAInstancesService);
  private readonly auditTrail = inject(AuditTrailService);
  private readonly notify = inject(NotificationService);

  protected readonly server = signal<EAPendingSignalRevalConfig | null>(null);
  protected readonly draft = signal<{
    enabled: boolean;
    atrTrigger: number;
    ttlHours: number;
    cooldownMinutes: number;
    maxAttempts: number;
    siblingValidationEnabled: boolean;
    siblingWindowMinutes: number;
    minSiblingConfidence: number;
  } | null>(null);
  protected readonly saving = signal(false);
  protected readonly saved = signal(false);
  protected readonly saveError = signal<string | null>(null);
  protected readonly resolveError = signal<string | null>(null);

  /** Any registered EA instance — the engine ignores instanceId for this engine-wide row group, but the URL still needs one. */
  private resolvedInstanceId: string | null = null;
  /** First EA dbId used for audit-trail attribution. */
  private resolvedEaId: number | null = null;

  protected readonly dirty = computed(() => {
    const s = this.server();
    const d = this.draft();
    if (!s || !d) return false;
    return (
      s.enabled !== d.enabled ||
      s.atrTrigger !== d.atrTrigger ||
      s.ttlHours !== d.ttlHours ||
      s.cooldownMinutes !== d.cooldownMinutes ||
      s.maxAttempts !== d.maxAttempts ||
      s.siblingValidationEnabled !== d.siblingValidationEnabled ||
      s.siblingWindowMinutes !== d.siblingWindowMinutes ||
      s.minSiblingConfidence !== d.minSiblingConfidence
    );
  });

  ngOnInit(): void {
    this.instances
      .list()
      .pipe(
        switchMap((res) => {
          const first = res?.data?.[0];
          if (!first) {
            this.resolveError.set(
              'No EA instances registered — config will be available once an EA connects.',
            );
            return of(null);
          }
          this.resolvedInstanceId = first.instanceId;
          this.resolvedEaId = first.id;
          return this.admin.getPendingSignalReval(first.instanceId);
        }),
        catchError(() => of(null)),
      )
      .subscribe((res) => {
        const cfg = res?.data ?? null;
        if (!cfg) return;
        this.server.set(cfg);
        this.draft.set({
          enabled: cfg.enabled,
          atrTrigger: cfg.atrTrigger,
          ttlHours: cfg.ttlHours,
          cooldownMinutes: cfg.cooldownMinutes,
          maxAttempts: cfg.maxAttempts,
          siblingValidationEnabled: cfg.siblingValidationEnabled,
          siblingWindowMinutes: cfg.siblingWindowMinutes,
          minSiblingConfidence: cfg.minSiblingConfidence,
        });
      });
  }

  protected updateDraft(patch: Partial<NonNullable<ReturnType<typeof this.draft>>>): void {
    const d = this.draft();
    if (!d) return;
    this.draft.set({ ...d, ...patch });
    this.saved.set(false);
    this.saveError.set(null);
  }

  protected reset(): void {
    const s = this.server();
    if (!s) return;
    this.draft.set({
      enabled: s.enabled,
      atrTrigger: s.atrTrigger,
      ttlHours: s.ttlHours,
      cooldownMinutes: s.cooldownMinutes,
      maxAttempts: s.maxAttempts,
      siblingValidationEnabled: s.siblingValidationEnabled,
      siblingWindowMinutes: s.siblingWindowMinutes,
      minSiblingConfidence: s.minSiblingConfidence,
    });
    this.saved.set(false);
    this.saveError.set(null);
  }

  protected save(): void {
    const draft = this.draft();
    const server = this.server();
    const instanceId = this.resolvedInstanceId;
    const eaId = this.resolvedEaId;
    if (!draft || !server || !instanceId || !this.dirty()) return;
    this.saving.set(true);
    this.saveError.set(null);
    this.admin
      .updatePendingSignalReval(instanceId, draft)
      .pipe(
        finalize(() => this.saving.set(false)),
        catchError((err) => {
          this.saveError.set(err?.error?.message ?? 'Save failed.');
          return of(null);
        }),
      )
      .subscribe((res) => {
        if (res === null) return;
        if (!res.status) {
          this.saveError.set(res.message ?? 'Save failed.');
          return;
        }
        this.server.set({ ...server, ...draft });
        this.saved.set(true);
        this.notify.success('Pending-signal re-validation settings saved (engine-wide).');
        if (eaId !== null) {
          this.auditTrail
            .create({
              entityType: 'EAInstance',
              entityId: eaId,
              decisionType: 'EAUpdatePendingSignalReval',
              outcome: 'Saved',
              reason: null,
              contextJson: JSON.stringify({ instanceId, ...draft }),
              source: 'AdminUI',
            })
            .subscribe({ error: () => undefined });
        }
      });
  }
}
