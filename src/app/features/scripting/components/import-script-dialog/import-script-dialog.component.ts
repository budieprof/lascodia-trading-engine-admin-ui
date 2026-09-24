import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type { CurrencyPairDto } from '@core/api/api.types';
import type { ScriptCompileResult } from '@core/api/scripting.types';
import { CurrencyPairsService } from '@core/services/currency-pairs.service';
import { NotificationService } from '@core/notifications/notification.service';
import { ScriptingService, toScriptingError } from '@core/services/scripting.service';
import { readDeclarationHeader } from '../../pine/pine-scan';
import { ScriptWorkbenchComponent } from '../script-workbench/script-workbench.component';
import { SCRIPTING_UI_STYLES } from '../scripting-ui.styles';

const TIMEFRAMES = ['M1', 'M5', 'M15', 'H1', 'H4', 'D1'] as const;

/**
 * "Import Pine…" on the strategies list: paste a Pine v6 script or open a `.pine` file, pick the
 * symbol and timeframe, and `POST strategy/import` creates the strategy (Paused). The script is
 * compiled while it is edited so problems show before the import is attempted.
 *
 * Renders its own trigger button; the dialog is fixed-position and sits outside the page flow.
 */
@Component({
  selector: 'app-import-script-button',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ScriptWorkbenchComponent],
  template: `
    <button
      type="button"
      class="trigger"
      (click)="openDialog()"
      title="Create a strategy from a Pine Script v6 file"
    >
      Import Pine…
    </button>

    @if (open()) {
      <div class="overlay" role="presentation" (click)="close()" (keydown.escape)="close()">
        <div
          class="dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="import-pine-title"
          tabindex="-1"
          (click)="$event.stopPropagation()"
          (keydown)="$event.stopPropagation()"
        >
          <header class="dialog-head">
            <h3 id="import-pine-title">Import a Pine script</h3>
            <button type="button" class="close" (click)="close()" aria-label="Close">×</button>
          </header>
          <div class="dialog-body">
            <div class="fields">
              <label class="field">
                <span>Name <span class="muted small">(optional)</span></span>
                <input
                  class="field-input"
                  type="text"
                  maxlength="200"
                  [placeholder]="suggestedName() || 'From the script title'"
                  [value]="name()"
                  (input)="name.set($any($event.target).value)"
                />
              </label>
              <label class="field">
                <span>Symbol <span class="required">*</span></span>
                <input
                  class="field-input"
                  type="text"
                  list="import-pine-symbols"
                  placeholder="EURUSD"
                  [value]="symbol()"
                  (input)="symbol.set($any($event.target).value.trim().toUpperCase())"
                />
                <datalist id="import-pine-symbols">
                  @for (p of pairs(); track p.id) {
                    @if (p.symbol) {
                      <option [value]="p.symbol"></option>
                    }
                  }
                </datalist>
              </label>
              <label class="field">
                <span>Timeframe</span>
                <select
                  class="field-input"
                  [value]="timeframe()"
                  (change)="timeframe.set($any($event.target).value)"
                >
                  @for (tf of timeframes; track tf) {
                    <option [value]="tf" [selected]="tf === timeframe()">{{ tf }}</option>
                  }
                </select>
              </label>
            </div>

            <app-script-workbench
              [(source)]="content"
              [symbol]="symbol() || null"
              [timeframe]="timeframe()"
              label="Paste the script, or open a .pine file"
              fileName="import.pine"
              editorHeight="340px"
              (compiled)="compiled.set($event)"
            />

            @if (kindWarning(); as w) {
              <p class="warn">{{ w }}</p>
            }
            @if (error(); as e) {
              <div class="error-box" role="alert">{{ e }}</div>
            }
          </div>
          <footer class="dialog-foot">
            <button type="button" class="btn" (click)="close()" [disabled]="importing()">Cancel</button>
            <button
              type="button"
              class="btn btn-primary"
              (click)="submit()"
              [disabled]="!canImport() || importing()"
              [title]="blockedReason() ?? ''"
            >
              @if (importing()) {
                <span class="spinner"></span>
              }
              Import
            </button>
          </footer>
        </div>
      </div>
    }
  `,
  styles: [
    SCRIPTING_UI_STYLES,
    `
      :host {
        display: contents;
      }
      .trigger {
        height: 36px;
        padding: 0 var(--space-5, 20px);
        border: none;
        border-radius: var(--radius-full, 999px);
        background: var(--bg-tertiary);
        color: var(--text-primary);
        font: inherit;
        font-size: var(--text-sm, 13px);
        font-weight: var(--font-medium, 500);
        cursor: pointer;
        white-space: nowrap;
      }
      .trigger:hover {
        filter: brightness(0.97);
      }
      .overlay {
        position: fixed;
        inset: 0;
        z-index: 1000;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: var(--space-4, 16px);
        background: rgba(0, 0, 0, 0.5);
        backdrop-filter: blur(4px);
      }
      .dialog {
        width: min(920px, 100%);
        max-height: 92vh;
        display: flex;
        flex-direction: column;
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-lg, 16px);
        box-shadow: var(--shadow-lg);
        overflow: hidden;
      }
      .dialog-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 14px 20px;
        border-bottom: 1px solid var(--border);
      }
      .dialog-head h3 {
        margin: 0;
        font-size: var(--text-lg, 17px);
        font-weight: 600;
      }
      .close {
        border: none;
        background: transparent;
        font-size: 22px;
        line-height: 1;
        color: var(--text-secondary);
        cursor: pointer;
      }
      .dialog-body {
        display: flex;
        flex-direction: column;
        gap: 12px;
        padding: 16px 20px;
        overflow-y: auto;
      }
      .fields {
        display: grid;
        grid-template-columns: 2fr 1fr 1fr;
        gap: 12px;
      }
      @media (max-width: 720px) {
        .fields {
          grid-template-columns: 1fr;
        }
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: 4px;
        font-size: 12px;
        color: var(--text-secondary);
      }
      .required {
        color: var(--loss);
      }
      .warn {
        margin: 0;
        font-size: 12px;
        color: #b25e00;
      }
      .dialog-foot {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        padding: 12px 20px;
        border-top: 1px solid var(--border);
        background: var(--bg-secondary);
      }
    `,
  ],
})
export class ImportScriptButtonComponent {
  private readonly scripting = inject(ScriptingService);
  private readonly pairsService = inject(CurrencyPairsService);
  private readonly notifications = inject(NotificationService);
  private readonly router = inject(Router);

