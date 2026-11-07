import { ChangeDetectionStrategy, Component, inject, input, output, signal } from '@angular/core';
import { DatePipe } from '@angular/common';

import type { StrategyDto, StrategyVersionDto } from '@core/api/api.types';
import type { ScriptInputDto } from '@core/api/scripting.types';
import { StrategiesService } from '@core/services/strategies.service';
import { NotificationService } from '@core/notifications/notification.service';
import { ScriptDialogService } from '@features/scripting/shared/script-dialog.service';
import { StrategyVersionDiffComponent } from '../strategy-version-diff/strategy-version-diff.component';
import type { StrategyVersionFields } from '../../util/version-diff';

/**
 * U13 (fu-ui) — the strategy form's version-history drawer, moved out of the form unchanged: the captured versions
 * (lazy-loaded on first expand), a manual snapshot, the diff against the form's current values and Roll back. A
 * confirmed rollback re-reads the strategy and hands it to the form ({@link restored}), which patches its fields and
 * the script editor; {@link changed} tells the host to re-read the strategy.
 */
@Component({
  selector: 'app-strategy-version-history',
  standalone: true,
  imports: [DatePipe, StrategyVersionDiffComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="version-history">
      <div class="version-history-head">
        <button
          type="button"
          class="btn btn-link"
          (click)="toggleVersionHistory()"
          [attr.aria-expanded]="showVersionHistory()"
        >
          {{ showVersionHistory() ? '▾' : '▸' }} Version history
          @if (versions().length > 0) {
            <span class="muted small">({{ versions().length }})</span>
          }
        </button>
        @if (loadingVersions()) {
          <span class="muted small">Loading…</span>
        }
      </div>
      @if (showVersionHistory()) {
        <div class="version-manual-capture">
          <input
            class="form-input small"
            type="text"
            placeholder="Reason / label (optional)"
            [value]="manualCaptureReason()"
            (input)="manualCaptureReason.set($any($event.target).value)"
          />
          <button
            type="button"
            class="btn btn-link"
            [disabled]="capturingVersion()"
            (click)="captureVersionNow()"
            title="Bookmark the current configuration as a fresh version. Roll back later if needed."
          >
            📌 Capture snapshot now
          </button>
        </div>
        @if (versions().length === 0 && !loadingVersions()) {
          <p class="muted small" style="padding:6px 4px;">
            No prior versions captured. The first edit will create a snapshot of the
            current state.
          </p>
        }
        @if (versions().length > 0) {
          <table class="version-table">
            <thead>
              <tr>
                <th>v</th>
                <th>Captured</th>
                <th>By</th>
                <th>Reason</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              @for (v of versions(); track v.id) {
                <tr>
                  <td class="mono">v{{ v.versionNumber }}</td>
                  <td>{{ v.capturedAt | date: 'yyyy-MM-dd HH:mm:ss' }}</td>
                  <td
                    class="small"
                    [class.muted]="!v.createdBy"
                    [title]="v.createdBy ? '' : 'Author not recorded for this version'"
                  >
                    {{ v.createdBy || '—' }}
                  </td>
                  <td class="muted small">{{ v.changeReason ?? '' }}</td>
                  <td>
                    <button
                      type="button"
                      class="btn btn-link"
                      (click)="diffWithCurrent(v)"
                      title="Show what changed between this version and current"
                    >
                      Diff
                    </button>
                    <button
                      type="button"
                      class="btn btn-link"
                      [disabled]="rollingBack()"
                      (click)="rollbackToVersion(v)"
                      [title]="'Restore strategy to v' + v.versionNumber"
                    >
                      Roll back
                    </button>
                  </td>
                </tr>
              }
            </tbody>
          </table>
          @if (diffVersion(); as dv) {
            <app-strategy-version-diff
              [version]="dv"
              [current]="current()"
              [inputDefs]="inputDefs()"
              (closed)="diffVersion.set(null)"
            />
          }
        }
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .mono {
        font-family: 'SF Mono', Menlo, monospace;
      }
      .form-input {
        width: 100%;
        height: 36px;
        padding: 0 var(--space-3);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-sm);
        font-family: inherit;
        outline: none;
        box-sizing: border-box;
        transition: border-color 0.15s ease;
      }
      .form-input:focus {
        border-color: var(--accent);
        box-shadow: 0 0 0 3px rgba(0, 113, 227, 0.1);
      }
      .btn {
        height: 36px;
        padding: 0 var(--space-5);
        border: none;
        border-radius: var(--radius-full);
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        font-family: inherit;
        cursor: pointer;
        transition: all 0.15s ease;
        display: flex;
        align-items: center;
        justify-content: center;
        min-width: 80px;
      }
      .btn:active:not(:disabled) {
        transform: scale(0.97);
      }
      .btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .version-history {
        margin-top: 16px;
        padding: 10px 12px;
        background: var(--bg-secondary, #f7f8fa);
        border: 1px solid var(--border, #e4e7eb);
        border-radius: 6px;
      }
      .version-history-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      .version-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 12px;
        margin-top: 8px;
      }
      .version-table th,
      .version-table td {
        text-align: left;
        padding: 4px 6px;
        border-bottom: 1px solid var(--border);
      }
      .version-table tr:last-child td {
        border-bottom: none;
      }
      .version-manual-capture {
        display: flex;
        gap: 6px;
        align-items: center;
        padding: 6px 0;
        margin-bottom: 6px;
        border-bottom: 1px dashed var(--border);
      }
      .version-manual-capture .form-input {
        flex: 1;
        font-size: 12px;
        padding: 4px 6px;
        height: 26px;
      }
    `,
  ],
})
export class StrategyVersionHistoryComponent {
  private readonly strategiesService = inject(StrategiesService);
  private readonly notifications = inject(NotificationService);
  private readonly dialogs = inject(ScriptDialogService);

  /** The strategy being edited. */
  readonly strategy = input.required<StrategyDto>();
  /** The form's current values in the shape a captured version records (what Diff compares against). */
  readonly current = input.required<StrategyVersionFields>();
  /** The inputs the current script declares, when known (the diff compares effective overrides). */
  readonly inputDefs = input<readonly ScriptInputDto[] | null>(null);
  /** Asked at confirm time: does the script editor hold an unsaved edit the rollback would replace? */
  readonly isScriptEdited = input<() => boolean>(() => false);

  /** The strategy as re-read after a rollback: the form patches its fields and the script editor from it. */
  readonly restored = output<StrategyDto>();
  /** A rollback went through (whether or not the re-read worked): the host re-reads the strategy. */
  readonly changed = output<void>();

  // Captured-version history for an existing strategy. Lazily loaded on
  // first expand to keep the create-modal payload light.
  readonly showVersionHistory = signal(false);
  readonly loadingVersions = signal(false);
  readonly versions = signal<StrategyVersionDto[]>([]);
  readonly rollingBack = signal(false);
  readonly capturingVersion = signal(false);
  /// Free-text reason for the manual-snapshot button — stored on the version row so operators see why.
  readonly manualCaptureReason = signal('');
  // Currently-selected version for the diff panel. Null when no diff open.
  readonly diffVersion = signal<StrategyVersionDto | null>(null);

  /** Close the drawer and forget the loaded versions (the form calls this when it re-seeds). */
  reset(): void {
    this.showVersionHistory.set(false);
    this.versions.set([]);
    this.diffVersion.set(null);
  }

  /** Open the inline diff panel for the chosen version. */
  diffWithCurrent(v: StrategyVersionDto): void {
    this.diffVersion.set(v);
  }

  /**
   * Manually snapshot the strategy's current state. The optional reason from
   * {@link manualCaptureReason} annotates the version row so operators see
   * what the bookmark was for.
   */
  captureVersionNow(): void {
    const s = this.strategy();
    if (!s || this.capturingVersion()) return;
    this.capturingVersion.set(true);
    this.strategiesService.captureVersion(s.id, this.manualCaptureReason()).subscribe({
      next: (res) => {
        this.capturingVersion.set(false);
        if (res?.status) {
          this.notifications.success(res.message ?? 'Snapshot captured');
          this.manualCaptureReason.set('');
          this.refreshVersionHistory();
        } else {
          this.notifications.error(res?.message ?? 'Failed to capture snapshot');
        }
      },
      error: () => {
        this.capturingVersion.set(false);
        this.notifications.error('Failed to capture snapshot');
      },
    });
  }

  /**
   * Toggle the version-history drawer. Lazy-loads the version list on first
   * expand so the modal payload stays light when operators don't open it.
   */
  toggleVersionHistory(): void {
    const next = !this.showVersionHistory();
    this.showVersionHistory.set(next);
    if (next && this.versions().length === 0 && !this.loadingVersions()) {
      this.refreshVersionHistory();
    }
  }

  private refreshVersionHistory(): void {
    const s = this.strategy();
    if (!s) return;
    this.loadingVersions.set(true);
    this.strategiesService.getVersions(s.id, 100).subscribe({
      next: (res) => {
        this.loadingVersions.set(false);
        this.versions.set(res?.data ?? []);
      },
      error: () => {
        this.loadingVersions.set(false);
        this.versions.set([]);
        this.notifications.error('Failed to load version history');
      },
    });
  }

  /**
   * Restore the strategy to a captured version. The engine snapshots the
   * current state first, so the rollback is reversible (operators see the
   * "pre-rollback" snapshot appear in the list afterwards). After the
   * server confirms the rollback we re-fetch the strategy and hand it to the
   * form ({@link restored}), which patches its fields in place so the operator
   * sees the restored values without having to close and reopen the modal.
   */
  async rollbackToVersion(v: StrategyVersionDto): Promise<void> {
    const s = this.strategy();
    if (!s || this.rollingBack()) return;
    const scriptEdited = this.isScriptEdited()();
    const ok = await this.dialogs.confirm({
      title: `Roll back to v${v.versionNumber}?`,
      message: `Strategy "${s.name}" returns to v${v.versionNumber}. Its current state is captured as a version first, so the rollback can be undone.`,
      details: scriptEdited
        ? ['Your unsaved script edit is replaced by the script of that version.']
        : [],
      confirmLabel: 'Roll back',
      tone: scriptEdited ? 'danger' : 'primary',
    });
    if (!ok) return;

    this.rollingBack.set(true);
    this.strategiesService.rollbackVersion(s.id, v.id).subscribe({
      next: (res) => {
        if (res?.status) {
          // Refetch the strategy so the form patches with the restored
          // server-side state — the rollback handler updates the row
          // in-place; we just need the new values.
          this.strategiesService.getById(s.id).subscribe({
            next: (g) => {
              this.rollingBack.set(false);
              const restored = g?.data;
              if (restored) this.restored.emit(restored);
              this.notifications.success(res.message ?? `Rolled back to v${v.versionNumber}`);
              this.refreshVersionHistory();
              this.changed.emit();
            },
            error: () => {
              this.rollingBack.set(false);
              // Even if the refetch fails, the rollback itself succeeded. The editor still holds
              // the old script, but a save from it is refused as stale (PE-01) instead of undoing
              // the rollback.
              this.notifications.success(
                `Rolled back to v${v.versionNumber} (form will refresh on next open)`,
              );
              this.refreshVersionHistory();
              this.changed.emit();
            },
          });
        } else {
          this.rollingBack.set(false);
          this.notifications.error(res?.message ?? 'Rollback failed');
        }
      },
      error: () => {
        this.rollingBack.set(false);
        this.notifications.error('Rollback failed');
      },
    });
  }
}
