import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { ChartIconComponent } from '../../icons/chart-icon.component';
import { DrawingStore } from '../drawing-store.service';
import type { ZOrderOp } from '../drawing-ops';
import type { DrawingTemplate } from '../drawing-templates';
import type { DashStyle, Drawing, DrawingStyle } from '../model';
import { ColorPopoverComponent } from './color-popover.component';
import { TemplateMenuComponent } from './template-menu.component';
import { hasFill, hasText, parseColor } from './colors';

type Pop = 'templates' | 'line' | 'fill' | 'text' | 'width' | 'dash' | 'more' | null;

const POS_KEY = 'lascodia.chart.drawing-toolbar.pos.v1';

/**
 * TradingView's floating drawing toolbar, shown while a drawing is selected.
 *
 * Grip · Templates · Line colour · Background · Text colour · Width · Style ·
 * Settings · Lock · Delete · More. Draggable by its grip; the position is
 * remembered per browser like TradingView's. Every edit is one undo step.
 */
@Component({
  selector: 'app-drawing-toolbar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ChartIconComponent, ColorPopoverComponent, TemplateMenuComponent],
  template: `
    @let d = drawing();
    <div
      class="dt"
      role="toolbar"
      aria-label="Drawing toolbar"
      [style.left]="pos() ? pos()!.x + 'px' : '50%'"
      [style.top.px]="pos()?.y ?? 8"
      [class.centred]="!pos()"
      (pointerdown)="$event.stopPropagation()"
    >
      <span class="dt-grip" title="Drag toolbar" (pointerdown)="startDrag($event)">
        <app-chart-icon name="grip" [size]="22" />
      </span>

      <span class="dt-anchor">
        <button type="button" class="dt-btn" title="Templates" [class.open]="pop() === 'templates'" (click)="toggle('templates')">
          <app-chart-icon name="templates" [size]="24" />
        </button>
        @if (pop() === 'templates') {
          <app-template-menu class="dt-pop" [drawing]="d" (apply)="applyTemplate($event)" />
        }
      </span>

      <span class="dt-sep"></span>

      <span class="dt-anchor">
        <button type="button" class="dt-btn" title="Line tool colour" [class.open]="pop() === 'line'" (click)="toggle('line')">
          <span class="dt-swatch-icon">
            <app-chart-icon name="line-color" [size]="22" />
            <span class="dt-bar" [style.background]="d.style.color"></span>
          </span>
        </button>
        @if (pop() === 'line') {
          <app-color-popover class="dt-pop" [value]="d.style.color" (changed)="style({ color: $event })" />
        }
      </span>

      @if (fillable()) {
        <span class="dt-anchor">
          <button type="button" class="dt-btn" title="Background colour" [class.open]="pop() === 'fill'" (click)="toggle('fill')">
            <span class="dt-swatch-icon">
              <app-chart-icon name="fill" [size]="22" />
              <span class="dt-bar" [style.background]="d.style.fill ?? 'transparent'" [class.none]="!d.style.fill"></span>
            </span>
          </button>
          @if (pop() === 'fill') {
            <app-color-popover class="dt-pop" [value]="d.style.fill ?? fillSeed()" (changed)="style({ fill: $event })" />
          }
        </span>
      }

      @if (texty()) {
        <span class="dt-anchor">
          <button type="button" class="dt-btn" title="Text colour" [class.open]="pop() === 'text'" (click)="toggle('text')">
            <span class="dt-swatch-icon">
              <app-chart-icon name="text-color" [size]="22" />
              <span class="dt-bar" [style.background]="d.style.textColor ?? d.style.color"></span>
            </span>
          </button>
          @if (pop() === 'text') {
            <app-color-popover
              class="dt-pop"
              [value]="d.style.textColor ?? d.style.color"
              (changed)="style({ textColor: $event })"
            />
          }
        </span>
      }

      <span class="dt-anchor">
        <button type="button" class="dt-btn dt-wide" title="Line width" [class.open]="pop() === 'width'" (click)="toggle('width')">
          <span class="dt-wline" [style.height.px]="d.style.width"></span>
          <span class="dt-wlabel">{{ d.style.width }}px</span>
        </button>
        @if (pop() === 'width') {
          <div class="dt-pop dt-menu">
            @for (w of widths; track w) {
              <button type="button" class="dt-item" [class.on]="d.style.width === w" (click)="style({ width: w }); pop.set(null)">
                <span class="dt-wline long" [style.height.px]="w"></span>
                <span>{{ w }}px</span>
              </button>
            }
          </div>
        }
      </span>

      <span class="dt-anchor">
        <button type="button" class="dt-btn" title="Line style" [class.open]="pop() === 'dash'" (click)="toggle('dash')">
          <app-chart-icon [name]="'line-' + d.style.dash" [size]="24" />
        </button>
        @if (pop() === 'dash') {
          <div class="dt-pop dt-menu">
            @for (s of dashes; track s.id) {
              <button type="button" class="dt-item" [class.on]="d.style.dash === s.id" (click)="style({ dash: s.id }); pop.set(null)">
                <app-chart-icon [name]="'line-' + s.id" [size]="24" />
                <span>{{ s.label }}</span>
              </button>
            }
          </div>
        }
      </span>

      <span class="dt-sep"></span>

      <button type="button" class="dt-btn" title="Settings" (click)="pop.set(null); settings.emit(d.id)">
        <app-chart-icon name="settings" [size]="24" />
      </button>
      <button
        type="button"
        class="dt-btn"
        [class.on]="d.locked"
        [title]="d.locked ? 'Unlock' : 'Lock'"
        (click)="store.toggleLock(d.id)"
      >
        <app-chart-icon [name]="d.locked ? 'lock' : 'unlock'" [size]="24" />
      </button>
      <button type="button" class="dt-btn" title="Remove" (click)="remove()">
        <app-chart-icon name="trash" [size]="24" />
      </button>

      <span class="dt-anchor">
        <button type="button" class="dt-btn" title="More" [class.open]="pop() === 'more'" (click)="toggle('more')">
          <app-chart-icon name="more" [size]="24" />
        </button>
        @if (pop() === 'more') {
          <div class="dt-pop dt-menu dt-more">
            <button type="button" class="dt-item" (click)="act('clone')"><app-chart-icon name="clone" [size]="20" />Clone</button>
            <button type="button" class="dt-item" (click)="act('copy')"><span class="dt-ico"></span>Copy<kbd>{{ mod }}C</kbd></button>
            <button type="button" class="dt-item" (click)="act('hide')"><app-chart-icon name="eye-off" [size]="20" />Hide</button>
            <div class="dt-msep"></div>
            <div class="dt-mhead">Visual order</div>
            <button type="button" class="dt-item" (click)="order('front')"><app-chart-icon name="bring-front" [size]="20" />Bring to front</button>
            <button type="button" class="dt-item" (click)="order('forward')"><span class="dt-ico"></span>Bring forward</button>
            <button type="button" class="dt-item" (click)="order('backward')"><span class="dt-ico"></span>Send backward</button>
            <button type="button" class="dt-item" (click)="order('back')"><app-chart-icon name="send-back" [size]="20" />Send to back</button>
            <div class="dt-msep"></div>
            <button type="button" class="dt-item danger" (click)="remove()"><app-chart-icon name="trash" [size]="20" />Remove</button>
          </div>
        }
      </span>
    </div>
  `,
  styles: `
    :host { position: absolute; inset: 0; pointer-events: none; z-index: 25; }
    .dt {
      position: absolute; display: flex; align-items: center; gap: 1px; padding: 2px;
      pointer-events: auto; background: var(--tv-bg, #fff); color: var(--tv-ink, #131722);
      border-radius: 6px; box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2), 0 0 0 1px var(--tv-line, #e0e3eb);
      user-select: none; font-size: 13px;
    }
    .dt.centred { transform: translateX(-50%); }
    .dt-grip {
      width: 18px; height: 34px; display: inline-flex; align-items: center; justify-content: center;
      color: var(--tv-muted, #787b86); cursor: grab;
    }
    .dt-grip:active { cursor: grabbing; }
    .dt-anchor { position: relative; display: inline-flex; }
    .dt-btn {
      min-width: 34px; height: 34px; padding: 0 5px; border: 0; border-radius: 4px; background: none;
      color: inherit; display: inline-flex; align-items: center; justify-content: center; gap: 4px; cursor: pointer;
      font: inherit;
    }
    .dt-btn:hover, .dt-btn.open { background: var(--tv-hover, #f0f3fa); }
    .dt-btn.on { color: var(--tv-blue, #2962ff); }
    .dt-wide { padding: 0 8px; }
    .dt-sep { width: 1px; height: 22px; margin: 0 3px; background: var(--tv-line, #e0e3eb); }
    .dt-swatch-icon { position: relative; display: inline-flex; flex-direction: column; align-items: center; }
    .dt-bar { width: 18px; height: 4px; border-radius: 1px; margin-top: -3px; border: 1px solid rgba(0, 0, 0, 0.1); }
    .dt-bar.none { background: repeating-linear-gradient(-45deg, transparent 0 2px, #f23645 2px 3px) !important; }
    .dt-wline { display: inline-block; width: 16px; background: currentColor; border-radius: 1px; min-height: 1px; }
    .dt-wline.long { width: 40px; }
    .dt-wlabel { font-size: 12px; }
    .dt-pop { position: absolute; top: calc(100% + 6px); left: 0; z-index: 2; }
    .dt-menu {
      min-width: 150px; padding: 6px 0; background: var(--tv-bg, #fff); border-radius: 6px;
      box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2), 0 0 0 1px var(--tv-line, #e0e3eb);
    }
    .dt-more { left: auto; right: 0; min-width: 210px; }
    .dt-item {
      display: flex; align-items: center; gap: 10px; width: 100%; padding: 6px 14px; border: 0;
      background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; white-space: nowrap;
    }
    .dt-item:hover { background: var(--tv-hover, #f0f3fa); }
    .dt-item.on { background: var(--tv-active-bg, #e3effd); color: var(--tv-blue, #2962ff); }
    .dt-item.danger:hover { color: var(--tv-down, #f23645); }
    .dt-item kbd { margin-left: auto; color: var(--tv-muted, #787b86); font: inherit; font-size: 12px; }
    .dt-ico { width: 20px; }
    .dt-msep { height: 1px; margin: 6px 0; background: var(--tv-line, #e0e3eb); }
    .dt-mhead { padding: 4px 14px; font-size: 11px; color: var(--tv-muted, #787b86); text-transform: uppercase; letter-spacing: 0.4px; }
  `,
})
export class DrawingToolbarComponent {
  readonly store = inject(DrawingStore);
  private readonly el = inject(ElementRef<HTMLElement>);

