import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { catchError, finalize, of, switchMap } from 'rxjs';

import { SpreadReactiveService } from '@core/services/spread-reactive.service';
import { EAInstancesService } from '@core/services/ea-instances.service';
import { AuditTrailService } from '@core/services/audit-trail.service';
import { NotificationService } from '@core/notifications/notification.service';
import type { SpreadReactiveConfig } from '@features/spread-reactive/spread-reactive.types';

/**
 * Engine-wide master toggle for the spread-pad subsystem
 * (<c>SpreadReactive:Pad:Enabled</c>).  AND-ed with each account's per-EA
 * <c>EA:SpreadPad:Account:{id}</c> toggle on the EA detail page — either
 * being off skips the pad for that account.  Lives here so the operator
 * can flip the whole fleet on/off from the EA control surface without
 * pivoting to the Spread-Reactive config page.
 *
 * Read/write goes through <c>SpreadReactiveService.getConfig()</c> /
 * <c>saveConfig()</c> — the engine's config block is monolithic, so a
 * save GETs the current block, swaps just <c>padEnabled</c>, and PUTs the
 * whole thing back.  Safe because this surface is the only single-field
 * editor; bulk edits still happen on the Spread-Reactive page.
 */
@Component({
  selector: 'app-ea-spread-pad-master-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="spm-panel" [attr.data-arm]="draft() ? 'on' : 'off'">
      <div class="spm-info">
        <div class="spm-headline">
          <span class="spm-label">Spread pad</span>
          <span
            class="spm-pill muted small"
            title="One master switch applies to every account on this engine."
            >engine-wide</span
          >
          @if (server() === null) {
            <span class="spm-pill muted">…</span>
          } @else if (server() === true) {
            <span class="spm-pill warn">Armed</span>
          } @else {
            <span class="spm-pill muted">Off</span>
          }
        </div>
        <span class="spm-desc muted small">
          Engine-wide master for SpreadPadder. AND-ed with each account's per-EA toggle on the EA
          detail page — both must be on for the pad to fire. Hot-reloads via EngineConfigCache on
          the next pad evaluation.
        </span>
      </div>
      <div class="spm-actions">
        @if (loadError()) {
          <span class="muted small">{{ loadError() }}</span>
        } @else if (draft() !== null) {
          <div class="spm-section">
            <label class="spm-row">
              <input
                type="checkbox"
                [checked]="draft()!"
                [disabled]="saving()"
                (change)="setDraft($any($event.target).checked)"
              />
              <span class="spm-section-name">Enable spread padding (engine-wide)</span>
            </label>
            <p class="spm-desc muted small">
              When on, the engine pads signal entry/SL/TP by the per-(account, symbol)
              <code>SpreadBaselineFloor</code> before placement (longs pad entry+SL down; shorts pad
              entry+TP up). Off skips the pad regardless of any per-EA opt-in.
            </p>
          </div>

          <div class="spm-status small">
            @if (saving()) {
              <span class="muted">Saving…</span>
            } @else if (saveError()) {
              <span class="bad">{{ saveError() }}</span>
            } @else if (saved()) {
              <span class="ok">Saved · takes effect on next pad evaluation</span>
            } @else if (dirty()) {
              <span class="muted">Unsaved change</span>
            } @else {
              <span class="muted">Default · on</span>
            }
          </div>
          <div class="spm-buttons">
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
      .spm-panel {
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
      .spm-panel[data-arm='on'] {
        border-left-color: #34c759;
      }
      .spm-info {
        display: flex;
        flex-direction: column;
        gap: 4px;
        min-width: 240px;
        max-width: 32ch;
      }
      .spm-headline {
        display: flex;
        align-items: center;
        gap: var(--space-2);
      }
      .spm-label {
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
      }
      .spm-pill {
        font-size: var(--text-xs);
        padding: 2px 8px;
        border-radius: var(--radius-full);
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .spm-pill.warn {
        background: rgba(52, 199, 89, 0.12);
        color: #248a3d;
      }
      .spm-pill.muted {
        background: rgba(0, 0, 0, 0.06);
        color: var(--text-tertiary);
      }
      .spm-desc {
        max-width: 60ch;
      }
      .spm-actions {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
        flex-grow: 1;
        min-width: 280px;
        max-width: 520px;
      }
      .spm-section {
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: 8px 12px;
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
      }
      .spm-row {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        cursor: pointer;
        user-select: none;
      }
      .spm-section-name {
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
      }
      .spm-status {
        min-height: 1.2em;
      }
      .spm-status .ok {
        color: #248a3d;
      }
      .spm-status .bad {
        color: #d70015;
      }
      .spm-buttons {
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
export class EASpreadPadMasterPanelComponent implements OnInit {
  private readonly spreadReactive = inject(SpreadReactiveService);
  private readonly instances = inject(EAInstancesService);
  private readonly auditTrail = inject(AuditTrailService);
  private readonly notify = inject(NotificationService);

  protected readonly server = signal<boolean | null>(null);
  protected readonly draft = signal<boolean | null>(null);
  protected readonly saving = signal(false);
  protected readonly saved = signal(false);
  protected readonly saveError = signal<string | null>(null);
  protected readonly loadError = signal<string | null>(null);

  /** Cached full config so save can read-modify-write without a fresh GET. */
  private serverConfig: SpreadReactiveConfig | null = null;
  /** First registered EA id — used purely for audit-row attribution. */
  private auditEaId: number | null = null;

  protected readonly dirty = computed(() => {
    const s = this.server();
    const d = this.draft();
    return s !== null && d !== null && s !== d;
  });

  ngOnInit(): void {
    // Resolve an EA id for audit attribution in parallel with loading the
    // config. The config call doesn't need an instanceId — it hits the
    // engine-wide /spread-reactive/config endpoint directly — but we want
    // an EA row for the audit trail.
    this.instances
      .list()
      .pipe(catchError(() => of(null)))
      .subscribe((res) => {
        this.auditEaId = res?.data?.[0]?.id ?? null;
      });

    this.spreadReactive
      .getConfig()
      .pipe(
        catchError((err) => {
          this.loadError.set(err?.error?.message ?? 'Failed to load spread-pad config.');
          return of(null);
        }),
      )
      .subscribe((cfg) => {
        if (!cfg) return;
        this.serverConfig = cfg;
        this.server.set(cfg.padEnabled);
        this.draft.set(cfg.padEnabled);
      });
  }

  protected setDraft(enabled: boolean): void {
    this.draft.set(enabled);
    this.saved.set(false);
    this.saveError.set(null);
  }

  protected reset(): void {
    this.draft.set(this.server());
    this.saved.set(false);
    this.saveError.set(null);
  }

  protected save(): void {
    const cfg = this.serverConfig;
    const draft = this.draft();
    if (!cfg || draft === null || !this.dirty()) return;
    this.saving.set(true);
    this.saveError.set(null);
    const next: SpreadReactiveConfig = { ...cfg, padEnabled: draft };
    this.spreadReactive
      .saveConfig(next)
      .pipe(
        finalize(() => this.saving.set(false)),
        catchError((err) => {
          this.saveError.set(err?.error?.message ?? 'Save failed.');
          return of(null);
        }),
      )
      .subscribe((saved) => {
        if (saved === null) return;
        this.serverConfig = saved;
        this.server.set(saved.padEnabled);
        this.draft.set(saved.padEnabled);
        this.saved.set(true);
        this.notify.success(
          `Spread pad ${saved.padEnabled ? 'enabled' : 'disabled'} (engine-wide).`,
        );
        if (this.auditEaId !== null) {
          this.auditTrail
            .create({
              entityType: 'EAInstance',
              entityId: this.auditEaId,
              decisionType: 'EAUpdateSpreadPadMaster',
              outcome: 'Saved',
              reason: null,
              contextJson: JSON.stringify({ padEnabled: saved.padEnabled }),
              source: 'AdminUI',
            })
            .subscribe({ error: () => undefined });
        }
      });
  }
}
