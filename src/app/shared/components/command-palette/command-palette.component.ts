import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  OnInit,
  afterNextRender,
  computed,
  inject,
  signal,
} from '@angular/core';
import { Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { LucideDynamicIcon } from '@lucide/angular';
import {
  EMPTY,
  catchError,
  debounceTime,
  distinctUntilChanged,
  fromEvent,
  of,
  switchMap,
} from 'rxjs';

import { GlobalSearchService } from '@core/search/global-search.service';
import { PAGE_CATALOG } from '@shared/navigation/page-catalog';
import { navIcon } from '../../../layout/sidebar/nav-icons';
import { CommandPaletteService } from './command-palette.service';
import {
  groupCommands,
  highlightSegments,
  iconForRoute,
  queryTokens,
  rankCommands,
  routeTrail,
  type PaletteCommand as Command,
} from './command-palette.logic';

/** Rows shown before anything is typed, and the cap on page matches once something is. */
const BROWSE_LIMIT = 24;
const MATCH_LIMIT = 40;

/**
 * Global command palette bound to ⌘K / Ctrl+K (and the header's search box). A centred panel with
 * a search field over the console's pages, grouped by section with the sidebar's icons; from two
 * characters it also searches orders, strategies and signals.
 */
@Component({
  selector: 'app-command-palette',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, LucideDynamicIcon],
  template: `
    @if (open()) {
      <div class="overlay" tabindex="-1" (click)="close()" (keydown.escape)="close()">
        <div
          class="palette"
          role="dialog"
          aria-modal="true"
          aria-label="Command palette"
          tabindex="-1"
          (click)="$event.stopPropagation()"
          (keydown)="$event.stopPropagation()"
          (keydown.escape)="close()"
        >
          <div class="search">
            <svg
              class="search-icon"
              [lucideIcon]="icons.Search"
              [size]="20"
              [strokeWidth]="2"
              aria-hidden="true"
            ></svg>
            <input
              type="text"
              class="input"
              role="combobox"
              aria-expanded="true"
              aria-controls="palette-list"
              aria-autocomplete="list"
              [attr.aria-activedescendant]="flat().length ? 'palette-opt-' + activeIndex() : null"
              [ngModel]="query()"
              (ngModelChange)="onQuery($event)"
              (keydown)="onKeydown($event)"
              placeholder="Search pages, orders, strategies…"
              autocomplete="off"
              spellcheck="false"
              aria-label="Search pages, orders, strategies and signals"
            />
            @if (query()) {
              <button type="button" class="clear" aria-label="Clear search" (click)="clearQuery()">
                <svg
                  [lucideIcon]="icons.X"
                  [size]="14"
                  [strokeWidth]="2.25"
                  aria-hidden="true"
                ></svg>
              </button>
            }
            <kbd class="esc">esc</kbd>
          </div>

          <div class="list" id="palette-list" role="listbox" aria-label="Matches">
            @for (section of sections(); track section.group) {
              <div class="section" role="group" [attr.aria-label]="section.group">
                <div class="section-title" aria-hidden="true">{{ section.group }}</div>
                @for (cmd of section.items; track cmd.route + cmd.label; let j = $index) {
                  @let i = section.start + j;
                  <div
                    role="option"
                    class="item"
                    [id]="'palette-opt-' + i"
                    [attr.aria-selected]="i === activeIndex()"
                    [class.active]="i === activeIndex()"
                    tabindex="-1"
                    (click)="run(cmd)"
                    (keydown.enter)="run(cmd)"
                    (mousemove)="hover(i, $event)"
                  >
                    <span class="item-icon" aria-hidden="true">
                      <svg [lucideIcon]="iconFor(cmd)" [size]="16" [strokeWidth]="1.9"></svg>
                    </span>
                    <span class="item-text">
                      <!-- One line on purpose: whitespace between the pieces would split a word. -->
                      <span class="item-label">
                        @for (seg of segments(cmd.label); track $index) {
                          <span [class.hit]="seg.hit">{{ seg.text }}</span>
                        }
                      </span>
                      <span class="item-trail">{{ trail(cmd.route) }}</span>
                    </span>
                    <span class="item-go" aria-hidden="true">
                      <svg [lucideIcon]="icons.CornerDownLeft" [size]="14" [strokeWidth]="2"></svg>
                    </span>
                  </div>
                }
              </div>
            } @empty {
              <div class="empty">
                <svg
                  class="empty-icon"
                  [lucideIcon]="icons.SearchX"
                  [size]="28"
                  [strokeWidth]="1.5"
                  aria-hidden="true"
                ></svg>
                <div class="empty-title">No matches for “{{ query().trim() }}”</div>
                <div class="empty-hint">Try a page name, a symbol, or an order or signal id.</div>
              </div>
            }
          </div>

          <div class="footer" aria-hidden="true">
            <span class="keys">
              <span class="key-group"><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
              <span class="key-group"><kbd>↵</kbd> open</span>
              <span class="key-group"><kbd>esc</kbd> close</span>
            </span>
            <span class="count">
              @if (searching()) {
                Searching…
              } @else if (query().trim()) {
                {{ flat().length }} {{ flat().length === 1 ? 'match' : 'matches' }}
              } @else {
                Type to search {{ commands.length }} pages
              }
            </span>
          </div>
        </div>
      </div>
    }
  `,
  styles: [
    `
      .overlay {
        position: fixed;
        inset: 0;
        background: color-mix(in srgb, #0b0d12 38%, transparent);
        display: flex;
        align-items: flex-start;
        justify-content: center;
        padding: 12vh var(--space-4) var(--space-4);
        z-index: 1200;
        backdrop-filter: blur(3px);
        -webkit-backdrop-filter: blur(3px);
        animation: fadeIn var(--dur-fast) ease-out;
      }
      :host-context([data-theme='dark']) .palette,
      :host-context([data-theme='dark']) .section-title {
        background: var(--bg-secondary);
      }
      :host-context([data-theme='dark']) .item-icon,
      :host-context([data-theme='dark']) .footer,
      :host-context([data-theme='dark']) kbd {
        background: var(--bg-tertiary);
      }
      .palette {
        width: min(680px, 100%);
        max-height: min(620px, 76vh);
        display: flex;
        flex-direction: column;
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: 16px;
        box-shadow:
          0 0 0 1px color-mix(in srgb, var(--text-primary) 4%, transparent),
          0 24px 64px -12px rgba(0, 0, 0, 0.35),
          0 8px 20px -8px rgba(0, 0, 0, 0.2);
        overflow: hidden;
        outline: none;
        animation: pop var(--dur-base) var(--ease-press);
      }

      /* ── search field ── */
      .search {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 0 16px 0 18px;
        height: 60px;
        flex: none;
        border-bottom: 1px solid var(--border);
      }
      .search-icon {
        color: var(--accent);
        flex: none;
      }
      .input {
        flex: 1;
        min-width: 0;
        height: 100%;
        border: none;
        outline: none;
        background: transparent;
        color: var(--text-primary);
        font-family: inherit;
        font-size: 17px;
        letter-spacing: -0.01em;
      }
      /* The search row is the field: the global input focus ring (styles.scss) would draw a box
         inside it. Scoped through .search so it outranks that rule's specificity. */
      .search input.input:focus,
      .search input.input:focus-visible {
        outline: none;
        box-shadow: none;
        border: none;
      }
      .input::placeholder {
        color: var(--text-tertiary);
      }
      .clear {
        display: grid;
        place-items: center;
        width: 22px;
        height: 22px;
        border: none;
        border-radius: 50%;
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        cursor: pointer;
        flex: none;
      }
      .clear:hover {
        color: var(--text-primary);
      }
      .clear:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 2px;
      }
      kbd {
        display: inline-grid;
        place-items: center;
        min-width: 20px;
        height: 20px;
        padding: 0 5px;
        font-family: inherit;
        font-size: 11px;
        font-weight: var(--font-medium);
        line-height: 1;
        color: var(--text-secondary);
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-bottom-width: 2px;
        border-radius: 5px;
      }
      .esc {
        flex: none;
      }

      /* ── results ── */
      .list {
        flex: 1;
        overflow-y: auto;
        overscroll-behavior: contain;
        padding: 6px 8px 8px;
        scroll-padding: 34px 0 8px;
      }
      .section + .section {
        margin-top: 4px;
      }
      .section-title {
        position: sticky;
        top: -6px;
        z-index: 1;
        padding: 10px 10px 6px;
        font-size: 11px;
        font-weight: var(--font-semibold);
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--text-tertiary);
        background: var(--bg-primary);
      }
      .item {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 8px 10px;
        border-radius: 10px;
        cursor: pointer;
        color: var(--text-primary);
        scroll-margin: 34px 0 8px;
      }
      .item-icon {
        display: grid;
        place-items: center;
        width: 32px;
        height: 32px;
        flex: none;
        border-radius: 8px;
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        color: var(--text-secondary);
        transition:
          background var(--dur-fast) ease,
          color var(--dur-fast) ease;
      }
      .item-text {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 1px;
      }
      .item-label {
        font-size: 14px;
        font-weight: var(--font-medium);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .item-label .hit {
        color: var(--accent);
        font-weight: var(--font-semibold);
      }
      .item-trail {
        font-size: 12px;
        color: var(--text-tertiary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .item-go {
        display: grid;
        place-items: center;
        width: 24px;
        height: 24px;
        flex: none;
        border-radius: 6px;
        color: var(--accent);
        background: color-mix(in srgb, var(--accent) 12%, transparent);
        opacity: 0;
        transform: translateX(-4px);
        transition:
          opacity var(--dur-fast) ease,
          transform var(--dur-fast) ease;
      }
      .item.active {
        background: color-mix(in srgb, var(--accent) 9%, transparent);
      }
      .item.active .item-icon {
        background: var(--accent);
        border-color: transparent;
        color: #fff;
      }
      .item.active .item-go {
        opacity: 1;
        transform: none;
      }

      .empty {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 6px;
        padding: 40px 16px 44px;
        text-align: center;
      }
      .empty-icon {
        color: var(--text-tertiary);
        margin-bottom: 6px;
      }
      .empty-title {
        font-size: 14px;
        font-weight: var(--font-medium);
        color: var(--text-primary);
        word-break: break-word;
      }
      .empty-hint {
        font-size: 13px;
        color: var(--text-tertiary);
      }

      /* ── footer ── */
      .footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        flex: none;
        padding: 9px 16px;
        border-top: 1px solid var(--border);
        background: var(--bg-secondary);
        font-size: 12px;
        color: var(--text-tertiary);
      }
      .keys {
        display: flex;
        gap: 14px;
      }
      .key-group {
        display: inline-flex;
        align-items: center;
        gap: 4px;
      }
      .count {
        white-space: nowrap;
      }

      @media (max-width: 600px) {
        .overlay {
          padding-top: 8vh;
        }
        .keys {
          display: none;
        }
        .item-trail {
          display: none;
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .overlay,
        .palette {
          animation: none;
        }
      }
      @keyframes fadeIn {
        from {
          opacity: 0;
        }
        to {
          opacity: 1;
        }
      }
      @keyframes pop {
        from {
          transform: translateY(-8px) scale(0.985);
          opacity: 0;
        }
        to {
          transform: none;
          opacity: 1;
        }
      }
    `,
  ],
})
export class CommandPaletteComponent implements OnInit {
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly host: HTMLElement = inject(ElementRef<HTMLElement>).nativeElement;
  private readonly injector = inject(Injector);
  private readonly globalSearch = inject(GlobalSearchService);
  private readonly paletteRequests = inject(CommandPaletteService);