  readonly drawing = input.required<Drawing>();
  readonly settings = output<string>();

  readonly pop = signal<Pop>(null);
  readonly pos = signal<{ x: number; y: number } | null>(readPos());
  readonly widths = [1, 2, 3, 4] as const;
  readonly dashes: { id: DashStyle; label: string }[] = [
    { id: 'solid', label: 'Line' },
    { id: 'dashed', label: 'Dashed line' },
    { id: 'dotted', label: 'Dotted line' },
  ];
  readonly mod = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform) ? '⌘' : 'Ctrl+';

  readonly fillable = computed(() => hasFill(this.drawing()));
  readonly texty = computed(() => hasText(this.drawing()));
  /** Picking a colour for an unfilled shape starts from TV's 20% tint of the line. */
  readonly fillSeed = computed(() => {
    const { hex } = parseColor(this.drawing().style.color);
    return `${hex}33`;
  });

  toggle(p: Exclude<Pop, null>): void {
    this.pop.set(this.pop() === p ? null : p);
  }

  style(patch: Partial<DrawingStyle>): void {
    this.store.updateStyle(this.drawing().id, patch);
  }

  applyTemplate(t: DrawingTemplate): void {
    const d = this.drawing();
    this.store.update(d.id, {
      style: { ...d.style, ...t.style, text: d.style.text },
      options: t.options && Object.keys(t.options).length ? { ...t.options } : undefined,
    });
    this.pop.set(null);
  }

  remove(): void {
    this.pop.set(null);
    this.store.remove(this.drawing().id);
  }

  act(a: 'clone' | 'copy' | 'hide'): void {
    const id = this.drawing().id;
    this.pop.set(null);
    if (a === 'clone') {
      const c = this.store.clone(id);
      if (c) this.store.selectedId.set(c.id);
    } else if (a === 'copy') {
      this.store.copy(id);
    } else {
      this.store.setHidden(id, true);
      this.store.selectedId.set(null);
    }
  }

  order(op: ZOrderOp): void {
    this.pop.set(null);
    this.store.reorder(this.drawing().id, op);
  }

  // ── drag by the grip ──
  startDrag(ev: PointerEvent): void {
    ev.preventDefault();
    const bar = (this.el.nativeElement as HTMLElement).querySelector('.dt') as HTMLElement;
    const host = (this.el.nativeElement as HTMLElement).getBoundingClientRect();
    const r = bar.getBoundingClientRect();
    const off = { x: ev.clientX - r.left, y: ev.clientY - r.top };
    this.pop.set(null);
    const move = (e: PointerEvent) => {
      const x = Math.max(0, Math.min(host.width - r.width, e.clientX - host.left - off.x));
      const y = Math.max(0, Math.min(host.height - r.height, e.clientY - host.top - off.y));
      this.pos.set({ x, y });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      try {
        localStorage.setItem(POS_KEY, JSON.stringify(this.pos()));
      } catch {
        /* position just isn't remembered */
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  /** Clicking anywhere outside closes an open popover. */
  @HostListener('document:pointerdown', ['$event'])
  onDocPointer(ev: PointerEvent): void {
    if (this.pop() && !(this.el.nativeElement as HTMLElement).querySelector('.dt')?.contains(ev.target as Node)) {
      this.pop.set(null);
    }
  }
}

function readPos(): { x: number; y: number } | null {
  try {
    const raw = localStorage.getItem(POS_KEY);
    const p = raw ? (JSON.parse(raw) as { x: number; y: number } | null) : null;
    return p && Number.isFinite(p.x) && Number.isFinite(p.y) ? p : null;
  } catch {
    return null;
  }
}
