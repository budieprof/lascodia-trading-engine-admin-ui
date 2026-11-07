import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { forkJoin, of } from 'rxjs';
import { catchError, map } from 'rxjs/operators';

import { NewsIntelService } from '@core/services/news-intel.service';
import { createPolledResource } from '@core/polling/polled-resource';
import { FeatureStateComponent } from '@shared/components/feedback/feature-state.component';
import { errorText } from '@features/iam/iam.logic';
import { NewsIntelNavComponent } from '../components/news-intel-nav.component';
import {
  PressureContribution,
  configValue,
  fmt,
  signed,
  storyExposures,
  storySampleInstants,
  storyStateCounts,
  storyWeightIn,
} from '../news-intel.logic';
import {
  NEWS_STORY_STATES,
  NewsConfigEntry,
  NewsStoryMembersView,
  NewsStoryState,
  NewsStoryView,
} from '../news-intel.types';

interface WeightPoint {
  at: string;
  total: number;
  signed: number;
}

/**
 * Stories — clusters of articles about one event (understanding v2), their lifecycle state
 * (Developing / Confirmed / Denied / Resolved — the LIVE reading), event key and exposures.
 *
 * Opening a story reads its weight over time: the engine's point-in-time pressure for the story's
 * exposures at 8 instants across its life, summing the contributors that belong to it. Contributors
 * are the top weighted items per key, so a story too light to make that list reads as zero there.
 */
