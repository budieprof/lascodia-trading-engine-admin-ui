import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  EventEmitter,
  HostListener,
  Output,
  ViewChild,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { finalize } from 'rxjs';

import { EAAdminService } from '@core/services/ea-admin.service';
import { CurrencyPairsService } from '@core/services/currency-pairs.service';
import { NotificationService } from '@core/notifications/notification.service';
import type {
  CurrencyPairDto,
  EAConfigInputs,
  EAFleetItem,
  UpdateInstanceConfigRequest,
} from '@core/api/api.types';
import { SkeletonComponent } from '@shared/components/ui/skeleton/skeleton.component';
import { EaOpsService } from '../../selfheal/ea-ops.service';
import { EaActionDialogComponent } from '../../selfheal/ea-action-dialog.component';
import { fleetStatusOf } from '../../current-fleet';
import {
  RESTART_BADGED_INPUTS,
  RESTART_INPUTS,
  buildSetInputs,
  isInputEdited,
  validateInputEdit,
  type InputEdit,
  type InputType,
} from '../../selfheal/selfheal.logic';
import {
  BADGE_WORDS,
  HOT_RELOAD_FIELDS,
  HOT_RELOAD_GROUPS,
  MT5_TIMEFRAMES,
  RESTART_HELP,
  RESTART_UNITS,
  formatSymbolMap,
  normalizeTimeframes,
  parseSymbolCsv,
  parseSymbolMap,
  sameSymbolSet,
  validateField,
  type FieldDef,
  type FieldGroup,
  type HotReloadKey,
  type ReloadBadge,
} from './ea-config-fields';
import { EaSymbolPickerComponent, type SymbolOption } from './ea-symbol-picker.component';

/**
 * EA configuration editor (EA detail page). Two tabs:
 *   - **Live settings** — the EA's hot-reloadable settings, grouped by topic.
 *     Every control starts at the EA's current value; changing it marks the
 *     row, Save (or ⏎) pushes that row, "Review & push" pushes them all after
 *     a from → to summary. Symbols are picked from the engine's instruments,
 *     on/off settings are switches, numbers carry their unit.
 *   - **Restart settings** — inputs the EA reads only when it starts, changed
 *     through SetInputs (C3 23): the EA rewrites its chart template and
 *     reloads itself on the new values.
 */
