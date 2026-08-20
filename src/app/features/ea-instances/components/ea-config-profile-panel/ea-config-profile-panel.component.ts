import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  Output,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { finalize } from 'rxjs';

import { EAAdminService } from '@core/services/ea-admin.service';
import { NotificationService } from '@core/notifications/notification.service';
import type { EaConfigProfile } from '@core/api/api.types';

/**
 * Named, reusable EA config profiles.
 *
 * Why this exists: instance configuration used to live ONLY as runtime state
 * inside a live EA, so the "reference" config was reproducible only by reading
 * one instance's heartbeat and hand-writing the same JSON everywhere else.
 * Drift was therefore invisible — on 2026-08-20 three accounts were found
 * running with spread and consecutive-loss guards effectively disabled because
 * an older per-instance override had been keyed to instance ids that no longer
 * existed after their terminals were re-attached.
 *
 * Applying a profile is a LIVE RISK-LIMIT CHANGE on a trading account, so the
 * UI deliberately shows the field count and the full JSON before you commit,
 * and the apply goes through the same UpdateInstanceConfig path (and therefore
 * the same guards) as a manual push.
 */
@Component({
  selector: 'app-ea-config-profile-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, FormsModule],
  template: `
    <section class="panel" aria-label="EA config profiles">
      <header class="panel-head">
        <div class="head-title">
          <h3>Config profiles</h3>
          @if (!loading() && profiles().length > 0) {
            <span class="count">{{ profiles().length }}</span>
          }
        </div>
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          (click)="reload()"
          [disabled]="busy() || loading()"
        >
          Refresh
        </button>
      </header>

      <p class="lede">
        Named, reusable snapshots of instance configuration. Identity fields — symbols and instance
        id — are never carried by a profile.
      </p>

      @if (loading()) {
        <div class="skeleton-block" aria-hidden="true">
          <span class="shimmer sk-line"></span>
          <span class="shimmer sk-card"></span>
        </div>
      } @else if (profiles().length === 0) {
        <div class="empty">
          <span class="empty-title">No profiles yet</span>
          <span class="empty-hint">
            Capture this instance's effective configuration below to create the first one.
          </span>
        </div>
      } @else {
        <div class="group">
          <h4 class="group-title">Apply</h4>

          <label class="field">
            <span class="field-label">Profile</span>
            <select class="input" [(ngModel)]="selectedId" name="profile" [disabled]="busy()">
              @for (p of profiles(); track p.id) {
                <option [ngValue]="p.id">{{ p.name }} · {{ p.fieldCount }} fields</option>
              }
            </select>
          </label>

          @if (selected(); as sel) {
            <article class="summary">
              <div class="summary-head">
                <span class="summary-name">{{ sel.name }}</span>
                <span class="chip chip-accent">{{ sel.fieldCount }} fields</span>
              </div>

              @if (sel.description) {
                <p class="summary-desc">{{ sel.description }}</p>
              }

              <ul class="facts">
                @if (sel.capturedFromInstanceId) {
                  <li>
                    <span class="fact-k">from</span>
                    <code>{{ sel.capturedFromInstanceId }}</code>
                  </li>
                }
                <li>
                  <span class="fact-k">applied</span>
                  <span class="fact-v">{{ sel.appliedCount }}×</span>
                </li>
                @if (sel.lastAppliedAt) {
                  <li>
                    <span class="fact-k">last</span>
                    <span class="fact-v">{{ sel.lastAppliedAt | date: 'MMM d, h:mm a' }}</span>
                  </li>
                }
              </ul>

              <details class="json">
                <summary>View {{ sel.fieldCount }} settings</summary>
                <pre>{{ pretty(sel.configJson) }}</pre>
              </details>
            </article>

            <p class="note note-warn">
              <span class="note-icon" aria-hidden="true">!</span>
              <span>
                Applying is a <strong>live risk-limit change</strong> on this account. It goes
                through the same guards as a manual config push.
              </span>
            </p>

            <div class="actions">
              <button
                type="button"
                class="btn btn-primary"
                (click)="apply()"
                [disabled]="busy() || !instanceId()"
              >
                Apply to this instance
              </button>
              <button type="button" class="btn btn-danger" (click)="remove()" [disabled]="busy()">
                Delete profile
              </button>
            </div>
          }
        </div>
      }

      <div class="group group-capture">
        <h4 class="group-title">Capture</h4>
        <form class="capture" (ngSubmit)="capture()">
          <p class="hint">
            Snapshots what this instance is <em>actually running</em> (after any config override),
            not its chart defaults.
          </p>
          <div class="capture-grid">
            <label class="field">
              <span class="field-label">Name</span>
              <input
                class="input"
                [(ngModel)]="captureName"
                name="captureName"
                placeholder="reference-unrestricted"
                [disabled]="busy()"
                required
              />
            </label>
            <label class="field">
              <span class="field-label">
                Description
                <span class="optional">optional</span>
              </span>
              <input
                class="input"
                [(ngModel)]="captureDesc"
                name="captureDesc"
                placeholder="What is this profile for?"
                [disabled]="busy()"
              />
            </label>
          </div>
          <button
            type="submit"
            class="btn btn-secondary"
            [disabled]="busy() || !captureName.trim() || !instanceId()"
          >
            Capture as profile
          </button>
        </form>
      </div>
    </section>
  `,
  styles: [
    `
      .panel {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--card-padding);
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }

      /* ── Header ─────────────────────────────────────────────────────── */
      .panel-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-3);
        flex-wrap: wrap;
      }
      .head-title {
        display: inline-flex;
        align-items: center;
        gap: var(--space-2);
      }
      .head-title h3 {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .count {
        font-size: 10px;
        font-weight: var(--font-semibold);
        line-height: 1;
        padding: 3px 7px;
        border-radius: var(--radius-full);
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        font-variant-numeric: tabular-nums;
      }
      .lede {
        margin: 0;
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        line-height: 1.5;
        max-width: 62ch;
      }

      /* ── Groups ─────────────────────────────────────────────────────── */
      .group {
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
      }
      .group-capture {
        border-top: 1px solid var(--border);
        padding-top: var(--space-3);
        margin-top: var(--space-1);
      }
      .group-title {
        margin: 0;
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.06em;
        font-weight: var(--font-semibold);
      }

      /* ── Fields ─────────────────────────────────────────────────────── */
      .field {
        display: flex;
        flex-direction: column;
        gap: 6px;
        min-width: 0;
      }
      .field-label {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        font-weight: var(--font-medium);
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .optional {
        font-size: 10px;
        font-weight: var(--font-medium);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .input {
        padding: 7px 10px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-sm);
        font-family: inherit;
        width: 100%;
        box-sizing: border-box;
      }
      .input:focus {
        outline: none;
        border-color: var(--accent);
        box-shadow: 0 0 0 3px rgba(0, 113, 227, 0.14);
      }
      .input:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }
      select.input {
        appearance: none;
        cursor: pointer;
        padding-right: 30px;
        background-image:
          linear-gradient(45deg, transparent 50%, var(--text-tertiary) 50%),
          linear-gradient(135deg, var(--text-tertiary) 50%, transparent 50%);
        background-position:
          calc(100% - 15px) 52%,
          calc(100% - 10px) 52%;
        background-size:
          5px 5px,
          5px 5px;
        background-repeat: no-repeat;
      }

      /* ── Selected-profile summary ───────────────────────────────────── */
      .summary {
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        padding: var(--space-3);
      }
      .summary-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-2);
        flex-wrap: wrap;
      }
      .summary-name {
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
        word-break: break-word;
      }
      .chip {
        font-size: 10px;
        font-weight: var(--font-semibold);
        line-height: 1;
        padding: 4px 8px;
        border-radius: var(--radius-full);
        white-space: nowrap;
        font-variant-numeric: tabular-nums;
      }
      .chip-accent {
        background: rgba(0, 113, 227, 0.1);
        color: var(--accent);
      }
      .summary-desc {
        margin: 0;
        font-size: var(--text-xs);
        color: var(--text-secondary);
        line-height: 1.5;
      }
      .facts {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-1) var(--space-3);
        font-size: var(--text-xs);
        color: var(--text-tertiary);
      }
      .facts li {
        display: inline-flex;
        align-items: center;
        gap: 5px;
      }
      .fact-k {
        text-transform: uppercase;
        letter-spacing: 0.05em;
        font-size: 10px;
      }
      .fact-v,
      .facts code {
        color: var(--text-secondary);
        font-variant-numeric: tabular-nums;
      }
      .facts code {
        font-size: 11px;
        background: var(--bg-tertiary);
        border-radius: 4px;
        padding: 1px 5px;
        /* Instance ids are long (LASC-MULTI-…-A107699364); wrap rather than
           forcing the whole panel to scroll horizontally. */
        overflow-wrap: anywhere;
      }

      /* ── JSON disclosure ────────────────────────────────────────────── */
      .json summary {
        cursor: pointer;
        font-size: var(--text-xs);
        color: var(--accent);
        font-weight: var(--font-medium);
        list-style: none;
        display: inline-flex;
        align-items: center;
        gap: 5px;
        user-select: none;
      }
      .json summary::-webkit-details-marker {
        display: none;
      }
      .json summary::before {
        content: '▸';
        font-size: 9px;
        transition: transform 0.15s ease;
      }
      .json[open] summary::before {
        transform: rotate(90deg);
      }
      .json pre {
        margin: var(--space-2) 0 0;
        max-height: 15rem;
        overflow: auto;
        font-size: 11px;
        line-height: 1.55;
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        padding: var(--space-2) var(--space-3);
        color: var(--text-secondary);
      }

      /* ── Warning note ───────────────────────────────────────────────── */
      .note {
        margin: 0;
        display: flex;
        align-items: flex-start;
        gap: var(--space-2);
        font-size: var(--text-xs);
        line-height: 1.5;
        border-radius: var(--radius-sm);
        padding: var(--space-2) var(--space-3);
      }
      .note-warn {
        background: rgba(255, 149, 0, 0.08);
        border: 1px solid rgba(255, 149, 0, 0.22);
        color: var(--text-secondary);
      }
      .note-warn strong {
        color: var(--text-primary);
        font-weight: var(--font-semibold);
      }
      .note-icon {
        flex: 0 0 auto;
        width: 15px;
        height: 15px;
        margin-top: 1px;
        border-radius: var(--radius-full);
        background: var(--warning);
        color: #fff;
        font-size: 10px;
        font-weight: 700;
        line-height: 15px;
        text-align: center;
      }

      /* ── Empty / loading ────────────────────────────────────────────── */
      .empty {
        display: flex;
        flex-direction: column;
        gap: 4px;
        align-items: center;
        text-align: center;
        padding: var(--space-5) var(--space-4);
        border: 1px dashed var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
      }
      .empty-title {
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
        color: var(--text-secondary);
      }
      .empty-hint {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        max-width: 46ch;
      }
      .skeleton-block {
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
      }
      .shimmer {
        display: block;
        border-radius: var(--radius-sm);
        background: linear-gradient(
          90deg,
          var(--bg-tertiary) 25%,
          var(--bg-primary) 50%,
          var(--bg-tertiary) 75%
        );
        background-size: 200% 100%;
        animation: profile-shimmer 1.3s ease-in-out infinite;
      }
      .sk-line {
        height: 30px;
      }
      .sk-card {
        height: 78px;
      }
      @keyframes profile-shimmer {
        from {
          background-position: 200% 0;
        }
        to {
          background-position: -200% 0;
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .shimmer {
          animation: none;
        }
      }

      /* ── Capture form ───────────────────────────────────────────────── */
      .capture {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
        align-items: flex-start;
      }
      .hint {
        margin: 0;
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        line-height: 1.5;
        max-width: 62ch;
      }
      .capture-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
        gap: var(--space-3);
        width: 100%;
      }

      /* ── Buttons ────────────────────────────────────────────────────── */
      .actions {
        display: flex;
        gap: var(--space-2);
        flex-wrap: wrap;
      }
      .btn {
        padding: 8px 18px;
        border-radius: var(--radius-sm);
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        font-family: inherit;
        cursor: pointer;
        border: 1px solid transparent;
        white-space: nowrap;
      }
      .btn-sm {
        padding: 5px 12px;
        font-size: var(--text-xs);
      }
      .btn-primary {
        background: var(--accent);
        color: #fff;
        border-color: var(--accent);
      }
      .btn-secondary {
        background: var(--bg-primary);
        color: var(--text-primary);
        border-color: var(--border);
      }
      .btn-secondary:hover:not(:disabled) {
        background: var(--bg-tertiary);
      }
      .btn-ghost {
        background: transparent;
        color: var(--text-secondary);
        border-color: var(--border);
      }
      .btn-ghost:hover:not(:disabled) {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }
      /* Destructive stays quiet until hover — deleting a profile is rare and
         should never sit next to Apply as an equally loud target. */
      .btn-danger {
        background: transparent;
        color: var(--loss);
        border-color: transparent;
      }
      .btn-danger:hover:not(:disabled) {
        background: rgba(255, 59, 48, 0.09);
        border-color: rgba(255, 59, 48, 0.25);
      }
      .btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
    `,
  ],
})
export class EaConfigProfilePanelComponent {
  private readonly svc = inject(EAAdminService);
  private readonly notify = inject(NotificationService);

