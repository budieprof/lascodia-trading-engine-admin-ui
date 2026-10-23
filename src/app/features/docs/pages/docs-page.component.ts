import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
  effect,
  untracked,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { map } from 'rxjs';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { DocsContentService } from '../docs-content.service';
import { DOC_GUIDES, guideBySlug } from '../docs-catalog';
import { renderMarkdown, type DocHeading } from '../markdown';

/**
 * The documentation portal (engine enterprise onboarding): `/docs` lists the guides, `/docs/<slug>`
 * renders one (Markdown shipped with the console release, rendered by the safe renderer — no raw HTML),
 * `/docs/api` is the API reference generated from the engine's OpenAPI document.
 */
@Component({
  selector: 'app-docs-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, PageHeaderComponent],
  styleUrl: './docs.scss',
  template: `
    <div class="page docs">
      @if (guide(); as g) {
        <app-page-header [title]="g.title" [subtitle]="g.summary">
          <a class="btn btn-secondary" routerLink="/docs">All guides</a>
        </app-page-header>
        <div class="docs-layout">
          @if (headings().length > 2) {
            <nav class="toc" aria-label="On this page">
              @for (h of headings(); track h.id) {
                @if (h.level <= 3) {
                  <a [class.sub]="h.level === 3" [href]="'#' + h.id" (click)="jump($event, h.id)">{{
                    h.text
                  }}</a>
                }
              }
            </nav>
          }
          <article class="doc card">
            @if (error(); as e) {
              <p role="alert"><span class="chip bad">Could not load</span> {{ e }}</p>
            } @else if (html() === null) {
              <p class="muted">Loading…</p>
            } @else {
              <div class="md" [innerHTML]="html()" (click)="follow($event)"></div>
            }
          </article>
        </div>
      } @else if (slug()) {
        <app-page-header title="Not found" subtitle="There is no guide by that name.">
          <a class="btn btn-secondary" routerLink="/docs">All guides</a>
        </app-page-header>
      } @else {
        <app-page-header
          title="Documentation"
          subtitle="Guides for everyone who uses the console, the people who run an organisation, platform staff and developers."
        />
        <div class="cards">
          @for (g of guides; track g.slug) {
            <a class="card guide" [routerLink]="['/docs', g.slug]">
              <span class="chip info">{{ g.audience }}</span>
              <h3>{{ g.title }}</h3>
              <p>{{ g.summary }}</p>
            </a>
          }
          <a class="card guide" routerLink="/docs/api">
            <span class="chip info">Developers</span>
            <h3>API reference</h3>
            <p>
              Every engine endpoint with its permission, parameters and types — generated from the
              engine's OpenAPI document.
            </p>
          </a>
        </div>
      }
    </div>
  `,
})
export class DocsPageComponent {
  private readonly content = inject(DocsContentService);
  private readonly router = inject(Router);

  /** Route param (`/docs/:slug`); none on the index. */
  readonly slug = toSignal(
    inject(ActivatedRoute).paramMap.pipe(map((p) => p.get('slug') ?? undefined)),
    {
      initialValue: undefined,
    },
  );

  protected readonly guides = DOC_GUIDES;
  readonly guide = computed(() => guideBySlug(this.slug()));
  readonly html = signal<string | null>(null);
  readonly headings = signal<DocHeading[]>([]);
  readonly error = signal<string | null>(null);

  constructor() {
    effect(() => {
      const g = this.guide();
      untracked(() => this.load(g?.slug ?? null));
    });
  }

  private load(slug: string | null): void {
    this.html.set(null);
    this.headings.set([]);
    this.error.set(null);
    if (!slug) return;
    this.content.guide(slug).subscribe({
      next: (md) => {
        const r = renderMarkdown(md);
        this.html.set(r.html);
        this.headings.set(r.headings);
      },
      error: () => this.error.set('This guide is not part of this console release.'),
    });
  }

  jump(event: Event, id: string): void {
    event.preventDefault();
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /** Site links inside a guide navigate in the app (no full reload); anchors scroll. */
  follow(event: MouseEvent): void {
    const a = (event.target as HTMLElement | null)?.closest('a');
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
