import { ChangeDetectionStrategy, Component, computed, input, model, output } from '@angular/core';
import { FormsModule } from '@angular/forms';

export interface TimeRange {
  /** Start of the range, inclusive, UTC ISO-8601. Null = unbounded. */
  from: string | null;
  /** End of the range, inclusive, UTC ISO-8601. Null = now. */
  to: string | null;
  /** Preset key (Today / 24h / 7d / 30d / Custom) so the UI can restore selection. */
  preset: TimeRangePreset;
}

export type TimeRangePreset = 'today' | '24h' | '7d' | '30d' | 'custom';

interface PresetDef {
  key: TimeRangePreset;
  label: string;
  /** Returns the from/to bounds for this preset at call time. */
  build(): { from: string | null; to: string | null };
}

const PRESETS: PresetDef[] = [
  {
    key: 'today',
    label: 'Today',
    build() {
      const start = new Date();
      start.setUTCHours(0, 0, 0, 0);
      return { from: start.toISOString(), to: null };
    },
  },
  {
    key: '24h',
    label: '24h',
    build() {
      const from = new Date(Date.now() - 24 * 3600 * 1000);
      return { from: from.toISOString(), to: null };
    },
  },
  {
    key: '7d',
    label: '7d',
    build() {
      const from = new Date(Date.now() - 7 * 24 * 3600 * 1000);
      return { from: from.toISOString(), to: null };
    },
  },
  {
    key: '30d',
    label: '30d',
    build() {
      const from = new Date(Date.now() - 30 * 24 * 3600 * 1000);
      return { from: from.toISOString(), to: null };
    },
  },
];

/**
 * Unified time-range picker. Drop on any list page and bind `value` to get
 * `{ from, to, preset }`; the preset buttons drive both at once and switching
 * to "Custom" exposes native date inputs so operators can pick arbitrary bounds.
 * Page code stays free of date-math.
 *
 * Value is updated whenever a preset is chosen or a custom input changes.
 * Consumers wire `[(value)]` for two-way, or `(valueChange)` for emit-only.
 */
@Component({
  selector: 'app-time-range-picker',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    <div class="picker" role="group" [attr.aria-label]="ariaLabel()">
      <div class="presets" role="tablist">
        @for (p of presets; track p.key) {
          <button
            type="button"
            role="tab"
            class="preset"
            [class.active]="current().preset === p.key"
            [attr.aria-selected]="current().preset === p.key"
            (click)="apply(p.key)"
          >
            {{ p.label }}
          </button>
        }
        <button
          type="button"
          role="tab"
          class="preset"
          [class.active]="current().preset === 'custom'"
          [attr.aria-selected]="current().preset === 'custom'"
          (click)="apply('custom')"
        >
          Custom
        </button>
      </div>

      @if (current().preset === 'custom') {
        <div class="custom">
          <label>
            <span class="lbl">From</span>
            <input
              type="datetime-local"
              [ngModel]="asLocal(current().from)"
              (ngModelChange)="setCustomFrom($event)"
            />
          </label>
          <label>
            <span class="lbl">To</span>
            <input
              type="datetime-local"
              [ngModel]="asLocal(current().to)"
              (ngModelChange)="setCustomTo($event)"
            />
          </label>
        </div>
      }
    </div>
  `,
  styles: [
    `
      .picker {
        display: inline-flex;
        align-items: center;
        gap: var(--space-3);
        flex-wrap: wrap;
      }
      .presets {
        display: inline-flex;
        gap: 2px;
        padding: 2px;
        background: var(--bg-tertiary);
        border-radius: var(--radius-full);
      }
      .preset {
        appearance: none;
        border: none;
        background: transparent;
        color: var(--text-secondary);
        font: inherit;
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
        padding: 4px 10px;
        border-radius: var(--radius-full);
        cursor: pointer;
        transition: all var(--dur-fast) var(--ease-out-soft);
      }
      .preset.active {
        background: var(--bg-primary);
        color: var(--text-primary);
        box-shadow: var(--shadow-sm);
      }
      .preset:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 2px;
      }
      .custom {
        display: inline-flex;
        gap: var(--space-3);
      }
      .custom label {
        display: inline-flex;
        align-items: center;
        gap: var(--space-2);
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .custom input {
        padding: 4px 8px;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-xs);
        font-family: inherit;
      }
      .lbl {
        font-weight: var(--font-medium);
      }
    `,
  ],
})
export class TimeRangePickerComponent {
  readonly ariaLabel = input<string>('Time range');

  /**
   * Default preset on first mount. Subsequent changes are owned by the
   * caller via `[(value)]`.
   */
  readonly defaultPreset = input<TimeRangePreset>('24h');

  // Two-way-bound current value.
  readonly value = model<TimeRange | null>(null);

  /**
   * Fires in addition to the `value` model — useful when the caller wants
   * an explicit "user changed the picker" hook separate from programmatic
   * resets.
   */
  readonly rangeChange = output<TimeRange>();

  readonly presets = PRESETS;

  readonly current = computed<TimeRange>(() => this.value() ?? this.initialValue());

  apply(preset: TimeRangePreset): void {
    if (preset === 'custom') {
      this.emit({
        preset: 'custom',
        from: this.current().from,
        to: this.current().to,
      });
      return;
    }
    const def = PRESETS.find((p) => p.key === preset);
    if (!def) return;
    const { from, to } = def.build();
    this.emit({ preset, from, to });
  }

  setCustomFrom(localIso: string): void {
    const iso = this.localToUtcIso(localIso);
    this.emit({ preset: 'custom', from: iso, to: this.current().to });
  }

  setCustomTo(localIso: string): void {
    const iso = this.localToUtcIso(localIso);
    this.emit({ preset: 'custom', from: this.current().from, to: iso });
  }

  /** Convert a UTC ISO string into the `datetime-local` format (no TZ suffix). */
  asLocal(iso: string | null): string {
    if (!iso) return '';
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  private localToUtcIso(localIso: string): string | null {
    if (!localIso) return null;
    return new Date(localIso).toISOString();
  }

  private emit(range: TimeRange): void {
    this.value.set(range);
    this.rangeChange.emit(range);
  }

  private initialValue(): TimeRange {
    const def = PRESETS.find((p) => p.key === this.defaultPreset()) ?? PRESETS[1];
    const { from, to } = def.build();
    return { preset: def.key, from, to };
  }
}
