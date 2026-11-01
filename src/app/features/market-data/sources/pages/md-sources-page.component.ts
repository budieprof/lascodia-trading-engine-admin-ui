import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { catchError, of } from 'rxjs';
import { RouterLink } from '@angular/router';

import { NotificationService } from '@core/notifications/notification.service';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { errorText, reportable, when } from '@features/iam/iam.logic';
import { ago } from '@features/iam/shared/admin-context.logic';
import { iamResource } from '@features/iam/shared/iam-resource';
import { MarketDataSourcesApiService } from '../md-sources-api.service';
import {
  badWriters,
  changes,
  formatSymbolMap,
  isEditable,
  isVenueId,
  kindLabel,
  parseSymbolMap,
  parseWriters,
  readiness,
  SOURCE_GROUPS,
  sourceGroup,
  storedText,
} from '../md-sources.logic';
import type {
  MarketDataSourceAdmin,
  MarketDataStoreCoverage,
  StoreCoverageSource,
} from '../md-sources.types';

interface EditState {
  row: MarketDataSourceAdmin;
  enabled: boolean;
  displayName: string;
  writersText: string;
  symbolMapText: string;
  contractSize: number;
  reason: string;
}

/** KPI stripe colours (the metric-card `dotColor`), shared with the rest of the platform pages. */
const TONE = {
  accent: '#0071E3',
  ok: '#34C759',
  warn: '#FF9500',
  muted: '#8E8E93',
  violet: '#5856D6',
} as const;

/**
 * Market-data sources (engine C7, platform staff, `platform.data.manage`): every source in the
 * registry — MT5 broker servers (the engine's own; read-only here), CME vendor paths and FX venues —
 * with its entitlement feed, size unit, symbol map and the machine ids allowed to write it. Staff
 * enable or disable an external source, set its writers and symbol map, and register a new FX venue
 * (created disabled). Who may READ a source's feed is the entitlements page. Venue onboarding:
 * engine `docs/runbooks/venue-onboarding.md`; CME: the cme-tier2 runbook.
 */