@Component({
  selector: 'app-ea-config-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    NgTemplateOutlet,
    SkeletonComponent,
    EaActionDialogComponent,
    EaSymbolPickerComponent,
  ],
  styleUrl: './ea-config-panel.component.scss',
  template: `
    <section class="panel" aria-label="EA configuration">
      <header class="panel-head">
        <div>
          <h3>Configuration</h3>
          <p class="sub">
            @if (tab() === 'editable') {
              Changes apply to this EA within seconds — no restart.
            } @else {
              Read when the EA starts. Applying restarts the EA (offline for a few seconds).
            }
          </p>
        </div>
        <div class="tabs" role="tablist">
          <button
            type="button"
            role="tab"
            [class.active]="tab() === 'editable'"
            (click)="tab.set('editable')"
            [attr.aria-selected]="tab() === 'editable'"
          >
            Live settings
            <span class="n">{{ HOT_RELOAD_FIELDS.length }}</span>
            @if (dirtyCount() > 0) {
              <span class="n dirty">{{ dirtyCount() }} changed</span>
            }
          </button>
          <button
            type="button"
            role="tab"
            [class.active]="tab() === 'readonly'"
            (click)="tab.set('readonly')"
            [attr.aria-selected]="tab() === 'readonly'"
          >
            Restart settings
            <span class="n">{{ restartFields.length }}</span>
            @if (restartChangeCount() > 0) {
              <span class="n dirty">{{ restartChangeCount() }} changed</span>
            }
          </button>
        </div>
      </header>

      @if (loading() && !inputs()) {
        <div class="skeleton-grid" aria-label="Loading configuration" role="status">
          @for (i of skeletonFields(); track i) {
            <div class="skeleton-field">
              <ui-skeleton height="11px" width="48%" borderRadius="4px" />
              <ui-skeleton height="32px" width="100%" borderRadius="6px" />
            </div>
          }
        </div>
      } @else if (!inputs()) {
        <p class="empty">
          No settings reported yet — the EA sends them with each heartbeat from v8.47.137. Older
          builds only accept the legacy safety values from the "Push safety config" dialog.
        </p>
      } @else if (tab() === 'editable') {
        <!-- ── Toolbar ─────────────────────────────────────────── -->
        <div class="toolbar">
          <div class="search">
            <span class="search-icon" aria-hidden="true">⌕</span>
            <input
              #searchInput
              type="text"
              [placeholder]="'Find a setting…'"
              [ngModel]="searchTerm()"
              (ngModelChange)="searchTerm.set($event)"
              aria-label="Find a setting"
            />
            @if (searchTerm()) {
              <button
                type="button"
                class="search-clear"
                (click)="searchTerm.set('')"
                aria-label="Clear search"
              >
                ✕
              </button>
            } @else {
              <kbd>/</kbd>
            }
          </div>
          <div class="seg" role="tablist" aria-label="Filter by when a change applies">
            @for (b of badgeFilterOptions; track b.value) {
              <button
                type="button"
                role="tab"
                [class.on]="badgeFilter() === b.value"
                [attr.aria-selected]="badgeFilter() === b.value"
                (click)="badgeFilter.set(b.value)"
              >
                {{ b.label }}
              </button>
            }
          </div>
          <label class="pill-toggle" [class.on]="dirtyOnly()">
            <input type="checkbox" [checked]="dirtyOnly()" (change)="dirtyOnly.set(!dirtyOnly())" />
            Changed only
          </label>
          <div class="grow"></div>
          @if (dirtyCount() > 0 || errorCount() > 0) {
            <button
              type="button"
              class="btn btn-quiet"
              (click)="clearEdits()"
              [disabled]="submitting()"
            >
              Discard
            </button>
          }
          <button
            type="button"
            class="btn btn-primary"
            [disabled]="submitting() || !hasDirty() || errorCount() > 0"
            (click)="openReview()"
            [title]="
              errorCount() > 0
                ? 'Fix the highlighted values first'
                : hasDirty()
                  ? 'Review, then push (⌘/Ctrl + S)'
                  : 'Change a setting to enable'
            "
          >
            @if (submitting()) {
              Pushing…
            } @else if (hasDirty()) {
              Review & push {{ dirtyCount() }}
            } @else {
              No changes
            }
          </button>
        </div>

        @if (filteredGroups().length === 0) {
          <p class="empty">
            No settings match.
            <button type="button" class="link-btn" (click)="clearSearch()">Clear filters</button>
          </p>
        } @else {
          <div class="body">
            <nav class="side" aria-label="Sections">
              @for (group of filteredGroups(); track group.title) {
                <button type="button" class="cat" (click)="scrollTo(group.title)">
                  <span class="cat-name">{{ group.title }}</span>
                  @if (groupDirtyCount(group) > 0) {
                    <span class="cat-dirty">{{ groupDirtyCount(group) }}</span>
                  } @else {
                    <span class="cat-count">{{ group.fields.length }}</span>
                  }
                </button>
              }
            </nav>

            <div class="groups">
              @for (group of filteredGroups(); track group.title) {
                <section class="grp" [id]="anchorId(group.title)">
                  <header class="grp-head">
                    <h4>{{ group.title }}</h4>
                    <span>{{ group.blurb }}</span>
                  </header>
                  @for (field of group.fields; track field.key) {
                    <div
                      class="row"
                      [class.dirty]="isDirty(field)"
                      [class.invalid]="!!fieldError(field)"
                      [class.wide]="field.kind === 'symbols'"
                    >
                      <div class="row-text">
                        <div class="row-label">
                          <span class="label">{{ field.label }}</span>
                          @if (field.badge !== 'live') {
                            <span
                              class="when"
                              [attr.data-badge]="field.badge"
                              [title]="badgeTitle(field.badge)"
                              >{{ badgeLabel(field.badge) }}</span
                            >
                          }
                          <span
                            class="info"
                            [title]="field.key + ' — ' + field.takesEffect"
                            aria-hidden="true"
                            >ⓘ</span
                          >
                        </div>
                        <p class="help">{{ field.help }}</p>
                      </div>

                      <div class="row-ctl">
                        @switch (field.kind) {
                          @case ('symbols') {
                            <app-ea-symbol-picker
                              [value]="symbolValue()"
                              [original]="symbolOriginal()"
                              [options]="symbolOptions()"
                              [disabled]="submitting()"
                              (valueChange)="setSymbols($event)"
                            />
                          }
                          @case ('bool') {
                            <button
                              type="button"
                              role="switch"
                              class="switch"
                              [class.on]="boolValue(field)"
                              [attr.aria-checked]="boolValue(field)"
                              [attr.aria-label]="field.label"
                              (click)="setBool(field, !boolValue(field))"
                            >
                              <span class="knob"></span>
                            </button>
                            <span class="switch-text">{{ boolValue(field) ? 'On' : 'Off' }}</span>
                          }
                          @case ('enum') {
                            <div
                              class="seg seg-ctl"
                              role="radiogroup"
                              [attr.aria-label]="field.label"
                            >
                              @for (opt of field.options ?? []; track opt) {
                                <button
                                  type="button"
                                  role="radio"
                                  [class.on]="display(field) === opt"
                                  [attr.aria-checked]="display(field) === opt"
                                  (click)="setChoice(field, opt)"
                                >
                                  {{ opt }}
                                </button>
                              }
                            </div>
                          }
                          @case ('int') {
                            <ng-container
                              *ngTemplateOutlet="numberCtl; context: { $implicit: field }"
                            />
                          }
                          @case ('double') {
                            <ng-container
                              *ngTemplateOutlet="numberCtl; context: { $implicit: field }"
                            />
                          }
                          @default {
                            <input
                              type="text"
                              class="input text"
                              autocomplete="off"
                              spellcheck="false"
                              [class.mono]="field.kind === 'url'"
                              [placeholder]="field.kind === 'url' ? 'https://…' : 'not set'"
                              [ngModel]="display(field)"
                              (ngModelChange)="setEdit(field, $event)"
                              (blur)="onBlur(field)"
                              (keydown)="onFieldKey($event, field)"
                            />
                          }
                        }
                        @if (fieldError(field); as err) {
                          <span class="err">{{ err }}</span>
                        } @else if (isDirty(field) && field.kind !== 'symbols') {
                          <span class="was">
                            was <span class="mono">{{ currentText(field) }}</span>
                            <button type="button" class="link-btn" (click)="revertField(field)">
                              Undo
                            </button>
                          </span>
                        } @else if (!hasCurrent(field)) {
                          <span class="was">This EA build does not report it.</span>
                        }
                      </div>

                      <div class="row-act">
                        @if (isDirty(field)) {
                          <button
                            type="button"
                            class="btn btn-save"
                            [disabled]="submitting()"
                            (click)="saveField(field)"
                            title="Push just this setting (⏎)"
                          >
                            Save
                          </button>
                        }
                      </div>
                    </div>
                  }
                </section>
              }
            </div>
          </div>
        }
      } @else {
        <!-- ── Restart settings ──────────────────────────────── -->
        @if (restartReady() === false) {
          <p class="ro-blocker" role="note">
            Remote restart is not ready on this EA (its chart template is not saved yet), so these
            cannot be applied. Restart the terminal from the Terminal card first — the EA saves its
            template when it starts.
          </p>
        }
        <div class="groups">
          @for (section of restartSections; track section.title) {
            <section class="grp">
              <header class="grp-head">
                <h4>{{ section.title }}</h4>
                <span>{{ section.blurb }}</span>
              </header>
              @for (field of section.fields; track field.key) {
                <div
                  class="row"
                  [class.dirty]="restartDirty(field) && !restartError(field)"
                  [class.invalid]="!!restartError(field)"
                  [class.danger]="field.dangerous"
                  [class.wide]="field.key === 'symbolMapping'"
                >
                  <div class="row-text">
                    <div class="row-label">
                      <span class="label">{{ field.label }}</span>
                      @if (field.dangerous) {
                        <span class="when" data-badge="danger">Careful</span>
                      }
                      <span class="info" [title]="field.inp" aria-hidden="true">ⓘ</span>
                    </div>
                    @if (restartHelp(field.key); as h) {
                      <p class="help">{{ h }}</p>
                    }
                    @if (field.warning && (field.dangerous || restartDirty(field))) {
                      <p class="help warn">{{ field.warning }}</p>
                    }
                  </div>
                  <div class="row-ctl">
                    @if (field.key === 'timeframes') {
                      <div class="tf-grid" role="group" aria-label="Timeframes">
                        @for (tf of MT5_TIMEFRAMES; track tf) {
                          <button
                            type="button"
                            class="tf"
                            [class.on]="timeframeOn(tf)"
                            [attr.aria-pressed]="timeframeOn(tf)"
                            [disabled]="applyingInputs()"
                            (click)="toggleTimeframe(field, tf)"
                          >
                            {{ tf }}
                          </button>
                        }
                      </div>
                    } @else if (field.key === 'symbolMapping') {
                      <div class="map">
                        @for (r of mapRows(); track $index; let i = $index) {
                          <div class="map-row">
                            <input
                              type="text"
                              class="input mono"
                              placeholder="Broker name, e.g. EURUSDm"
                              spellcheck="false"
                              autocomplete="off"
                              [ngModel]="r.broker"
                              (ngModelChange)="setMapRow(field, i, 'broker', $event)"
                              [disabled]="applyingInputs()"
                              aria-label="Broker symbol"
                            />
                            <span class="arrow" aria-hidden="true">→</span>
                            <select
                              class="input mono"
                              [ngModel]="r.engine"
                              (ngModelChange)="setMapRow(field, i, 'engine', $event)"
                              [disabled]="applyingInputs()"
                              aria-label="Engine symbol"
                            >
                              <option value="">Engine symbol…</option>
                              @for (s of mapEngineOptions(r.engine); track s) {
                                <option [value]="s">{{ s }}</option>
                              }
                            </select>
                            <button
                              type="button"
                              class="icon-btn"
                              (click)="removeMapRow(field, i)"
                              [disabled]="applyingInputs()"
                              aria-label="Remove mapping"
                            >
                              ×
                            </button>
                          </div>
                        }
                        <button
                          type="button"
                          class="link-btn add-map"
                          (click)="addMapRow()"
                          [disabled]="applyingInputs()"
                        >
                          + Add a mapping
                        </button>
                      </div>
                    } @else if (field.type === 'b') {
                      <button
                        type="button"
                        role="switch"
                        class="switch"
                        [class.on]="restartBool(field)"
                        [attr.aria-checked]="restartBool(field)"
                        [attr.aria-label]="field.label"
                        [disabled]="applyingInputs()"
                        (click)="setRestartBool(field, !restartBool(field))"
                      >
                        <span class="knob"></span>
                      </button>
                      <span class="switch-text">{{ restartBool(field) ? 'On' : 'Off' }}</span>
                    } @else {
                      <div class="num">
                        <input
                          type="text"
                          class="input"
                          [class.text]="field.type === 's'"
                          [class.mono]="field.type === 's'"
                          [attr.inputmode]="field.type === 's' ? null : 'decimal'"
                          autocomplete="off"
                          spellcheck="false"
                          placeholder="not set"
                          [ngModel]="restartDisplay(field)"
                          (ngModelChange)="setRestartRaw(field, $event)"
                          (blur)="onRestartBlur(field)"
                          [disabled]="applyingInputs()"
                        />
                        @if (restartUnit(field.key); as u) {
                          <span class="unit">{{ u }}</span>
                        }
                      </div>
                    }
                    @if (restartError(field); as err) {
                      <span class="err">{{ err }}</span>
                    } @else if (restartDirty(field)) {
                      <span class="was">
                        was <span class="mono">{{ restartCurrentText(field) }}</span>
                        <button type="button" class="link-btn" (click)="revertRestart(field)">
                          Undo
                        </button>
                      </span>
                    }
                  </div>
                  <div class="row-act"></div>
                </div>
              }
            </section>
          }
        </div>
        <div class="ro-foot">
          <span class="muted">
            @if (restartChangeCount() === 0) {
              No changes.
            } @else {
              {{ restartChangeCount() }} change{{ restartChangeCount() === 1 ? '' : 's' }} ready.
            }
          </span>
          <button
            type="button"
            class="btn btn-quiet"
            (click)="clearRestartEdits()"
            [disabled]="restartChangeCount() === 0 || applyingInputs()"
          >
            Discard
          </button>
          <button
            type="button"
            class="btn btn-primary"
            (click)="askApplyInputs()"
            [disabled]="
              restartChangeCount() === 0 ||
              restartHasErrors() ||
              applyingInputs() ||
              restartReady() === false
            "
          >
            Apply &amp; restart
          </button>
        </div>
      }
    </section>

    <ng-template #numberCtl let-field>
      <div class="num">
        <button
          type="button"
          class="stp"
          (click)="step(field, -1)"
          [attr.aria-label]="'Decrease ' + field.label"
          tabindex="-1"
        >
          −
        </button>
        <input
          type="text"
          inputmode="decimal"
          class="input"
          autocomplete="off"
          [placeholder]="hasCurrent(field) ? '' : 'not reported'"
          [ngModel]="display(field)"
          (ngModelChange)="setEdit(field, $event)"
          (blur)="onBlur(field)"
          (keydown)="onFieldKey($event, field)"
          [attr.aria-label]="field.label"
        />
        <button
          type="button"
          class="stp"
          (click)="step(field, 1)"
          [attr.aria-label]="'Increase ' + field.label"
          tabindex="-1"
        >
          +
        </button>
        @if (field.unit) {
          <span class="unit">{{ field.unit }}</span>
        }
        @if (field.zeroMeans && isZero(field)) {
          <span class="zero">{{ field.zeroMeans }}</span>
        }
      </div>
    </ng-template>

    <!-- Review before a bulk push -->
    <app-ea-action-dialog
      [open]="reviewing()"
      [title]="'Push ' + dirtyCount() + ' change' + (dirtyCount() === 1 ? '' : 's') + ' to this EA'"
      description="The EA applies these within a few seconds. Settings marked “after restart” are stored now and used the next time the EA starts."
      confirmLabel="Push changes"
      tone="ok"
      [askReason]="false"
      [busy]="submitting()"
      (confirmed)="submit()"
      (cancelled)="reviewing.set(false)"
    >
      <ul class="change-list">
        @for (c of reviewChanges(); track c.key) {
          <li>
            <span class="cl-label">{{ c.label }}</span>
            <span class="cl-diff">
              <span class="mono from">{{ c.from }}</span> → <strong class="mono">{{ c.to }}</strong>
            </span>
          </li>
        }
      </ul>
    </app-ea-action-dialog>

    <app-ea-action-dialog
      [open]="confirmingInputs()"
      title="Apply settings and restart the EA"
      description="The EA saves these values into its chart template and reloads itself on them. It is offline for a few seconds; open positions keep their stop loss and take profit.

If a value stops the EA from starting, its health card shows why and the old values can be applied again from here — unless the EA can no longer reach the engine (a wrong engine address)."
      [warning]="dangerWarning()"
      confirmLabel="Apply &amp; restart"
      [tone]="dangerWarning() ? 'bad' : 'warn'"
      [askReason]="true"
      [reasonRequired]="!!dangerWarning()"
      [busy]="applyingInputs()"
      [confirmDisabled]="!!dangerWarning() && !dangerAck"
      (confirmed)="applyInputs($event)"
      (cancelled)="confirmingInputs.set(false)"
    >
      <ul class="change-list">
        @for (c of pendingChanges(); track c.key) {
          <li>
            <span class="cl-label">{{ c.label }}</span>
            <span class="cl-diff">
              <span class="mono from">{{ c.from }}</span> → <strong class="mono">{{ c.to }}</strong>
            </span>
          </li>
        }
      </ul>
      @if (dangerWarning()) {
        <label class="ack">
          <input type="checkbox" [(ngModel)]="dangerAck" />
          <span>I understand what changing these does.</span>
        </label>
      }
    </app-ea-action-dialog>
  `,
})
export class EAConfigPanelComponent {
  readonly instanceId = input.required<string>();
  readonly inputs = input<EAConfigInputs | null>(null);
  /** True while the parent detail resource is still loading for the first time. */
  readonly loading = input(false);
  @Output() readonly configPushed = new EventEmitter<void>();
  /** C1 `diag.restartTemplateSeeded`: false = SetInputs cannot work; null = not reported. */
  readonly restartReady = input<boolean | null>(null);