  readonly timeframes = TIMEFRAMES;
  readonly open = signal(false);
  readonly name = signal('');
  readonly symbol = signal('');
  readonly timeframe = signal<string>('H1');
  readonly content = signal('');
  readonly compiled = signal<ScriptCompileResult | null>(null);
  readonly importing = signal(false);
  readonly error = signal<string | null>(null);
  readonly pairs = signal<CurrencyPairDto[]>([]);
  private pairsLoaded = false;

  readonly suggestedName = computed(
    () => this.compiled()?.declaration?.title ?? readDeclarationHeader(this.content())?.title ?? '',
  );
  readonly errorCount = computed(
    () => (this.compiled()?.diagnostics ?? []).filter((d) => d.severity === 'error').length,
  );
  readonly kindWarning = computed(() => {
    const kind = this.compiled()?.declaration?.kind;
    return kind && kind !== 'strategy'
      ? `This script declares ${kind}(), not strategy() — it will not place trades.`
      : null;
  });
  readonly blockedReason = computed<string | null>(() => {
    if (!this.content().trim()) return 'Paste a script or open a .pine file';
    if (!this.symbol()) return 'Pick the symbol it runs on';
    if (this.errorCount() > 0) return 'Fix the compile errors first';
    return null;
  });
  readonly canImport = computed(() => this.blockedReason() === null);

  openDialog(): void {
    this.error.set(null);
    this.open.set(true);
    if (!this.pairsLoaded) {
      this.pairsLoaded = true;
      this.pairsService
        .list({ currentPage: 1, itemCountPerPage: 200, filter: { isActive: true } })
        .subscribe({
          next: (res) => this.pairs.set(res?.data?.data ?? []),
          error: () => this.pairs.set([]),
        });
    }
  }

  close(): void {
    if (this.importing()) return;
    this.open.set(false);
  }

  async submit(): Promise<void> {
    if (!this.canImport() || this.importing()) return;
    this.importing.set(true);
    this.error.set(null);
    try {
      const id = await firstValueFrom(
        this.scripting.importStrategy({
          content: this.content(),
          symbol: this.symbol(),
          timeframe: this.timeframe(),
          name: this.name().trim() || null,
        }),
      );
      this.notifications.success(`Imported as strategy #${id} (Paused)`);
      this.open.set(false);
      this.content.set('');
      this.name.set('');
      this.compiled.set(null);
      void this.router.navigate(['/strategies', id]);
    } catch (err) {
      const e = toScriptingError(err, 'The import failed.');
      if (e.compile) this.compiled.set(e.compile);
      this.error.set(e.message);
    } finally {
      this.importing.set(false);
    }
  }
}