  /** Target instance for apply/capture. */
  readonly instanceId = input<string | null>(null);

  /** Emitted after a successful apply so the parent can refresh the state envelope. */
  @Output() readonly profileApplied = new EventEmitter<void>();

  readonly profiles = signal<EaConfigProfile[]>([]);
  readonly loading = signal(false);
  readonly busy = signal(false);

  selectedId: number | null = null;
  captureName = '';
  captureDesc = '';

  readonly selected = computed(() => this.profiles().find((p) => p.id === this.selectedId) ?? null);

  constructor() {
    this.reload();
  }

  pretty(json: string): string {
    try {
      return JSON.stringify(JSON.parse(json), null, 2);
    } catch {
      return json;
    }
  }

  reload(): void {
    this.loading.set(true);
    this.svc
      .listConfigProfiles()
      .pipe(finalize(() => this.loading.set(false)))
      .subscribe({
        next: (res) => {
          const rows = res.data ?? [];
          this.profiles.set(rows);
          if (this.selectedId == null && rows.length > 0) this.selectedId = rows[0].id;
        },
        error: () => this.notify.error('Could not load config profiles'),
      });
  }

  apply(): void {
    const id = this.selectedId;
    const target = this.instanceId();
    if (id == null || !target) return;
    this.busy.set(true);
    this.svc
      .applyConfigProfile(id, [target])
      .pipe(finalize(() => this.busy.set(false)))
      .subscribe({
        next: (res) => {
          const r = res.data;
          // Partial success is a normal outcome, so surface the per-target
          // failure text rather than a generic error.
          if (r && r.failures.length > 0) this.notify.error(r.failures.join('; '));
          else this.notify.success(res.message ?? 'Profile applied');
          this.reload();
          this.profileApplied.emit();
        },
        error: () => this.notify.error('Apply failed'),
      });
  }

  capture(): void {
    const target = this.instanceId();
    if (!target || !this.captureName.trim()) return;
    this.busy.set(true);
    this.svc
      .captureConfigProfile(target, {
        name: this.captureName.trim(),
        description: this.captureDesc.trim() || null,
      })
      .pipe(finalize(() => this.busy.set(false)))
      .subscribe({
        next: (res) => {
          if (!res.status) {
            this.notify.error(res.message ?? 'Capture failed');
            return;
          }
          this.notify.success(`Captured '${this.captureName.trim()}'`);
          this.captureName = '';
          this.captureDesc = '';
          this.reload();
        },
        error: () => this.notify.error('Capture failed'),
      });
  }

  remove(): void {
    const id = this.selectedId;
    if (id == null) return;
    this.busy.set(true);
    this.svc
      .deleteConfigProfile(id)
      .pipe(finalize(() => this.busy.set(false)))
      .subscribe({
        next: (res) => {
          this.notify.success(res.message ?? 'Deleted');
          this.selectedId = null;
          this.reload();
        },
        error: () => this.notify.error('Delete failed'),
      });
  }
}