  /** Follows the command each push / input change queues (provided by the EA detail page). */
  private readonly ops = inject(EaOpsService, { optional: true });
  private readonly admin = inject(EAAdminService);
  private readonly pairsApi = inject(CurrencyPairsService);
  private readonly notify = inject(NotificationService);
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected readonly skeletonFields = computed(() => Array.from({ length: 6 }, (_, i) => i));

  protected readonly HOT_RELOAD_FIELDS = HOT_RELOAD_FIELDS;
  protected readonly MT5_TIMEFRAMES = MT5_TIMEFRAMES;

  /**
   * Per-key edits. Numbers and text hold the raw typed string (so "" while
   * typing doesn't snap back), switches a boolean, symbols a CSV. A key is
   * only present while it differs from the EA's value or is being typed.
   */
  protected edits: Partial<Record<HotReloadKey, string | boolean>> = {};
  protected readonly tab = signal<'editable' | 'readonly'>('editable');
  protected readonly submitting = signal(false);
  protected readonly reviewing = signal(false);

  protected readonly searchTerm = signal('');
  protected readonly badgeFilter = signal<'all' | ReloadBadge>('all');
  protected readonly dirtyOnly = signal(false);
  /** Ticks on every edit: `edits` is a plain object, so computeds read this to recompute. */
  private readonly dirtyRevision = signal(0);

