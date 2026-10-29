import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { LscCanDirective } from '@core/auth/can.directive';
import { Permission } from '@core/auth/permissions.generated';
import { NotificationService } from '@core/notifications/notification.service';
import { errorText, reportable, when } from '@features/iam/iam.logic';
import {
  FeatureStateComponent,
  type FeatureRequirement,
} from '@shared/components/feedback/feature-state.component';
import { DealingApiService } from '../dealing-api.service';
import { DealingFiltersStore } from '../dealing-filters.store';
import { feedProblems, isModuleNotInPlan, parseWriters } from '../dealing.logic';
import type { DealingFeed } from '../dealing.types';

interface FeedForm {
  create: boolean;
  feedId: string;
  displayName: string;
  serverName: string;
  writersText: string;
  priceSourceId: string;
  enabled: boolean;
}

/**
 * The organisation's client-trade feeds: one per MT5 trade server, with the gateway identities (daemon machine
 * credentials) allowed to post it and the market-data source its fills are marked out against. Changes need
 * `dealing.manage` and are audited by the engine. The gateway itself: engine `docs/runbooks/dealing-gateway.md` (its
 * MetaQuotes Manager API connection is a documented skeleton until the broker wires MetaQuotes' SDK).
 */
@Component({
  selector: 'app-dealing-feeds-tab',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, LscCanDirective, FeatureStateComponent],
  styleUrl: '../../iam/shared/iam-page.scss',
  styles: [
    `
      textarea.input {
        min-height: 64px;
        font-family: var(--font-mono, monospace);
        font-size: var(--text-xs);
      }
      td.num {
        text-align: right;
      }
    `,
  ],
  template: `
    <section class="card">
      <header class="card-head">
        <h3>Trade feeds</h3>
        <span class="spacer"></span>
        <button
          *lscCan="P.DealingManage"
          type="button"
          class="btn btn-sm btn-secondary"
          (click)="startCreate()"
        >
          Register a feed
        </button>
        <button
          type="button"
          class="btn btn-sm btn-secondary"
          [disabled]="loading()"
          (click)="load()"
        >
          {{ loading() ? 'Loading…' : 'Refresh' }}
        </button>
      </header>

      @if (form(); as f) {
        <form
          class="card-body"
          (ngSubmit)="save()"
          [attr.aria-label]="f.create ? 'Register a trade feed' : 'Edit trade feed'"
        >
          @if (f.create) {
            <p class="note">
              Register the trade server, then give its gateway a DAEMON enrollment token
              (Organisation → Terminals) and list the gateway's daemon id below. Nothing is stored
              from a gateway that is not listed.
            </p>
          }
          @if (!f.enabled && !f.create) {
            <p class="note warn">A disabled feed accepts posts and stores nothing.</p>
          }
          <div class="form-grid">
            <label class="field">
              <span class="label">Feed id</span>
              <input
                class="input"
                name="feedId"
                maxlength="64"
                [disabled]="!f.create"
                [ngModel]="f.feedId"
                (ngModelChange)="patch({ feedId: $event })"
              />
            </label>
            <label class="field">
              <span class="label">Display name</span>
              <input
                class="input"
                name="displayName"
                maxlength="128"
                [ngModel]="f.displayName"
                (ngModelChange)="patch({ displayName: $event })"
              />
            </label>
            <label class="field">
              <span class="label">MT5 trade server</span>
              <input
                class="input"
                name="serverName"
                maxlength="128"
                [ngModel]="f.serverName"
                (ngModelChange)="patch({ serverName: $event })"
              />
            </label>
            <label class="field">
              <span class="label"
                >Price source (market-data source id; blank = the busiest MT5 source)</span
              >
              <input
                class="input"
                name="priceSourceId"
                maxlength="64"
                [ngModel]="f.priceSourceId"
                (ngModelChange)="patch({ priceSourceId: $event })"
              />
            </label>
            <label class="field">
              <span class="label">Gateway daemon ids (one per line)</span>
              <textarea
                class="input"
                name="writers"
                [ngModel]="f.writersText"
                (ngModelChange)="patch({ writersText: $event })"
              ></textarea>
            </label>
          </div>
          <label class="check">
            <input
              type="checkbox"
              name="enabled"
              [ngModel]="f.enabled"
              (ngModelChange)="patch({ enabled: $event })"
            />
            Enabled
          </label>
          @for (p of problems(); track p) {
            <p class="note warn">{{ p }}</p>
          }
          <div class="actions-row">
            <button type="button" class="btn btn-secondary" data-autofocus (click)="form.set(null)">
              Cancel
            </button>
            <button
              type="submit"
              class="btn btn-primary"
              [disabled]="busy() || problems().length > 0"
            >
              {{ busy() ? 'Saving…' : f.create ? 'Register' : 'Save' }}
            </button>
          </div>
        </form>
      }

      @if (error(); as err) {
        <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
      }
      @if (feeds().length) {
        <div class="table-wrap">
          <table class="grid">
            <thead>
              <tr>
                <th>Feed</th>
                <th>Server</th>
                <th>State</th>
                <th>Gateways</th>
                <th>Price source</th>
                <th class="num">Trades</th>
                <th class="num">Open</th>
                <th>Last post</th>
                <th><span class="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              @for (f of feeds(); track f.feedId) {
                <tr>
                  <td>
                    <code>{{ f.feedId }}</code
                    ><span class="sub">{{ f.displayName }}</span>
                  </td>
                  <td class="small">{{ f.serverName ?? '—' }}</td>
                  <td>
                    <span class="chip" [class.ok]="f.enabled">{{
                      f.enabled ? 'enabled' : 'disabled'
                    }}</span>
                  </td>
                  <td class="small">
                    {{ f.writerInstanceIds.length ? f.writerInstanceIds.join(', ') : 'none' }}
                  </td>
                  <td class="small">
                    <code>{{ f.priceSourceId ?? 'default' }}</code>
                  </td>
                  <td class="num">{{ f.trades }}</td>
                  <td class="num">{{ f.openTrades }}</td>
                  <td class="small">{{ when(f.lastIngestAtUtc) }}</td>
                  <td class="actions">
                    <button
                      *lscCan="P.DealingManage"
                      type="button"
                      class="btn btn-sm btn-secondary"
                      (click)="startEdit(f)"
                    >
                      Edit
                    </button>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      } @else if (loaded() && !error()) {
        <div class="card-body">
          <app-feature-state
            title="Client trade feeds"
            kind="partial"
            stateLabel="Own accounts only"
            switchKey="Dealing:Markout:Enabled"
            summary="A trade feed brings the client trades of a broker's MT5 trade server into the desk, so every client's flow is marked out, scored for toxicity and suggested for A- or B-book. Without one, the desk analyses your own trading accounts' fills (feed &quot;own&quot;) — which is what the other tabs show now."
            detail="A feed is posted by a gateway next to the trade server (the MetaQuotes Manager API is a licensed SDK, so the reference gateway documents it but does not ship it). Register the feed here with the gateway's daemon identity, then start the gateway."
            [requirements]="requirements()"
          />
        </div>
      }
    </section>
  `,
})
export class DealingFeedsTabComponent {
  private readonly api = inject(DealingApiService);
  private readonly store = inject(DealingFiltersStore);
  private readonly notify = inject(NotificationService);

