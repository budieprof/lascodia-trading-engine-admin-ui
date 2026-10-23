import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { NotificationService } from '@core/notifications/notification.service';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { errorText, reportable, when } from '@features/iam/iam.logic';
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
} from '../md-sources.logic';
import type { MarketDataSourceAdmin } from '../md-sources.types';

interface EditState {
  row: MarketDataSourceAdmin;
  enabled: boolean;
  displayName: string;
  writersText: string;
  symbolMapText: string;
  contractSize: number;
  reason: string;
}

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
  imports: [FormsModule, RouterLink, PageHeaderComponent],
  styleUrl: '../../../iam/shared/iam-page.scss',
  styles: [
    `
      textarea.input {
        min-height: 72px;
        font-family: var(--font-mono, monospace);
        font-size: var(--text-xs);
      }
      .chips {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
      }
    `,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Market-data sources"
        subtitle="Every source the engine stores: MT5 broker servers, CME vendor paths and FX venues — who may write each one, and its feed."
      >
        <a class="btn btn-secondary" routerLink="/market-data/entitlements">Entitlements</a>
        <button type="button" class="btn btn-secondary" (click)="startVenue()">
          Register a venue
        </button>
        <button
          type="button"
          class="btn btn-secondary"
          (click)="sources.reload()"
          [disabled]="sources.loading()"
        >
          {{ sources.loading() ? 'Loading…' : 'Refresh' }}
        </button>
      </app-page-header>

      @if (venue(); as v) {
        <section class="card" aria-label="Register an FX venue">
          <header class="card-head"><h3>Register an FX venue</h3></header>
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
              <button
                type="button"
                class="btn btn-secondary"
                data-autofocus
                (click)="venue.set(null)"
              >
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
        <section class="card" aria-label="Edit source">
          <header class="card-head">
            <h3>{{ e.row.sourceId }}</h3>
          </header>
          <form class="card-body" (ngSubmit)="save()">
            @if (e.enabled && !e.row.enabled) {
              <p class="note warn">
                Enabling starts storing this source's data from its writers and shows it to every
                organisation entitled to <code>{{ e.row.feedId }}</code
                >. Check the licence first.
              </p>
            }
            <label class="check">
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
                class="btn btn-secondary"
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

      <section class="card">
        @if (sources.error(); as err) {
          <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
        }
        @if (sources.value().length) {
          <div class="table-wrap">
            <table class="grid">
              <thead>
                <tr>
                  <th>Source</th>
                  <th>Kind</th>
                  <th>Feed</th>
                  <th>State</th>
                  <th>Writers</th>
                  <th>Symbols</th>
                  <th>Updated</th>
                  <th><span class="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                @for (s of sources.value(); track s.sourceId) {
                  <tr>
                    <td>
                      <code>{{ s.sourceId }}</code>
                      <span class="sub">{{ s.displayName }}</span>
                    </td>
                    <td class="small">
                      {{ kind(s.kind) }}
                      <span class="sub"
                        >{{ s.sizeUnit }}{{ s.contractSize ? ' × ' + s.contractSize : ''
                        }}{{ s.priceTransform === 'Invert' ? ' · inverted' : '' }}</span
                      >
                    </td>
                    <td>
                      <code>{{ s.feedId }}</code>
                    </td>
                    <td>
                      <span class="chip" [class]="ready(s).tone">{{ ready(s).text }}</span>
                    </td>
                    <td class="small">
                      @if (s.kind === 'Mt5Broker') {
                        <span class="muted">trusted EAs</span>
                      } @else if (s.writerInstanceIds.length) {
                        <div class="chips">
                          @for (w of s.writerInstanceIds; track w) {
                            <code>{{ w }}</code>
                          }
                        </div>
                      } @else {
                        <span class="muted">none</span>
                      }
                    </td>
                    <td class="small">{{ symbolCount(s) }}</td>
                    <td class="small">{{ when(s.updatedAtUtc) }}</td>
                    <td class="actions">
                      @if (editable(s)) {
                        <button
                          type="button"
                          class="btn btn-sm btn-secondary"
                          (click)="startEdit(s)"
                        >
                          Edit
                        </button>
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        } @else if (sources.loaded() && !sources.error()) {
          <p class="pad muted">No market-data source is registered yet.</p>
        }
        <p class="note">
          MT5 broker sources are created by the engine the first time a trusted EA streams from a
          new broker server; which EAs are trusted is the market-data source trust setting, not this
          page. External sources are written only by the machine ids listed as their writers.
        </p>
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

  readonly sources = iamResource<MarketDataSourceAdmin[]>(
    () => this.api.list(),
    [],
    'Could not load the market-data sources.',
  );
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
