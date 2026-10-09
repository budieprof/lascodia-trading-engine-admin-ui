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

import { WatchlistService } from '../watchlist/watchlist.service';
import { CHANNEL_OPTIONS } from './chart-alert-rules';
import { ChartScriptAlertsService } from './chart-script-alerts.service';
import {
  ALERT_CALLS_KEY,
  ORDER_FILLS_KEY,
  timeframeLabel,
  type ChartScriptAlertDto,
  type ChartScriptAlertInput,
} from './chart-script-alerts.types';

/** What "Create alert on <script>" knows about the script (PC-I14). */
export interface ScriptAlertTarget {
  /** The saved chart script (`scripting/indicators/{id}`) the alert snapshots. */
  chartScriptId: number;
  scriptName: string;
  /** Its alertcondition() titles (the run's outputs). */
  alertConditions: string[];
  /** It (or a library it imports) calls alert(). */
  callsAlert: boolean;
  isStrategy: boolean;
  /** The chart's symbol and timeframe (Pine spelling). */
  symbol: string;
  timeframe: string;
  /** The input values the script runs with on the chart (on top of its saved ones). */
  inputs?: Record<string, unknown> | null;
}

const FREQUENCIES = [
  { id: 'once_per_bar', label: 'Once per bar', hint: 'The first time it is true in a bar' },
  { id: 'once_per_bar_close', label: 'Once per bar close', hint: 'Only when the bar closes with it true' },
  { id: 'all', label: 'Every time', hint: 'Each time the script finds it true (the storm guard stops a flood)' },
  { id: 'once', label: 'Only once', hint: 'Fires once, then pauses itself' },
] as const;

const TIMEFRAMES = ['1', '5', '15', '30', '60', '120', '240', '1D', '1W'];

/**
 * Create or edit an alert on a chart script (SS-I1 / PC-I14): which of the script's alerts (an alertcondition title,
 * its alert() calls, a strategy's order fills), on which symbols (or a watchlist) and timeframe, how often, and where
 * it is delivered. The engine snapshots the script as it is now; refusals come back in its own words.
 */