  protected readonly P = Permission;
  protected readonly when = when;

  readonly feeds = signal<DealingFeed[]>([]);
  readonly loading = signal(false);
  readonly loaded = signal(false);
  readonly error = signal<string | null>(null);
  readonly busy = signal(false);
  readonly form = signal<FeedForm | null>(null);
  readonly problems = computed(() => {
    const f = this.form();
    return f ? feedProblems(f) : [];
  });

  /** `Dealing:Markout:*` switches as the engine has them (null = not readable with this access). */
  readonly config = signal<Record<string, string | null>>({});
  readonly requirements = computed<FeatureRequirement[]>(() => {
    const c = this.config();
    const flag = (k: string) => (c[k] == null ? null : c[k]!.toLowerCase() === 'true');
    const markout = flag('Dealing:Markout:Enabled');
    const own = flag('Dealing:Markout:OwnAccounts');
    return [
      {
        label: 'Markout worker on',
        ok: markout,
        detail:
          markout === null
            ? 'Dealing:Markout:Enabled could not be read.'
            : `Dealing:Markout:Enabled = ${markout} — fills are marked out at 1 s to 5 min on the tick store.`,
        route: '/engine-config',
        query: { search: 'Dealing:' },
      },
      {
        label: "Your own accounts' fills analysed",
        ok: own,
        detail:
          own === null
            ? 'Dealing:Markout:OwnAccounts could not be read.'
            : own
              ? `Dealing:Markout:OwnAccounts = true — the last ${c['Dealing:Markout:OwnLookbackDays'] ?? '7'} days of your live fills.`
              : 'Dealing:Markout:OwnAccounts = false — your own fills are not analysed.',
        route: '/engine-config',
        query: { search: 'Dealing:' },
      },
      {
        label: 'A trade feed registered',
        ok: false,
        detail: 'None — use “Register a feed” with the trade server name and the gateway identity.',
      },
      {
        label: 'A gateway posting client trades',
        ok: false,
        detail: 'Nothing has posted to dealing/trades/ingest (no feed to post to).',
      },
    ];
  });