  @ViewChild('searchInput') private searchInput?: ElementRef<HTMLInputElement>;

  protected readonly badgeFilterOptions: ReadonlyArray<{
    label: string;
    value: 'all' | ReloadBadge;
  }> = [
    { label: 'All', value: 'all' },
    { label: 'Instant', value: 'live' },
    { label: 'Next backfill', value: 'next-job' },
    { label: 'After restart', value: 'restart' },
  ];

  // ── Symbol catalogue + sibling ownership ─────────────────────────────

  private readonly pairs = signal<CurrencyPairDto[]>([]);
  private readonly fleet = signal<EAFleetItem[]>([]);

  constructor() {
    this.pairsApi.list({ currentPage: 1, itemCountPerPage: 500, filter: null }).subscribe({
      next: (res) => this.pairs.set((res.data?.data ?? []).filter((p) => p.isActive && !!p.symbol)),
      error: () => this.pairs.set([]),
    });
    this.admin.listFleet().subscribe({
      next: (res) => this.fleet.set(res.data ?? []),
      error: () => this.fleet.set([]),
    });
  }

  /** Engine instruments, grouped by asset class, with symbols other live EAs on this account own. */
  protected readonly symbolOptions = computed<SymbolOption[]>(() => {
    const me = this.instanceId();
    const fleet = this.fleet();
    const mine = fleet.find((f) => f.instanceId === me);
    const now = Date.now();
    const owner = new Map<string, string>();
    if (mine) {
      for (const f of fleet) {
        if (f.instanceId === me || f.tradingAccountId !== mine.tradingAccountId) continue;
        if (f.deregisteredAt || fleetStatusOf(f, now) !== 'Active') continue;
        for (const s of parseSymbolCsv(f.symbols)) if (!owner.has(s)) owner.set(s, f.instanceId);
      }
    }
    return this.pairs().map((p) => {
      const g = assetGroup(p.assetClass);
      const symbol = (p.symbol ?? '').toUpperCase();
      return { symbol, group: g.label, groupRank: g.rank, takenBy: owner.get(symbol) ?? null };
    });
  });

