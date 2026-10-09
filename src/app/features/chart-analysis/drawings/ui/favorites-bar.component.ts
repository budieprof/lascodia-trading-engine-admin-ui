import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { ChartIconComponent } from '../../icons/chart-icon.component';
import { ChartPrefsService } from '../../workspace/chart-prefs.service';
import { DrawingFavorites } from '../drawing-favorites.service';
import { toolFor, type DrawingKind } from '../model';

const POS_KEY = 'lascodia.chart.favoritesBar.pos.v1';

/**
 * TradingView's Favourites toolbar (DR-I12): the starred drawing tools, one click to arm. Floats over the chart,
 * dragged by its grip (the place is remembered like the drawing toolbar's); shown while there are favourites.
 */
@Component({
  selector: 'app-drawing-favorites-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ChartIconComponent],
  template: `
    @if (tools().length) {
      <div
        class="fb"
        role="toolbar"
        aria-label="Favourite drawing tools"
        [style.left.px]="pos().x"
        [style.top.px]="pos().y"
        (pointerdown)="$event.stopPropagation()"
      >
        <span class="fb-grip" title="Drag toolbar" (pointerdown)="startDrag($event)">
          <app-chart-icon name="grip" [size]="18" />
        </span>
        @for (t of tools(); track t.kind) {
          <button
            type="button"
            class="fb-btn"
            [class.on]="tool() === t.kind"
            [title]="t.label"
            [attr.aria-pressed]="tool() === t.kind"
            (click)="pick.emit(t.kind)"
          >
            <app-chart-icon [name]="t.kind" [size]="24" />
          </button>
        }
      </div>
    }
  `,
  styles: `
    .fb {
      position: absolute;
      z-index: 6;
      display: flex;
      align-items: center;
      gap: 2px;
      padding: 3px;
      border-radius: 6px;
      background: var(--tv-bg, #fff);
      color: var(--tv-ink, #131722);
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
    }
    .fb-grip {
      display: inline-flex;
      cursor: grab;
      color: var(--tv-muted, #787b86);
      padding: 0 2px;
      touch-action: none;
    }
    .fb-btn {
      width: 32px;
      height: 32px;
      border: 0;
      border-radius: 4px;
      background: none;
      color: inherit;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
    }
    .fb-btn:hover {
      background: var(--tv-hover, #f0f3fa);
    }
    .fb-btn.on {
      background: var(--tv-active-bg, #e3effd);
      color: var(--tv-blue, #2962ff);
    }
  `,
})
export class FavoritesBarComponent {
  private readonly favorites = inject(DrawingFavorites);
  private readonly prefs = inject(ChartPrefsService);

  /** The armed tool. */
  readonly tool = input<DrawingKind | null>(null);
  readonly pick = output<DrawingKind>();

  readonly tools = computed(() =>
    this.favorites
      .list()
      .map((kind) => ({ kind, label: toolFor(kind)?.label ?? kind }))
      .filter((t) => !!toolFor(t.kind)),
  );
  readonly pos = signal<{ x: number; y: number }>(this.readPos());

  startDrag(ev: PointerEvent): void {
    ev.preventDefault();
    const from = { px: ev.clientX, py: ev.clientY, x: this.pos().x, y: this.pos().y };
    const move = (e: PointerEvent) =>
      this.pos.set({
        x: Math.max(0, from.x + e.clientX - from.px),
        y: Math.max(0, from.y + e.clientY - from.py),
      });
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      this.prefs.setItem(POS_KEY, JSON.stringify(this.pos()));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  private readPos(): { x: number; y: number } {
    try {
      const v = JSON.parse(this.prefs.getItem(POS_KEY) ?? 'null') as {
        x?: unknown;
        y?: unknown;
      } | null;
      if (v && typeof v.x === 'number' && typeof v.y === 'number') return { x: v.x, y: v.y };
    } catch {
      /* the default place */
    }
    return { x: 56, y: 48 };
  }
}