  // Named one by one: scripts/generate-nav-icons.mjs bundles only the `navIcon.<Name>` it can see.
  protected readonly icons = {
    Search: navIcon.Search,
    SearchX: navIcon.SearchX,
    X: navIcon.X,
    CornerDownLeft: navIcon.CornerDownLeft,
  };

  readonly open = signal(false);
  readonly query = signal('');
  readonly activeIndex = signal(0);
  readonly remoteResults = signal<Command[]>([]);
  readonly searching = signal(false);

  // Built during field initialization so `toObservable` runs inside the
  // injection context. Angular 20 rejects calls made from lifecycle hooks
  // (NG0203) unless an explicit `Injector` is forwarded.
  private readonly query$ = toObservable(this.query);

  readonly commands: readonly Command[] = PAGE_CATALOG;

  private readonly tokens = computed(() => queryTokens(this.query()));

  /** Matches in the order they are drawn: page sections first, then search results. */
  readonly sections = computed(() => {
    const tokens = this.tokens();
    const nav = !tokens.length
      ? this.commands.slice(0, BROWSE_LIMIT)
      : rankCommands(this.commands, tokens).slice(0, MATCH_LIMIT);
    return groupCommands([...nav, ...this.remoteResults()]);
  });

  /** The drawn rows, flattened: what the arrow keys walk and Enter opens. */
  readonly flat = computed<Command[]>(() => this.sections().flatMap((s) => s.items));

