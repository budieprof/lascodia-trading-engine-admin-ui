import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';

import type { AlertChannel, AlertSeverity } from '@core/api/api.types';
import {
  CHANNEL_OPTIONS,
  DIRECTIONS,
  FREQUENCIES,
  SEVERITIES,
  SIDES,
  type AlertDirection,
  alreadyMetReason,
  conditionFor,
  defaultChannel,
  defaultLevel,
  directionOf,
  isChannelDirection,
  roundTo,
} from './chart-alert-rules';
import { ChartAlertsService } from './chart-alerts.service';
import type {
  ChartAlertDto,
  ChartAlertFrequency,
  ChartAlertInput,
  ChartAlertSide,
} from './chart-alerts.types';

/**
 * Create or edit a chart alert (alerts v2). The direction is explicit — "crosses above" / "crosses below" / either / a
 * channel — and the level starts 10 points beyond the live price on the chosen side, never at it: the old form
 * pre-filled the last close, guessed the direction from it and the alert fired at once (SP-02). A level the price has
 * already reached is refused here with the engine's own words before the round trip.
 */
@Component({
  selector: 'app-chart-alert-form',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form class="caf" (submit)="$event.preventDefault(); save()" novalidate>
      <div class="caf-head">{{ heading() }}</div>

      @if (isDrawing()) {
        <p class="caf-note">
          On the {{ drawingLabel() }} — its level follows the drawing bar by bar.
        </p>
      }

      <!-- [selected] per option, not [value] on the select: the options of a @for do not exist yet when the select's
           value is applied, and the browser then shows the first one whatever the alert says. -->
      <label class="caf-row">
        <span>When</span>
        <select (change)="setDirection($any($event.target).value)" data-testid="caf-direction">
          @for (d of directionChoices(); track d.id) {
            <option [value]="d.id" [selected]="d.id === direction()">{{ d.label }}</option>
          }
        </select>
      </label>

      <label class="caf-row">
        <span>Price</span>
        <select (change)="setSide($any($event.target).value)" data-testid="caf-side">
          @for (s of sides; track s.id) {
            <option [value]="s.id" [title]="s.hint" [selected]="s.id === side()">
              {{ s.label }}
            </option>
          }
        </select>
      </label>

      @if (!isDrawing()) {
        @if (isChannel()) {
          <label class="caf-row">
            <span>Lower</span>
            <input
              type="number"
              [step]="step()"
              [value]="lower()"
              (input)="lower.set(num($event))"
              data-testid="caf-lower"
            />
          </label>
          <label class="caf-row">
            <span>Upper</span>
            <input
              type="number"
              [step]="step()"
              [value]="upper()"
              (input)="upper.set(num($event))"
              data-testid="caf-upper"
            />
          </label>
        } @else {
          <label class="caf-row">
            <span>Level</span>
            <input
              type="number"
              [step]="step()"
              [value]="level()"
              (input)="level.set(num($event))"
              data-testid="caf-level"
            />
          </label>
        }
      }

      @if (livePrice() !== null) {
        <div class="caf-live">Now: {{ side().toLowerCase() }} {{ livePrice() }}</div>
      }

      <label class="caf-row">
        <span>Trigger</span>
        <select (change)="frequency.set($any($event.target).value)" data-testid="caf-frequency">
          @for (f of frequencies; track f.id) {
            <option [value]="f.id" [title]="f.hint" [selected]="f.id === frequency()">
              {{ f.label }}
            </option>
          }
        </select>
      </label>

      <fieldset class="caf-channels">
        <legend>Notify by</legend>
        @for (c of channelOptions; track c.id) {
          <label>
            <input
              type="checkbox"
              [checked]="channels().includes(c.id)"
              (change)="toggleChannel(c.id)"
            />
            {{ c.label }}
          </label>
        }
      </fieldset>

      <label class="caf-row">
        <span>Severity</span>
        <select (change)="severity.set($any($event.target).value)">
          @for (s of severities; track s) {
            <option [value]="s" [selected]="s === severity()">{{ s }}</option>
          }
        </select>
      </label>

      <label class="caf-row">
        <span>Expires</span>
        <input
          type="datetime-local"
          [value]="expires()"
          (input)="expires.set($any($event.target).value)"
        />
      </label>

      <label class="caf-row">
        <span>Name</span>
        <input
          type="text"
          maxlength="100"
          [value]="name()"
          (input)="name.set($any($event.target).value)"
          placeholder="optional"
        />
      </label>

      <label class="caf-col">
        <span
          >Message <small>({{ placeholderHint }})</small></span
        >
        <textarea
          rows="2"
          maxlength="1000"
          [value]="message()"
          (input)="message.set($any($event.target).value)"
          placeholder="optional — a plain sentence is sent when empty"
        ></textarea>
      </label>

      @if (problem(); as p) {
        <p class="caf-problem" role="alert" data-testid="caf-problem">{{ p }}</p>
      }
      @if (serverError(); as e) {
        <p class="caf-problem" role="alert" data-testid="caf-server-error">{{ e }}</p>
      }

      <div class="caf-actions">
        <button type="button" class="caf-secondary" (click)="cancelled.emit()">Cancel</button>
        <button
          type="submit"
          class="caf-primary"
          [disabled]="!!problem() || saving()"
          data-testid="caf-save"
        >
          {{ saving() ? 'Saving…' : edit() ? 'Save' : 'Create' }}
        </button>
      </div>
    </form>
  `,
  styles: [
    `
      .caf {
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: 8px 12px 10px;
        min-width: 260px;
        color: var(--tv-ink, inherit);
      }
      .caf-head {
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--tv-muted, #888);
      }
      .caf-note,
      .caf-live {
        margin: 0;
        font-size: 12px;
        color: var(--tv-muted, #888);
      }
      .caf-row {
        display: grid;
        grid-template-columns: 70px 1fr;
        align-items: center;
        gap: 8px;
        font-size: 12px;
      }
      .caf-col {
        display: flex;
        flex-direction: column;
        gap: 4px;
        font-size: 12px;
      }
      .caf-col small {
        color: var(--tv-muted, #888);
      }
      input,
      select,
      textarea {
        height: 28px;
        padding: 0 8px;
        border: 1px solid var(--tv-line, #ccc);
        border-radius: 4px;
        background: var(--tv-bg, #fff);
        color: inherit;
        font: inherit;
        min-width: 0;
      }
      textarea {
        height: auto;
        padding: 6px 8px;
        resize: vertical;
      }
      .caf-channels {
        display: flex;
        flex-wrap: wrap;
        gap: 4px 12px;
        margin: 0;
        padding: 4px 0;
        border: 0;
        font-size: 12px;
      }
      .caf-channels legend {
        float: left;
        width: 70px;
        padding: 0;
        color: inherit;
      }
      .caf-channels input {
        height: auto;
      }
      .caf-problem {
        margin: 0;
        padding: 6px 8px;
        border-radius: 4px;
        font-size: 12px;
        background: color-mix(in srgb, var(--tv-down, #ef5350) 14%, transparent);
      }
      .caf-actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 4px;
      }
      .caf-primary,
      .caf-secondary {
        height: 30px;
        padding: 0 14px;
        border-radius: 4px;
        font: inherit;
        font-weight: 600;
        cursor: pointer;
      }
      .caf-primary {
        border: 0;
        background: var(--tv-blue, #2962ff);
        color: #fff;
      }
      .caf-primary:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .caf-secondary {
        border: 1px solid var(--tv-line, #ccc);
        background: transparent;
        color: inherit;
      }
    `,
  ],
})
export class ChartAlertFormComponent {
  private readonly alerts = inject(ChartAlertsService);

  /** The chart's symbol and timeframe (a new alert's). */
  readonly symbol = input.required<string>();
  readonly timeframe = input<string>('60');
  readonly precision = input<number>(5);
  /** The last close — the level's base when there is no fresh quote. */
  readonly lastClose = input<number>(0);
  /** A price to start from (right-click "Add alert at …"); null = 10 points beyond the live price. */
  readonly presetPrice = input<number | null>(null);
  /** The alert to edit (or a template to copy, with `copy`). */
  readonly edit = input<ChartAlertDto | null>(null);
  readonly copy = input<boolean>(false);
  /**
   * A NEW alert to start from, saved as a new alert (DR-I6: a drawing's alert from the drawing toolbar — its
   * geometry, drawing id and kind filled in). Ignored while `edit` is set.
   */
  readonly draft = input<ChartAlertDto | null>(null);
  /** What the form starts from: the alert edited, else the draft. */
  private readonly base = computed(() => this.edit() ?? this.draft());

  readonly saved = output<ChartAlertDto>();
  readonly cancelled = output<void>();

  protected readonly placeholderHint = '{{price}}, {{level}}, {{ticker}}, {{side}}, {{time}} …';
  protected readonly sides = SIDES;
  protected readonly frequencies = FREQUENCIES;
  protected readonly channelOptions = CHANNEL_OPTIONS;
  protected readonly severities = SEVERITIES;

  readonly direction = signal<AlertDirection>('above');
  readonly side = signal<ChartAlertSide>('Bid');
  readonly level = signal<number>(0);
  readonly lower = signal<number>(0);
  readonly upper = signal<number>(0);
  readonly frequency = signal<ChartAlertFrequency>('once');
  readonly channels = signal<AlertChannel[]>(['InApp']);
  readonly severity = signal<AlertSeverity>('Medium');
  /** `datetime-local` value (local time) or empty. */
  readonly expires = signal<string>('');
  readonly name = signal<string>('');
  readonly message = signal<string>('');
  readonly saving = signal(false);
  readonly serverError = signal<string | null>(null);

  /** Set once the operator typed a level — re-defaulting must not overwrite it. */
  private touchedLevel = false;

  protected readonly isDrawing = computed(() => this.base()?.kind === 'Drawing');
  protected readonly isChannel = computed(() => isChannelDirection(this.direction()));
  protected readonly step = computed(() => 10 ** -Math.max(0, this.precision()));
  protected readonly heading = computed(() => {
    const e = this.edit();
    if (e && !this.copy()) return `Edit alert · ${e.symbol}`;
    const draft = e ? null : this.draft();
    if (draft?.kind === 'Drawing') return `Drawing alert · ${draft.symbol.toUpperCase()}`;
    return `${this.copy() ? 'Copy alert' : 'Price alert'} · ${(e?.symbol ?? this.symbol()).toUpperCase()}`;
  });
  protected readonly drawingLabel = computed(() =>
    (this.base()?.drawingKind ?? 'drawing').replace(/-/g, ' '),
  );

  /** A channel drawing takes enter/exit only; a line or a level takes the crossings. */
  protected readonly directionChoices = computed(() => {
    const e = this.base();
    if (e?.kind === 'Drawing') {
      const channel = e.geometry?.shape === 'channel';
      return DIRECTIONS.filter((d) => isChannelDirection(d.id) === channel);
    }
    return DIRECTIONS;
  });

  private readonly alertSymbol = computed(() =>
    (this.base()?.symbol ?? this.symbol()).toUpperCase(),
  );

  protected readonly livePrice = computed<string | null>(() => {
    const q = this.alerts.quotes()[this.alertSymbol()];
    if (!q) return null;
    const v = this.side() === 'Ask' ? q.ask : this.side() === 'Mid' ? (q.bid + q.ask) / 2 : q.bid;
    return v.toFixed(Math.max(0, this.precision()));
  });

  /** What stops the alert from being armed, in plain words; null when it can be saved. */
  readonly problem = computed<string | null>(() => {
    if (this.channels().length === 0) return 'Choose at least one way to be notified.';
    if (this.expires() && Date.parse(this.expires()) <= Date.now())
      return 'The expiry is in the past.';
    if (this.isDrawing()) return null;
    if (this.isChannel()) {
      if (!(this.lower() > 0) || !(this.upper() > 0)) return 'Enter both channel levels.';
      if (this.upper() <= this.lower()) return 'The upper level must be above the lower level.';
      return null;
    }
    if (!(this.level() > 0)) return 'Enter the level.';
    return alreadyMetReason(
      this.alertSymbol(),
      this.direction(),
      this.level(),
      this.side(),
      this.alerts.quotes()[this.alertSymbol()],
      this.precision(),
    );
  });

  constructor() {
    // Load the edited alert (or the defaults) whenever the input changes.
    effect(() => {
      const e = this.base();
      const preset = this.presetPrice();
      untracked(() => this.reset(e, preset));
    });
  }

  protected num(ev: Event): number {
    this.touchedLevel = true;
    const v = (ev.target as HTMLInputElement).valueAsNumber;
    return Number.isFinite(v) ? v : 0;
  }

  setDirection(direction: AlertDirection): void {
    this.direction.set(direction);
    this.redefault();
  }

  setSide(side: ChartAlertSide): void {
    this.side.set(side);
    this.redefault();
  }

  toggleChannel(channel: AlertChannel): void {
    this.channels.update((list) =>
      list.includes(channel) ? list.filter((c) => c !== channel) : [...list, channel],
    );
  }

  /** The input the form describes. */
  toInput(): ChartAlertInput {
    const e = this.base();
    const channel = this.isChannel();
    return {
      name: this.name().trim() || null,
      symbol: this.alertSymbol(),
      timeframe: e?.timeframe ?? this.timeframe(),
      kind: e?.kind ?? 'Price',
      side: this.side(),
      condition: conditionFor(this.direction()),
      price:
        e?.kind === 'Drawing'
          ? null
          : roundTo(channel ? this.lower() : this.level(), this.precision()),
      upperPrice:
        e?.kind === 'Drawing' || !channel ? null : roundTo(this.upper(), this.precision()),
      geometry: e?.kind === 'Drawing' ? (e.geometry ?? null) : null,
      drawingId: e?.drawingId ?? null,
      drawingKind: e?.drawingKind ?? null,
      frequency: this.frequency(),
      expiresAtUtc: this.expires() ? new Date(this.expires()).toISOString() : null,
      channels: this.channels(),
      messageTemplate: this.message().trim() || null,
      severity: this.severity(),
    };
  }

  save(): void {
    if (this.problem() || this.saving()) return;
    this.saving.set(true);
    this.serverError.set(null);
    const e = this.edit();
    const call =
      e && !this.copy()
        ? this.alerts.update(e.id, this.toInput())
        : this.alerts.create(this.toInput());
    call.subscribe({
      next: (res) => {
        this.saving.set(false);
        if (res?.status && res.data) this.saved.emit(res.data);
        else this.serverError.set(res?.message || 'The alert could not be saved.');
      },
      error: () => {
        this.saving.set(false);
        this.serverError.set('The alert could not be saved — the engine did not answer.');
      },
    });
  }

  private reset(e: ChartAlertDto | null, preset: number | null): void {
    this.serverError.set(null);
    this.touchedLevel = false;
    if (e) {
      this.direction.set(directionOf(e.condition));
      this.side.set(e.side);
      this.level.set(e.price ?? 0);
      this.lower.set(e.price ?? 0);
      this.upper.set(e.upperPrice ?? 0);
      this.frequency.set(e.frequency);
      this.channels.set(e.channels.length ? [...e.channels] : ['InApp']);
      this.severity.set(e.severity);
      this.expires.set(e.expiresAtUtc ? toLocalInput(e.expiresAtUtc) : '');
      this.name.set(this.copy() && e.name ? `${e.name} (copy)` : (e.name ?? ''));
      this.message.set(e.messageTemplate ?? '');
      this.touchedLevel = true;
      return;
    }
    this.side.set('Bid');
    this.frequency.set('once');
    this.channels.set(['InApp']);
    this.severity.set('Medium');
    this.expires.set('');
    this.name.set('');
    this.message.set('');
    if (preset !== null && preset > 0) {
      // A level picked on the chart: watch the direction price has to travel to reach it.
      const q = this.alerts.quote(this.symbol());
      const live = q ? q.bid : this.lastClose();
      this.direction.set(live > 0 && preset < live ? 'below' : 'above');
      this.level.set(roundTo(preset, this.precision()));
      this.touchedLevel = true;
      return;
    }
    this.direction.set('above');
    this.redefault();
  }

  /** Re-derive the untouched level(s) from the live price on the chosen side. */
  private redefault(): void {
    if (this.touchedLevel || this.isDrawing()) return;
    const quote = this.alerts.quote(this.alertSymbol());
    if (this.isChannel()) {
      const ch = defaultChannel(quote, this.lastClose(), this.side(), this.precision());
      this.lower.set(ch.lower);
      this.upper.set(ch.upper);
    } else {
      this.level.set(
        defaultLevel(quote, this.lastClose(), this.side(), this.direction(), this.precision()),
      );
    }
  }
}

/** ISO UTC → the `datetime-local` value in the browser's zone. */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
