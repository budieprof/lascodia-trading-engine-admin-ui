import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { LucideDynamicIcon } from '@lucide/angular';

import { DocsContentService } from '../docs-content.service';
import { DOC_GROUPS, DOC_GUIDES, guideBySlug, type DocGuide } from '../docs-catalog';
import { DOC_ICONS } from '../docs-icons';
import { searchDocs, sectionsOf, type DocSection } from '../docs-search';
import { readingMinutes } from '../markdown';

/** The "new here?" path, in reading order. */
const START_PATH = ['getting-started', 'ea-install', 'user-guide', 'trading-guide'] as const;

/**
 * `/docs` — the help portal's front page: search across every guide, the four-guide path for new people,
 * and every guide grouped by who it is for.
 */
@Component({
  selector: 'app-docs-home',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, LucideDynamicIcon],
  styleUrl: './docs-home.scss',
  template: `
    <div class="page docs docs-home">
      <section class="hero">
        <div class="hero-text">
          <span class="eyebrow">
            <svg
              [lucideIcon]="icons['life-buoy']"
              [size]="14"
              [strokeWidth]="2"
              aria-hidden="true"
            ></svg>
            Help &amp; guides
          </span>
          <h1>How can we help?</h1>
          <p>
            Step-by-step guides in plain words, with pictures of every screen. Pick a guide below or
            search for what you want to do.
          </p>
          <label class="search">
            <svg [lucideIcon]="icons.search" [size]="18" [strokeWidth]="2" aria-hidden="true"></svg>
            <input
              type="search"
              placeholder="Search, e.g. “connect MetaTrader”, “stop loss” or “API key”"
              aria-label="Search the guides"
              [value]="query()"
              (input)="query.set($any($event.target).value)"
            />
          </label>
          <div class="popular">
            <span>Popular:</span>
            @for (p of popular; track p) {
              <button type="button" (click)="query.set(p)">{{ p }}</button>
            }
          </div>
        </div>
        <div class="hero-art" aria-hidden="true">
          <svg viewBox="0 0 240 180" width="240" height="180">
            <rect x="10" y="20" width="220" height="140" rx="14" class="art-panel" />
            <rect x="10" y="20" width="220" height="24" rx="12" class="art-bar" />
            <circle cx="28" cy="32" r="4" class="art-dot" />
            <circle cx="42" cy="32" r="4" class="art-dot" />
            <circle cx="56" cy="32" r="4" class="art-dot" />
            <polyline points="30,130 60,110 85,118 115,84 140,96 170,62 205,72" class="art-line" />
            @for (c of artCandles; track c.x) {
              <line
                [attr.x1]="c.x"
                [attr.x2]="c.x"
                [attr.y1]="c.hi"
                [attr.y2]="c.lo"
                [attr.class]="c.up ? 'art-wick up' : 'art-wick down'"
              />
              <rect
                [attr.x]="c.x - 5"
                [attr.y]="c.top"
                width="10"
                [attr.height]="c.h"
                rx="2"
                [attr.class]="c.up ? 'art-body up' : 'art-body down'"
              />
            }
            <circle cx="205" cy="72" r="6" class="art-ping" />
          </svg>
        </div>
      </section>

      @if (query().trim()) {
        <section class="results" aria-live="polite">
          <h2>
            @if (hits().length) {
              {{ hits().length }} {{ hits().length === 1 ? 'place' : 'places' }} mention “{{
                query().trim()
              }}”
            } @else if (indexed()) {
              Nothing found for “{{ query().trim() }}”
            } @else {
              Searching…
            }
          </h2>
          @if (!hits().length && indexed()) {
            <p class="muted">
              Try fewer or simpler words, or look it up in
              <a routerLink="/docs/glossary">Words explained</a>.
            </p>
          }
          @for (h of hits(); track h.guide.slug + h.id) {
            <a class="hit" [routerLink]="['/docs', h.guide.slug]" [fragment]="h.id || undefined">
              <span class="hit-icon">
                <svg
                  [lucideIcon]="icons[h.guide.icon]"
                  [size]="18"
                  [strokeWidth]="1.75"
                  aria-hidden="true"
                ></svg>
              </span>
              <span class="hit-text">
                <span class="hit-where"
                  >{{ h.guide.title }}
                  @if (h.id) {
                    › {{ h.heading }}
                  }
                </span>
                <span class="hit-snippet">{{ h.snippet }}</span>
              </span>
            </a>
          }
        </section>
      } @else {
        <section class="path">
          <div class="section-head">
            <h2>New here? Read these four, in order</h2>
            <p>About {{ pathMinutes() }} minutes in all, and you will be ready to trade.</p>
          </div>
          <ol class="path-steps">
            @for (g of path; track g.slug; let i = $index) {
              <li>
                <a [routerLink]="['/docs', g.slug]">
                  <span class="path-num">{{ i + 1 }}</span>
                  <span class="path-icon">
                    <svg
                      [lucideIcon]="icons[g.icon]"
                      [size]="22"
                      [strokeWidth]="1.75"
                      aria-hidden="true"
                    ></svg>
                  </span>
                  <strong>{{ g.title }}</strong>
                  <span>{{ g.summary }}</span>
                </a>
              </li>
            }
          </ol>
        </section>

        @for (grp of groups; track grp.audience) {
          <section class="group" [attr.data-audience]="grp.audience">
            <div class="section-head">
              <span class="group-icon">
                <svg
                  [lucideIcon]="icons[grp.icon]"
                  [size]="20"
                  [strokeWidth]="1.75"
                  aria-hidden="true"
                ></svg>
              </span>
              <div>
                <h2>{{ grp.title }}</h2>
                <p>{{ grp.blurb }}</p>
              </div>
            </div>
            <div class="guide-grid">
              @for (g of guidesFor(grp.audience); track g.slug) {
                <a class="guide-card" [routerLink]="['/docs', g.slug]">
                  <span class="guide-icon">
                    <svg
                      [lucideIcon]="icons[g.icon]"
                      [size]="22"
                      [strokeWidth]="1.75"
                      aria-hidden="true"
                    ></svg>
                  </span>
                  <h3>{{ g.title }}</h3>
                  <p>{{ g.summary }}</p>
                  <span class="guide-meta">
                    @if (stats().get(g.slug); as s) {
                      <span>{{ s.minutes }} min read</span>
                      @if (s.pictures) {
                        <span
                          >{{ s.pictures }} {{ s.pictures === 1 ? 'picture' : 'pictures' }}</span
                        >
                      }
                      @if (s.diagrams) {
                        <span
                          >{{ s.diagrams }} {{ s.diagrams === 1 ? 'diagram' : 'diagrams' }}</span
                        >
                      }
                    }
                  </span>
                </a>
              }
              @if (grp.audience === 'Developers') {
                <a class="guide-card" routerLink="/docs/api">
                  <span class="guide-icon">
                    <svg
                      [lucideIcon]="icons['square-terminal']"
                      [size]="22"
                      [strokeWidth]="1.75"
                      aria-hidden="true"
                    ></svg>
                  </span>
                  <h3>API reference</h3>
                  <p>Every engine endpoint with who may call it, its inputs and what it returns.</p>
                  <span class="guide-meta"><span>Searchable list</span></span>
                </a>
              }
            </div>
          </section>
        }

        <section class="still-stuck">
          <svg
            [lucideIcon]="icons['message-circle']"
            [size]="22"
            [strokeWidth]="1.75"
            aria-hidden="true"
          ></svg>
          <div>
            <strong>Still stuck?</strong>
            <p>
              Ask the assistant (the round button at the bottom right of every page): it can see the
              page you are on. Or look a word up in
              <a routerLink="/docs/glossary">Words explained</a>.
            </p>
          </div>
        </section>
      }
    </div>
  `,
})
export class DocsHomeComponent {
  private readonly content = inject(DocsContentService);