  protected readonly symbolOriginal = computed(() =>
    parseSymbolCsv(this.inputs()?.['symbols'] as string),
  );
  protected symbolValue(): string[] {
    this.dirtyRevision();
    const e = this.edits.symbols;
    return typeof e === 'string' ? parseSymbolCsv(e) : this.symbolOriginal();
  }
  protected setSymbols(list: string[]): void {
    if (sameSymbolSet(list, this.symbolOriginal())) delete this.edits.symbols;
    else this.edits.symbols = list.join(',');
    this.markEdited();
  }

  // ── Values ───────────────────────────────────────────────────────────

  private current(f: FieldDef): unknown {
    return this.inputs()?.[f.key];
  }

  protected hasCurrent(f: FieldDef): boolean {
    return this.current(f) != null;
  }

  protected currentText(f: FieldDef): string {
    return this.fmt(f, this.current(f));
  }

  /** What the control shows: the pending edit, else the EA's value. */
  protected display(f: FieldDef): string {
    this.dirtyRevision();
    const e = this.edits[f.key];
    if (e !== undefined && typeof e !== 'boolean') return e;
    const c = this.current(f);
    return c == null ? '' : String(c);
  }

  protected boolValue(f: FieldDef): boolean {
    this.dirtyRevision();
    const e = this.edits[f.key];
    return typeof e === 'boolean' ? e : this.current(f) === true;
  }

  protected isZero(f: FieldDef): boolean {
    const v = this.display(f).trim();
    return v !== '' && Number(v) === 0;
  }

  protected setEdit(f: FieldDef, value: string): void {
    this.edits[f.key] = value ?? '';
    if (!this.changed(f) && value !== '') delete this.edits[f.key];
    this.markEdited();
  }

  protected setBool(f: FieldDef, v: boolean): void {
    if (v === (this.current(f) === true)) delete this.edits[f.key];
    else this.edits[f.key] = v;
    this.markEdited();
  }

  protected setChoice(f: FieldDef, v: string): void {
    if (v === String(this.current(f) ?? '')) delete this.edits[f.key];
    else this.edits[f.key] = v;
    this.markEdited();
  }

  /** Leaving a field empty means "keep the EA's value". */
  protected onBlur(f: FieldDef): void {
    const e = this.edits[f.key];
    if (typeof e === 'string' && (e.trim() === '' || !this.changed(f))) {
      delete this.edits[f.key];
      this.markEdited();
    }
  }

  protected step(f: FieldDef, dir: 1 | -1): void {
    const step = f.step ?? 1;
    const base = Number(this.display(f));
    const start = Number.isFinite(base) ? base : 0;
    const decimals = (String(step).split('.')[1] ?? '').length;
    let next = Math.round((start + dir * step) * 10 ** decimals) / 10 ** decimals;
    if (f.min !== undefined) next = Math.max(f.min, next);
    if (f.max !== undefined) next = Math.min(f.max, next);
    this.setEdit(f, String(next));
  }

  /** Differs from the EA's current value (valid or not). */
  private changed(f: FieldDef): boolean {
    const raw = this.edits[f.key];
    if (raw === undefined || raw === '') return false;
    const cur = this.current(f);
    switch (f.kind) {
      case 'bool':
        return raw !== (cur === true);
      case 'symbols':
        return !sameSymbolSet(parseSymbolCsv(String(raw)), parseSymbolCsv(cur as string));
      case 'int':
      case 'double': {
        const n = Number(String(raw).trim());
        return !(Number.isFinite(n) && n === cur);
      }
      default:
        return String(raw).trim() !== String(cur ?? '');
    }
  }

  protected fieldError(f: FieldDef): string | null {
    this.dirtyRevision();
    return this.changed(f) ? validateField(f, this.edits[f.key]) : null;
  }

  protected isDirty(f: FieldDef): boolean {
    this.dirtyRevision();
    return this.changed(f) && this.fieldError(f) === null;
  }

  protected readonly dirtyCount = computed(() => {
    this.dirtyRevision();
    this.inputs();
    return HOT_RELOAD_FIELDS.filter((f) => this.isDirty(f)).length;
  });
  protected readonly errorCount = computed(() => {
    this.dirtyRevision();
    this.inputs();
    return HOT_RELOAD_FIELDS.filter((f) => this.fieldError(f) !== null).length;
  });
  protected hasDirty(): boolean {
    return this.dirtyCount() > 0;
  }

  private fmt(f: FieldDef, v: unknown): string {
    if (v == null || v === '') return f.kind === 'url' || f.kind === 'string' ? '(blank)' : '—';
    if (f.kind === 'bool') return v ? 'On' : 'Off';
    if (f.kind === 'symbols') return parseSymbolCsv(String(v)).join(', ');
    const s = String(v).trim();
    return f.unit && (f.kind === 'int' || f.kind === 'double') ? `${s} ${f.unit}` : s;
  }

  protected readonly reviewChanges = computed(() => {
    this.dirtyRevision();
    return HOT_RELOAD_FIELDS.filter((f) => this.isDirty(f)).map((f) => {
      if (f.kind === 'symbols') {
        const before = this.symbolOriginal();
        const after = parseSymbolCsv(String(this.edits.symbols));
        const added = after.filter((s) => !before.includes(s));
        const removed = before.filter((s) => !after.includes(s));
        const to = [...added.map((s) => `+${s}`), ...removed.map((s) => `−${s}`)].join(' ');
        return { key: f.key, label: f.label, from: `${before.length} symbols`, to };
      }
      return {
        key: f.key,
        label: f.label,
        from: this.currentText(f),
        to: this.fmt(f, this.edits[f.key]),
      };
    });
  });