@Component({
  selector: 'app-md-sources-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, RouterLink, PageHeaderComponent, MetricCardComponent],
  styleUrls: [
    '../../../iam/shared/iam-page.scss',
    '../../md-summary.scss',
    './md-sources-page.scss',
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Market-data sources"
        subtitle="Every source the engine stores: MT5 broker servers, CME vendor paths and FX venues — who may write each one, and its feed."
      >
        <a class="btn btn-ghost" routerLink="/market-data/entitlements">Entitlements</a>
        <button
          type="button"
          class="btn btn-secondary"
          (click)="sources.reload(); coverage.reload()"
          [disabled]="sources.loading()"
        >
          {{ sources.loading() ? 'Loading…' : 'Refresh' }}
        </button>
        <button type="button" class="btn btn-primary" (click)="startVenue()">
          Register a venue
        </button>
      </app-page-header>

      @if (sources.error(); as err) {
        <section class="card">
          <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
        </section>
      }

      <div class="kpis" aria-label="Summary">
        <app-metric-card
          label="Sources registered"
          [value]="sources.value().length"
          [dotColor]="tone.accent"
          [caption]="kindTabs().length - 1 + ' kinds · ' + kindSummary()"
        />
        @if (coverage.value()) {
          <app-metric-card
            label="Receiving today"
            [value]="counts().receiving"
            [dotColor]="counts().receiving ? tone.ok : tone.muted"
            caption="stored data today (UTC)"
          />
          <app-metric-card
            label="Enabled, nothing arriving"
            [value]="counts().waiting"
            [dotColor]="counts().waiting ? tone.warn : tone.ok"
            caption="nothing stored today"
          />
        } @else {
          <app-metric-card
            label="Receiving today"
            displayValue="—"
            caption="needs the engine update (store coverage)"
          />
          <app-metric-card
            label="Enabled"
            [value]="counts().enabled"
            [dotColor]="tone.ok"
            caption="MT5 servers stream from the EAs; others from their writers"
          />
        }
        <app-metric-card
          label="Disabled"
          [value]="counts().stored + counts().disabled"
          [dotColor]="tone.muted"
          [caption]="
            coverage.value()
              ? counts().stored + ' kept history · ' + counts().disabled + ' never stored'
              : 'registered, not enabled'
          "
        />
        <app-metric-card
          label="Symbols stored"
          [value]="coverage.value() ? storedSymbols() : null"
          [displayValue]="coverage.value() ? null : '—'"
          [dotColor]="tone.violet"
          caption="source × symbol pairs"
        />
      </div>

      @if (venue(); as v) {
        <section class="card form-card" aria-label="Register an FX venue">
          <header class="card-head">
            <h3>Register an FX venue</h3>
            <span class="hint">created disabled — nothing is stored until you enable it</span>
          </header>
          <form class="card-body" (ngSubmit)="createVenue()">
            <p class="note">
              The source is created DISABLED as <code>venue-{{ v.venueId || '…' }}</code> with feed
              <code>venue:{{ v.venueId || '…' }}</code
              >. Nothing is stored until you enable it and name the sidecar's machine id as its
              writer.
            </p>
            <div class="form-grid">
              <label class="field">
                <span class="label">Venue id (lowercase, e.g. lmax)</span>
                <input
                  class="input"
                  name="venueId"
                  maxlength="48"
                  [ngModel]="v.venueId"
                  (ngModelChange)="patchVenue({ venueId: $event })"
                />
              </label>
              <label class="field">
                <span class="label">Display name</span>
                <input
                  class="input"
                  name="venueName"
                  maxlength="128"
                  [ngModel]="v.displayName"
                  (ngModelChange)="patchVenue({ displayName: $event })"
                />
              </label>
              <label class="field">
                <span class="label">Symbol map (ENGINE=venue symbol, one per line)</span>
                <textarea
                  class="input"
                  name="venueMap"
                  [ngModel]="v.symbolMapText"
                  (ngModelChange)="patchVenue({ symbolMapText: $event })"
                ></textarea>
              </label>
              <label class="field">
                <span class="label">Reason (audit log)</span>
                <input
                  class="input"
                  name="venueReason"
                  maxlength="500"
                  [ngModel]="v.reason"
                  (ngModelChange)="patchVenue({ reason: $event })"
                />
              </label>
            </div>
            @for (p of venueProblems(); track p) {
              <p class="note warn">{{ p }}</p>
            }
            <div class="actions-row">
              <button type="button" class="btn btn-ghost" data-autofocus (click)="venue.set(null)">
                Cancel
              </button>
              <button
                type="submit"
                class="btn btn-primary"
                [disabled]="busy() || venueProblems().length > 0"
              >
                {{ busy() ? 'Registering…' : 'Register (disabled)' }}
              </button>
            </div>
          </form>
        </section>
      }

      @if (editing(); as e) {
        <section class="card form-card" aria-label="Edit source">
          <header class="card-head">
            <h3>
              Edit <span class="ident">{{ e.row.sourceId }}</span>
            </h3>
            <span class="tag">{{ kind(e.row.kind) }}</span>
            <span class="hint">feed {{ e.row.feedId }}</span>
          </header>
          <form class="card-body" (ngSubmit)="save()">
            @if (e.enabled && !e.row.enabled) {
              <p class="note warn">
                Enabling starts storing this source's data from its writers and shows it to every
                organisation entitled to <code>{{ e.row.feedId }}</code
                >. Check the licence first.
              </p>
            }
            <label class="toggle" [class.on]="e.enabled">
              <input
                type="checkbox"
                name="enabled"
                [ngModel]="e.enabled"
                (ngModelChange)="patchEdit({ enabled: $event })"
              />
              Enabled
            </label>
            <div class="form-grid">
              <label class="field">
                <span class="label">Display name</span>
                <input
                  class="input"
                  name="displayName"
                  maxlength="128"
                  [ngModel]="e.displayName"
                  (ngModelChange)="patchEdit({ displayName: $event })"
                />
              </label>
              <label class="field">
                <span class="label">Contract size (base units per contract/lot)</span>
                <input
                  class="input"
                  type="number"
                  name="contractSize"
                  min="0"
                  [ngModel]="e.contractSize"
                  (ngModelChange)="patchEdit({ contractSize: +$event })"
                />
              </label>
              <label class="field">
                <span class="label"
                  >Writer machine ids (one per line — the sidecar's daemon id)</span
                >
                <textarea
                  class="input"
                  name="writers"
                  [ngModel]="e.writersText"
                  (ngModelChange)="patchEdit({ writersText: $event })"
                ></textarea>
              </label>
              <label class="field">
                <span class="label">Symbol map (ENGINE=source symbol, one per line)</span>
                <textarea
                  class="input"
                  name="symbolMap"
                  [ngModel]="e.symbolMapText"
                  (ngModelChange)="patchEdit({ symbolMapText: $event })"
                ></textarea>
              </label>
              <label class="field">
                <span class="label">Reason (audit log)</span>
                <input
                  class="input"
                  name="reason"
                  maxlength="500"
                  [ngModel]="e.reason"
                  (ngModelChange)="patchEdit({ reason: $event })"
                />
              </label>
            </div>
            @for (p of editProblems(); track p) {
              <p class="note warn">{{ p }}</p>
            }
            <div class="actions-row">
              <button
                type="button"
                class="btn btn-ghost"
                data-autofocus
                (click)="editing.set(null)"
              >
                Cancel
              </button>
              <button
                type="submit"
                class="btn btn-primary"
                [disabled]="busy() || editProblems().length > 0"
              >
                {{ busy() ? 'Saving…' : 'Save' }}
              </button>
            </div>
          </form>
        </section>
      }

      @if (sources.value().length) {
        <section class="card" aria-label="Filter sources">
          <div class="toolbar">
            <div class="seg" role="group" aria-label="Kind">
              @for (k of kindTabs(); track k.key) {
                <button
                  type="button"
                  [class.on]="kindFilter() === k.key"
                  [attr.aria-pressed]="kindFilter() === k.key"
                  (click)="kindFilter.set(k.key)"
                >
                  {{ k.label }}<span class="n">{{ k.n }}</span>
                </button>
              }
            </div>
            <div class="search-box">
              <input
                class="input"
                type="search"
                aria-label="Search sources"
                placeholder="Search sources"
                title="Matches source, feed, kind, writer or mapped symbol"
                [ngModel]="query()"
                (ngModelChange)="query.set($event)"
              />
            </div>
            <label class="toggle" [class.on]="showDisabled()">
              <input
                type="checkbox"
                [ngModel]="showDisabled()"
                (ngModelChange)="showDisabled.set($event)"
              />
              Show disabled
            </label>
            @if (filtering() || kindFilter() !== 'all') {
              <span class="shown">{{ shownCount() }} of {{ sources.value().length }} shown</span>
            }
          </div>
        </section>
      }

      @for (g of groups(); track g.group) {
        <section class="card" [attr.aria-label]="g.title">
          <header class="card-head">
            <span class="tone" [class]="groupTone(g.group)"></span>
            <h3>{{ g.title }}</h3>
            <span class="count" [class]="groupTone(g.group)">{{ g.rows.length }}</span>
            <span class="hint">{{ g.hint }}</span>
            @if (isOffGroup(g.group)) {
              <span class="spacer"></span>
              <button
                type="button"
                class="btn btn-sm btn-ghost"
                (click)="showDisabled.set(!showDisabled())"
              >
                {{ showDisabled() ? 'Hide' : 'Show' }}
              </button>
            }
          </header>
          @if (isOffGroup(g.group) && !showDisabled() && !filtering()) {
            <p class="collapsed">{{ disabledSummary() }}</p>
          } @else {
            <div class="table-wrap">
              <table class="grid">
                <thead>
                  <tr>
                    <th>Source</th>
                    <th>Kind</th>
                    <th>Feed</th>
                    <th>State</th>
                    <th>Writers</th>
                    <th>Symbols mapped</th>
                    <th title="What the market-data store holds for this source">Stored</th>
                    <th><span class="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  @for (s of g.rows; track s.sourceId) {
                    <tr
                      [class.is-editing]="editing()?.row?.sourceId === s.sourceId"
                      [class.is-off]="!s.enabled"
                    >
                      <td>
                        <span class="ident">{{ s.sourceId }}</span>
                        <span class="sub" [title]="'Updated ' + at(s.updatedAtUtc)">{{
                          s.displayName
                        }}</span>
                      </td>
                      <td class="small">
                        {{ kind(s.kind) }}
                        <span class="sub"
                          >{{ s.sizeUnit }}{{ s.contractSize ? ' × ' + s.contractSize : ''
                          }}{{ s.priceTransform === 'Invert' ? ' · inverted' : '' }}</span
                        >
                      </td>
                      <td>
                        <span class="tag">{{ s.feedId }}</span>
                      </td>
                      <td>
                        <span class="dot nowrap" [class]="dotTone(ready(s).tone)">{{
                          ready(s).text
                        }}</span>
                      </td>
                      <td class="small">
                        @if (s.kind === 'Mt5Broker') {
                          <span class="muted">trusted EAs</span>
                        } @else if (s.writerInstanceIds.length) {
                          <div class="chips">
                            @for (w of s.writerInstanceIds; track w) {
                              <span class="tag">{{ w }}</span>
                            }
                          </div>
                        } @else {
                          <span class="muted">none</span>
                        }
                      </td>
                      <td class="small syms">{{ symbolCount(s) }}</td>
                      <td class="small">
                        @if (coverage.value()) {
                          <span class="dot" [class.ok]="covFor(s.sourceId)?.lastDay === today()">{{
                            stored(covFor(s.sourceId), today())
                          }}</span>
                          @if (covFor(s.sourceId); as c) {
                            <span class="sub"
                              >{{ c.symbolsOnLastDay }} on the last day · {{ topSymbols(c) }}</span
                            >
                          }
                        } @else {
                          <span class="muted">—</span>
                        }
                      </td>
                      <td class="actions">
                        @if (editable(s)) {
                          <button type="button" class="btn btn-sm btn-ghost" (click)="startEdit(s)">
                            Edit
                          </button>
                        }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </section>
      }
      @if (sources.loaded() && !sources.error() && !sources.value().length) {
        <section class="card">
          <div class="empty">
            <strong>No market-data source is registered yet.</strong>
            MT5 broker servers appear here the first time a trusted EA streams from them; register
            an FX venue above to add an external one.
          </div>
        </section>
      } @else if (sources.value().length && !groups().length) {
        <section class="card">
          <div class="empty">
            <strong>No source matches.</strong>
            Clear the search or pick another kind.
          </div>
        </section>
      }

      <section class="card" aria-label="How sources work">
        <header class="card-head"><h3>How sources work</h3></header>
        <div class="card-body how-body">
          <p class="how">
            MT5 broker sources are created by the engine the first time a trusted EA streams from a
            new broker server; which EAs are trusted is the market-data source trust setting, not
            this page. External sources (CME, crypto, stocks, FX venues) are written only by the
            machine ids listed as their writers — a sidecar feed process (compose profiles
            <code>crypto</code>, <code>venues</code>, <code>equities</code>) signs in as that id.
            Enabling a source starts storing what its writers send; who may READ it is the
            entitlements page.
          </p>
          <nav class="links-row" aria-label="Related">
            <a routerLink="/market-data/entitlements">Entitlements (who may read each feed)</a>
            <a routerLink="/market-data/usage">Usage this month</a>
            <a routerLink="/market-data/instrument-candles"
              >Instrument candles (built from these trades)</a
            >
            <a routerLink="/docs/platform-guide">Guide: data sources</a>
          </nav>
        </div>
      </section>
    </div>
  `,
})
export class MarketDataSourcesPageComponent {
  private readonly api = inject(MarketDataSourcesApiService);
  private readonly notify = inject(NotificationService);

  protected readonly when = when;
  protected readonly kind = kindLabel;
  protected readonly ready = readiness;
  protected readonly editable = isEditable;
  protected readonly tone = TONE;

  readonly sources = iamResource<MarketDataSourceAdmin[]>(
    () => this.api.list(),
    [],
    'Could not load the market-data sources.',
  );
  /** Null = the engine has no coverage endpoint yet (404) or the read failed. */
  readonly coverage = iamResource<MarketDataStoreCoverage | null>(
    () => this.api.coverage().pipe(catchError(() => of(null))),
    null,
  );
  readonly showDisabled = signal(false);
  /** View filters (presentation only): source kind tab + free-text search. */
  readonly kindFilter = signal<string>('all');
  readonly query = signal('');
  readonly filtering = computed(() => this.query().trim().length > 0);
  protected readonly stored = storedText;
  readonly today = computed(
    () => this.coverage.value()?.todayUtc ?? new Date().toISOString().slice(0, 10),
  );
  private readonly covById = computed(
    () => new Map((this.coverage.value()?.sources ?? []).map((c) => [c.sourceId, c])),
  );
  readonly grouped = computed(() => {
    const today = this.today();
    const by = new Map<string, MarketDataSourceAdmin[]>();
    for (const s of this.sources.value()) {
      const g = sourceGroup(
        s,
        this.covById().get(s.sourceId),
        today,
        this.coverage.value() !== null,
      );
      by.set(g, [...(by.get(g) ?? []), s]);
    }
    return by;
  });
  readonly kindTabs = computed(() => {
    const n = new Map<string, number>();
    for (const s of this.sources.value()) n.set(s.kind, (n.get(s.kind) ?? 0) + 1);
    return [
      { key: 'all', label: 'All', n: this.sources.value().length },
      ...[...n.entries()].map(([k, c]) => ({ key: k as string, label: kindLabel(k), n: c })),
    ];
  });
  private matches(s: MarketDataSourceAdmin): boolean {
    if (this.kindFilter() !== 'all' && s.kind !== this.kindFilter()) return false;
    const q = this.query().trim().toLowerCase();
    if (!q) return true;
    return [
      s.sourceId,
      s.displayName,
      s.feedId,
      kindLabel(s.kind),
      ...s.writerInstanceIds,
      ...Object.keys(s.symbolMap ?? {}),
    ].some((x) => (x ?? '').toLowerCase().includes(q));
  }
  readonly groups = computed(() =>
    SOURCE_GROUPS.map((g) => ({
      ...g,
      rows: (this.grouped().get(g.group) ?? []).filter((s) => this.matches(s)),
    })).filter((g) => g.rows.length > 0),
  );
  readonly shownCount = computed(() => this.groups().reduce((a, g) => a + g.rows.length, 0));
  readonly counts = computed(() => ({
    receiving: this.grouped().get('receiving')?.length ?? 0,
    waiting: this.grouped().get('waiting')?.length ?? 0,
    stored: this.grouped().get('stored')?.length ?? 0,
    disabled:
      (this.grouped().get('disabled')?.length ?? 0) + (this.grouped().get('off')?.length ?? 0),
    enabled: this.sources.value().filter((x) => x.enabled).length,
  }));
  readonly storedSymbols = computed(() =>
    (this.coverage.value()?.sources ?? []).reduce((a, c) => a + c.symbolCount, 0),
  );
  readonly kindSummary = computed(() => {
    const n = new Map<string, number>();
    for (const s of this.sources.value())
      n.set(kindLabel(s.kind), (n.get(kindLabel(s.kind)) ?? 0) + 1);
    return [...n.entries()].map(([k, v]) => `${v} ${k}`).join(' · ') || 'none';
  });
  readonly disabledSummary = computed(() => {
    const rows = [
      ...(this.grouped().get('disabled') ?? []),
      ...(this.grouped().get('off') ?? []),
    ].filter((s) => this.matches(s));
    const n = new Map<string, string[]>();
    for (const s of rows)
      n.set(kindLabel(s.kind), [...(n.get(kindLabel(s.kind)) ?? []), s.sourceId]);
    return (
      [...n.entries()].map(([k, ids]) => `${k}: ${ids.join(', ')}`).join(' · ') +
      (this.coverage.value()
        ? '. Registered and ready to enable; none has ever stored anything. Show them to edit.'
        : '. Registered and ready to enable. Show them to edit.')
    );
  });
  readonly busy = signal(false);
  readonly editing = signal<EditState | null>(null);
  readonly venue = signal<{
    venueId: string;
    displayName: string;
    symbolMapText: string;
    reason: string;
  } | null>(null);

  readonly editProblems = computed(() => {
    const e = this.editing();
    if (!e) return [];
    const problems: string[] = [];
    const bad = badWriters(parseWriters(e.writersText));
    if (bad.length) problems.push(`Not a machine id: ${bad.join(', ')}`);
    const map = parseSymbolMap(e.symbolMapText);
    if (map.problems.length) problems.push(`Symbol map entries to fix: ${map.problems.join(', ')}`);
    if (!(e.contractSize >= 0)) problems.push('The contract size cannot be negative.');
    if (problems.length === 0 && Object.keys(this.body(e)).length === 0)
      problems.push('Nothing changed yet.');
    return problems;
  });

  readonly venueProblems = computed(() => {
    const v = this.venue();
    if (!v) return [];
    const problems: string[] = [];
    if (!isVenueId(v.venueId.trim()))
      problems.push(
        'The venue id is lowercase letters, digits, dots, dashes or underscores (up to 48).',
      );
    if (!v.displayName.trim()) problems.push('Give the venue a display name.');
    const map = parseSymbolMap(v.symbolMapText);
    if (map.problems.length) problems.push(`Symbol map entries to fix: ${map.problems.join(', ')}`);
    return problems;
  });

  constructor() {
    this.sources.reload();
    this.coverage.reload();
  }

  /** "3 days ago (exact local time)" for a title attribute. */
  protected at(utc: string | null | undefined): string {
    return utc ? `${ago(utc)} (${when(utc)})` : '—';
  }

  /** The 'disabled' / 'off' groups collapse to a one-line summary until shown. */
  isOffGroup(group: string): boolean {
    return group === 'disabled' || group === 'off';
  }

  /** Header dot/count tone of a source group. */
  groupTone(group: string): string {
    return group === 'receiving' || group === 'enabled' ? 'ok' : group === 'waiting' ? 'warn' : '';
  }

  /** readiness() tone → status-dot class ('info' is the neutral grey dot). */
  dotTone(tone: string): string {
    return tone === 'ok' || tone === 'warn' ? tone : '';
  }

  covFor(sourceId: string): StoreCoverageSource | null {
    return this.covById().get(sourceId) ?? null;
  }

  topSymbols(c: StoreCoverageSource): string {
    const names = c.symbols.slice(0, 5).map((x) => x.symbol);
    return (
      names.join(', ') + (c.symbolCount > names.length ? ` +${c.symbolCount - names.length}` : '')
    );
  }

  symbolCount(s: MarketDataSourceAdmin): string {
    const n = Object.keys(s.symbolMap ?? {}).length;
    return n === 0 ? '—' : n <= 4 ? Object.keys(s.symbolMap).join(', ') : `${n} symbols`;
  }
  startEdit(s: MarketDataSourceAdmin): void {
    this.venue.set(null);
    this.editing.set({
      row: s,
      enabled: s.enabled,
      displayName: s.displayName,
      writersText: s.writerInstanceIds.join('\n'),
      symbolMapText: formatSymbolMap(s.symbolMap),
      contractSize: s.contractSize,
      reason: '',
    });
  }

  patchEdit(p: Partial<EditState>): void {
    this.editing.update((e) => (e ? { ...e, ...p } : e));
  }

  startVenue(): void {
    this.editing.set(null);
    this.venue.set({ venueId: '', displayName: '', symbolMapText: '', reason: '' });
  }

  patchVenue(
    p: Partial<{ venueId: string; displayName: string; symbolMapText: string; reason: string }>,
  ): void {
    this.venue.update((v) => (v ? { ...v, ...p } : v));
  }

  private body(e: EditState) {
    return changes(e.row, {
      enabled: e.enabled,
      displayName: e.displayName,
      writers: parseWriters(e.writersText),
      symbolMap: parseSymbolMap(e.symbolMapText).map,
      contractSize: e.contractSize,
    });
  }

  save(): void {
    const e = this.editing();
    if (!e || this.busy() || this.editProblems().length) return;
    this.busy.set(true);
    this.api
      .update(e.row.sourceId, {
        ...this.body(e),
        ...(e.reason.trim() ? { reason: e.reason.trim() } : {}),
      })
      .subscribe({
        next: () => {
          this.busy.set(false);
          this.editing.set(null);
          this.notify.success(`${e.row.sourceId} saved.`);
          this.sources.reload();
        },
        error: (err) => {
          this.busy.set(false);
          if (reportable(err)) this.notify.error(errorText(err, 'The source was not saved.'));
        },
      });
  }

  createVenue(): void {
    const v = this.venue();
    if (!v || this.busy() || this.venueProblems().length) return;
    this.busy.set(true);
    const map = parseSymbolMap(v.symbolMapText).map;
    this.api
      .createVenue({
        venueId: v.venueId.trim(),
        displayName: v.displayName.trim(),
        ...(Object.keys(map).length ? { symbolMap: map } : {}),
        ...(v.reason.trim() ? { reason: v.reason.trim() } : {}),
      })
      .subscribe({
        next: (row) => {
          this.busy.set(false);
          this.venue.set(null);
          this.notify.success(`${row.sourceId} registered (disabled).`);
          this.sources.reload();
        },
        error: (err) => {
          this.busy.set(false);
          if (reportable(err)) this.notify.error(errorText(err, 'The venue was not registered.'));
        },
      });
  }
}
