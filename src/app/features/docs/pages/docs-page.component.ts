import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { DomSanitizer, type SafeHtml } from '@angular/platform-browser';
import { toSignal } from '@angular/core/rxjs-interop';
import { DatePipe } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { LucideDynamicIcon } from '@lucide/angular';
import { map } from 'rxjs';

import { DocsContentService } from '../docs-content.service';
import { DOC_GROUPS, guideBySlug, neighbours } from '../docs-catalog';
import { DOC_ICONS } from '../docs-icons';
import { isSafeDocHtml, readingMinutes, renderMarkdown, type DocHeading } from '../markdown';

/** A screenshot opened full size. */
interface Zoomed {
  src: string;
  alt: string;
  caption: string;
}

/**
 * `/docs/<slug>` — one guide: Markdown shipped with the console release, rendered by the docs renderer
 * (escape-first, fixed tags; see markdown.ts), with a table of contents that follows the reader, a
 * reading-progress bar, full-size screenshots on click, and the previous / next guide at the end.
 */
@Component({
  selector: 'app-docs-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, LucideDynamicIcon, DatePipe],
  styleUrl: './docs.scss',
  host: { '(window:scroll)': 'onScroll()', '(document:keydown.escape)': 'zoomed.set(null)' },
  template: `
    <div class="progress" aria-hidden="true"><span [style.width.%]="progress()"></span></div>
    <div class="page docs docs-guide">
      @if (guide(); as g) {
        <header class="guide-hero">
          <span class="guide-icon big">
            <svg
              [lucideIcon]="icons[g.icon]"
              [size]="28"
              [strokeWidth]="1.75"
              aria-hidden="true"
            ></svg>
          </span>
          <div>
            <h1>{{ g.title }}</h1>
            <p>{{ g.summary }}</p>
            <div class="guide-facts">
              <a class="fact link" routerLink="/docs">
                <svg
                  [lucideIcon]="icons['book-open']"
                  [size]="14"
                  [strokeWidth]="2"
                  aria-hidden="true"
                ></svg>
                {{ group()?.title }}
              </a>
              <span class="fact">
                <svg
                  [lucideIcon]="icons.users"
                  [size]="14"
                  [strokeWidth]="2"
                  aria-hidden="true"
                ></svg>
                For {{ g.audience === 'Everyone' ? 'everyone' : g.audience.toLowerCase() }}
              </span>
              @if (minutes()) {
                <span class="fact">
                  <svg
                    [lucideIcon]="icons.clock"
                    [size]="14"
                    [strokeWidth]="2"
                    aria-hidden="true"
                  ></svg>
                  {{ minutes() }} min read
                </span>
              }
              <span class="fact">
                <svg
                  [lucideIcon]="icons.calendar"
                  [size]="14"
                  [strokeWidth]="2"
                  aria-hidden="true"
                ></svg>
                Updated {{ g.updated | date: 'd MMM y' }}
              </span>
            </div>
          </div>
        </header>

        <div class="docs-layout">
          @if (headings().length > 2) {
            <nav class="toc" aria-label="On this page">
              <span class="toc-title">On this page</span>
              @for (h of tocHeadings(); track h.id) {
                <a
                  [class.sub]="h.level === 3"
                  [class.active]="h.id === active()"
                  [href]="'#' + h.id"
                  (click)="jump($event, h.id)"
                  >{{ h.text }}</a
                >
              }
              <a class="toc-top" href="#" (click)="top($event)">↑ Back to top</a>
            </nav>
          }
          <article class="doc">
            @if (error(); as e) {
              <p role="alert" class="load-error">{{ e }}</p>
            } @else if (html() === null) {
              <div class="skeleton" aria-label="Loading">
                <span></span><span></span><span class="short"></span><span></span>
              </div>
            } @else {
              <div class="md" [innerHTML]="html()" (click)="follow($event)"></div>
            }

            <footer class="guide-foot">
              @if (around().prev; as p) {
                <a class="next-card prev" [routerLink]="['/docs', p.slug]">
                  <span class="dir">← Previous</span>
                  <strong>{{ p.title }}</strong>
                </a>
              } @else {
                <span></span>
              }
              @if (around().next; as n) {
                <a class="next-card next" [routerLink]="['/docs', n.slug]">
                  <span class="dir">Next →</span>
                  <strong>{{ n.title }}</strong>
                </a>
              }
            </footer>
            <p class="all-guides"><a routerLink="/docs">See all guides</a></p>
          </article>
        </div>
      } @else {
        <div class="not-found">
          <svg
            [lucideIcon]="icons['circle-help']"
            [size]="40"
            [strokeWidth]="1.5"
            aria-hidden="true"
          ></svg>
          <h1>We could not find that guide</h1>
          <p>It may have been renamed. Every guide is listed on the help page.</p>
          <a class="btn btn-primary" routerLink="/docs">Go to Help &amp; guides</a>
        </div>
      }
    </div>

    @if (zoomed(); as z) {
      <div
        class="lightbox"
        role="dialog"
        aria-modal="true"
        [attr.aria-label]="z.alt"
        (click)="zoomed.set(null)"
      >
        <figure>
          <img [src]="z.src" [alt]="z.alt" />
          @if (z.caption) {
            <figcaption>{{ z.caption }}</figcaption>
          }
        </figure>
        <button type="button" class="lightbox-close" aria-label="Close">×</button>
      </div>
    }
  `,
})
export class DocsPageComponent {
  private readonly content = inject(DocsContentService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly host = inject(ElementRef<HTMLElement>);

  protected readonly icons = DOC_ICONS;

  /** Route param (`/docs/:slug`). */
  readonly slug = toSignal(this.route.paramMap.pipe(map((p) => p.get('slug') ?? undefined)), {
    initialValue: undefined,
  });
  private readonly fragment = toSignal(this.route.fragment, { initialValue: null });

  readonly guide = computed(() => guideBySlug(this.slug()));
  readonly group = computed(() => DOC_GROUPS.find((g) => g.audience === this.guide()?.audience));
  readonly around = computed(() => neighbours(this.slug() ?? ''));
  readonly html = signal<SafeHtml | string | null>(null);
  readonly headings = signal<DocHeading[]>([]);
  readonly tocHeadings = computed(() =>
    this.headings().filter((h) => h.level === 2 || h.level === 3),
  );
  readonly minutes = signal(0);
  readonly error = signal<string | null>(null);
  readonly active = signal<string>('');
  readonly progress = signal(0);
  readonly zoomed = signal<Zoomed | null>(null);

  constructor() {
    effect(() => {
      const g = this.guide();
      untracked(() => this.load(g?.slug ?? null));
    });
    // Arriving with #section (from search or a link): scroll there once the guide is on the page.
    effect(() => {
      const f = this.fragment();
      if (this.html() !== null && f) untracked(() => setTimeout(() => this.scrollTo(f, 'auto')));
    });
    inject(DestroyRef).onDestroy(() => this.zoomed.set(null));
  }

  private load(slug: string | null): void {
    this.html.set(null);
    this.headings.set([]);
    this.error.set(null);
    this.active.set('');
    if (!slug) return;
    this.content.guide(slug).subscribe({
      next: (md) => {
        const r = renderMarkdown(md);
        // The renderer escapes everything and emits only its own tags (checked again here), so its
        // output is trusted: Angular's sanitizer would strip the SVG icons and zoom buttons.
        this.html.set(
          isSafeDocHtml(r.html) ? this.sanitizer.bypassSecurityTrustHtml(r.html) : r.html,
        );
        this.headings.set(r.headings);
        this.minutes.set(readingMinutes(md));
        setTimeout(() => this.onScroll());
      },
      error: () =>
        this.error.set(
          'This guide could not be loaded. Check your connection and refresh the page; if it keeps happening, this console release may not include it.',
        ),
    });
  }

  /** Reading progress and the table-of-contents highlight follow the scroll position. */
  onScroll(): void {
    const doc = document.documentElement;
    const max = doc.scrollHeight - window.innerHeight;
    this.progress.set(max > 0 ? Math.min(100, (window.scrollY / max) * 100) : 0);
    let current = '';
    for (const h of this.tocHeadings()) {
      const el = document.getElementById(h.id);
      if (el && el.getBoundingClientRect().top < 140) current = h.id;
    }
    if (current !== this.active()) this.active.set(current);
  }

  private scrollTo(id: string, behavior: ScrollBehavior): void {
    document.getElementById(id)?.scrollIntoView({ behavior, block: 'start' });
  }

  jump(event: Event, id: string): void {
    event.preventDefault();
    this.scrollTo(id, 'smooth');
    history.replaceState(history.state, '', `${location.pathname}#${id}`);
  }

  top(event: Event): void {
    event.preventDefault();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /** Clicks inside a guide: screenshots open full size, site links navigate in the app, anchors scroll. */
  follow(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    const zoom = target?.closest('button.shot-zoom');
    if (zoom) {
      const img = [...zoom.querySelectorAll('img')].find((i) => i.offsetParent !== null);
      const caption = zoom.parentElement?.querySelector('figcaption')?.textContent ?? '';
      if (img) this.zoomed.set({ src: img.currentSrc || img.src, alt: img.alt, caption });
      return;
    }
    const a = target?.closest('a');
    const href = a?.getAttribute('href');
    if (!a || !href || a.target === '_blank' || event.ctrlKey || event.metaKey || event.shiftKey)
      return;
    if (href.startsWith('#')) {
      this.jump(event, href.slice(1));
    } else if (href.startsWith('/')) {
      event.preventDefault();
      void this.router.navigateByUrl(href);
    }
  }
}