@Component({
  selector: 'app-chart-script-alert-form',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form class="saf" (submit)="$event.preventDefault(); save()" novalidate>
      <div class="saf-head">{{ heading() }}</div>
      @if (edit(); as e) {
        @if (e.scriptChanged) {
          <label class="saf-banner" data-testid="saf-rearm">
            <input type="checkbox" [checked]="rearm()" (change)="rearm.set($any($event.target).checked)" />
            The script “{{ e.scriptName }}” changed since this alert was armed — re-arm it with the current version
          </label>
        }
      }

      <label class="saf-row">
        <span>Alert on</span>
        @if (keyOptions().length) {
          <select (change)="alertKey.set($any($event.target).value)" data-testid="saf-key">
            @for (k of keyOptions(); track k.id) {
              <option [value]="k.id" [selected]="k.id === alertKey()">{{ k.label }}</option>
            }
          </select>
        } @else {
          <input type="text" [value]="alertKey()" (input)="alertKey.set($any($event.target).value)" data-testid="saf-key" />
        }
      </label>

      <label class="saf-row">
        <span>Watch</span>
        <select (change)="useWatchlist.set($any($event.target).value === 'list')" data-testid="saf-scope">
          <option value="symbols" [selected]="!useWatchlist()">Symbols</option>
          <option value="list" [selected]="useWatchlist()" [disabled]="!watchlists().length">A watchlist</option>
        </select>
      </label>
      @if (useWatchlist()) {
        <label class="saf-row">
          <span>Watchlist</span>
          <select (change)="watchlistId.set(+$any($event.target).value || null)" data-testid="saf-watchlist">
            @for (w of watchlists(); track w.id) {
              <option [value]="w.id" [selected]="w.id === watchlistId()">{{ w.name }}</option>
            }
          </select>
        </label>
      } @else {
        <label class="saf-row">
          <span>Symbols</span>
          <input
            type="text"
            [value]="symbolsText()"
            (input)="symbolsText.set($any($event.target).value)"
            placeholder="EURUSD, GBPUSD"
            data-testid="saf-symbols"
          />
        </label>
      }

      <label class="saf-row">
        <span>Timeframe</span>
        <select (change)="timeframe.set($any($event.target).value)" data-testid="saf-timeframe">
          @for (t of timeframes(); track t) {
            <option [value]="t" [selected]="t === timeframe()">{{ tfLabel(t) }}</option>
          }
        </select>
      </label>

      <label class="saf-row">
        <span>Trigger</span>
        <select (change)="frequency.set($any($event.target).value)" data-testid="saf-frequency">
          @for (f of frequencyOptions(); track f.id) {
            <option [value]="f.id" [title]="f.hint" [selected]="f.id === frequency()">{{ f.label }}</option>
          }
        </select>
      </label>

      <fieldset class="saf-channels">
        <legend>Notify by</legend>
        @for (c of channelOptions; track c.id) {
          <label>
            <input type="checkbox" [checked]="channels().includes(c.id)" (change)="toggleChannel(c.id)" />
            {{ c.label }}
          </label>
        }
      </fieldset>
      @if (channels().includes('Webhook')) {
        <label class="saf-row">
          <span>Webhook</span>
          <input
            type="url"
            [value]="webhook()"
            (input)="webhook.set($any($event.target).value)"
            placeholder="https://… (public hosts only)"
            data-testid="saf-webhook"
          />
        </label>
      }

      <label class="saf-row">
        <span>Expires</span>
        <input type="datetime-local" [value]="expires()" (input)="expires.set($any($event.target).value)" />
      </label>
      <label class="saf-row">
        <span>Name</span>
        <input
          type="text"
          maxlength="120"
          [value]="name()"
          (input)="name.set($any($event.target).value)"
          [placeholder]="scriptName()"
        />
      </label>
      <label class="saf-col">
        <span>Message <small>(Pine placeholders: {{ '{{' }}close{{ '}}' }}, {{ '{{' }}ticker{{ '}}' }}, {{ '{{' }}plot_0{{ '}}' }} …)</small></span>
        <textarea
          rows="2"
          maxlength="1000"
          [value]="message()"
          (input)="message.set($any($event.target).value)"
          placeholder="optional — the script's own message when empty"
        ></textarea>
      </label>

      @if (problem(); as p) {
        <p class="saf-problem" role="alert" data-testid="saf-problem">{{ p }}</p>
      }
      @if (serverError(); as e) {
        <p class="saf-problem" role="alert" data-testid="saf-server-error">{{ e }}</p>
      }
      <div class="saf-actions">
        <button type="button" (click)="cancelled.emit()">Cancel</button>
        <button type="submit" class="primary" [disabled]="!!problem() || saving()" data-testid="saf-save">
          {{ saving() ? 'Saving…' : edit() ? 'Save' : 'Create alert' }}
        </button>
      </div>
    </form>
  `,
  styles: [
    `
      .saf {
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: 8px 12px 10px;
        min-width: 280px;
        font-size: 12px;
        color: var(--tv-ink, inherit);
      }
      .saf-head {
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--tv-muted, #888);
      }
      .saf-banner {
        display: flex;
        gap: 6px;
        padding: 6px 8px;
        border-radius: 4px;
        background: color-mix(in srgb, #f59e0b 16%, transparent);
      }
      .saf-row {
        display: grid;
        grid-template-columns: 76px 1fr;
        align-items: center;
        gap: 8px;
      }
      .saf-col {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .saf-col small {
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
      input[type='checkbox'] {
        height: auto;
      }
      textarea {
        height: auto;
        padding: 6px 8px;
        resize: vertical;
      }
      .saf-channels {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        border: 0;
        padding: 0;
        margin: 0;
      }
      .saf-channels legend {
        padding: 0 0 4px;
        color: var(--tv-muted, #888);
      }
      .saf-problem {
        margin: 0;
        padding: 6px 8px;
        border-radius: 4px;
        background: color-mix(in srgb, var(--tv-down, #ef5350) 14%, transparent);
      }
      .saf-actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
      }
      button {
        font: inherit;
        color: inherit;
        background: transparent;
        border: 1px solid var(--tv-line, #ddd);
        border-radius: 4px;
        padding: 4px 10px;
        cursor: pointer;
      }
      button.primary {
        border-color: var(--tv-blue, #2962ff);
        background: var(--tv-blue, #2962ff);
        color: #fff;
      }
      button:disabled {
        opacity: 0.5;
        cursor: default;
      }
      @media (pointer: coarse) {
        input,
        select,
        button {
          min-height: 40px;
        }
      }
    `,
  ],
})
export class ChartScriptAlertFormComponent {
  private readonly alerts = inject(ChartScriptAlertsService);
  private readonly watchlistService = inject(WatchlistService);

  /** Create: the script and the chart. */
  readonly target = input<ScriptAlertTarget | null>(null);
  /** Edit: the alert. */
  readonly edit = input<ChartScriptAlertDto | null>(null);

  readonly saved = output<ChartScriptAlertDto>();
  readonly cancelled = output<void>();

  protected readonly channelOptions = CHANNEL_OPTIONS;
  readonly alertKey = signal('');
  readonly useWatchlist = signal(false);
  readonly watchlistId = signal<number | null>(null);
  readonly symbolsText = signal('');
  readonly timeframe = signal('60');
  readonly frequency = signal<string>('once_per_bar');
  readonly channels = signal<string[]>(['InApp']);
  readonly webhook = signal('');
  readonly expires = signal('');
  readonly name = signal('');
  readonly message = signal('');
  readonly rearm = signal(false);
  readonly saving = signal(false);
  readonly serverError = signal<string | null>(null);

  readonly heading = computed(() =>
    this.edit() ? `Edit alert · ${this.edit()!.displayName}` : `Create alert on ${this.target()?.scriptName ?? 'the script'}`,
  );
  readonly scriptName = computed(() => this.edit()?.scriptName ?? this.target()?.scriptName ?? '');
  readonly watchlists = computed(() => this.watchlistService.lists().filter((w) => w.id > 0));

  /** The script's alerts it can be armed on; for an edit, the alert's own key (the engine checks a change). */
  readonly keyOptions = computed(() => {
    const t = this.target();
    if (!t) {
      const k = this.edit()?.alertKey;
      return k ? [{ id: k, label: keyLabel(k) }] : [];
    }
    const out: { id: string; label: string }[] = [];
    if (!t.isStrategy) for (const title of t.alertConditions) out.push({ id: title, label: `“${title}”` });
    if (t.callsAlert) out.push({ id: ALERT_CALLS_KEY, label: 'Any alert() call' });
    if (t.isStrategy) out.push({ id: ORDER_FILLS_KEY, label: 'Order fills' });
    return out;
  });

  readonly frequencyOptions = computed(() =>
    // alert() carries its own frequency (alert.freq_*); the alert's applies to alertconditions only.
    this.alertKey() === ALERT_CALLS_KEY || this.alertKey() === ORDER_FILLS_KEY
      ? FREQUENCIES.filter((f) => f.id === 'once_per_bar' || f.id === 'all')
      : FREQUENCIES,
  );

  readonly timeframes = computed(() => [...new Set([...TIMEFRAMES, this.timeframe()])]);

  readonly symbols = computed(() =>
    [...new Set(this.symbolsText().split(/[\s,;]+/).map((s) => s.trim().toUpperCase()).filter(Boolean))],
  );

  /** Why it cannot be saved yet, in a sentence; null when it can. */
  readonly problem = computed<string | null>(() => {
    if (!this.alertKey().trim())
      return this.target() && !this.keyOptions().length
        ? 'This script has nothing to alert on: no alertcondition(), no alert() call (and it is not a strategy).'
        : 'Pick what to alert on.';
    if (this.useWatchlist() ? this.watchlistId() === null : this.symbols().length === 0) return 'Pick at least one symbol.';
    if (!this.channels().length) return 'Pick at least one way to be notified.';
    if (this.channels().includes('Webhook') && !this.webhook().trim()) return 'Give the webhook URL.';
    if (this.expires() && Date.parse(this.expires()) <= Date.now()) return 'The expiry is in the past.';
    return null;
  });

  constructor() {
    // The operator's watchlists, for "Watch: a watchlist" (the watchlist panel usually has them already).
    if (!this.watchlistService.loaded()) void this.watchlistService.load();
    effect(() => {
      const t = this.target();
      const e = this.edit();
      untracked(() => this.reset(t, e));
    });
  }

  private reset(t: ScriptAlertTarget | null, e: ChartScriptAlertDto | null): void {
    this.serverError.set(null);
    this.rearm.set(false);
    if (e) {
      this.alertKey.set(e.alertKey);
      this.useWatchlist.set(e.watchlistId !== null);
      this.watchlistId.set(e.watchlistId);
      this.symbolsText.set(e.symbols.join(', '));
      this.timeframe.set(e.timeframe);
      this.frequency.set(e.frequency);
      this.channels.set([...e.channels]);
      this.webhook.set(e.webhookUrl ?? '');
      this.expires.set(e.expiresAtUtc ? toLocalInput(e.expiresAtUtc) : '');
      this.name.set(e.name ?? '');
      this.message.set(e.messageTemplate ?? '');
      return;
    }
    if (!t) return;
    const first = this.keyOptions()[0]?.id ?? '';
    this.alertKey.set(first);
    this.useWatchlist.set(false);
    this.watchlistId.set(this.watchlists()[0]?.id ?? null);
    this.symbolsText.set(t.symbol.toUpperCase());
    this.timeframe.set(t.timeframe);
    this.frequency.set('once_per_bar');
    this.channels.set(['InApp']);
    this.webhook.set('');
    this.expires.set('');
    this.name.set('');
    this.message.set('');
  }

  toggleChannel(id: string): void {
    this.channels.update((list) => (list.includes(id) ? list.filter((c) => c !== id) : [...list, id]));
  }

  protected tfLabel(tf: string): string {
    return timeframeLabel(tf);
  }

  save(): void {
    if (this.problem() || this.saving()) return;
    const body: ChartScriptAlertInput = {
      name: this.name().trim() || null,
      alertKey: this.alertKey().trim(),
      timeframe: this.timeframe(),
      frequency: this.frequency(),
      channels: this.channels(),
      webhookUrl: this.channels().includes('Webhook') ? this.webhook().trim() || null : null,
      messageTemplate: this.message().trim() || null,
      expiresAtUtc: this.expires() ? new Date(this.expires()).toISOString() : null,
      ...(this.useWatchlist() ? { watchlistId: this.watchlistId() } : { symbols: this.symbols() }),
    };
    const t = this.target();
    const e = this.edit();
    const call = e
      ? this.alerts.update(e.id, { ...body, rearm: this.rearm() })
      : this.alerts.create({ ...body, chartScriptId: t!.chartScriptId, inputs: t?.inputs ?? null });
    this.saving.set(true);
    this.serverError.set(null);
    call.subscribe({
      next: (res) => {
        this.saving.set(false);
        if (res?.status && res.data) this.saved.emit(res.data);
        else this.serverError.set(res?.message || 'The engine refused the alert.');
      },
      error: () => {
        this.saving.set(false);
        this.serverError.set('The engine did not answer.');
      },
    });
  }
}

function keyLabel(k: string): string {
  return k === ALERT_CALLS_KEY ? 'Any alert() call' : k === ORDER_FILLS_KEY ? 'Order fills' : `“${k}”`;
}

/** An ISO instant as a `datetime-local` value in the viewer's zone. */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
