import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

import { SCRIPTING_UI_STYLES } from '../components/scripting-ui.styles';
import { ScreenFiltersEditorComponent } from './screen-filters-editor.component';
import {
  MAX_SCREEN_NAME,
  SCREEN_CHANNELS,
  SCREEN_SEVERITIES,
  isoText,
  scheduleText,
  screenSourceText,
  type FilterColumnOption,
  type ScreenSettingsDraft,
} from './screens.model';
import type { ScreenFilter, ScriptScreenDto } from './screens.types';

const CHANNEL_LABELS: Record<string, string> = {
  InApp: 'In-app (bell + pop-up)',
  Telegram: 'Telegram',
  Email: 'Email',
  Webhook: 'Webhook',
};

/**
 * SS-I6 / BX-6 — the screen half of the screener: name the screen, set the filters that decide a match, switch on the
 * schedule (a run at every bar close) and the alerts for symbols entering or leaving the matches. The engine checks and
 * stores the definition; the page sends it.
 */
@Component({
  selector: 'app-screen-settings',
  standalone: true,
  imports: [ScreenFiltersEditorComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card" aria-labelledby="scr-screen-title" data-testid="screen-settings">
      <header class="head">
        <h2 class="card-title" id="scr-screen-title">
          {{ screen() ? 'Screen: ' + screen()!.name : 'Save as a screen' }}
        </h2>
        @if (screen(); as s) {
          <span class="chip">{{ sourceText() }}</span>
          <span class="chip" [class.chip-ok]="s.scheduleEnabled" data-testid="screen-schedule">
            {{ scheduleLine() }}
          </span>
        }
      </header>

      @if (screen(); as s) {
        @if (s.sourceMissing) {
          <p class="banner warn" role="status" data-testid="source-missing">
            The {{ originNoun() }} this screen copied its script from no longer exists, or you can
            no longer read it. The screen keeps running its copy.
          </p>
        } @else if (s.sourceChanged) {
          <div class="banner warn" role="status" data-testid="source-changed">
            <span>
              The {{ originNoun() }} changed since this screen copied its script. The screen keeps
              running its copy until you take the new one.
            </span>
            <button
              type="button"
              class="btn btn-sm"
              data-testid="refresh-source"
              [disabled]="!canWrite() || saving()"
              (click)="refreshSource.emit()"
            >
              Use the current script
            </button>
          </div>
        }
        @if (s.statusReason && !s.scheduleEnabled) {
          <p class="banner error" role="status">The schedule stopped: {{ s.statusReason }}</p>
        }
        @if (s.lastRunError) {
          <p class="banner error" role="status">
            The last run ({{ lastRunText() }}) failed: {{ s.lastRunError }}
          </p>
        }
      }

      <label class="field">
        <span class="muted small">Name</span>
        <input
          class="field-input"
          type="text"
          data-testid="screen-name"
          [attr.maxlength]="maxName"
          [value]="draft().name"
          [disabled]="!canWrite()"
          (input)="set('name', $any($event.target).value)"
        />
      </label>

      <div class="block">
        <h3 class="sub">Filters</h3>
        <p class="muted small">
          A symbol matches the screen when every filter passes on its last bar. Pick a column the
          results show, or type a plot title.
        </p>
        <app-screen-filters-editor
          [filters]="draft().filters"
          [columns]="columns()"
          [mainTimeframe]="mainTimeframe()"
          [extraTimeframes]="extraTimeframes()"
          [disabled]="!canWrite()"
          (filtersChange)="setFilters($event)"
        />
      </div>

      <div class="block">
        <h3 class="sub">Schedule and alerts</h3>
        <label class="check">
          <input
            type="checkbox"
            data-testid="screen-scheduled"
            [checked]="draft().scheduleEnabled"
            [disabled]="!canWrite()"
            (change)="set('scheduleEnabled', $any($event.target).checked)"
          />
          Run when each {{ mainTimeframe() }} bar closes
        </label>
        <p class="muted small">
          Each scheduled run stores the matches. Only scheduled runs alert, and the first run after
          a change to what decides a match sets the starting point without alerting.
        </p>
        <div class="row">
          <label class="check">
            <input
              type="checkbox"
              data-testid="alert-enter"
              [checked]="draft().alertOnEnter"
              [disabled]="!canWrite()"
              (change)="set('alertOnEnter', $any($event.target).checked)"
            />
            Alert when a symbol starts matching
          </label>
          <label class="check">
            <input
              type="checkbox"
              data-testid="alert-leave"
              [checked]="draft().alertOnLeave"
              [disabled]="!canWrite()"
              (change)="set('alertOnLeave', $any($event.target).checked)"
            />
            Alert when it stops matching
          </label>
        </div>
        @if (alerting()) {
          <fieldset class="channels">
            <legend class="muted small">Send alerts to</legend>
            @for (c of channels; track c) {
              <label class="check">
                <input
                  type="checkbox"
                  [attr.data-channel]="c"
                  [checked]="draft().channels.includes(c)"
                  [disabled]="!canWrite()"
                  (change)="toggleChannel(c, $any($event.target).checked)"
                />
                {{ channelLabel(c) }}
              </label>
            }
            <label class="sev">
              <span class="muted small">Severity</span>
              <select
                class="field-input"
                [disabled]="!canWrite()"
                (change)="set('severity', $any($event.target).value)"
              >
                @for (s of severities; track s) {
                  <option [value]="s" [selected]="draft().severity === s">{{ s }}</option>
                }
              </select>
            </label>
          </fieldset>
          @if (!draft().scheduleEnabled) {
            <p class="muted small">Alerts are sent only while the schedule is on.</p>
          }
        }
      </div>

      @if (problem(); as p) {
        <p class="error-box" role="alert" data-testid="screen-problem">{{ p }}</p>
      } @else if (note(); as n) {
        <p class="banner ok" role="status" data-testid="screen-note">{{ n }}</p>
      }
      <div class="actions">
        @if (screen()) {
          <button
            type="button"
            class="btn btn-ghost"
            data-testid="close-screen"
            [disabled]="saving()"
            (click)="closeScreen.emit()"
          >
            Close
          </button>
          <button
            type="button"
            class="btn"
            data-testid="save-as-new"
            [disabled]="!canWrite() || saving()"
            [attr.title]="writeTitle()"
            (click)="saveAsNew.emit()"
          >
            Save as new
          </button>
        }
        <button
          type="button"
          class="btn btn-primary"
          data-testid="save-screen"
          [disabled]="!canWrite() || saving()"
          [attr.title]="writeTitle()"
          (click)="save.emit()"
        >
          @if (saving()) {
            <span class="spinner" aria-hidden="true"></span>
          }
          {{ screen() ? 'Update screen' : 'Save screen' }}
        </button>
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
        padding: var(--space-5);
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
        min-width: 0;
      }
      .head {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
      }
      .card-title {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .sub {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .block {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: 2px;
        max-width: 480px;
      }
      .row {
        display: flex;
        flex-wrap: wrap;
        gap: 4px 16px;
      }
      .check {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: var(--text-sm);
      }
      .channels {
        margin: 0;
        padding: 8px 10px;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px 16px;
      }
      .sev {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .banner {
        margin: 0;
        padding: 8px 12px;
        border-radius: var(--radius-sm);
        font-size: var(--text-sm);
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
        justify-content: space-between;
      }
      .banner.warn {
        background: rgba(255, 159, 10, 0.1);
        color: var(--text-primary);
      }
      .banner.error {
        background: rgba(255, 59, 48, 0.08);
        color: var(--loss);
      }
      .banner.ok {
        background: rgba(52, 199, 89, 0.1);
        color: var(--text-primary);
      }
      .actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
      }
      p {
        margin: 0;
      }
    `,
  ],
})
export class ScreenSettingsComponent {
  readonly draft = input.required<ScreenSettingsDraft>();
  /** The saved screen open on the page; null while building a new one. */
  readonly screen = input<ScriptScreenDto | null>(null);
  readonly columns = input<readonly FilterColumnOption[]>([]);
  readonly mainTimeframe = input('');
  readonly extraTimeframes = input<readonly string[]>([]);
  readonly canWrite = input(true);
  readonly saving = input(false);
  readonly problem = input<string | null>(null);
  /** What the last save or action did (shown when there is no problem). */
  readonly note = input<string | null>(null);

  readonly draftChange = output<ScreenSettingsDraft>();
  readonly save = output<void>();
  readonly saveAsNew = output<void>();
  readonly closeScreen = output<void>();
  readonly refreshSource = output<void>();

  readonly maxName = MAX_SCREEN_NAME;
  readonly channels = SCREEN_CHANNELS;
  readonly severities = SCREEN_SEVERITIES;

  readonly alerting = computed(() => this.draft().alertOnEnter || this.draft().alertOnLeave);
  readonly sourceText = computed(() => {
    const s = this.screen();
    return s ? screenSourceText(s) : '';
  });
  readonly scheduleLine = computed(() => {
    const s = this.screen();
    return s ? `Schedule: ${scheduleText(s)}` : '';
  });
  readonly lastRunText = computed(() => isoText(this.screen()?.lastRunAt));
  readonly originNoun = computed(() =>
    this.screen()?.sourceKind === 'ChartScript' ? 'chart script' : 'strategy',
  );
  readonly writeTitle = computed(() =>
    this.canWrite() ? null : 'Saving a screen needs the operator permission.',
  );

  channelLabel(c: string): string {
    return CHANNEL_LABELS[c] ?? c;
  }

  set<K extends keyof ScreenSettingsDraft>(key: K, value: ScreenSettingsDraft[K]): void {
    this.draftChange.emit({ ...this.draft(), [key]: value });
  }

  setFilters(filters: ScreenFilter[]): void {
    this.set('filters', filters);
  }

  toggleChannel(channel: string, on: boolean): void {
    const current = this.draft().channels.filter((c) => c !== channel);
    // Keep the engine's order (InApp, Telegram, Email, Webhook).
    const next = on ? SCREEN_CHANNELS.filter((c) => c === channel || current.includes(c)) : current;
    this.set('channels', [...next]);
  }
}
