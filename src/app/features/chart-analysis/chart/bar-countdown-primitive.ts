import type {
  ISeriesApi,
  ISeriesPrimitive,
  ISeriesPrimitiveAxisView,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from 'lightweight-charts';

/**
 * TradingView's "countdown to bar close" on the price scale: a second label line, in the
 * last-price label's colour, directly under the series' own last-value label so the two read as
 * one two-line box (price, then time left). The built-in label keeps drawing the price — it
 * already handles log, % and indexed scales and the price format — and this view sits one label
 * height below it.
 *
 * Updating is cheap by design: {@link set} stores the text and asks the library for a repaint
 * (`requestUpdate`), never a re-layout or an Angular change detection.
 */
export class BarCountdownPrimitive implements ISeriesPrimitive<Time> {
  private series: ISeriesApi<SeriesType> | null = null;
  private requestUpdate: (() => void) | null = null;
  private price: number | null = null;
  private text: string | null = null;
  private color = '#2962ff';
  private textColor = '#ffffff';
  private labelHeight = 18;

  private readonly view: ISeriesPrimitiveAxisView = {
    coordinate: () => {
      if (this.price === null || !this.series) return -1;
      const y = this.series.priceToCoordinate(this.price);
      return y === null ? -1 : y + this.labelHeight;
    },
    text: () => this.text ?? '',
    textColor: () => this.textColor,
    backColor: () => this.color,
    visible: () => this.text !== null && this.price !== null,
    tickVisible: () => false,
  };

  attached(param: SeriesAttachedParameter<Time>): void {
    this.series = param.series as ISeriesApi<SeriesType>;
    this.requestUpdate = param.requestUpdate;
  }

  detached(): void {
    this.series = null;
    this.requestUpdate = null;
  }

  priceAxisViews(): readonly ISeriesPrimitiveAxisView[] {
    return [this.view];
  }

  /**
   * The label's state. `labelHeight` is the price-axis label height at the chart's font size, so
   * the countdown sits flush under the built-in last-value label. `color` must be opaque: the
   * library paints a primitive's label exactly as given, so a translucent one let the axis prices
   * show through it (`opaqueOver`, axis-label-color.ts).
   */
  set(
    text: string | null,
    price: number | null,
    color: string,
    textColor: string,
    labelHeight: number,
  ): void {
    if (
      text === this.text &&
      price === this.price &&
      color === this.color &&
      textColor === this.textColor &&
      labelHeight === this.labelHeight
    )
      return;
    this.text = text;
    this.price = price;
    this.color = color;
    this.textColor = textColor;
    this.labelHeight = labelHeight;
    this.requestUpdate?.();
  }
}

/**
 * Height of a price-axis label at `fontSize` — lightweight-charts' own sizing: the font plus
 * `2.5 * fontSize / 12` padding above and below and a 1 px border (18 px at the default 12 px).
 */
export function axisLabelHeight(fontSize: number): number {
  return Math.round(fontSize + (5 * fontSize) / 12 + 1);
}