  protected markEdited(): void {
    this.dirtyRevision.update((n) => n + 1);
    this.cdr.markForCheck();
  }

  protected revertField(f: FieldDef): void {
    delete this.edits[f.key];
    this.markEdited();
  }

  protected clearEdits(): void {
    this.edits = {};
    this.markEdited();
  }

  // ── Search / filter ──────────────────────────────────────────────────

  private fieldMatches(f: FieldDef): boolean {
    const q = this.searchTerm().trim().toLowerCase();
    if (q && !`${f.label} ${f.help} ${f.key}`.toLowerCase().includes(q)) return false;
    const bf = this.badgeFilter();
    if (bf !== 'all' && f.badge !== bf) return false;
    if (this.dirtyOnly() && !this.changed(f)) return false;
    return true;
  }

  protected readonly filteredGroups = computed<FieldGroup[]>(() => {
    this.dirtyRevision();
    this.searchTerm();
    this.badgeFilter();
    this.dirtyOnly();
    this.inputs();
    const out: FieldGroup[] = [];
    for (const g of HOT_RELOAD_GROUPS) {
      const fields = g.fields.filter((f) => this.fieldMatches(f));
      if (fields.length > 0) out.push({ ...g, fields });
    }
    return out;
  });

  protected groupDirtyCount(group: FieldGroup): number {
    this.dirtyRevision();
    return group.fields.filter((f) => this.changed(f)).length;
  }

  protected badgeLabel(b: ReloadBadge): string {
    return BADGE_WORDS[b].label;
  }
  protected badgeTitle(b: ReloadBadge): string {
    return BADGE_WORDS[b].title;
  }

  protected anchorId(title: string): string {
    return 'cfg-' + title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  }

  protected scrollTo(title: string): void {
    const el = this.host.nativeElement.querySelector('#' + this.anchorId(title));
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  protected clearSearch(): void {
    this.searchTerm.set('');
    this.badgeFilter.set('all');
    this.dirtyOnly.set(false);
  }

  // ── Keyboard ─────────────────────────────────────────────────────────

  /** `/` focuses the search; ⌘S / Ctrl+S opens the review when there are changes. */
  @HostListener('document:keydown', ['$event'])
  onKey(ev: KeyboardEvent): void {
    if ((ev.metaKey || ev.ctrlKey) && (ev.key === 's' || ev.key === 'S')) {
      if (this.tab() === 'editable' && this.hasDirty() && !this.submitting()) {
        ev.preventDefault();
        this.openReview();
      }
      return;
    }
    const target = ev.target as HTMLElement | null;
    const inEditable =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      (target?.isContentEditable ?? false);
    if (ev.key === '/' && !inEditable && this.tab() === 'editable') {
      ev.preventDefault();
      this.searchInput?.nativeElement.focus();
      this.searchInput?.nativeElement.select();
    }
  }

  /** ⏎ saves the row, Esc reverts it. */
  protected onFieldKey(ev: KeyboardEvent, f: FieldDef): void {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      if (this.isDirty(f)) this.saveField(f);
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      this.revertField(f);
      (ev.target as HTMLElement).blur();
    } else if (ev.key === 'ArrowUp' && (f.kind === 'int' || f.kind === 'double')) {
      ev.preventDefault();
      this.step(f, 1);
    } else if (ev.key === 'ArrowDown' && (f.kind === 'int' || f.kind === 'double')) {
      ev.preventDefault();
      this.step(f, -1);
    }
  }

  // ── Push ─────────────────────────────────────────────────────────────

  protected openReview(): void {
    if (!this.hasDirty() || this.errorCount() > 0) return;
    this.reviewing.set(true);
  }

  private packField(body: UpdateInstanceConfigRequest, f: FieldDef): void {
    const raw = this.edits[f.key];
    let value: number | string | boolean;
    if (f.kind === 'bool') value = raw as boolean;
    else if (f.kind === 'symbols') value = parseSymbolCsv(String(raw)).join(',');
    else if (f.kind === 'int' || f.kind === 'double') value = Number(String(raw).trim());
    else value = String(raw).trim();
    (body as Record<string, number | string | boolean>)[f.key] = value;
  }

  protected submit(): void {
    if (!this.hasDirty() || this.errorCount() > 0) return;
    // The server DTO marks `instanceId` required, so it is echoed in the body too.
    const body: UpdateInstanceConfigRequest = { instanceId: this.instanceId() };
    const fields = HOT_RELOAD_FIELDS.filter((f) => this.isDirty(f));
    for (const f of fields) this.packField(body, f);
    this.pushBody(body, fields);
  }

  protected saveField(f: FieldDef): void {
    if (!this.isDirty(f) || this.submitting()) return;
    const body: UpdateInstanceConfigRequest = { instanceId: this.instanceId() };
    this.packField(body, f);
    this.pushBody(body, [f]);
  }

  private pushBody(body: UpdateInstanceConfigRequest, fields: FieldDef[]): void {
    this.submitting.set(true);
    this.admin
      .updateInstanceConfig(this.instanceId(), body)
      .pipe(
        finalize(() => {
          this.submitting.set(false);
          this.cdr.markForCheck();
        }),
      )
      .subscribe({
        next: (res) => {
          if (res.status) {
            const label = fields.length === 1 ? fields[0].label : `${fields.length} settings`;
            if (this.ops) {
              this.ops.trackLatestCommand(
                this.instanceId(),
                'UpdateConfig',
                `Config change: ${label}`,
              );
              this.notify.info(`${label} sent — waiting for the EA's answer.`);
            } else {
              this.notify.success(`${label} queued.`);
            }
            for (const f of fields) delete this.edits[f.key];
            this.reviewing.set(false);
            this.markEdited();
            this.configPushed.emit();
          } else {
            this.notify.error(res.message ?? 'Config push failed.');
          }
        },
        error: () => this.notify.error('Config push failed.'),
      });
  }

