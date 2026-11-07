import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { NewsIntelService } from '@core/services/news-intel.service';
import { AuthService } from '@core/auth/auth.service';
import { Permission } from '@core/auth/permissions.generated';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { errorText } from '@features/iam/iam.logic';
import { NewsIntelNavComponent } from '../components/news-intel-nav.component';
import {
  NiInfoComponent,
  NiKeyComponent,
  NiPanelComponent,
  NiStatComponent,
} from '../components/viz/ni-primitives';
import { kindColor, kindVar } from '../components/viz/ni-viz';
import {
  EXPOSURE_KIND_LABEL,
  configValue,
  editExposureList,
  exposureKindOf,
  groupKeysByKind,
  invalidExposureTokens,
  parseExposureList,
  parseSearchQueries,
} from '../news-intel.logic';
import {
  ExposureKindName,
  NewsConfigEntry,
  NewsExposureListView,
  NewsSearchTermView,
} from '../news-intel.types';

const EXPOSURES = 'NewsIntel:Exposures';
const CURRENCIES = 'NewsIntel:Currencies';
const RECOMMENDED = 'NewsIntel:Exposures:Recommended';
const QUERIES = 'NewsIntel:Ingest:SearchQueriesJson';

/**
 * Exposures config — the tracked exposure list against the one the symbol universe implies
 * (`NewsIntel:Exposures:Recommended`, derived and read-only), and the aggregator search term per key.
 *
 * Changes go through `PUT news-intel/config`, which routes every key through the engine's
 * `UpsertEngineConfigCommand` — audit row, cache invalidation and the risk-loosening governance — and
 * answers one message per key (applied / queued for cooling-off / refused), shown verbatim.
 */
