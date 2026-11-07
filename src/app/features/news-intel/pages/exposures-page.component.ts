import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { NewsIntelService } from '@core/services/news-intel.service';
import { AuthService } from '@core/auth/auth.service';
import { Permission } from '@core/auth/permissions.generated';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { errorText } from '@features/iam/iam.logic';
import { NewsIntelNavComponent } from '../components/news-intel-nav.component';
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
import { NewsConfigEntry } from '../news-intel.types';

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
  imports: [RouterLink, NewsIntelNavComponent, ConfirmDialogComponent],
  styleUrls: ['../news-intel-shared.scss'],
  template: `
    <div class="page">
      <header>
        <h1>Tracked exposures</h1>
        <p class="muted small">
          What the module classifies news for. Every tracked key costs classification (model calls
          shared with spot analysis) and, where it has a search term, an aggregator search every
          cycle. An untracked key is never scored as zero — symbols that need it read as partial.
        </p>
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

      <section class="card">
        <div class="card-head">
          <div>
            <h2>Tracked now ({{ tracked().length }})</h2>
            <p class="muted xsmall">
              @if (usingCurrencies()) {
                <code>{{ exposuresKey }}</code> is empty, so the module tracks
                <code>{{ currenciesKey }}</code
                >. Adding a key here writes the full list into
                <code>{{ exposuresKey }}</code> (currencies included).
              } @else {
                From <code>{{ exposuresKey }}</code
                >.
              }
            </p>
          </div>
          @if (dirty()) {
            <div class="filters">
              <button type="button" class="btn subtle" (click)="discard()">Discard</button>
              <button
                type="button"
                class="btn primary"
                [disabled]="!canEdit() || saving()"
                (click)="confirmOpen.set(true)"
              >
                Review &amp; save
              </button>
            </div>
          }
        </div>
        @for (g of trackedGroups(); track g.kind) {
          <div>
            <h3>{{ label(g.kind) }}</h3>
            <div class="legs">
              @for (k of g.keys; track k) {
                <span class="key" [class.untracked]="removed().includes(k)">
                  {{ k }}
                  @if (canEdit()) {
                    <button
                      type="button"
                      class="x"
                      [attr.aria-label]="(removed().includes(k) ? 'Keep ' : 'Remove ') + k"
                      (click)="toggleRemove(k)"
                    >
                      {{ removed().includes(k) ? '↺' : '×' }}
                    </button>
                  }
                </span>
              }
            </div>
          </div>
        }
        @if (added().length) {
          <div>
            <h3>To add</h3>
            <div class="legs">
              @for (k of added(); track k) {
                <span class="key"
                  >+ {{ k }}
                  <button
                    type="button"
                    class="x"
                    [attr.aria-label]="'Drop ' + k"
                    (click)="toggleAdd(k)"
                  >
                    ×
                  </button></span
                >
              }
            </div>
          </div>
        }
        @if (canEdit()) {
          <div class="filters">
            <input
              class="inp mono"
              placeholder="Add keys: WTI, IDX:US500, EQ:AAPL"
              aria-label="Exposure keys to add"
              [value]="draft()"
              (input)="draft.set($any($event.target).value)"
              (keydown.enter)="addDraft()"
            />
            <button type="button" class="btn" (click)="addDraft()">Add</button>
            @if (draftInvalid().length) {
              <span class="neg xsmall">Not exposure keys: {{ draftInvalid().join(', ') }}</span>
            }
          </div>
        } @else {
          <p class="muted xsmall">Changing the list needs <code>platform.engine.manage</code>.</p>
        }
      </section>

      <section class="card">
        <div class="card-head">
          <div>
            <h2>Recommended — not tracked ({{ missing().length }})</h2>
            <p class="muted xsmall">
              Read-only, derived by the engine from the active symbol universe through the exposure
              map (<code>{{ recommendedKey }}</code
              >). Pick what is worth the classification cost.
            </p>
          </div>
          @if (canEdit() && missing().length) {
            <button type="button" class="btn" (click)="addAllOfKind(null)">Add all</button>
          }
        </div>
        @for (g of missingGroups(); track g.kind) {
          <div>
            <h3>
              {{ label(g.kind) }} ({{ g.keys.length }})
              @if (canEdit()) {
                <button type="button" class="btn subtle xsmall" (click)="addAllOfKind(g.kind)">
                  add all
                </button>
              }
            </h3>
            <div class="legs">
              @for (k of g.keys; track k) {
                <button
                  type="button"
                  class="key untracked as-btn"
                  [disabled]="!canEdit()"
                  [class.picked]="added().includes(k)"
                  (click)="toggleAdd(k)"
                >
                  {{ added().includes(k) ? '✓ ' : '' }}{{ k }}
                </button>
              }
            </div>
          </div>
        } @empty {
          <p class="empty">Every recommended key is tracked.</p>
        }
      </section>

      <section class="card">
        <h2>Search term per tracked key</h2>
        <p class="muted xsmall">
          The aggregator query each tracked key is searched with. Keys in
          <code>{{ queriesKey }}</code> use that term; others use the engine's built-in term (not
          exposed by the API) or are not searched. Edit the JSON in the
          <a routerLink="/news-intel">Overview</a> configuration panel (Sourcing section).
        </p>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Key</th>
                <th>Kind</th>
                <th>Search term</th>
              </tr>
            </thead>
            <tbody>
              @for (k of tracked(); track k) {
                <tr>
                  <td class="mono">{{ k }}</td>
                  <td>{{ kindLabel(k) }}</td>
                  <td class="mono xsmall">
                    @if (queries()[k]; as q) {
                      {{ q }}
                    } @else {
                      <span class="muted">engine built-in term, if any</span>
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      </section>

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
          <input
            class="inp"
            [value]="reason()"
            (input)="reason.set($any($event.target).value)"
            placeholder="e.g. track WTI/BRENT for the oil CFDs"
          />
        </label>
      </app-confirm-dialog>
    </div>
  `,
  styles: [
    `
      .x {
        border: 0;
        background: transparent;
        color: inherit;
        cursor: pointer;
        padding: 0 0 0 4px;
      }
      .as-btn {
        cursor: pointer;
      }
      .as-btn.picked {
        border-style: solid;
        border-color: var(--accent);
        color: var(--accent);
      }
      h3 {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        margin-bottom: 4px;
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
}
