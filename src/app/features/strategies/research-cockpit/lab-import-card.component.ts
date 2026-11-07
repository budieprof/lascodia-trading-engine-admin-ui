import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { AuthService } from '@core/auth/auth.service';
import { Permission } from '@core/auth/permissions.generated';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { describeFailure } from '@features/scripting/shared/api-error';

import { COCKPIT_CARD_STYLES } from './cockpit.styles';
import { ResearchCockpitApiService } from './research-cockpit-api.service';
import { LAB_MAX_TRIALS, parseLabImport, type LabParse } from './research-cockpit.model';
import type { ImportLabTrialsResultDto } from './research-cockpit.types';

/** Largest file read in the browser (a 500-trial export with long trade lists stays well under it). */
export const LAB_FILE_MAX_BYTES = 20 * 1024 * 1024;

/**
 * U12 / V16 — import research-lab trials into the lineage's trial ledger (`POST strategy-feedback/{id}/trials/lab-import`).
 * Every trial counts toward the multiple-testing N; the engine re-runs each as a reproduction backtest and marks it
 * Verified only when its numbers match. The file is checked against the engine's rules before anything is sent, and the
 * import itself is an operator action behind a confirm dialog.
 */
@Component({
  selector: 'app-lab-import-card',
  standalone: true,
  imports: [ConfirmDialogComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (canOperate()) {
      <section class="card" aria-labelledby="li-title" data-testid="lab-import">
        <header class="head">
          <h3 id="li-title" class="title">Import lab trials</h3>
        </header>
        <p class="muted small">
          A JSON export: <code>&#123; "batch", "trials": [ … ] &#125;</code> or a bare array. Each
          trial: <code>windowFromUtc</code>, <code>windowToUtc</code>,
          <code>tradeR</code> (per-trade R), <code>dataHash</code>, <code>codeHash</code>, and
          <code>inputs</code> (by id) or <code>inputsByTitle</code>. At most {{ max }} trials. Every
          imported trial counts toward the deflated-Sharpe trial count, whatever its verification.
        </p>
        <div class="actions">
          <label class="field">
            <span class="muted small">Batch name</span>
            <input
              class="field-input"
              type="text"
              maxlength="128"
              [value]="batch()"
              (input)="batch.set($any($event.target).value)"
            />
          </label>
          <label class="field">
            <span class="muted small">Export file</span>
            <input
              type="file"
              accept=".json,application/json"
              (change)="pick($event)"
              data-testid="li-file"
            />
          </label>
        </div>
        @if (parsed(); as p) {
          @if (p.errors.length > 0) {
            <ul class="error-box" role="alert" data-testid="li-errors">
              @for (e of p.errors.slice(0, 12); track e) {
                <li>{{ e }}</li>
              }
              @if (p.errors.length > 12) {
                <li>… and {{ p.errors.length - 12 }} more</li>
              }
            </ul>
          } @else {
            <p class="small" data-testid="li-ready">
              {{ p.trials.length }} trial{{ p.trials.length === 1 ? '' : 's' }} ready in batch “{{
                p.batch
              }}”, {{ totalTrades() }} trades in all.
            </p>
            <div class="actions">
              <button
                type="button"
                class="btn btn-primary btn-sm"
                [disabled]="busy()"
                (click)="confirmOpen.set(true)"
              >
                Import…
              </button>
            </div>
          }
        }
        @if (error(); as e) {
          <p class="error-box" role="alert">{{ e }}</p>
        }
        @if (result(); as r) {
          <div class="note" role="status" data-testid="li-result">
            <p>
              Imported {{ r.imported }}, {{ r.duplicates }} already in the ledger,
              {{ r.reproductionsQueued }} reproduction backtest{{
                r.reproductionsQueued === 1 ? '' : 's'
              }}
              queued (lineage #{{ r.lineageRootStrategyId }}).
            </p>
            @for (n of r.notes; track n) {
              <p class="muted small">{{ n }}</p>
            }
          </div>
        }
      </section>

      <app-confirm-dialog
        [open]="confirmOpen()"
        title="Import the lab trials?"
        [message]="confirmMessage()"
        confirmLabel="Import"
        [loading]="busy()"
        (confirm)="submit()"
        (cancelled)="confirmOpen.set(false)"
      />
    }
  `,
  styles: [
    COCKPIT_CARD_STYLES,
    `
      .field {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      ul.error-box {
        margin: 0;
        padding-left: 24px;
      }
      code {
        font-size: var(--text-xs);
      }
    `,
  ],
})
export class LabImportCardComponent {
  private readonly api = inject(ResearchCockpitApiService);
  private readonly auth = inject(AuthService);

  readonly strategyId = input.required<number>();

  readonly max = LAB_MAX_TRIALS;
  readonly batch = signal('');
  readonly fileText = signal<string | null>(null);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly result = signal<ImportLabTrialsResultDto | null>(null);
  readonly confirmOpen = signal(false);

  readonly canOperate = computed(() => this.auth.hasPermission(Permission.AccessOperator));
  readonly parsed = computed<LabParse | null>(() => {
    const t = this.fileText();
    return t === null ? null : parseLabImport(t, this.batch());
  });
  readonly totalTrades = computed(() =>
    (this.parsed()?.trials ?? []).reduce((a, t) => a + t.tradeR.length, 0),
  );
  readonly confirmMessage = computed(() => {
    const p = this.parsed();
    return p
      ? `${p.trials.length} trial(s) join the lineage's trial ledger for good (they raise the multiple-testing count) and one reproduction backtest per trial is queued.`
      : '';
  });

  async pick(event: Event): Promise<void> {
    this.error.set(null);
    this.result.set(null);
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    if (file.size > LAB_FILE_MAX_BYTES) {
      this.fileText.set(null);
      this.error.set('The file is larger than 20 MB.');
      return;
    }
    this.fileText.set(await file.text());
  }

  async submit(): Promise<void> {
    const p = this.parsed();
    if (!p || p.errors.length > 0 || !this.canOperate()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const res = await firstValueFrom(
        this.api.importLabTrials(this.strategyId(), p.batch, p.trials),
      );
      if (res?.status && res.data) {
        this.result.set(res.data);
        this.fileText.set(null);
      } else this.error.set(describeFailure(res, 'The import was refused.'));
    } catch (err) {
      this.error.set(describeFailure(err, 'The import was refused.'));
    } finally {
      this.busy.set(false);
      this.confirmOpen.set(false);
    }
  }
}
