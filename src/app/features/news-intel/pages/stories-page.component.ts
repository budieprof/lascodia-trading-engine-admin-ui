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
  NiInfoComponent,
  NiKeyComponent,
  NiMeterComponent,
  NiPanelComponent,
  NiStatComponent,
} from '../components/viz/ni-primitives';
import { HBarItem, NiHBarsComponent } from '../components/viz/ni-tabs-b';
import { ago, kindVar, shortKey } from '../components/viz/ni-viz';
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
  imports: [
    DatePipe,
    NewsIntelNavComponent,
    FeatureStateComponent,
    NiPanelComponent,
    NiInfoComponent,
    NiStatComponent,
    NiKeyComponent,
    NiMeterComponent,
    NiHBarsComponent,
  ],
  styleUrls: ['../news-intel-shared.scss'],
  template: `
    <div class="page">
      <header class="page-head">
        <div class="title">
          <h1>News stories</h1>
          <app-ni-info
            text="Articles about the same event, grouped — by the classifier's event key, else by lexical similarity within a window. Corroboration counts independent PUBLISHERS, not copies. State is the live reading: Developing → Confirmed (3+ publishers or an official source) → Denied (a denial cancels the rumour from then on, point-in-time) → Resolved."
          />
          <span class="pill" [class.ok]="storyMode() === 'Enforce'" [class.info]="storyMode() === 'Observe'"
            >mode {{ storyMode() }}</span
          >
          <span class="faint xsmall">
            @if (storyMode() !== 'Enforce') {
              recorded only — no weight changes yet
            } @else {
              echoes demoted · denied claims count for nothing
            }
          </span>
        </div>
      </header>
      <app-news-intel-nav
        [showRefresh]="true"
        [refreshing]="stories.refreshing()"
        (refresh)="stories.refresh()"
      />

      @if (stories.error(); as e) {
        <div class="banner error">{{ err(e) }}</div>
      }

      <div class="ni-kpis">
        <app-ni-stat label="Stories" [value]="kpi().total" [sub]="'last ' + windowLabel()" />
        <app-ni-stat label="Developing" [value]="kpi().developing" sub="unconfirmed" />
        <app-ni-stat label="Confirmed" [value]="kpi().confirmed" [sub]="kpi().confirmedShare" tone="ok" />
        <app-ni-stat label="Denied" [value]="kpi().denied" sub="rumours cancelled" [tone]="kpi().deniedN ? 'warn' : null" />
        <app-ni-stat label="Resolved" [value]="kpi().resolved" sub="decaying" />
        <app-ni-stat
          label="Multi-source"
          [value]="kpi().corroborated"
          sub="3+ publishers"
          info="Stories carried by at least three independent publishers — the confirmation threshold (Story:ConfirmMinPublishers)."
        />
        <app-ni-stat label="Publishers" [value]="kpi().medianPubs" sub="median per story" [spark]="kpi().pubHist" [sparkLabels]="pubHistLabels" />
        <app-ni-stat label="Articles" [value]="kpi().articles" [sub]="kpi().perStory" />
      </div>

      <div class="ni-grid-3">
        <app-ni-panel title="Lifecycle" info="Share of stories in each state. Click a state to filter the table; click it again to clear.">
          <div class="state-bar" role="img" [attr.aria-label]="stateAria()">
            @for (s of stateMix(); track s.state) {
              <span [style.flex-grow]="s.count" [class]="'sb ' + s.state" [title]="s.state + ': ' + s.count"></span>
            }
          </div>
          <div class="states">
            @for (s of stateMix(); track s.state) {
              <button type="button" class="st-row" [class.on]="state() === s.state" (click)="setState(state() === s.state ? '' : s.state)">
                <i [class]="s.state"></i>
                <span>{{ s.state }}</span>
                <b>{{ s.count }}</b>
                <span class="faint">{{ s.pct }}%</span>
              </button>
            }
          </div>
        </app-ni-panel>
        <app-ni-panel title="Most-covered exposures" info="Exposure keys by number of stories touching them. Click a key to filter the table (server-side).">
          @if (exposure()) {
            <button actions type="button" class="btn subtle" (click)="setExposure('')">{{ exposure() }} ✕</button>
          }
          <app-ni-hbars [items]="exposureBars()" [limit]="8" [clickable]="true" (pick)="setExposure($event)" emptyText="No stories." style="--lab-w: 86px" />
        </app-ni-panel>
        <app-ni-panel title="How stories grow" info="How the newest member of each story joined it: by the classifier's event key, by lexical title similarity, or the story is a single origin article.">
          <app-ni-hbars [items]="basisBars()" [limit]="6" emptyText="No stories." style="--lab-w: 96px" />
        </app-ni-panel>
      </div>

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
        <app-ni-panel title="Stories" [flush]="true" info="Most-corroborated first. Click a row for its member articles, publishers and weight over time.">
          <span meta>{{ visible().length }} of {{ list.length }}</span>
          <div actions class="filters">
            <span class="seg" role="group" aria-label="Window">
              @for (h of [24, 48, 168]; track h) {
                <button type="button" [class.on]="hours() === h" (click)="setHours(h + '')">{{ h === 168 ? '7d' : h + 'h' }}</button>
              }
            </span>
            <select class="sel" aria-label="State" (change)="setState($any($event.target).value)">
              <option value="" [selected]="!state()">All states</option>
              @for (s of states; track s) {
                <option [value]="s" [selected]="state() === s">{{ s }} ({{ counts()[s] ?? 0 }})</option>
              }
            </select>
            <input class="inp mono xp" placeholder="Exposure: USD" aria-label="Exposure key" [value]="exposure()" (change)="setExposure($any($event.target).value)" />
            <input class="inp q" type="search" placeholder="Search titles…" aria-label="Search stories" [value]="q()" (input)="q.set($any($event.target).value)" />
          </div>
          <div class="table-wrap st-wrap">
            <table>
              <thead>
                <tr>
                  <th>State</th>
                  <th>Story</th>
                  <th>Exposures</th>
                  <th>Publishers</th>
                  <th class="num">Arts</th>
                  <th>Joined by</th>
                  <th class="num">First</th>
                  <th class="num">Last</th>
                </tr>
              </thead>
              <tbody>
                @for (s of visible(); track s.id) {
                  <tr class="clickable" [class.sel]="open()?.id === s.id" (click)="toggle(s)">
                    <td>
                      <span
                        class="pill"
                        [class.ok]="s.state === 'Confirmed'"
                        [class.bad]="s.state === 'Denied'"
                        [class.info]="s.state === 'Developing'"
                        [title]="'since ' + (s.stateChangedAtUtc | date: 'MMM d HH:mm' : 'UTC') + 'Z'"
                        >{{ s.state }}</span
                      >
                    </td>
                    <td class="title-cell">
                      <span class="t" [title]="s.title">{{ s.title }}</span>
                      @if (s.eventKey) {
                        <span class="ek" [title]="s.eventKey">{{ s.eventKey }}</span>
                      }
                    </td>
                    <td>
                      <div class="legs one-line">
                        @for (k of exposuresOf(s).slice(0, 2); track k) {
                          <app-ni-key [key]="k" [short]="true" />
                        }
                        @if (exposuresOf(s).length > 2) {
                          <span class="faint xsmall plus" [title]="exposuresOf(s).join(', ')">+{{ exposuresOf(s).length - 2 }}</span>
                        }
                      </div>
                    </td>
                    <td class="pubs-cell" [title]="(s.publishers ?? []).join(', ')">
                      <app-ni-meter [value]="s.publisherCount / maxPubs()" [label]="s.publisherCount + ''" [tone]="s.publisherCount >= 3 ? 'ok' : null" />
                    </td>
                    <td class="num">{{ s.articleCount }}</td>
                    <td class="faint xsmall">{{ s.lastMatchBasis ?? '—' }}</td>
                    <td class="num faint">{{ s.firstSeenUtc | date: 'MMM d HH:mm' : 'UTC' }}</td>
                    <td class="num">{{ agoText(s.lastSeenUtc) }}</td>
                  </tr>
                  @if (open()?.id === s.id) {
                    <tr class="row-detail">
                      <td colspan="8">
                        <div class="detail">
                          <div class="d-left">
                            <p class="meta-line">
                              <span>Story #{{ s.id }}</span>
                              <span>origin article #{{ s.firstArticleId }}</span>
                              <span>newest joined by {{ s.lastMatchBasis ?? 'unknown' }}</span>
                              @if (s.deniedAtUtc) {
                                <span class="neg">denied {{ s.deniedAtUtc | date: 'MMM d HH:mm' : 'UTC' }}Z</span>
                              }
                              @if (s.resolvedAtUtc) {
                                <span>resolved {{ s.resolvedAtUtc | date: 'MMM d HH:mm' : 'UTC' }}Z</span>
                              }
                            </p>
                            <div class="d-head">
                              <h3>Weight over time</h3>
                              <app-ni-info text="Point-in-time pressure on the story's exposures at 8 instants across its life, summing the weighted contributors that belong to it. Bar = summed |weight|; red = net bearish signed weight. Contributors are the top weighted items per key, so a story too light to make that list reads as zero." />
                            </div>
                            @if (series(); as pts) {
                              @if (maxWeight() > 0) {
                                <svg class="spark" viewBox="0 0 400 80" preserveAspectRatio="none" role="img" aria-label="Story weight over time">
                                  @for (p of pts; track p.at; let i = $index) {
                                    <rect
                                      [attr.x]="(i * 400) / pts.length + 2"
                                      [attr.y]="80 - (p.total / maxWeight()) * 76"
                                      [attr.width]="400 / pts.length - 4"
                                      [attr.height]="(p.total / maxWeight()) * 76"
                                      rx="2"
                                      [class.neg-bar]="p.signed < 0"
                                    >
                                      <title>{{ p.at | date: 'MMM d HH:mm' : 'UTC' }}Z — weight {{ f(p.total) }}, signed {{ sg(p.signed) }}</title>
                                    </rect>
                                  }
                                </svg>
                                <div class="spark-axis">
                                  <span>{{ pts[0].at | date: 'MMM d HH:mm' : 'UTC' }}</span>
                                  <span>peak {{ f(maxWeight()) }}</span>
                                  <span>{{ pts[pts.length - 1].at | date: 'MMM d HH:mm' : 'UTC' }}</span>
                                </div>
                              } @else {
                                <p class="empty">Never made the weighted contributors of its exposures — untracked keys or too light to count.</p>
                              }
                            } @else {
                              <p class="empty">Reading history…</p>
                            }
                            @if (members().length) {
                              <h3>Weighted at the latest read</h3>
                              <ul class="wm">
                                @for (m of members(); track m.articleId + m.currency) {
                                  <li>
                                    <app-ni-key [key]="m.currency" [short]="true" />
                                    <span class="t" [title]="m.title">{{ m.title }}</span>
                                    <span class="faint">{{ m.sourceName ?? '?' }}</span>
                                    <b class="num">{{ f(m.weight) }}</b>
                                  </li>
                                }
                              </ul>
                            }
                          </div>
                          <div class="d-right">
                            <div class="d-head">
                              <h3>Member articles</h3>
                              @if (storyMembers(); as sm) {
                                <span class="faint xsmall" [title]="(sm.story.publishers ?? []).join(', ')"
                                  >{{ sm.articles.length }} articles · {{ sm.story.publishers?.length ?? 0 }} publishers</span
                                >
                              }
                            </div>
                            @if (storyMembers(); as sm) {
                              @if (sm.story.publishers?.length) {
                                <div class="legs">
                                  @for (p of sm.story.publishers!; track p) {
                                    <span class="key">{{ p }}</span>
                                  }
                                </div>
                              }
                              <div class="table-wrap members" data-testid="story-members">
                                <table>
                                  <thead>
                                    <tr>
                                      <th class="num">Seen</th>
                                      <th>Publisher</th>
                                      <th>Headline</th>
                                      <th>Labels</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    @for (m of sm.articles; track m.id) {
                                      <tr>
                                        <td class="num faint">
                                          {{ m.firstSeenUtc | date: 'MMM d HH:mm' : 'UTC' }}
                                        </td>
                                        <td class="xsmall nowrap">
                                          {{ m.sourceName }}
                                          @if (m.isOrigin) {
                                            <span class="pill info plain">origin</span>
                                          }
                                        </td>
                                        <td class="hl">
                                          @if (m.url) {
                                            <a [href]="m.url" target="_blank" rel="noopener" [title]="m.title">{{ m.title }}</a>
                                          } @else {
                                            <span [title]="m.title">{{ m.title }}</span>
                                          }
                                          @if (m.stance !== 'Asserts') {
                                            <span class="pill warn plain">{{ m.stance }}</span>
                                          }
                                        </td>
                                        <td>
                                          @for (l of m.labels; track l.exposureKey) {
                                            <span
                                              class="lab"
                                              [class.bull]="l.direction === 'Bullish'"
                                              [class.bear]="l.direction === 'Bearish'"
                                              [title]="l.exposureKey + ' · ' + l.category + ' · ' + l.direction + ' · ' + l.novelty + ' · ' + l.certainty"
                                              ><i [style.background]="kc(l.exposureKey)"></i>{{ short(l.exposureKey) }}<b>{{ l.direction === 'Bullish' ? '▲' : l.direction === 'Bearish' ? '▼' : '●' }}</b
                                              ><em>{{ l.novelty }}</em></span
                                            >
                                          } @empty {
                                            <span class="faint xsmall">{{ m.classificationStatus }}</span>
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
                              <p class="empty">This engine build does not list a story's members — only those still weighted are shown.</p>
                            } @else {
                              <p class="empty">Loading members…</p>
                            }
                          </div>
                        </div>
                      </td>
                    </tr>
                  }
                } @empty {
                  <tr>
                    <td colspan="8" class="empty pad">No story matches the filters.</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </app-ni-panel>
      } @else if (stories.loading()) {
        <p class="empty">Loading…</p>
      }
    </div>
  `,
  styles: [
    `
      .state-bar {
        display: flex;
        gap: 2px;
        height: 10px;
        border-radius: 5px;
        overflow: hidden;
      }
      .state-bar .sb {
        flex-basis: 0;
        min-width: 3px;
      }
      .Developing {
        background: var(--ni-k-currency);
      }
      .Confirmed {
        background: var(--ni-ok);
      }
      .Denied {
        background: var(--ni-bad);
      }
      .Resolved {
        background: var(--text-tertiary);
      }
      .states {
        display: flex;
        flex-direction: column;
        gap: 1px;
      }
      .st-row {
        display: grid;
        grid-template-columns: 8px minmax(0, 1fr) 40px 40px;
        align-items: center;
        gap: 8px;
        border: 0;
        background: transparent;
        color: inherit;
        font: inherit;
        font-size: 12px;
        padding: 3px 4px;
        border-radius: 5px;
        cursor: pointer;
        text-align: left;
      }
      .st-row:hover,
      .st-row.on {
        background: var(--ni-sunken);
      }
      .st-row i {
        width: 8px;
        height: 8px;
        border-radius: 2px;
      }
      .st-row b,
      .st-row .faint {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .xp {
        width: 110px;
      }
      .q {
        width: 160px;
      }
      .st-wrap {
        max-height: 720px;
      }
      .st-wrap > table > thead th:first-child,
      .st-wrap > table > tbody > tr > td:first-child {
        padding-left: 12px;
      }
      .st-wrap > table > thead th:last-child,
      .st-wrap > table > tbody > tr > td:last-child {
        padding-right: 12px;
      }
      .title-cell {
        max-width: 420px;
        min-width: 240px;
      }
      .title-cell .t {
        display: block;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        font-weight: 500;
      }
      .ek {
        display: block;
        font-family: var(--ni-mono);
        font-size: 10px;
        color: var(--text-tertiary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .one-line {
        flex-wrap: nowrap;
        align-items: center;
      }
      .plus {
        align-self: center;
      }
      .pubs-cell {
        min-width: 96px;
      }
      .detail {
        display: grid;
        grid-template-columns: minmax(0, 0.85fr) minmax(0, 1.15fr);
        gap: 16px;
        padding: 6px 4px 10px;
      }
      @media (max-width: 1100px) {
        .detail {
          grid-template-columns: minmax(0, 1fr);
        }
      }
      .d-left,
      .d-right {
        display: flex;
        flex-direction: column;
        gap: 6px;
        min-width: 0;
      }
      .d-head {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      h3 {
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-tertiary);
        margin: 4px 0 0;
      }
      .meta-line {
        display: flex;
        flex-wrap: wrap;
        gap: 2px 12px;
        font-size: 11px;
        color: var(--text-secondary);
      }
      .spark {
        width: 100%;
        height: 72px;
        display: block;
      }
      .spark rect {
        fill: var(--ni-up);
        opacity: 0.85;
      }
      .spark rect.neg-bar {
        fill: var(--ni-down);
      }
      .spark-axis {
        display: flex;
        justify-content: space-between;
        font-size: 10px;
        color: var(--text-tertiary);
      }
      .wm {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
      }
      .wm li {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr) auto 44px;
        gap: 8px;
        align-items: center;
        font-size: 11.5px;
        padding: 3px 0;
        border-bottom: 1px dashed var(--border);
      }
      .wm .t {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .wm .faint {
        font-size: 10.5px;
      }
      .wm b {
        text-align: right;
        font-weight: 600;
      }
      .members {
        max-height: 280px;
        border: 1px solid var(--border);
        border-radius: 8px;
        background: var(--ni-panel);
      }
      .members th {
        background: var(--ni-panel);
      }
      .members .hl {
        max-width: 320px;
      }
      .members .hl a,
      .members .hl span:first-child {
        display: inline-block;
        max-width: 100%;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        vertical-align: bottom;
        color: var(--text-primary);
        text-decoration: none;
      }
      .members .hl a:hover {
        color: var(--accent);
      }
      .nowrap {
        white-space: nowrap;
      }
      .lab {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        margin: 1px 3px 1px 0;
        padding: 0 5px;
        line-height: 17px;
        border-radius: 5px;
        border: 1px solid var(--border);
        font-family: var(--ni-mono);
        font-size: 10.5px;
        white-space: nowrap;
      }
      .lab i {
        width: 6px;
        height: 6px;
        border-radius: 2px;
      }
      .lab b {
        font-size: 9px;
        color: var(--text-tertiary);
      }
      .lab em {
        font-style: normal;
        font-family: inherit;
        font-size: 9.5px;
        color: var(--text-tertiary);
      }
      .lab.bull b {
        color: var(--ni-up);
      }
      .lab.bear b {
        color: var(--ni-down);
      }
      .empty.pad {
        padding: 12px;
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
  /** Client-side title / event-key search over the loaded window. */
  readonly q = signal('');
  readonly pubHistLabels = ['1 pub', '2', '3', '4', '5', '6+'];

  readonly visible = computed(() => {
    const q = this.q().trim().toLowerCase();
    const list = [...(this.stories.value() ?? [])].sort(
      (a, b) =>
        b.publisherCount - a.publisherCount ||
        b.articleCount - a.articleCount ||
        Date.parse(b.lastSeenUtc) - Date.parse(a.lastSeenUtc),
    );
    return q
      ? list.filter((s) => s.title.toLowerCase().includes(q) || (s.eventKey ?? '').toLowerCase().includes(q))
      : list;
  });
  readonly maxPubs = computed(() => Math.max(3, ...(this.stories.value() ?? []).map((s) => s.publisherCount)));

  readonly stateMix = computed(() => {
    const c = this.counts();
    const total = Object.values(c).reduce((s, v) => s + v, 0) || 1;
    return NEWS_STORY_STATES.map((state) => ({
      state,
      count: c[state] ?? 0,
      pct: Math.round(((c[state] ?? 0) / total) * 100),
    }));
  });
  readonly stateAria = computed(() =>
    this.stateMix()
      .map((s) => `${s.state} ${s.count}`)
      .join(', '),
  );

  readonly exposureBars = computed<HBarItem[]>(() => {
    const m = new Map<string, number>();
    for (const s of this.stories.value() ?? [])
      for (const k of storyExposures(s)) m.set(k, (m.get(k) ?? 0) + 1);
    return [...m.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([k, v]) => ({ label: k, key: k, value: v }));
  });

  readonly basisBars = computed<HBarItem[]>(() => {
    const m = new Map<string, number>();
    for (const s of this.stories.value() ?? []) {
      const b = s.lastMatchBasis ?? 'unknown';
      m.set(b, (m.get(b) ?? 0) + 1);
    }
    return [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => ({ label: k, value: v, color: 'var(--ni-k-factor)' }));
  });

  readonly kpi = computed(() => {
    const list = this.stories.value();
    const c = this.counts();
    if (!list) {
      const d = '—';
      return { total: d, developing: d, confirmed: d, confirmedShare: null, denied: d, deniedN: 0, resolved: d, corroborated: d, medianPubs: d, pubHist: null, articles: d, perStory: null };
    }
    const pubs = list.map((s) => s.publisherCount).sort((a, b) => a - b);
    const median = pubs.length ? pubs[Math.floor(pubs.length / 2)] : 0;
    const hist = [0, 0, 0, 0, 0, 0];
    for (const p of pubs) hist[Math.min(5, Math.max(1, p) - 1)]++;
    const arts = list.reduce((s, x) => s + x.articleCount, 0);
    return {
      total: String(list.length),
      developing: String(c['Developing'] ?? 0),
      confirmed: String(c['Confirmed'] ?? 0),
      confirmedShare: list.length ? `${Math.round(((c['Confirmed'] ?? 0) / list.length) * 100)}% of stories` : null,
      denied: String(c['Denied'] ?? 0),
      deniedN: c['Denied'] ?? 0,
      resolved: String(c['Resolved'] ?? 0),
      corroborated: String(list.filter((s) => s.publisherCount >= 3).length),
      medianPubs: String(median),
      pubHist: hist,
      articles: String(arts),
      perStory: list.length ? `${(arts / list.length).toFixed(1)} per story` : null,
    };
  });

  readonly windowLabel = computed(() => (this.hours() === 168 ? '7 days' : `${this.hours()} h`));

  agoText(iso: string): string {
    return ago(iso);
  }
  kc(key: string): string {
    return kindVar(key);
  }
  short(key: string): string {
    return shortKey(key);
  }
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
    const k = v.trim().toUpperCase();
    this.exposure.set(this.exposure() === k ? '' : k);
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
