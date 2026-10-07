import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { isSessionResolution, type TvResolution } from '../datafeed/resolution';
import { RatingGaugeComponent } from './rating-gauge.component';
import {
  PIVOT_METHODS,
  PIVOT_ROWS,
  bracket,
  periodLabel,
  pivotInputs,
  pivotLevels,
  pivotPeriodBars,
  pivotPeriodFor,
  type PivotMethod,
  type PivotPeriod,
  type PivotRow,
} from './pivots';
import type { GroupRating, IndicatorVote, RatingLabel, StudyRef, Vote } from './technicals';
import {
  TECHNICALS_TIMEFRAMES,
  TechnicalsService,
  type SymbolTechnicals,
} from './technicals.service';

const REFRESH_MS = 60_000;

/** Display names for the pair title, TradingView-style ("Euro / U.S. Dollar"). */
const CURRENCY_NAMES: Readonly<Record<string, string>> = {
  AUD: 'Australian Dollar',
  CAD: 'Canadian Dollar',
  CHF: 'Swiss Franc',
  CNH: 'Chinese Yuan',
  EUR: 'Euro',
  GBP: 'British Pound',
  HKD: 'Hong Kong Dollar',
  JPY: 'Japanese Yen',
  MXN: 'Mexican Peso',
  NGN: 'Nigerian Naira',
  NOK: 'Norwegian Krone',
  NZD: 'New Zealand Dollar',
  PLN: 'Polish Zloty',
  SEK: 'Swedish Krona',
  SGD: 'Singapore Dollar',
  TRY: 'Turkish Lira',
  USD: 'U.S. Dollar',
  XAG: 'Silver',
  XAU: 'Gold',
  ZAR: 'South African Rand',
};

const PERIOD_NAMES: Readonly<Record<PivotPeriod, string>> = {
  day: 'Daily',
  week: 'Weekly',
  month: 'Monthly',
  year: 'Yearly',
};

type Tone = 'buy' | 'sell' | 'neutral';

/**
 * The full Technicals view TradingView opens from "More technicals": ratings for
 * a symbol on every timeframe, the oscillator and moving-average votes behind
 * them, and pivot points. It sits over the chart and leaves it mounted, so
 * "Back to chart" returns to exactly the same state.
 *
 * Past TradingView: every timeframe tab carries its own verdict (one glance
 * shows whether 15m and 4h agree), each action explains the rule that fired, a
 * row can drop its indicator onto the chart with the same inputs, and the pivot
 * levels price is trading between are highlighted.
 */