@Component({
  selector: 'app-news-exposures-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    NewsIntelNavComponent,
    ConfirmDialogComponent,
    NiInfoComponent,
    NiKeyComponent,
    NiPanelComponent,
    NiStatComponent,
  ],
  styleUrls: ['../news-intel-shared.scss'],
  template: `
    <div class="page">
      <header class="page-head">
        <div class="title">
          <h1>Tracked exposures</h1>
          <app-ni-info text="What the module classifies news for. Every tracked key costs classification (model calls shared with spot analysis) and, where it has a search term, an aggregator search every cycle. An untracked key is never scored as zero — symbols that need it read as partial." />
        </div>
      </header>
      <app-news-intel-nav [showRefresh]="true" [refreshing]="loading()" (refresh)="load()" />

      @if (error(); as e) {
        <div class="banner error">{{ e }}</div>
      }
      @if (messages().length) {
        <div class="banner info">
          @for (m of messages(); track m) {
            <div class="mono xsmall">{{ m }}</div>
          }
        </div>
      }

      <div class="ni-kpis kpi6">
        <app-ni-stat label="Tracked" [value]="tracked().length" [sub]="usingCurrencies() ? 'from Currencies (Exposures empty)' : 'NewsIntel:Exposures'" info="Keys the classifier labels news against right now." />
        <app-ni-stat label="Recommended" [value]="recommended().length" sub="derived from the universe" info="Derived by the engine from the active symbol universe through the exposure map (NewsIntel:Exposures:Recommended, read-only)." />
        <app-ni-stat label="Not tracked" [value]="missing().length" [sub]="recommended().length ? pctOf(missing().length, recommended().length) + ' of recommended' : null" [tone]="missing().length ? 'warn' : 'ok'" info="Recommended keys the module does not track — the symbols that need them read as partial." />
        <app-ni-stat label="Searched" [value]="searchStats().polled" [sub]="searchStats().enabled" info="Keys whose search term the aggregator search source runs every cycle." />
        <app-ni-stat label="Overrides" [value]="searchStats().overrides" sub="search terms from config" info="Search terms set in NewsIntel:Ingest:SearchQueriesJson (your override) rather than built-in or shipped defaults." />
        <app-ni-stat label="Pending edit" [value]="dirty() ? '+' + added().length + ' / −' + removed().length : '—'" [sub]="dirty() ? 'review & save to apply' : 'no changes'" [tone]="dirty() ? 'warn' : null" info="Changes go through PUT news-intel/config: audit row, cache invalidation and risk-loosening governance; the engine answers per key." />
      </div>

      <div class="ni-grid-2">
        <app-ni-panel title="Tracked now" [info]="usingCurrencies() ? exposuresKey + ' is empty, so the module tracks ' + currenciesKey + '. Adding a key here writes the full list into ' + exposuresKey + ' (currencies included).' : 'From ' + exposuresKey + '. Click × to mark a key for removal, ↺ to keep it.'">
          <span meta>{{ tracked().length }} keys</span>
          @if (dirty()) {
            <div actions class="filters">
              <button type="button" class="btn subtle" (click)="discard()">Discard</button>
              <button type="button" class="btn primary" [disabled]="!canEdit() || saving()" (click)="confirmOpen.set(true)">Review &amp; save</button>
            </div>
          }
          <div class="board">
            @for (g of trackedGroups(); track g.kind) {
              <div class="brow">
                <div class="bk"><i [style.background]="kc(g.kind)"></i>{{ label(g.kind) }}<span>{{ g.keys.length }}</span></div>
                <div class="legs">
                  @for (k of g.keys; track k) {
                    <span class="key chip" [class.untracked]="removed().includes(k)" [class.gone]="removed().includes(k)">
                      <i [style.background]="kc(g.kind)"></i>{{ k }}
                      @if (canEdit()) {
                        <button type="button" class="x" [attr.aria-label]="(removed().includes(k) ? 'Keep ' : 'Remove ') + k" (click)="toggleRemove(k)">{{ removed().includes(k) ? '↺' : '×' }}</button>
                      }
                    </span>
                  }
                </div>
              </div>
            }
            @if (added().length) {
              <div class="brow add">
                <div class="bk"><i class="plus"></i>To add<span>{{ added().length }}</span></div>
                <div class="legs">
                  @for (k of added(); track k) {
                    <span class="key chip picked"><i [style.background]="kcKey(k)"></i>+ {{ k }}<button type="button" class="x" [attr.aria-label]="'Drop ' + k" (click)="toggleAdd(k)">×</button></span>
                  }
                </div>
              </div>
            }
          </div>
          @if (canEdit()) {
            <div class="filters addrow">
              <input class="inp mono" placeholder="Add keys: WTI, IDX:US500, EQ:AAPL" aria-label="Exposure keys to add" [value]="draft()" (input)="draft.set($any($event.target).value)" (keydown.enter)="addDraft()" />
              <button type="button" class="btn" (click)="addDraft()">Add</button>
              @if (draftInvalid().length) {
                <span class="neg xsmall">Not exposure keys: {{ draftInvalid().join(', ') }}</span>
              }
            </div>
          } @else {
            <p class="faint xsmall">Changing the list needs <code>platform.engine.manage</code>.</p>
          }
        </app-ni-panel>

        <app-ni-panel title="Recommended — not tracked" [info]="'Read-only, derived by the engine from the active symbol universe (' + recommendedKey + '). Click a key to stage it for adding; pick what is worth the classification cost.'">
          <span meta>{{ missing().length }} keys</span>
          @if (canEdit() && missing().length) {
            <button actions type="button" class="btn" (click)="addAllOfKind(null)">Add all</button>
          }
          <div class="board">
            @for (g of missingGroups(); track g.kind) {
              <div class="brow">
                <div class="bk">
                  <i [style.background]="kc(g.kind)"></i>{{ label(g.kind) }}<span>{{ g.keys.length }}</span>
                  @if (canEdit()) {
                    <button type="button" class="lnkbtn" (click)="addAllOfKind(g.kind)">add all</button>
                  }
                </div>
                <div class="legs">
                  @for (k of g.keys; track k) {
                    <button type="button" class="key untracked as-btn chip" [disabled]="!canEdit()" [class.picked]="added().includes(k)" (click)="toggleAdd(k)">
                      <i [style.background]="kc(g.kind)"></i>{{ added().includes(k) ? '✓ ' : '' }}{{ k }}
                    </button>
                  }
                </div>
              </div>
            } @empty {
              <p class="empty">Every recommended key is tracked.</p>
            }
          </div>
        </app-ni-panel>
      </div>

      <app-ni-panel title="Search term per key" [info]="'The aggregator query each key is searched with, and where it comes from: config (your override in ' + queriesKey + '), shipped default, built-in (the exposure catalogue term) or none. Polled = the search source runs that term now. Edit the JSON on the Settings tab (Sourcing).'" [flush]="true">
        @if (exposureList(); as xl) {
          <span meta data-testid="search-terms-engine">search {{ xl.searchEnabled ? 'on' : 'OFF' }} · {{ filteredTerms().length }} of {{ xl.searchTerms.length }} keys</span>
        } @else {
          <span meta>engine does not report effective terms</span>
        }
        <div actions class="filters">
          @if (exposureList()) {
            <span class="seg">
              @for (f of termFilters; track f) {
                <button type="button" [class.on]="termFilter() === f" (click)="termFilter.set(f)">{{ f }}</button>
              }
            </span>
          }
          <a class="lnk" routerLink="/news-intel/settings">Edit in Settings →</a>
        </div>
        @if (exposureList(); as xl) {
          <div class="table-wrap scroll terms">
            <table>
              <thead>
                <tr>
                  <th>Key</th>
                  <th>Status</th>
                  <th>Source</th>
                  <th>Polled</th>
                  <th>Search term</th>
                </tr>
              </thead>
              <tbody>
                @for (t of filteredTerms(); track t.key) {
                  <tr>
                    <td><app-ni-key [key]="t.key" [untracked]="!t.tracked" /></td>
                    <td><span class="pill" [class.ok]="t.tracked" [class.plain]="!t.tracked">{{ t.tracked ? 'tracked' : 'recommended' }}</span></td>
                    <td><span class="pill plain" [class.info]="t.source === 'config'">{{ sourceLabel(t) }}</span></td>
                    <td>
                      @if (t.polled) {
                        <span class="pill ok">yes</span>
                      } @else {
                        <span class="faint xsmall">no</span>
                      }
                    </td>
                    <td class="mono term ellipsis" [title]="t.term ?? ''">
                      @if (t.term) {
                        {{ t.term }}
                      } @else {
                        <span class="faint">no term — not searched</span>
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        } @else {
          <div class="table-wrap scroll terms">
            <table>
              <thead>
                <tr>
                  <th>Key</th>
                  <th>Search term</th>
                </tr>
              </thead>
              <tbody>
                @for (k of tracked(); track k) {
                  <tr>
                    <td><app-ni-key [key]="k" /></td>
                    <td class="mono term">
                      @if (queries()[k]; as q) {
                        {{ q }}
                      } @else {
                        <span class="faint">engine built-in term, if any</span>
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      </app-ni-panel>

      <app-confirm-dialog
        [open]="confirmOpen()"
        title="Change the tracked exposures?"
        [message]="confirmText()"
        confirmLabel="Save"
        [loading]="saving()"
        (confirm)="save()"
        (cancelled)="confirmOpen.set(false)"
      >
        <label class="small reason">
          Reason (recorded with the change)
          <input class="inp" [value]="reason()" (input)="reason.set($any($event.target).value)" placeholder="e.g. track WTI/BRENT for the oil CFDs" />
        </label>
      </app-confirm-dialog>
    </div>
  `,
  styles: [
    `
      .title {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .kpi6 {
        grid-template-columns: repeat(6, minmax(0, 1fr));
      }
      @media (max-width: 1100px) {
        .kpi6 {
          grid-template-columns: repeat(auto-fit, minmax(118px, 1fr));
        }
      }
      .lnk {
        font-size: 11px;
        color: var(--accent);
        text-decoration: none;
      }
      .board {
        display: flex;
        flex-direction: column;
      }
      .brow {
        display: grid;
        grid-template-columns: 112px minmax(0, 1fr);
        gap: 10px;
        padding: 7px 0;
        border-top: 1px solid var(--border);
        align-items: start;
      }
      .brow:first-child {
        border-top: 0;
        padding-top: 0;
      }
      .bk {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 5px;
        font-size: 10.5px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-secondary);
        line-height: 20px;
      }
      .bk i {
        width: 8px;
        height: 8px;
        border-radius: 2px;
      }
      .bk i.plus {
        background: var(--accent);
      }
      .bk span {
        font-weight: 500;
        color: var(--text-tertiary);
      }
      .lnkbtn {
        border: 0;
        background: transparent;
        color: var(--accent);
        font-size: 10.5px;
        text-transform: none;
        letter-spacing: 0;
        cursor: pointer;
        padding: 0;
        font-weight: 500;
      }
      .chip {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        line-height: 20px;
      }
      .chip i {
        width: 6px;
        height: 6px;
        border-radius: 2px;
      }
      .chip.gone {
        text-decoration: line-through;
        opacity: 0.7;
      }
      .x {
        border: 0;
        background: transparent;
        color: var(--text-tertiary);
        cursor: pointer;
        padding: 0 0 0 2px;
        font-size: 12px;
        line-height: 1;
      }
      .x:hover {
        color: var(--ni-bad);
      }
      .as-btn {
        cursor: pointer;
        font: inherit;
        font-family: var(--ni-mono);
        font-size: 11px;
        color: var(--text-secondary);
      }
      .as-btn:hover:not(:disabled) {
        border-color: var(--accent);
        color: var(--text-primary);
      }
      .as-btn.picked,
      .chip.picked {
        border-style: solid;
        border-color: var(--accent);
        color: var(--accent);
        background: color-mix(in oklab, var(--accent) 8%, transparent);
      }
      .addrow .inp {
        flex: 1;
        min-width: 200px;
      }
      .terms {
        max-height: 460px;
      }
      .terms th:first-child,
      .terms td:first-child {
        padding-left: 12px;
      }
      .term {
        font-size: 11px;
        max-width: 1px;
        width: 60%;
      }
      .reason {
        display: flex;
        flex-direction: column;
        gap: 4px;
        margin-top: var(--space-2);
      }
    `,
  ],
})
export class NewsExposuresPageComponent {
  private readonly svc = inject(NewsIntelService);
  private readonly auth = inject(AuthService);