  /** The last pointer position, so a list scrolled under a still mouse does not steal the row. */
  private lastPointer = '';

  ngOnInit(): void {
    // The header's search box (and anything else) opens the palette through the root service.
    this.paletteRequests.openRequested$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.openPalette());

    fromEvent<KeyboardEvent>(document, 'keydown')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((event) => {
        const isMod = event.metaKey || event.ctrlKey;
        if (isMod && event.key.toLowerCase() === 'k') {
          event.preventDefault();
          this.toggle();
        }
      });

    // Fan-out global entity search for queries ≥ 2 chars. Debounced +
    // switch-mapped so bursts of keystrokes collapse to one in-flight request,
    // and errors are swallowed so a backend hiccup can never blow up the palette.
    this.query$
      .pipe(
        debounceTime(250),
        distinctUntilChanged(),
        switchMap((q) => {
          const trimmed = q.trim();
          if (trimmed.length < 2) {
            this.searching.set(false);
            return of([] as Command[]);
          }
          this.searching.set(true);
          return this.globalSearch.search(trimmed).pipe(
            catchError(() => {
              this.searching.set(false);
              return EMPTY;
            }),
            switchMap((results) =>
              of(
                results.map<Command>((r) => ({
                  group: 'Results',
                  label: r.sublabel ? `${r.label} · ${r.sublabel}` : r.label,
                  route: r.route,
                })),
              ),
            ),
          );
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((results) => {
        this.searching.set(false);
        this.remoteResults.set(results);
      });
  }

  toggle(): void {
    if (this.open()) {
      this.close();
    } else {
      this.openPalette();
    }
  }

  openPalette(): void {
    this.query.set('');
    this.activeIndex.set(0);
    this.remoteResults.set([]);
    this.searching.set(false);
    this.open.set(true);
    // After the panel renders: a microtask ran before the @if drew the input, so focus stayed on
    // the page and the first keystrokes went nowhere.
    afterNextRender(() => this.focusInput(), { injector: this.injector });
  }

  close(): void {
    this.open.set(false);
  }

  onQuery(value: string): void {
    this.query.set(value);
    this.activeIndex.set(0);
    this.host.querySelector('.list')?.scrollTo({ top: 0 });
  }

  clearQuery(): void {
    this.onQuery('');
    this.remoteResults.set([]);
    this.focusInput();
  }

  hover(index: number, event?: MouseEvent): void {
    if (event) {
      const at = `${event.clientX},${event.clientY}`;
      if (at === this.lastPointer) return;
      this.lastPointer = at;
    }
    this.activeIndex.set(index);
  }

  onKeydown(event: KeyboardEvent): void {
    const matches = this.flat();
    if (event.key === 'Escape') {
      event.preventDefault();
      this.close();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!matches.length) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      // Wraps at either end, like every native list.
      this.activeIndex.set((this.activeIndex() + step + matches.length) % matches.length);
      this.revealActive();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const pick = matches[this.activeIndex()];
      if (pick) this.run(pick);
    }
  }

  run(command: Command): void {
    this.close();
    this.router.navigateByUrl(command.route);
  }

  protected iconFor(cmd: Command) {
    return iconForRoute(cmd.route);
  }

  protected segments(label: string) {
    return highlightSegments(label, this.tokens());
  }

  protected trail(route: string): string {
    return routeTrail(route);
  }

  private focusInput(): void {
    this.host.querySelector<HTMLInputElement>('input')?.focus();
  }

  private revealActive(): void {
    queueMicrotask(() =>
      this.host
        .querySelector(`#palette-opt-${this.activeIndex()}`)
        ?.scrollIntoView?.({ block: 'nearest' }),
    );
  }
}