@Component({
  selector: 'app-technicals-view',
  standalone: true,
  imports: [RatingGaugeComponent, DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './technicals-view.component.html',
  styleUrl: './technicals-view.component.scss',
  host: { role: 'region', 'aria-label': 'Technicals' },
})
export class TechnicalsViewComponent implements OnInit {
  readonly symbol = input.required<string>();
  readonly base = input<string | null>(null);
  readonly quote = input<string | null>(null);
  /** Price decimals for moving averages and pivots. */
  readonly digits = input(5);
  /** The chart's timeframe: the tab to open on, when TradingView has one for it. */
  readonly initialResolution = input<TvResolution>('1D');
  /** Live price, for placing the pivots; falls back to the last close. */
  readonly livePrice = input<number | null>(null);

  readonly closed = output<void>();
  /** Add this indicator, with these inputs, to the chart. */
  readonly addStudy = output<StudyRef>();

  private readonly service = inject(TechnicalsService);

  protected readonly timeframes = TECHNICALS_TIMEFRAMES;
  protected readonly methods = PIVOT_METHODS;
  protected readonly pivotRows = PIVOT_ROWS;

  readonly selected = signal<TvResolution>('1D');
  readonly data = signal<SymbolTechnicals | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  private seq = 0;

  readonly pairName = computed(() => {
    const b = this.base();
    const q = this.quote();
    if (!b || !q) return this.symbol();
    return `${CURRENCY_NAMES[b] ?? b} / ${CURRENCY_NAMES[q] ?? q}`;
  });

  readonly tabLabel = computed(
    () => TECHNICALS_TIMEFRAMES.find((t) => t.id === this.selected())?.label ?? this.selected(),
  );

  readonly frame = computed(() => this.data()?.frames[this.selected()] ?? null);

  /** The tab's bars are the engine's session bars (2 hours and up), not its stored candles. */
  readonly sessionGrid = computed(() => isSessionResolution(this.selected()));

  readonly gauges = computed(() => {
    const r = this.frame()?.rating;
    if (!r) return [];
    const g = (
      key: string,
      title: string,
      x: Pick<GroupRating, 'rating' | 'label' | 'buy' | 'neutral' | 'sell'>,
    ) => ({
      key,
      title,
      ...x,
    });
    return [
      g('osc', 'Oscillators', r.oscillators),
      g('summary', 'Summary', r.summary),
      g('ma', 'Moving Averages', r.movingAverages),
    ];
  });

  readonly tables = computed(() => {
    const r = this.frame()?.rating;
    if (!r) return [];
    const price = (n: number) => n.toFixed(this.digits());
    return [
      { title: 'Oscillators', votes: r.oscillators.votes, fmt: (n: number) => n.toFixed(5) },
      { title: 'Moving Averages', votes: r.movingAverages.votes, fmt: price },
    ];
  });

  /** Rows with no value — lookbacks longer than the stored history. */
  readonly missing = computed(() => {
    const r = this.frame()?.rating;
    if (!r) return 0;
    return [...r.oscillators.votes, ...r.movingAverages.votes].filter((v) => v.value === null)
      .length;
  });

  readonly pivots = computed(() => {
    const d = this.data();
    const f = this.frame();
    if (!d || f?.lastTime == null) return null;
    const period = pivotPeriodFor(this.selected());
    // The engine's session days (17:00 New York, where TradingView and the FX market close a
    // day), weeks and months — years folded from the months.
    const inputs = pivotInputs(pivotPeriodBars(period, d), f.lastTime);
    if (!inputs) return null;
    const levels = pivotLevels(inputs.prev, inputs.currentOpen);
    const price = this.livePrice() ?? f.lastClose;
    const brackets = {} as Record<PivotMethod, { above: PivotRow | null; below: PivotRow | null }>;
    for (const m of PIVOT_METHODS) {
      brackets[m.id] = price === null ? { above: null, below: null } : bracket(levels[m.id], price);
    }
    return {
      periodName: PERIOD_NAMES[period],
      from: periodLabel(period, inputs.prev),
      levels,
      brackets,
      price,
    };
  });

  constructor() {
    effect(() => {
      const s = this.symbol();
      untracked(() => void this.reload(s, true));
    });
    const timer = setInterval(() => {
      if (!document.hidden) void this.reload(this.symbol(), false);
    }, REFRESH_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  ngOnInit(): void {
    const r = this.initialResolution();
    this.selected.set(TECHNICALS_TIMEFRAMES.some((t) => t.id === r) ? r : '1D');
  }

  private async reload(symbol: string, reset: boolean): Promise<void> {
    const n = ++this.seq;
    if (reset) this.data.set(null);
    this.loading.set(true);
    try {
      const d = await this.service.load(symbol);
      if (n !== this.seq) return;
      this.data.set(d);
      this.error.set(null);
    } catch {
      if (n === this.seq) this.error.set(`Could not load candles for ${symbol}.`);
    } finally {
      if (n === this.seq) this.loading.set(false);
    }
  }

  protected tone(label: RatingLabel): Tone {
    return label === 'Buy' || label === 'Strong buy'
      ? 'buy'
      : label === 'Sell' || label === 'Strong sell'
        ? 'sell'
        : 'neutral';
  }

  protected action(v: IndicatorVote): string {
    if (v.value === null) return '—';
    return ({ buy: 'Buy', sell: 'Sell', neutral: 'Neutral' } satisfies Record<Vote, string>)[
      v.vote
    ];
  }

  protected price(n: number): string {
    return n.toFixed(this.digits());
  }
}
