import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  afterNextRender,
  computed,
  effect,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';

import type { ScriptInputDto, ScriptInputValues } from '@core/api/scripting.types';
import { InputsFormComponent } from '@features/scripting/components/inputs-form/inputs-form.component';
import {
  inputOverrides,
  resolveInputValues,
  sameInputValues,
} from '@features/scripting/pine/pine-inputs';

/** Edits apply live; a burst of them (a colour being dragged) settles into one re-run. */
export const SCRIPT_SETTINGS_APPLY_MS = 200;

/**
 * TradingView's study Settings dialog for a Pine script on the chart: its inputs laid out as the
 * script declares them (the shared inputs form — `group` headings, `inline` rows, tooltips), with
 * Defaults ▾ / Cancel / Ok.
 *
 * Edits preview live on the chart, as in TradingView: each one is emitted as `changed` (only the
 * inputs that differ from their defaults) once the edits pause for
 * {@link SCRIPT_SETTINGS_APPLY_MS}. Ok keeps them; Cancel, × and Esc put back the values the
 * dialog opened with.
 */
@Component({
  selector: 'app-script-settings-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [InputsFormComponent],
  template: `
    <div class="sd-backdrop" (pointerdown)="cancel()"></div>
    <div
      #box
      class="sd"
      role="dialog"
      aria-modal="true"
      tabindex="-1"
      [attr.aria-label]="title() + ' settings'"
      (keydown)="$event.stopPropagation()"
      (keydown.escape)="cancel()"
    >
      <header class="sd-head">
        <span class="sd-title" [title]="title()">{{ title() }}</span>
        <button type="button" class="sd-x" aria-label="Close" (click)="cancel()">×</button>
      </header>
      <nav class="sd-tabs">
        <span class="sd-tab on">Inputs</span>
      </nav>
      <div class="sd-body">
        @if (inputs(); as list) {
          <app-inputs-form
            [inputs]="list"
            [overrides]="draft()"
            (overridesChange)="edit($event)"
            [showReset]="false"
            emptyText="This script has no inputs."
          />
        } @else {
          <p class="sd-hint" role="status">Loading the strategy's saved inputs…</p>
        }
      </div>
      <footer class="sd-foot">
        <span class="sd-anchor">
          <button
            type="button"
            class="sd-btn"
            aria-haspopup="menu"
            [attr.aria-expanded]="menuOpen()"
            (click)="menuOpen.set(!menuOpen())"
          >
            Defaults ▾
          </button>
          @if (menuOpen()) {
            <div class="sd-menu" role="menu">
              <button
                type="button"
                role="menuitem"
                [disabled]="!changedCount()"
                (click)="reset()"
                title="Put every input back to the script's own defaults"
              >
                Reset to defaults
              </button>
              @if (canSaveDefault()) {
                <button
                  type="button"
                  role="menuitem"
                  [disabled]="savingDefault() || !inputs()"
                  (click)="saveAsDefault()"
                  title="A copy of this script added to a chart starts with these inputs"
                >
                  {{ savingDefault() ? 'Saving…' : 'Save as default' }}
                </button>
              }
            </div>
          }
        </span>
        @if (changedCount(); as n) {
          <span class="sd-note">{{ n }} changed from default</span>
        }
        <span class="sd-spacer"></span>
        <button type="button" class="sd-btn" (click)="cancel()">Cancel</button>
        <button type="button" class="sd-btn primary" (click)="ok()">Ok</button>
      </footer>
    </div>
  `,
  styles: `
    /* No box of its own: the page lays its panes out with gaps, and a modal is not one of them. */
    :host {
      display: contents;
    }
    .sd-backdrop {
      position: fixed;
      inset: 0;
      z-index: 1000;
      background: rgba(0, 0, 0, 0.2);
    }
    .sd {
      position: fixed;
      z-index: 1001;
      left: 50%;
      top: 50%;
      transform: translate(-50%, -50%);
      width: min(540px, calc(100vw - 32px));
      max-height: calc(100vh - 64px);
      display: flex;
      flex-direction: column;
      background: var(--tv-bg, #fff);
      color: var(--tv-ink, #131722);
      border-radius: 6px;
      box-shadow: 0 2px 24px rgba(0, 0, 0, 0.3);
      font-size: 14px;
      outline: none;
    }
    .sd-head {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 16px 20px 10px;
    }
    .sd-title {
      flex: 1;
      min-width: 0;
      font-size: 20px;
      font-weight: 600;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .sd-x {
      border: 0;
      background: none;
      color: var(--tv-muted, #787b86);
      font-size: 24px;
      cursor: pointer;
      line-height: 1;
    }
    .sd-tabs {
      display: flex;
      gap: 18px;
      padding: 0 20px;
      border-bottom: 1px solid var(--tv-line, #e0e3eb);
    }
    .sd-tab {
      padding: 8px 0;
      margin-bottom: -1px;
      border-bottom: 3px solid transparent;
      color: var(--tv-muted, #787b86);
    }
    .sd-tab.on {
      color: var(--tv-ink, #131722);
      border-bottom-color: var(--tv-ink, #131722);
    }
    .sd-body {
      flex: 1;
      min-height: 120px;
      padding: 14px 20px;
      overflow: auto;
    }
    .sd-hint {
      margin: 0;
      color: var(--tv-muted, #787b86);
      font-size: 13px;
    }
    .sd-foot {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 14px 20px;
      border-top: 1px solid var(--tv-line, #e0e3eb);
    }
    .sd-spacer {
      flex: 1;
    }
    .sd-note {
      color: var(--tv-muted, #787b86);
      font-size: 12px;
      white-space: nowrap;
    }
    .sd-anchor {
      position: relative;
      display: inline-flex;
    }
    .sd-btn {
      height: 34px;
      padding: 0 16px;
      border-radius: 6px;
      border: 1px solid var(--tv-line, #e0e3eb);
      background: var(--tv-bg, #fff);
      color: inherit;
      font: inherit;
      cursor: pointer;
      white-space: nowrap;
    }
    .sd-btn:hover {
      background: var(--tv-hover, #f0f3fa);
    }
    .sd-btn.primary {
      background: var(--tv-ink, #131722);
      color: var(--tv-bg, #fff);
      border-color: var(--tv-ink, #131722);
    }
    .sd-menu {
      position: absolute;
      bottom: calc(100% + 4px);
      left: 0;
      z-index: 5;
      min-width: 200px;
      padding: 6px 0;
      background: var(--tv-bg, #fff);
      border-radius: 6px;
      box-shadow:
        var(--tv-menu-shadow, 0 2px 4px rgba(0, 0, 0, 0.2)),
        0 0 0 1px var(--tv-line, #e0e3eb);
    }
    .sd-menu button {
      display: block;
      width: 100%;
      padding: 8px 14px;
      border: 0;
      background: none;
      color: inherit;
      font: inherit;
      text-align: left;
      cursor: pointer;
    }
    .sd-menu button:hover:not(:disabled) {
      background: var(--tv-hover, #f0f3fa);
    }
    .sd-menu button:disabled {
      color: var(--tv-muted, #787b86);
      cursor: default;
    }
    @media (max-width: 480px) {
      .sd-note {
        display: none;
      }
      .sd-btn {
        padding: 0 12px;
      }
    }
  `,
})
export class ScriptSettingsDialogComponent implements OnDestroy {
  /** The script's name, as its chip shows it. */
  readonly title = input('');
  /** The script's inputs; null while the defaults are still being read (an engine strategy's). */
  readonly inputs = input<readonly ScriptInputDto[] | null>(null);
  /** The overrides the script runs with on the chart. */
  readonly values = input<ScriptInputValues>({});
  /** The script is saved in the engine ("My scripts"), so it can keep default inputs. */
  readonly canSaveDefault = input(false);
  readonly savingDefault = input(false);