  // ── Restart settings (C3 SetInputs) ──────────────────────────────────

  protected readonly restartSections: readonly {
    title: string;
    blurb: string;
    fields: readonly RestartField[];
  }[] = [
    {
      title: 'Read when the EA starts',
      blurb: 'Connection, identity and order transport.',
      fields: RESTART_INPUTS.map((d) => ({ ...d })),
    },
    {
      title: 'Also take effect only after a restart',
      blurb: 'The same as on Live settings, applied with an immediate restart.',
      fields: Object.entries(RESTART_BADGED_INPUTS).map(([key, v]) => ({
        key,
        inp: v.inp,
        type: v.type,
        label: HOT_RELOAD_FIELDS.find((f) => f.key === key)?.label ?? key,
      })),
    },
  ];
  protected readonly restartFields: readonly RestartField[] = this.restartSections.flatMap(
    (s) => s.fields,
  );

  protected restartEdits: Record<string, InputEdit> = {};
  private readonly restartRevision = signal(0);
  protected readonly confirmingInputs = signal(false);
  protected readonly applyingInputs = signal(false);
  protected dangerAck = false;
  /** Rows of the symbol-map editor while it is being edited (null = mirror the EA's value). */
  private readonly mapDraft = signal<{ broker: string; engine: string }[] | null>(null);

  protected restartHelp(key: string): string | null {
    return RESTART_HELP[key] ?? null;
  }
  protected restartUnit(key: string): string | null {
    return RESTART_UNITS[key] ?? null;
  }

  private restartCurrent(field: RestartField): unknown {
    return this.inputs()?.[field.key];
  }

  protected restartCurrentText(field: RestartField): string {
    const v = this.restartCurrent(field);
    if (v == null || v === '') return '(blank)';
    if (typeof v === 'boolean') return v ? 'On' : 'Off';
    return String(v);
  }

  protected restartDisplay(field: RestartField): string {
    this.restartRevision();
    const e = this.restartEdits[field.key];
    if (e !== undefined && e !== null && typeof e !== 'boolean') return String(e);
    const c = this.restartCurrent(field);
    return c == null ? '' : String(c);
  }

  protected restartBool(field: RestartField): boolean {
    this.restartRevision();
    const e = this.restartEdits[field.key];
    return typeof e === 'boolean' ? e : this.restartCurrent(field) === true;
  }

  private bumpRestart(): void {
    this.restartRevision.update((n) => n + 1);
    this.cdr.markForCheck();
  }

  protected setRestartBool(field: RestartField, v: boolean): void {
    if (v === (this.restartCurrent(field) === true)) delete this.restartEdits[field.key];
    else this.restartEdits[field.key] = v;
    this.bumpRestart();
  }

  /** Stores what was typed; drops the edit when it matches the EA's value again. */
  protected setRestartRaw(field: RestartField, v: string): void {
    const cur = this.restartCurrent(field);
    const same =
      field.type === 's' ? v === String(cur ?? '') : v.trim() !== '' && Number(v.trim()) === cur;
    if (same) delete this.restartEdits[field.key];
    else this.restartEdits[field.key] = v;
    this.bumpRestart();
  }

  protected onRestartBlur(field: RestartField): void {
    if (field.type !== 's' && String(this.restartEdits[field.key] ?? '').trim() === '') {
      delete this.restartEdits[field.key];
      this.bumpRestart();
    }
  }

  protected revertRestart(field: RestartField): void {
    delete this.restartEdits[field.key];
    if (field.key === 'symbolMapping') this.mapDraft.set(null);
    this.bumpRestart();
  }

  // Timeframes
  protected timeframeOn(tf: string): boolean {
    const f = this.restartFields.find((x) => x.key === 'timeframes');
    return !!f && normalizeTimeframes(this.restartDisplay(f)).includes(tf);
  }
  protected toggleTimeframe(field: RestartField, tf: string): void {
    const set = new Set(normalizeTimeframes(this.restartDisplay(field)));
    if (set.has(tf)) set.delete(tf);
    else set.add(tf);
    const next = MT5_TIMEFRAMES.filter((t) => set.has(t)).join(',');
    const cur = normalizeTimeframes(String(this.restartCurrent(field) ?? '')).join(',');
    if (next === cur) delete this.restartEdits[field.key];
    else this.restartEdits[field.key] = next;
    this.bumpRestart();
  }

  // Symbol map
  protected mapRows(): { broker: string; engine: string }[] {
    this.restartRevision();
    return this.mapDraft() ?? parseSymbolMap(String(this.inputs()?.['symbolMapping'] ?? ''));
  }
  protected mapEngineOptions(selected: string): string[] {
    const list = this.pairs()
      .map((p) => (p.symbol ?? '').toUpperCase())
      .sort();
    return selected && !list.includes(selected) ? [selected, ...list] : list;
  }
  private commitMap(field: RestartField, rows: { broker: string; engine: string }[]): void {
    this.mapDraft.set(rows);
    const next = formatSymbolMap(rows);
    const cur = formatSymbolMap(parseSymbolMap(String(this.restartCurrent(field) ?? '')));
    if (next === cur) delete this.restartEdits[field.key];
    else this.restartEdits[field.key] = next;
    this.bumpRestart();
  }
  protected setMapRow(field: RestartField, i: number, side: 'broker' | 'engine', v: string): void {
    const rows = this.mapRows().map((r) => ({ ...r }));
    rows[i] = { ...rows[i], [side]: side === 'engine' ? v.toUpperCase() : v };
    this.commitMap(field, rows);
  }
  protected removeMapRow(field: RestartField, i: number): void {
    this.commitMap(
      field,
      this.mapRows().filter((_, j) => j !== i),
    );
  }
  protected addMapRow(): void {
    this.mapDraft.set([...this.mapRows(), { broker: '', engine: '' }]);
    this.bumpRestart();
  }