  constructor() {
    this.load();
    for (const key of [
      'Dealing:Markout:Enabled',
      'Dealing:Markout:OwnAccounts',
      'Dealing:Markout:OwnLookbackDays',
    ])
      this.api.setting(key).subscribe((v) => this.config.update((c) => ({ ...c, [key]: v })));
  }

  load(): void {
    this.loading.set(true);
    this.api.feeds().subscribe({
      next: (rows) => {
        this.feeds.set(rows);
        this.error.set(null);
        this.loading.set(false);
        this.loaded.set(true);
      },
      error: (e) => {
        this.loading.set(false);
        this.loaded.set(true);
        if (isModuleNotInPlan(e)) this.store.moduleMissing.set(true);
        else this.error.set(errorText(e, 'Could not load the trade feeds.'));
      },
    });
  }

  startCreate(): void {
    this.form.set({
      create: true,
      feedId: '',
      displayName: '',
      serverName: '',
      writersText: '',
      priceSourceId: '',
      enabled: true,
    });
  }

  startEdit(f: DealingFeed): void {
    this.form.set({
      create: false,
      feedId: f.feedId,
      displayName: f.displayName,
      serverName: f.serverName ?? '',
      writersText: f.writerInstanceIds.join('\n'),
      priceSourceId: f.priceSourceId ?? '',
      enabled: f.enabled,
    });
  }

  patch(p: Partial<FeedForm>): void {
    this.form.update((f) => (f ? { ...f, ...p } : f));
  }

  save(): void {
    const f = this.form();
    if (!f || this.busy() || this.problems().length) return;
    this.busy.set(true);
    const body = {
      feedId: f.feedId.trim(),
      displayName: f.displayName.trim(),
      serverName: f.serverName.trim(),
      writerInstanceIds: parseWriters(f.writersText),
      priceSourceId: f.priceSourceId.trim(),
      enabled: f.enabled,
    };
    (f.create ? this.api.createFeed(body) : this.api.updateFeed(body)).subscribe({
      next: (row) => {
        this.busy.set(false);
        this.form.set(null);
        this.notify.success(`${row.feedId} saved.`);
        this.load();
      },
      error: (e) => {
        this.busy.set(false);
        if (reportable(e)) this.notify.error(errorText(e, 'The trade feed was not saved.'));
      },
    });
  }
}
