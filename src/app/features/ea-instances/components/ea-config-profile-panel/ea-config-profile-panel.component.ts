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
  imports: [FormsModule],
  template: `
    <section class="panel" aria-label="EA config profiles">
      <header class="hdr">
        <h3>Config profiles</h3>
        <button type="button" class="ghost" (click)="reload()" [disabled]="busy()">Refresh</button>
      </header>

      @if (loading()) {
        <p class="muted">Loading profiles…</p>
      } @else if (profiles().length === 0) {
        <p class="muted">
          No profiles yet. Capture this instance's current configuration to create one.
        </p>
      } @else {
        <label class="field">
          <span>Profile</span>
          <select [(ngModel)]="selectedId" name="profile" [disabled]="busy()">
            @for (p of profiles(); track p.id) {
              <option [ngValue]="p.id">{{ p.name }} ({{ p.fieldCount }} fields)</option>
            }
          </select>
        </label>

        @if (selected(); as sel) {
          <div class="meta">
            @if (sel.description) {
              <p class="desc">{{ sel.description }}</p>
            }
            <p class="muted small">
              @if (sel.capturedFromInstanceId) {
                Captured from <code>{{ sel.capturedFromInstanceId }}</code> ·
              }
              applied {{ sel.appliedCount }}×
              @if (sel.lastAppliedAt) {
                · last {{ sel.lastAppliedAt | date: 'short' }}
              }
            </p>
            <details>
              <summary>{{ sel.fieldCount }} settings</summary>
              <pre>{{ pretty(sel.configJson) }}</pre>
            </details>
          </div>

          <div class="actions">
            <button
              type="button"
              class="primary"
              (click)="apply()"
              [disabled]="busy() || !instanceId()"
            >
              Apply to this instance
            </button>
            <button type="button" class="danger ghost" (click)="remove()" [disabled]="busy()">
              Delete
            </button>
          </div>
          <p class="warn small">
            Applying changes live risk limits on this account. Identity fields (symbols, instance
            id) are never carried by a profile.
          </p>
        }
      }

      <hr />

      <form class="capture" (ngSubmit)="capture()">
        <h4>Capture current config</h4>
        <p class="muted small">
          Snapshots what this instance is <em>actually running</em> (after any config override), not
          its chart defaults.
        </p>
        <label class="field">
          <span>Name</span>
          <input
            [(ngModel)]="captureName"
            name="captureName"
            placeholder="e.g. reference-unrestricted"
            [disabled]="busy()"
            required
          />
        </label>
        <label class="field">
          <span>Description</span>
          <input
            [(ngModel)]="captureDesc"
            name="captureDesc"
            placeholder="What is this profile for?"
            [disabled]="busy()"
          />
        </label>
        <button type="submit" [disabled]="busy() || !captureName.trim() || !instanceId()">
          Capture as profile
        </button>
      </form>
    </section>
  `,
  styles: [
    `
      .panel {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
      }
      .hdr {
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
      }
      .field span {
        font-size: 0.8rem;
        opacity: 0.8;
      }
      .actions {
        display: flex;
        gap: 0.5rem;
        flex-wrap: wrap;
      }
      .muted {
        opacity: 0.7;
      }
      .small {
        font-size: 0.78rem;
      }
      .warn {
        color: var(--warn, #b26a00);
      }
      pre {
        max-height: 16rem;
        overflow: auto;
        font-size: 0.75rem;
      }
      .capture {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
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