  /** New overrides to run the script with (only the inputs that differ from their defaults). */
  readonly changed = output<ScriptInputValues>();
  /** "Save as default" with these overrides. */
  readonly saveDefault = output<ScriptInputValues>();
  readonly closed = output<void>();

  /** The overrides the form shows — ahead of `values` while an edit waits to apply. */
  readonly draft = signal<ScriptInputValues>({});
  readonly menuOpen = signal(false);
  readonly changedCount = computed(() => Object.keys(this.overridesOf(this.draft())).length);

  private readonly box = viewChild<ElementRef<HTMLElement>>('box');
  /** The values the dialog opened with: what Cancel puts back. */
  private opened: ScriptInputValues | null = null;
  /** The newest values the chart runs with, as far as this dialog knows (emitted or received). */
  private applied: ScriptInputValues = {};
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closedOnce = false;

  constructor() {
    effect(() => {
      const values = this.values();
      untracked(() => this.receive(values));
    });
    // Esc works at once, without a click into the dialog first.
    afterNextRender(() => this.box()?.nativeElement.focus());
  }

  /**
   * The values the script runs with: the first are what Cancel puts back. Later ones changed
   * elsewhere (the strategy tester, the assistant) replace the form's — unless an edit here is
   * still waiting to apply, or they are the ones this dialog sent.
   */
  receive(values: ScriptInputValues): void {
    if (this.opened === null) {
      this.opened = values;
      this.applied = values;
      this.draft.set(values);
      return;
    }
    if (this.timer !== null || sameInputValues(values, this.applied)) return;
    this.applied = values;
    this.draft.set(values);
  }

  /** An edit in the form: shown at once, applied when the edits pause. */
  edit(overrides: ScriptInputValues): void {
    this.draft.set(overrides);
    this.clearTimer();
    this.timer = setTimeout(() => this.apply(), SCRIPT_SETTINGS_APPLY_MS);
  }

  /** Apply the form's values now, if the chart does not run with them already. */
  apply(): void {
    this.clearTimer();
    const draft = this.draft();
    if (sameInputValues(draft, this.applied)) return;
    this.applied = draft;
    this.changed.emit(draft);
  }

  reset(): void {
    this.menuOpen.set(false);
    this.draft.set({});
    this.apply();
  }

  saveAsDefault(): void {
    this.menuOpen.set(false);
    this.apply();
    this.saveDefault.emit(this.overridesOf(this.draft()));
  }

  ok(): void {
    if (this.closedOnce) return;
    this.closedOnce = true;
    this.apply();
    this.closed.emit();
  }

  cancel(): void {
    if (this.closedOnce) return;
    this.closedOnce = true;
    this.clearTimer();
    const opened = this.opened ?? {};
    if (!sameInputValues(opened, this.applied)) {
      this.applied = opened;
      this.changed.emit(opened);
    }
    this.closed.emit();
  }

  ngOnDestroy(): void {
    // Closed from outside (the script left the chart, the layout was replaced): an edit still
    // waiting is dropped — its script may not be the one on the chart any more.
    this.clearTimer();
  }

  /** Only the values that differ from the inputs' defaults (and still apply to them). */
  private overridesOf(values: ScriptInputValues): ScriptInputValues {
    const list = this.inputs();
    return list ? inputOverrides(list, resolveInputValues(list, values)) : {};
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
