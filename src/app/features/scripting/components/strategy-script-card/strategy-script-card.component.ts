import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  linkedSignal,
  output,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { filter, firstValueFrom } from 'rxjs';

import type { StrategyDto } from '@core/api/api.types';
import type { ScriptCompileResult } from '@core/api/scripting.types';
import {
  ScriptingService,
  toScriptingError,
  type ScriptingApiError,
} from '@core/services/scripting.service';
import { StrategiesService } from '@core/services/strategies.service';
import { NotificationService } from '@core/notifications/notification.service';
import { AuthService } from '@core/auth/auth.service';
import { downloadTextFile } from '@shared/utils/download';
import { inputOverrides, parseSavedInputs, resolveInputValues } from '../../pine/pine-inputs';
import { OPERATOR_PERMISSION } from '../../shared/permissions';
import { DeclarationSummaryComponent } from '../declaration-summary/declaration-summary.component';
import { InputsFormComponent } from '../inputs-form/inputs-form.component';
import { PineEditorComponent } from '../pine-editor/pine-editor.component';
import { SCRIPTING_UI_STYLES } from '../scripting-ui.styles';

/**
 * The engine said no (a refusal envelope, 4xx) — as opposed to not answering (transport) or
 * failing (5xx), when the console's own copy of the source is a fair stand-in.
 */
function isRefusal(e: ScriptingApiError): boolean {
  if (e.httpStatus === 0 || e.httpStatus >= 500) return false;
  return e.httpStatus >= 400 || e.code !== null;
}

/**
 * A script strategy's Pine source on its detail page: read-only editor, the compiled declaration
 * and the inputs with their saved values, plus Edit (opens the strategy form in script mode) and
 * Export (`GET strategy/{id}/export` → a `.pine` download). The execution-policy and binding chips
 * open the Execution tab, the one place both are changed.
 */
@Component({
  selector: 'app-strategy-script-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PineEditorComponent, DeclarationSummaryComponent, InputsFormComponent],
  template: `
    <section class="card">
      <header class="card-head">
        <h3 class="card-title">Pine script</h3>
        <span class="chip chip-accent">Pine v{{ current().scriptLanguageVersion ?? 6 }}</span>
        @if (current().executionPolicy; as p) {
          <button
            type="button"
            class="chip chip-link"
            [title]="'Execution policy: ' + p + ' — change it on the Execution tab'"
            (click)="executionRequested.emit()"
          >
            {{ p }} policy
          </button>
        }
        @if (
          current().accountBindingCount !== null && current().accountBindingCount !== undefined
        ) {
          <button
            type="button"
            class="chip chip-link"
            [class.chip-warn]="current().accountBindingCount === 0"
            [title]="
              (current().accountBindingCount === 0
                ? 'Not bound to any account — runs on the emulator only'
                : 'Trades live on the bound accounts') + ' — manage them on the Execution tab'
            "
            (click)="executionRequested.emit()"
          >
            {{ current().accountBindingCount }} account binding{{
              current().accountBindingCount === 1 ? '' : 's'
            }}
          </button>
        }
        <span class="spacer"></span>
        <button type="button" class="btn btn-ghost btn-sm" (click)="copy()">Copy</button>
        <!-- PE-11 / PE-I13: exporting and editing need operator access in the engine. -->
        @if (canOperate()) {
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            (click)="export()"
            [disabled]="exporting()"
          >
            Export .pine
          </button>
          <button type="button" class="btn btn-primary btn-sm" (click)="editRequested.emit()">
            Edit script
          </button>
        } @else {
          <span class="muted small" title="Exporting and editing need operator access"
            >Read-only</span
          >
        }
      </header>

      <div class="card-body">
        <div class="editor-cell">
          <app-pine-editor
            [value]="source()"
            [readOnly]="true"
            [diagnostics]="compiled()?.diagnostics ?? []"
            height="100%"
            ariaLabel="Strategy script (read-only)"
          />
        </div>
        <div class="side">
          <h4 class="side-title">Declaration</h4>
          <app-declaration-summary
            [declaration]="compiled()?.declaration ?? null"
            [emptyText]="compileError() ?? 'Reading the declaration…'"
          />
          <h4 class="side-title">
            Inputs
            @if (overrideCount()) {
              <span class="muted small">· {{ overrideCount() }} set on this strategy</span>
            }
          </h4>
          @if (compiled(); as c) {
            <app-inputs-form
              [inputs]="c.inputs"
              [overrides]="savedInputs()"
              [disabled]="true"
              [showReset]="false"
            />
          } @else if (overrideCount()) {
            <ul class="raw-inputs">
              @for (e of savedEntries(); track e[0]) {
                <li>
                  <span class="mono">{{ e[0] }}</span> = <span class="mono">{{ e[1] }}</span>
                </li>
              }
            </ul>
          } @else {
            <p class="muted small">Every input is at its default.</p>
          }
        </div>
      </div>
    </section>
  `,
  styles: [
    SCRIPTING_UI_STYLES,
    `
      :host {
        display: block;
      }
      .card {
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md, 12px);
        padding: var(--space-4, 16px);
      }
      .card-head {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
        margin-bottom: 12px;
      }
      .card-title {
        margin: 0;
        font-size: var(--text-base, 15px);
        font-weight: var(--font-semibold, 600);
      }
      .spacer {
        flex: 1;
      }
      .card-body {
        display: grid;
        grid-template-columns: minmax(0, 1.6fr) minmax(260px, 1fr);
        gap: 16px;
        /* Stretch so the editor cell matches the declaration/inputs column's height. */
        align-items: stretch;
      }
      /* The side column drives the row height; the editor is taken out of flow so its own
         content never grows the row, and fills whatever height the side column sets. */
      .editor-cell {
        position: relative;
        min-width: 0;
        min-height: 380px;
      }
      .editor-cell app-pine-editor {
        position: absolute;
        inset: 0;
      }
      @media (max-width: 1000px) {
        .card-body {
          grid-template-columns: minmax(0, 1fr);
        }
      }
      .side {
        min-width: 0;
      }
      .side-title {
        margin: 0 0 6px;
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-secondary);
      }
      .side-title:not(:first-child) {
        margin-top: 14px;
      }
      .raw-inputs {
        margin: 0;
        padding-left: 16px;
        font-size: 12px;
      }
      .chip-link {
        border: none;
        font-family: inherit;
        cursor: pointer;
      }
      .chip-link:hover {
        text-decoration: underline;
      }
    `,
  ],
})
export class StrategyScriptCardComponent {
  readonly strategy = input.required<StrategyDto>();
  /** Open the strategy form on the script. */
  readonly editRequested = output<void>();
  /** Open the Execution tab (execution policy, account bindings). */
  readonly executionRequested = output<void>();