  protected readonly exposuresKey = EXPOSURES;
  protected readonly currenciesKey = CURRENCIES;
  protected readonly recommendedKey = RECOMMENDED;
  protected readonly queriesKey = QUERIES;

  readonly entries = signal<NewsConfigEntry[]>([]);
  /** The engine's exposure lists with effective search terms; null on an engine without the read. */
  readonly exposureList = signal<NewsExposureListView | null>(null);
  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);
  readonly messages = signal<string[]>([]);
  readonly added = signal<string[]>([]);
  readonly removed = signal<string[]>([]);
  readonly draft = signal('');
  readonly reason = signal('');
  readonly confirmOpen = signal(false);

  readonly canEdit = computed(() => this.auth.hasPermission(Permission.PlatformEngineManage));
  readonly usingCurrencies = computed(
    () => parseExposureList(configValue(this.entries(), EXPOSURES)).length === 0,
  );
  readonly tracked = computed(() =>
    this.usingCurrencies()
      ? parseExposureList(configValue(this.entries(), CURRENCIES))
      : parseExposureList(configValue(this.entries(), EXPOSURES)),
  );
  readonly recommended = computed(() =>
    parseExposureList(configValue(this.entries(), RECOMMENDED)),
  );
  readonly missing = computed(() => this.recommended().filter((k) => !this.tracked().includes(k)));
  readonly trackedGroups = computed(() => groupKeysByKind(this.tracked()));
  readonly missingGroups = computed(() => groupKeysByKind(this.missing()));
  readonly queries = computed(() => parseSearchQueries(configValue(this.entries(), QUERIES)));
  readonly draftInvalid = computed(() => invalidExposureTokens(this.draft()));
  readonly dirty = computed(() => this.added().length > 0 || this.removed().length > 0);
  readonly nextValue = computed(() =>
    editExposureList(this.tracked(), this.added(), this.removed()),
  );
  readonly confirmText = computed(() => {
    const add = this.added();
    const rem = this.removed();
    const parts = [
      add.length ? `Track ${add.join(', ')}.` : '',
      rem.length ? `Stop tracking ${rem.join(', ')}.` : '',
      `${EXPOSURES} becomes "${this.nextValue()}".`,
      add.length
        ? 'More keys mean more classification work on model slots shared with spot analysis, and more searches where a key has a term.'
        : '',
    ];
    return parts.filter(Boolean).join(' ');
  });

  constructor() {
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.svc.getExposureList().subscribe({
      next: (x) => this.exposureList.set(x),
      error: () => this.exposureList.set(null),
    });
    this.svc.getConfig().subscribe({
      next: (e) => {
        this.entries.set(e);
        this.loading.set(false);
      },
      error: (e) => {
        this.loading.set(false);
        this.error.set(errorText(e, 'Could not load the module configuration.'));
      },
    });
  }

  sourceLabel(t: NewsSearchTermView): string {
    switch (t.source) {
      case 'config':
        return 'config';
      case 'shipped-default':
        return 'shipped default';
      case 'built-in':
        return 'built-in';
      default:
        return 'none';
    }
  }

  label(kind: string): string {
    return EXPOSURE_KIND_LABEL[kind as keyof typeof EXPOSURE_KIND_LABEL] ?? kind;
  }

  kindLabel(key: string): string {
    const k = exposureKindOf(key);
    return k ? EXPOSURE_KIND_LABEL[k] : '?';
  }

  toggleAdd(k: string): void {
    this.added.update((a) => (a.includes(k) ? a.filter((x) => x !== k) : [...a, k]));
  }

  toggleRemove(k: string): void {
    this.removed.update((r) => (r.includes(k) ? r.filter((x) => x !== k) : [...r, k]));
  }

  addAllOfKind(kind: string | null): void {
    const keys = this.missing().filter((k) => kind === null || exposureKindOf(k) === kind);
    this.added.update((a) => [...a, ...keys.filter((k) => !a.includes(k))]);
  }

  addDraft(): void {
    const keys = parseExposureList(this.draft()).filter((k) => !this.tracked().includes(k));
    this.added.update((a) => [...a, ...keys.filter((k) => !a.includes(k))]);
    if (!this.draftInvalid().length) this.draft.set('');
  }

  discard(): void {
    this.added.set([]);
    this.removed.set([]);
  }

  save(): void {
    this.saving.set(true);
    this.error.set(null);
    this.svc
      .saveConfig([{ key: EXPOSURES, value: this.nextValue(), dataType: 'String' }], {
        reason: this.reason() || undefined,
      })
      .subscribe({
        next: (msgs) => {
          this.saving.set(false);
          this.confirmOpen.set(false);
          this.messages.set(msgs);
          this.discard();
          this.reason.set('');
          this.load();
        },
        error: (e) => {
          this.saving.set(false);
          this.confirmOpen.set(false);
          const text = errorText(e, 'The change was not saved.');
          if (/-202-approval/.test(JSON.stringify(e ?? {})))
            this.messages.set([`${EXPOSURES}: sent for approval.`]);
          else this.error.set(text);
        },
      });
  }

  // ── Dense layout helpers ──
  readonly termFilters = ['all', 'tracked', 'recommended', 'no term'] as const;
  readonly termFilter = signal<(typeof this.termFilters)[number]>('all');
  readonly filteredTerms = computed(() => {
    const ts = this.exposureList()?.searchTerms ?? [];
    switch (this.termFilter()) {
      case 'tracked':
        return ts.filter((t) => t.tracked);
      case 'recommended':
        return ts.filter((t) => !t.tracked);
      case 'no term':
        return ts.filter((t) => !t.term);
      default:
        return ts;
    }
  });
  readonly searchStats = computed(() => {
    const xl = this.exposureList();
    if (!xl) {
      return { polled: '—', overrides: String(Object.keys(this.queries()).length), enabled: 'engine does not report' };
    }
    return {
      polled: String(xl.searchTerms.filter((t) => t.polled).length),
      overrides: String(xl.searchTerms.filter((t) => t.source === 'config').length),
      enabled: xl.searchEnabled ? 'search on' : 'search OFF',
    };
  });

  pctOf(n: number, d: number): string {
    return d ? `${Math.round((n / d) * 100)}%` : '—';
  }
  kc(kind: string): string {
    return kindColor(kind as ExposureKindName);
  }
  kcKey(key: string): string {
    return kindVar(key);
  }
}