  protected clearRestartEdits(): void {
    this.restartEdits = {};
    this.mapDraft.set(null);
    this.bumpRestart();
  }

  protected restartDirty(field: RestartField): boolean {
    this.restartRevision();
    return isInputEdited(field, this.restartEdits[field.key], this.restartCurrent(field));
  }

  /** Checks beyond the type check: a usable engine address, at least one timeframe, complete map rows. */
  private extraRestartError(field: RestartField, edit: InputEdit): string | null {
    if (field.key === 'engineBaseUrl') {
      if (String(edit ?? '').trim() === '') return 'Enter the engine address.';
      return validateField(
        { key: 'engineBaseUrl', kind: 'url', label: '', help: '', badge: 'live', takesEffect: '' },
        edit,
      );
    }
    if (field.key === 'telemetryEndpoint' && String(edit ?? '').trim() !== '') {
      return validateField(
        {
          key: 'telemetryEndpoint',
          kind: 'url',
          label: '',
          help: '',
          badge: 'restart',
          takesEffect: '',
        },
        edit,
      );
    }
    if (field.key === 'timeframes' && normalizeTimeframes(String(edit ?? '')).length === 0)
      return 'Pick at least one timeframe.';
    if (field.key === 'symbolMapping') {
      const rows = this.mapDraft() ?? [];
      if (rows.some((r) => !!r.broker.trim() !== !!r.engine.trim()))
        return 'Each mapping needs both a broker name and an engine symbol.';
      const brokers = rows.map((r) => r.broker.trim()).filter(Boolean);
      if (new Set(brokers).size !== brokers.length) return 'A broker name is mapped twice.';
    }
    return null;
  }

  protected restartError(field: RestartField): string | null {
    this.restartRevision();
    if (!this.restartDirty(field)) return null;
    const edit = this.restartEdits[field.key];
    return validateInputEdit(field, edit) ?? this.extraRestartError(field, edit);
  }

  private readonly restartBuild = computed(() => {
    this.restartRevision();
    return buildSetInputs(
      this.restartFields.map((f) => ({ key: f.key, inp: f.inp, label: f.label, type: f.type })),
      this.restartEdits,
      (this.inputs() ?? null) as Record<string, unknown> | null,
    );
  });
  private readonly restartExtraErrors = computed(() => {
    this.restartRevision();
    return this.restartFields.filter(
      (f) => this.restartDirty(f) && this.extraRestartError(f, this.restartEdits[f.key]) !== null,
    ).length;
  });
  protected readonly restartChangeCount = computed(
    () => this.restartBuild().changed.length + Object.keys(this.restartBuild().errors).length,
  );
  protected readonly restartHasErrors = computed(
    () => Object.keys(this.restartBuild().errors).length > 0 || this.restartExtraErrors() > 0,
  );

  protected readonly pendingChanges = computed(() => {
    const b = this.restartBuild();
    return b.changed.map((key) => {
      const f = this.restartFields.find((x) => x.key === key)!;
      const edit = this.restartEdits[key];
      const fmt = (v: unknown) =>
        v == null || v === '' ? '(blank)' : typeof v === 'boolean' ? (v ? 'On' : 'Off') : String(v);
      return { key, label: f.label, from: fmt(this.inputs()?.[key]), to: fmt(edit) };
    });
  });

  protected readonly dangerWarning = computed(() => {
    const keys = new Set(this.restartBuild().changed);
    const dangerous = this.restartFields.filter((f) => f.dangerous && keys.has(f.key));
    return dangerous.length ? dangerous.map((f) => `${f.label}: ${f.warning}`).join(' ') : null;
  });

  protected askApplyInputs(): void {
    if (this.restartChangeCount() === 0 || this.restartHasErrors()) return;
    this.dangerAck = false;
    this.confirmingInputs.set(true);
  }

  protected applyInputs(reason: string): void {
    const { inputs, changed, errors } = this.restartBuild();
    if (changed.length === 0 || Object.keys(errors).length > 0 || this.restartExtraErrors() > 0)
      return;
    if (this.dangerWarning() && !this.dangerAck) return;
    const id = this.instanceId();
    this.applyingInputs.set(true);
    this.admin
      .setInputs(id, { inputs, reason: reason || null })
      .pipe(
        finalize(() => {
          this.applyingInputs.set(false);
          this.cdr.markForCheck();
        }),
      )
      .subscribe({
        next: (res) => {
          if (res.status && res.data) {
            if (this.ops) {
              this.ops.trackCommand(
                id,
                res.data.commandId,
                `Change ${changed.length} input${changed.length === 1 ? '' : 's'} + restart`,
              );
              this.notify.info(
                'Input change sent — the EA answers, then restarts on the new values.',
              );
            } else {
              this.notify.success(`Input change queued (command #${res.data.commandId}).`);
            }
            this.confirmingInputs.set(false);
            this.clearRestartEdits();
            this.configPushed.emit();
          } else {
            this.notify.error(res.message ?? 'The engine refused the input change.');
          }
        },
        error: (err: { error?: { message?: string } }) =>
          this.notify.error(err?.error?.message ?? 'Input change could not be sent.'),
      });
  }
}

interface RestartField {
  key: string;
  inp: string;
  label: string;
  type: InputType;
  warning?: string;
  dangerous?: boolean;
}

function assetGroup(cls: string | null | undefined): { label: string; rank: number } {
  switch (cls) {
    case 'FxMajor':
      return { label: 'FX majors', rank: 0 };
    case 'FxMinor':
      return { label: 'FX crosses', rank: 1 };
    case 'FxExotic':
      return { label: 'FX exotics', rank: 2 };
    case 'Index':
      return { label: 'Indices', rank: 3 };
    case 'Commodity':
      return { label: 'Commodities', rank: 4 };
    case 'Crypto':
      return { label: 'Crypto', rank: 5 };
    default:
      return { label: 'Other', rank: 9 };
  }
}