  private readonly scripting = inject(ScriptingService);
  private readonly strategies = inject(StrategiesService);
  private readonly notifications = inject(NotificationService);
  private readonly auth = inject(AuthService);

  /** PE-I13: Export and Edit need operator access in the engine. */
  readonly canOperate = computed(() => this.auth.hasPermission(OPERATOR_PERMISSION));

  /** The strategy as last read — refreshed when its script is saved from the form. */
  readonly current = linkedSignal(() => this.strategy());
  readonly source = computed(() => this.current().scriptSource ?? '');
  readonly savedInputs = computed(() => parseSavedInputs(this.current().scriptInputs));
  readonly savedEntries = computed(() => Object.entries(this.savedInputs()));
  /**
   * Overrides that still apply: once the script is compiled, only those naming an input it
   * declares (coerced to its range) — an override of a removed input changes nothing.
   */
  readonly overrideCount = computed(() => {
    const c = this.compiled();
    if (!c?.declaration) return this.savedEntries().length;
    return Object.keys(inputOverrides(c.inputs, resolveInputValues(c.inputs, this.savedInputs())))
      .length;
  });
  readonly compiled = signal<ScriptCompileResult | null>(null);
  readonly compileError = signal<string | null>(null);
  readonly exporting = signal(false);

  constructor() {
    effect(() => {
      const src = this.source();
      const s = this.current();
      untracked(() => void this.compileSource(src, s.symbol, s.timeframe));
    });
    this.scripting.strategyScriptSaved$
      .pipe(
        filter((id) => id === this.current().id),
        takeUntilDestroyed(inject(DestroyRef)),
      )
      .subscribe((id) => void this.reload(id));
  }

  private async compileSource(
    source: string,
    symbol: string | null,
    timeframe: string | null,
  ): Promise<void> {
    if (!source.trim()) {
      this.compiled.set(null);
      return;
    }
    try {
      const r = await firstValueFrom(this.scripting.compile({ source, symbol, timeframe }));
      if (source === this.source()) {
        this.compiled.set(r);
        this.compileError.set(null);
      }
    } catch (err) {
      this.compileError.set(toScriptingError(err, 'The declaration could not be read.').message);
    }
  }

  private async reload(id: number): Promise<void> {
    try {
      const res = await firstValueFrom(this.strategies.getById(id));
      if (res?.status && res.data) this.current.set(res.data);
    } catch {
      /* the page's own refresh will catch up */
    }
  }

  /**
   * `GET strategy/{id}/export`. When the engine cannot be reached (or fails) the source the
   * console holds is downloaded instead — but a refusal (no permission, not found, refused) is
   * shown as such and nothing is downloaded around it (PE-11).
   */
  async export(): Promise<void> {
    const s = this.current();
    this.exporting.set(true);
    try {
      const file = await firstValueFrom(this.scripting.exportStrategy(s.id));
      downloadTextFile(file.fileName || `${s.name ?? 'strategy'}.pine`, file.content);
    } catch (err) {
      const e = toScriptingError(err, 'Exporting failed.');
      if (isRefusal(e)) {
        this.notifications.error(
          e.httpStatus === 401 || e.httpStatus === 403
            ? 'You do not have permission to export this strategy.'
            : e.message,
        );
        return;
      }
      // The engine's export is the canonical file; if it is unavailable, the source still is.
      downloadTextFile(`${(s.name ?? 'strategy').replace(/\s+/g, '_')}.pine`, this.source());
      this.notifications.info(`Exported the source held by the console (${e.message}).`);
    } finally {
      this.exporting.set(false);
    }
  }

  async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.source());
      this.notifications.success('Script copied');
    } catch {
      this.notifications.error('The clipboard is not available here');
    }
  }
}
