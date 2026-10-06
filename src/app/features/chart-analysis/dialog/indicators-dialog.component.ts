import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  input,
  output,
  signal,
  viewChild,
  afterNextRender,
} from '@angular/core';
import { ChartIconComponent } from '../icons/chart-icon.component';
import {
  ALL,
  DIALOG_TABS,
  FAVOURITES,
  TAB_FOR_KIND,
  categoriesFor,
  filterItems,
  itemKey,
  type DialogItem,
  type DialogTab,
} from './dialog-items';

const FAV_STORAGE = 'lascodia.chart.favouriteStudies';

function loadFavourites(): Set<string> {
  try {
    const raw = localStorage.getItem(FAV_STORAGE);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

/**
 * TradingView-style "Indicators, metrics and strategies" dialog: search across
 * everything, tabs per family, a category sidebar with favourites, and a
 * description line under the hovered item. Favourites are a per-viewer
 * convenience, so they live in localStorage.
 */
@Component({
  selector: 'app-indicators-dialog',
  imports: [ChartIconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(keydown.escape)': 'closed.emit()' },
  template: `
    <div class="backdrop" (click)="closed.emit()"></div>
    <div class="dialog" role="dialog" aria-label="Indicators, metrics and strategies">
      <header>
        <h2>Indicators, metrics and strategies</h2>
        <button type="button" class="close" (click)="closed.emit()" aria-label="Close">
          <app-chart-icon name="close" [size]="20" />
        </button>
      </header>
      <input
        #search
        class="search"
        type="search"
        placeholder="Search"
        [value]="query()"
        (input)="query.set($any($event.target).value)"
      />
      <nav class="tabs" role="tablist">
        @for (t of tabs; track t.id) {
          <button
            type="button"
            role="tab"
            [class.active]="tab() === t.id && !query()"
            [attr.aria-selected]="tab() === t.id"
            (click)="selectTab(t.id)"
          >
            {{ t.label }} <span class="count">{{ counts()[t.id] }}</span>
          </button>
        }
      </nav>
      <div class="body">
        @if (!query()) {
          <ul class="categories">
            @for (c of categories(); track c) {
              <li>
                <button type="button" [class.active]="category() === c" (click)="category.set(c)">
                  @if (c === favouritesLabel) {
                    <app-chart-icon name="star" [size]="16" />
                  }
                  {{ c }}
                </button>
              </li>
            }
          </ul>
        }
        <ul class="items" data-testid="dialog-items">
          @for (it of visible(); track key(it)) {
            <li (mouseenter)="hovered.set(it)">
              <button
                type="button"
                class="fav"
                [class.on]="favourites().has(key(it))"
                (click)="toggleFavourite(it)"
                [title]="favourites().has(key(it)) ? 'Remove from favourites' : 'Add to favourites'"
              >
                <app-chart-icon
                  [name]="favourites().has(key(it)) ? 'star-filled' : 'star'"
                  [size]="16"
                />
              </button>
              @if (confirming() === key(it)) {
                <span class="confirm" role="alert">
                  <span class="name">Delete “{{ it.name }}”? This cannot be undone.</span>
                  <button type="button" class="confirm-yes" (click)="confirmDelete(it)">
                    Delete
                  </button>
                  <button type="button" class="confirm-no" (click)="cancelDelete()">Cancel</button>
                </span>
              } @else {
                <button type="button" class="pick" (click)="picked.emit(it)">
                  <span class="name">{{ it.name }}</span>
                  @if (query()) {
                    <span class="muted">{{ tabLabel(it) }}</span>
                  }
                  @if (it.tag) {
                    <span class="muted">{{ it.tag }}</span>
                  }
                </button>
                @if (it.deletable) {
                  <button
                    type="button"
                    class="del"
                    [attr.aria-label]="'Delete ' + it.name"
                    title="Delete script"
                    (click)="askDelete(it)"
                  >
                    <app-chart-icon name="trash" [size]="16" />
                  </button>
                }
              }
            </li>
          } @empty {
            <li class="empty">{{ emptyText() }}</li>
          }
        </ul>
      </div>
      <footer class="description">{{ hovered()?.description ?? '' }}</footer>
    </div>
  `,
  styles: `
    :host {
      position: fixed;
      inset: 0;
      z-index: 200;
      display: grid;
      place-items: center;
    }
    .backdrop {
      position: absolute;
      inset: 0;
      background: rgba(0, 0, 0, 0.25);
    }
    .dialog {
      position: relative;
      width: min(760px, calc(100vw - 32px));
      height: min(560px, calc(100vh - 64px));
      display: flex;
      flex-direction: column;
      background: var(--surface, #fff);
      color: inherit;
      border: 1px solid var(--border, #e6e9ef);
      border-radius: 10px;
      box-shadow: 0 16px 48px rgba(0, 0, 0, 0.25);
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 14px 16px 6px;
    }
    h2 {
      margin: 0;
      font-size: 16px;
      font-weight: 600;
    }
    .close {
      border: 0;
      background: transparent;
      color: inherit;
      font-size: 16px;
      cursor: pointer;
    }
    .search {
      margin: 6px 16px;
      padding: 8px 10px;
      border: 1px solid var(--border, #e6e9ef);
      border-radius: 6px;
      background: transparent;
      color: inherit;
      font: inherit;
    }
    .tabs {
      display: flex;
      gap: 6px;
      padding: 6px 16px;
      flex-wrap: wrap;
    }
    .tabs button {
      border: 1px solid var(--border, #e6e9ef);
      background: transparent;
      color: inherit;
      border-radius: 14px;
      padding: 3px 12px;
      cursor: pointer;
      font: inherit;
      font-size: 12px;
    }
    .tabs button.active {
      background: var(--text, #131722);
      color: var(--surface, #fff);
    }
    .count {
      opacity: 0.6;
      font-size: 11px;
    }
    .body {
      flex: 1;
      display: flex;
      min-height: 0;
      border-top: 1px solid var(--border, #e6e9ef);
    }
    ul {
      list-style: none;
      margin: 0;
      padding: 6px 0;
      overflow-y: auto;
    }
    .categories {
      width: 180px;
      flex: none;
      border-right: 1px solid var(--border, #e6e9ef);
    }
    .categories button {
      width: 100%;
      text-align: left;
      border: 0;
      background: transparent;
      color: inherit;
      padding: 6px 14px;
      cursor: pointer;
      font: inherit;
      font-size: 13px;
    }
    .categories button.active {
      background: var(--hover, rgba(0, 0, 0, 0.06));
      font-weight: 600;
    }
    .items {
      flex: 1;
    }
    .items li {
      display: flex;
      align-items: center;
    }
    .items li:hover {
      background: var(--hover, rgba(0, 0, 0, 0.05));
    }
    .fav {
      border: 0;
      background: transparent;
      cursor: pointer;
      color: var(--muted, #9598a1);
      opacity: 0.35;
      padding: 6px 4px 6px 12px;
    }
    .fav.on {
      color: #f5b301;
      opacity: 1;
    }
    .items li:hover .fav {
      opacity: 1;
    }
    .pick {
      flex: 1;
      display: flex;
      gap: 10px;
      align-items: center;
      border: 0;
      background: transparent;
      color: inherit;
      text-align: left;
      padding: 6px 12px 6px 4px;
      cursor: pointer;
      font: inherit;
      font-size: 13px;
    }
    .name {
      flex: 1;
    }
    .del {
      border: 0;
      background: transparent;
      cursor: pointer;
      color: var(--muted, #9598a1);
      opacity: 0;
      padding: 6px 12px 6px 4px;
    }
    .items li:hover .del,
    .del:focus-visible {
      opacity: 1;
    }
    .del:hover {
      color: var(--danger, #f23645);
    }
    .confirm {
      flex: 1;
      display: flex;
      gap: 8px;
      align-items: center;
      padding: 4px 12px 4px 4px;
      font-size: 13px;
    }
    .confirm button {
      border: 1px solid var(--border, #e6e9ef);
      background: transparent;
      color: inherit;
      border-radius: 4px;
      padding: 2px 10px;
      cursor: pointer;
      font: inherit;
      font-size: 12px;
    }
    .confirm .confirm-yes {
      border-color: var(--danger, #f23645);
      background: var(--danger, #f23645);
      color: #fff;
    }
    .muted {
      color: var(--muted, #787b86);
      font-size: 11px;
    }
    .empty {
      padding: 16px;
      color: var(--muted, #787b86);
    }
    .description {
      min-height: 34px;
      padding: 8px 16px;
      font-size: 12px;
      color: var(--muted, #787b86);
      border-top: 1px solid var(--border, #e6e9ef);
    }
    @media (max-width: 600px) {
      .categories {
        width: 120px;
      }
    }
  `,
})
export class IndicatorsDialogComponent {
  readonly items = input.required<DialogItem[]>();
  readonly initialTab = input<DialogTab>('indicators');
  /** Scripts/strategies are still being fetched. */
  readonly loading = input(false);
  readonly picked = output<DialogItem>();
  readonly closed = output<void>();
  /** A deletable item the operator confirmed deleting; the page deletes it and refreshes `items`. */
  readonly deleteRequested = output<DialogItem>();

  /** Key of the row showing its "Delete …?" confirmation, if any. */
  readonly confirming = signal<string | null>(null);

  readonly tabs = DIALOG_TABS;
  readonly favouritesLabel = FAVOURITES;
  readonly key = itemKey;

  readonly query = signal('');
  readonly tab = signal<DialogTab>('indicators');
  readonly category = signal<string>(ALL);
  readonly hovered = signal<DialogItem | null>(null);
  readonly favourites = signal<Set<string>>(loadFavourites());

  private readonly searchEl = viewChild<ElementRef<HTMLInputElement>>('search');

  readonly categories = computed(() => categoriesFor(this.items(), this.tab()));
  readonly visible = computed(() =>
    filterItems(this.items(), {
      tab: this.tab(),
      category: this.category(),
      query: this.query(),
      favourites: this.favourites(),
    }),
  );
  readonly counts = computed(() => {
    const c: Record<DialogTab, number> = {
      indicators: 0,
      strategies: 0,
      profiles: 0,
      patterns: 0,
      fundamentals: 0,
    };
    for (const it of this.items()) c[TAB_FOR_KIND[it.kind]]++;
    return c;
  });
  readonly emptyText = computed(() =>
    this.loading() && this.tab() === 'strategies'
      ? 'Loading strategies…'
      : this.query()
        ? 'Nothing matches.'
        : this.category() === FAVOURITES
          ? 'No favourites yet — star an item to pin it here.'
          : 'Nothing here yet.',
  );

  constructor() {
    afterNextRender(() => {
      this.tab.set(this.initialTab());
      this.searchEl()?.nativeElement.focus();
    });
  }

  selectTab(tab: DialogTab): void {
    this.tab.set(tab);
    this.category.set(ALL);
    this.query.set('');
  }

  tabLabel(it: DialogItem): string {
    return DIALOG_TABS.find((t) => t.id === TAB_FOR_KIND[it.kind])?.label ?? '';
  }

  askDelete(it: DialogItem): void {
    if (it.deletable) this.confirming.set(itemKey(it));
  }

  cancelDelete(): void {
    this.confirming.set(null);
  }

  confirmDelete(it: DialogItem): void {
    if (this.confirming() !== itemKey(it)) return;
    this.confirming.set(null);
    this.deleteRequested.emit(it);
  }

  toggleFavourite(it: DialogItem): void {
    const next = new Set(this.favourites());
    const k = itemKey(it);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    this.favourites.set(next);
    try {
      localStorage.setItem(FAV_STORAGE, JSON.stringify([...next]));
    } catch {
      /* private mode — favourites just don't persist */
    }
  }
}