@Component({
  selector: 'app-news-stories-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, NewsIntelNavComponent, FeatureStateComponent],
  styleUrls: ['../news-intel-shared.scss'],
  template: `
    <div class="page">
      <header>
        <h1>News stories</h1>
        <p class="muted small">
          Articles about the same event, grouped. Story mode is
          <span class="pill" [class.ok]="storyMode() === 'Enforce'">{{ storyMode() }}</span>
          @if (storyMode() !== 'Enforce') {
            — stories are recorded but do not change any weight yet.
          } @else {
            — echoes are demoted and denied claims count for nothing.
          }
        </p>
      </header>
      <app-news-intel-nav
        [showRefresh]="true"
        [refreshing]="stories.refreshing()"
        (refresh)="stories.refresh()"
      />

      <section class="card">
        <div class="filters">
          <select class="sel" aria-label="Window" (change)="setHours($any($event.target).value)">
            <option value="24">last 24 h</option>
            <option value="48" selected>last 48 h</option>
            <option value="168">last 7 days</option>
          </select>
          <select class="sel" aria-label="State" (change)="setState($any($event.target).value)">
            <option value="">All states</option>
            @for (s of states; track s) {
              <option [value]="s">{{ s }} ({{ counts()[s] ?? 0 }})</option>
            }
          </select>
          <input
            class="inp mono"
            placeholder="Exposure: USD, WTI"
            aria-label="Exposure key"
            (change)="setExposure($any($event.target).value)"
          />
        </div>
      </section>

      @if (stories.error(); as e) {
        <div class="banner error">{{ err(e) }}</div>
      }
      @if (stories.loading()) {
        <p class="muted small">Loading…</p>
      }

      @if (stories.value(); as list) {
        @if (!list.length && !state() && !exposure()) {
          <app-feature-state
            kind="waiting"
            title="No stories yet"
            summary="Stories are built as articles are classified (only articles classified after the understanding-v2 deploy get one). History is not back-filled."
            switchKey="NewsIntel:Story:Mode"
            [detail]="'Story mode is ' + storyMode() + '. Off stops clustering entirely.'"
          />
        }
        <section class="card">
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Story</th>
                  <th>State</th>
                  <th>Event key</th>
                  <th>Exposures</th>
                  <th class="num">Articles</th>
                  <th class="num">Publishers</th>
                  <th>First / last seen (UTC)</th>
                </tr>
              </thead>
              <tbody>
                @for (s of list; track s.id) {
                  <tr class="clickable" (click)="toggle(s)">
                    <td>{{ s.title }}</td>
                    <td>
                      <span
                        class="pill"
                        [class.ok]="s.state === 'Confirmed'"
                        [class.bad]="s.state === 'Denied'"
                        [class.info]="s.state === 'Developing'"
                        [title]="'since ' + (s.stateChangedAtUtc | date: 'MMM d HH:mm' : 'UTC')"
                        >{{ s.state }}</span
                      >
                    </td>
                    <td class="mono xsmall">{{ s.eventKey ?? '—' }}</td>
                    <td>
                      <div class="legs">
                        @for (k of exposuresOf(s); track k) {
                          <span class="key">{{ k }}</span>
                        }
                      </div>
                    </td>
                    <td class="num">{{ s.articleCount }}</td>
                    <td class="num" [title]="(s.publishers ?? []).join(', ')">
                      {{ s.publisherCount }}
                      @if (s.publishers?.length) {
                        <div class="muted xsmall pubs">{{ publishersText(s.publishers!) }}</div>
                      }
                    </td>
                    <td class="xsmall">
                      {{ s.firstSeenUtc | date: 'MMM d HH:mm' : 'UTC' }} →
                      {{ s.lastSeenUtc | date: 'MMM d HH:mm' : 'UTC' }}
                    </td>
                  </tr>
                  @if (open()?.id === s.id) {
                    <tr class="row-detail">
                      <td colspan="7">
                        <div class="detail">
                          <p class="xsmall muted">
                            Story #{{ s.id }} · origin article #{{ s.firstArticleId }} · newest
                            member joined by {{ s.lastMatchBasis ?? 'unknown' }}
                            @if (s.deniedAtUtc) {
                              · denied {{ s.deniedAtUtc | date: 'MMM d HH:mm' : 'UTC' }}
                            }
                            @if (s.resolvedAtUtc) {
                              · resolved {{ s.resolvedAtUtc | date: 'MMM d HH:mm' : 'UTC' }}
                            }
                          </p>
                          <h3>Weight contribution over time</h3>
                          @if (series(); as pts) {
                            @if (maxWeight() > 0) {
                              <svg
                                class="spark"
                                viewBox="0 0 400 80"
                                preserveAspectRatio="none"
                                role="img"
                                aria-label="Story weight over time"
                              >
                                @for (p of pts; track p.at; let i = $index) {
                                  <rect
                                    [attr.x]="(i * 400) / pts.length + 2"
                                    [attr.y]="80 - (p.total / maxWeight()) * 76"
                                    [attr.width]="400 / pts.length - 4"
                                    [attr.height]="(p.total / maxWeight()) * 76"
                                    [class.neg-bar]="p.signed < 0"
                                  >
                                    <title>
                                      {{ p.at | date: 'MMM d HH:mm' : 'UTC' }}Z — weight
                                      {{ f(p.total) }}, signed {{ sg(p.signed) }}
                                    </title>
                                  </rect>
                                }
                              </svg>
                              <p class="muted xsmall">
                                {{ pts.length }} point-in-time reads from first seen to
                                {{ pts[pts.length - 1].at | date: 'MMM d HH:mm' : 'UTC' }}Z. Bar =
                                summed |weight| on its exposures; red = net bearish signed weight.
                              </p>
                            } @else {
                              <p class="empty">
                                The story never made the weighted contributors of its exposures —
                                either untracked keys or too light to count.
                              </p>
                            }
                          } @else {
                            <p class="muted xsmall">Reading history…</p>
                          }
                          @if (members().length) {
                            <h3>Weighted members at the latest read</h3>
                            @for (m of members(); track m.articleId + m.currency) {
                              <div class="xsmall">
                                <span class="key">{{ m.currency }}</span>
                                {{ m.title }}
                                <span class="muted"
                                  >· {{ m.sourceName ?? '?' }} · weight {{ f(m.weight) }}</span
                                >
                              </div>
                            }
                          }
                          <h3>Member articles</h3>
                          @if (storyMembers(); as sm) {
                            <p class="xsmall">
                              Publishers ({{ sm.story.publishers?.length ?? 0 }}):
                              {{ (sm.story.publishers ?? []).join(', ') || '—' }}
                            </p>
                            <div class="table-wrap" data-testid="story-members">
                              <table>
                                <thead>
                                  <tr>
                                    <th>First seen (UTC)</th>
                                    <th>Publisher</th>
                                    <th>Headline</th>
                                    <th>Labels (key · direction · novelty)</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  @for (m of sm.articles; track m.id) {
                                    <tr>
                                      <td class="xsmall">
                                        {{ m.firstSeenUtc | date: 'MMM d HH:mm' : 'UTC' }}
                                        @if (m.isOrigin) {
                                          <span class="pill info">origin</span>
                                        }
                                      </td>
                                      <td class="xsmall">{{ m.sourceName }}</td>
                                      <td class="small">
                                        @if (m.url) {
                                          <a [href]="m.url" target="_blank" rel="noopener">{{
                                            m.title
                                          }}</a>
                                        } @else {
                                          {{ m.title }}
                                        }
                                        @if (m.stance !== 'Asserts') {
                                          <span class="pill">{{ m.stance }}</span>
                                        }
                                      </td>
                                      <td class="xsmall">
                                        @for (l of m.labels; track l.exposureKey) {
                                          <div>
                                            <span class="key">{{ l.exposureKey }}</span>
                                            {{ l.direction }} · {{ l.novelty }} · {{ l.certainty }}
                                          </div>
                                        } @empty {
                                          <span class="muted">{{ m.classificationStatus }}</span>
                                        }
                                      </td>
                                    </tr>
                                  } @empty {
                                    <tr>
                                      <td colspan="4" class="empty">No member article found.</td>
                                    </tr>
                                  }
                                </tbody>
                              </table>
                            </div>
                          } @else if (storyMembersMissing()) {
                            <p class="muted xsmall">
                              This engine build does not list a story's members — only those still
                              weighted are shown above.
                            </p>
                          } @else {
                            <p class="muted xsmall">Loading members…</p>
                          }
                        </div>
                      </td>
                    </tr>
                  }
                } @empty {
                  <tr>
                    <td colspan="7" class="empty">No story matches the filters.</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </section>
      }
    </div>
  `,
  styles: [
    `
      .detail {
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
        padding: var(--space-2) 0;
      }
      .spark {
        width: 100%;
        max-width: 560px;
        height: 80px;
      }
      .spark rect {
        fill: var(--accent);
      }
      .spark rect.neg-bar {
        fill: var(--loss);
      }
    `,
  ],
})
export class NewsStoriesPageComponent {
  private readonly svc = inject(NewsIntelService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly states = NEWS_STORY_STATES;

  readonly hours = signal(48);
  readonly state = signal<NewsStoryState | null>(null);
  readonly exposure = signal('');
  readonly open = signal<NewsStoryView | null>(null);
  readonly series = signal<WeightPoint[] | null>(null);
  readonly members = signal<PressureContribution[]>([]);
  readonly config = signal<NewsConfigEntry[]>([]);
  readonly storyMembers = signal<NewsStoryMembersView | null>(null);
  readonly storyMembersMissing = signal(false);

  readonly stories = createPolledResource(
    () =>
      this.svc.getStories({
        hours: this.hours(),
        state: this.state(),
        exposure: this.exposure() || undefined,
        take: 300,
      }),
    { intervalMs: 120_000 },
  );

  readonly counts = computed(() => storyStateCounts(this.stories.value() ?? []));
  readonly storyMode = computed(
    () => configValue(this.config(), 'NewsIntel:Story:Mode') ?? 'Observe',
  );
  readonly maxWeight = computed(() => Math.max(0, ...(this.series() ?? []).map((p) => p.total)));

  constructor() {
    this.svc
      .getConfig()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (e) => this.config.set(e), error: () => this.config.set([]) });
  }

  setHours(v: string): void {
    this.hours.set(Number(v));
    this.stories.refresh();
  }

  setState(v: string): void {
    this.state.set(v ? (v as NewsStoryState) : null);
    this.stories.refresh();
  }

  setExposure(v: string): void {
    this.exposure.set(v.trim().toUpperCase());
    this.stories.refresh();
  }

  exposuresOf(s: NewsStoryView): string[] {
    return storyExposures(s);
  }

  toggle(s: NewsStoryView): void {
    if (this.open()?.id === s.id) {
      this.open.set(null);
      return;
    }
    this.open.set(s);
    this.series.set(null);
    this.members.set([]);
    this.storyMembers.set(null);
    this.storyMembersMissing.set(false);
    this.svc
      .getStoryArticles(s.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (m) => {
          if (this.open()?.id === s.id) this.storyMembers.set(m);
        },
        error: () => {
          if (this.open()?.id === s.id) this.storyMembersMissing.set(true);
        },
      });
    const keys = storyExposures(s);
    const instants = storySampleInstants(s, new Date());
    if (!keys.length || !instants.length) {
      this.series.set([]);
      return;
    }
    forkJoin(
      instants.map((at) =>
        this.svc.getPressureReadings({ keys, asOfUtc: at, topItems: 50 }).pipe(
          map((r) => ({ at, ...storyWeightIn(r, s.id) })),
          catchError(() => of({ at, total: 0, signed: 0, members: [] as PressureContribution[] })),
        ),
      ),
    )
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((pts) => {
        if (this.open()?.id !== s.id) return;
        this.series.set(pts.map(({ at, total, signed }) => ({ at, total, signed })));
        this.members.set(pts[pts.length - 1]?.members ?? []);
      });
  }

  publishersText(p: readonly string[]): string {
    return p.length <= 3 ? p.join(', ') : `${p.slice(0, 3).join(', ')} +${p.length - 3}`;
  }

  f(v: number): string {
    return fmt(v);
  }

  sg(v: number): string {
    return signed(v);
  }

  err(e: unknown): string {
    return errorText(e, 'Could not load stories.');
  }
}