  protected readonly icons = DOC_ICONS;
  protected readonly groups = DOC_GROUPS;
  protected readonly path = START_PATH.map((s) => guideBySlug(s)).filter((g): g is DocGuide => !!g);
  protected readonly popular = [
    'connect MetaTrader',
    'stop loss',
    'paper trading',
    'API key',
    'alerts',
  ];
  protected readonly artCandles = [
    { x: 40, top: 112, h: 18, hi: 104, lo: 136, up: true },
    { x: 62, top: 100, h: 16, hi: 92, lo: 122, up: false },
    { x: 84, top: 96, h: 22, hi: 88, lo: 124, up: true },
    { x: 106, top: 80, h: 20, hi: 70, lo: 106, up: true },
    { x: 128, top: 84, h: 14, hi: 76, lo: 104, up: false },
    { x: 150, top: 66, h: 22, hi: 58, lo: 94, up: true },
    { x: 172, top: 60, h: 16, hi: 52, lo: 82, up: true },
  ];

  readonly query = signal('');

  private readonly all = toSignal(this.content.allGuides(), { initialValue: null });
  readonly indexed = computed(() => this.all() !== null);

  private readonly sections = computed<DocSection[]>(() => {
    const all = this.all();
    if (!all) return [];
    return DOC_GUIDES.flatMap((g) => (all.has(g.slug) ? sectionsOf(g, all.get(g.slug)!) : []));
  });

  readonly hits = computed(() => searchDocs(this.sections(), this.query()));

  readonly stats = computed(() => {
    const out = new Map<string, { minutes: number; pictures: number; diagrams: number }>();
    for (const [slug, md] of this.all() ?? []) {
      out.set(slug, {
        minutes: readingMinutes(md),
        pictures: (md.match(/^\s*!\[/gm) ?? []).length,
        diagrams: (md.match(/^\s*```(flow|stack|decide|cards)\s*$/gm) ?? []).length,
      });
    }
    return out;
  });

  readonly pathMinutes = computed(() => {
    const s = this.stats();
    const total = START_PATH.reduce((n, slug) => n + (s.get(slug)?.minutes ?? 0), 0);
    return total || 30;
  });

  guidesFor(audience: string): DocGuide[] {
    return DOC_GUIDES.filter((g) => g.audience === audience);
  }
}
