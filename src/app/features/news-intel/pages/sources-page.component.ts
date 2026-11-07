import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';

import { NewsIntelService } from '@core/services/news-intel.service';
import { ConfigService, isQueuedForCoolingOff } from '@core/services/config.service';
import { AuthService } from '@core/auth/auth.service';
import { Permission } from '@core/auth/permissions.generated';
import { createPolledResource } from '@core/polling/polled-resource';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { errorText } from '@features/iam/iam.logic';
import { NewsIntelNavComponent } from '../components/news-intel-nav.component';
import { NiInfoComponent, NiPanelComponent, NiStatComponent } from '../components/viz/ni-primitives';
import { LatencyRangeRow, NiLatencyRangeComponent } from '../components/viz/ni-tabs-a';
import {
  VendorRow,
  configValue,
  feedHost,
  feedSummary,
  formatMinutes,
  latencyRows,
  parseSourceNote,
  pastedKeyTag,
  pct,
  vendorRows,
} from '../news-intel.logic';
import { NewsConfigEntry, NewsVendorVerifyResult } from '../news-intel.types';

const SEC_UA = 'NewsIntel:Ingest:SecUserAgent';

type PendingWrite =
  | { kind: 'apiKey'; vendor: VendorRow; value: string }
  | { kind: 'enable'; vendor: VendorRow; on: boolean }
  | { kind: 'secUa'; value: string };

/**
 * Sources — intake speed and health per channel and publisher (publish → first-seen p50/p90 over 24 h
 * and 7 d), the conditional-GET state of every polled feed, the sources that are off and why, and the
 * paid vendor adapters.
 *
 * Vendor API keys are WRITE-ONLY: the engine shows them as ***SET / ***UNSET and never returns key
 * material. A pasted key is sent once through `PUT /config` (which demands `platform.engine.secrets`
 * for a secret) and the field is cleared as it is sent; only a short tag of what was pasted stays on
 * screen for this session.
 */
@Component({
  selector: 'app-news-sources-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    NewsIntelNavComponent,
    ConfirmDialogComponent,
    NiInfoComponent,
    NiPanelComponent,
    NiStatComponent,
    NiLatencyRangeComponent,
  ],
  styleUrls: ['../news-intel-shared.scss'],
  template: `
    <div class="page">
      <header class="page-head">
        <div class="title">
          <h1>News sources</h1>
          <app-ni-info text="How fast each channel delivers (publisher timestamp → first seen by the engine), which feeds answer conditional GETs, which sources are switched off and why, and the paid vendor adapters." />
        </div>
      </header>
      <app-news-intel-nav [showRefresh]="true" [refreshing]="status.refreshing()" (refresh)="status.refresh(); loadConfig()" />

      @if (error(); as e) {
        <div class="banner error">{{ e }}</div>
      }
      @if (notice(); as n) {
        <div class="banner info">{{ n }}</div>
      }
      @if (status.loading() && !status.value()) {
        <p class="empty">Loading…</p>
      }

      @if (status.value(); as st) {
        @if (!st.latency) {
          <div class="banner warn">This engine build does not report intake latency or feed state (sourcing v2 not deployed). Channel and publisher counts are on the Overview tab.</div>
        }

        <div class="ni-kpis kpi8">
          <app-ni-stat label="Channels" [value]="kpi().channels" [sub]="kpi().channelsSub" [tone]="kpi().channelsTone" info="Discovery channels with fresh articles vs stale ones; staleness is judged against each channel's own cadence by the engine." />
          <app-ni-stat label="p50 24h" [value]="kpi().p50" sub="publish → seen" info="Count-weighted median minutes from the publisher's timestamp to the engine first holding the item, across channels, last 24 h." />
          <app-ni-stat label="p90 24h" [value]="kpi().p90" [sub]="'7d p90 ' + kpi().p90w" info="Count-weighted 90th percentile, last 24 h (sub: 7-day figure)." />
          <app-ni-stat label="Publishers" [value]="latency().publishers.length" sub="with latency rows" info="Publishers with enough articles to rank in the latency windows." />
          <app-ni-stat label="Feeds" [value]="feeds().feeds" [sub]="feeds().withValidators + ' send validators'" info="Polled feed URLs; validators = the publisher sends ETag / Last-Modified, so a conditional GET is possible." />
          <app-ni-stat label="304 hit" [value]="pct(feeds().hitRate)" sub="at last poll" info="Share of feeds whose last poll answered 304 Not Modified — bandwidth saved, a point-in-time rate not a history." />
          <app-ni-stat label="Failing" [value]="feeds().failing" sub="status ≥ 400" [tone]="feeds().failing ? 'bad' : 'ok'" info="Feeds whose last poll failed (HTTP ≥ 400 or no answer)." />
          <app-ni-stat label="Sources off" [value]="notes().length" [sub]="vendorShort()" [tone]="notes().length ? 'warn' : null" info="Sources the engine reports as switched off, each with the knob that turns it on; paid vendors stay off until a key is pasted and enabled." />
        </div>

        <div class="ni-grid-main">
          <app-ni-panel title="Latency by channel" info="Range = p50 to p90 minutes from the publisher's own timestamp to the engine first holding the item; dot = p50. Solid = last 24 h, thin = 7 d. Search is recall, not the fast path; RSS and wires should sit well under an hour.">
            <span meta>{{ latency().channels.length }} channels</span>
            <app-ni-latency-range [rows]="channelRows()" />
            <div class="chs">
              @for (r of latency().channels; track r.channel) {
                @if (channelStale(r.channel); as s) {
                  <span class="pill" [class.bad]="s.stale" [class.ok]="!s.stale">{{ r.channel }} · {{ s.stale ? 'stale ' + m(s.minutes) : 'live' }}</span>
                }
              }
            </div>
          </app-ni-panel>

          <app-ni-panel title="Sources that are off" info="One line per source the engine reports as OFF, naming the knob that turns it on.">
            <span meta>{{ notes().length }}</span>
            <ul class="notes">
              @for (n of notes(); track n.text) {
                <li class="note">
                  @if (n.subject) {
                    <span class="pill warn">{{ n.subject }}</span>
                  }
                  <span>{{ n.text }}</span>
                </li>
              } @empty {
                <li class="empty">The engine reports no disabled source.</li>
              }
            </ul>
            <div class="sec">
              <div class="sech">
                <h3>SEC EDGAR user agent</h3>
                <app-ni-info align="right" text="SEC fair-access policy requires &quot;<Company> <contact email>&quot;. Empty keeps SEC 8-K filings off." />
              </div>
              <code class="cur" [class.faint]="!secUa()">{{ secUa() || '(empty — off)' }}</code>
              @if (canManage()) {
                <div class="filters">
                  <input class="inp" placeholder="Company Name ops@example.com" aria-label="SEC user agent" [value]="secDraft()" (input)="secDraft.set($any($event.target).value)" />
                  <button type="button" class="btn" [disabled]="!secDraft().trim() || busy()" (click)="pending.set({ kind: 'secUa', value: secDraft().trim() })">Set</button>
                </div>
              }
            </div>
          </app-ni-panel>
        </div>

        <div class="ni-grid-2">
          <app-ni-panel title="Latency by publisher" info="Same ranges per publisher, slowest 7-day p50 first. A publisher drifting right is a feed going stale before it goes silent.">
            <span meta>{{ publishers().length }} of {{ latency().publishers.length }}</span>
            <button actions type="button" class="btn subtle" (click)="allPublishers.set(!allPublishers())">
              {{ allPublishers() ? 'Top 15' : 'All ' + latency().publishers.length }}
            </button>
            <div class="pubscroll">
              <app-ni-latency-range [rows]="publisherRows()" />
            </div>
          </app-ni-panel>

          <app-ni-panel title="Polled feeds" info="Conditional-GET state per feed: last HTTP status (304 = not modified), consecutive 304s, whether the publisher sends validators, and the last poll time (UTC)." [flush]="true">
            <span meta>{{ feeds().feeds }} feeds · {{ feeds().lastNotModified }} × 304</span>
            <div class="table-wrap scroll feedtbl">
              <table>
                <thead>
                  <tr>
                    <th>Feed</th>
                    <th class="num">Status</th>
                    <th class="num">304 streak</th>
                    <th>Validators</th>
                    <th class="num">Polled</th>
                  </tr>
                </thead>
                <tbody>
                  @for (f of sortedFeeds(); track f.url) {
                    <tr>
                      <td class="ellipsis" [title]="f.url">
                        <span class="mono xsmall">{{ host(f.url) }}</span><span class="faint xsmall"> {{ path(f.url) }}</span>
                      </td>
                      <td class="num">
                        <span class="pill" [class.ok]="f.lastStatus === 304 || f.lastStatus === 200" [class.bad]="f.lastStatus >= 400 || f.lastStatus === 0">{{ f.lastStatus }}</span>
                      </td>
                      <td class="num">{{ f.notModifiedStreak }}</td>
                      <td>
                        @if (f.hasValidators) {
                          <span class="pill ok">yes</span>
                        } @else {
                          <span class="faint xsmall">no</span>
                        }
                      </td>
                      <td class="num faint">{{ f.lastPolledUtc | date: 'HH:mm:ss' : 'UTC' }}</td>
                    </tr>
                  } @empty {
                    <tr>
                      <td colspan="5" class="empty">No feed state recorded yet.</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </app-ni-panel>
        </div>

        <app-ni-panel title="Paid vendors" info="Adapters are built to each vendor's published API and are unproven until a key is pasted. Keys are write-only and never shown again. Verify makes one bounded call with the stored key (at most once per 30 s) and shows the answer plus a fingerprint (first 8 hex of its SHA-256) — never the key.">
          <span meta>{{ vendorSub() }}</span>
          <div class="vendors">
            @for (v of vendors(); track v.name) {
              <div class="vc" [class.on]="v.enabled">
                <div class="vh">
                  <b>{{ v.name }}</b>
                  <span class="pill" [class.ok]="v.enabled" [class.warn]="v.blocked" [class.plain]="!v.enabled && !v.blocked">{{ v.enabled === null ? 'off (default)' : v.enabled ? 'on' : 'off' }}</span>
                  <span class="pill" [class.ok]="v.keyState === 'set'" [class.plain]="v.keyState !== 'set'">key {{ v.keyState === 'set' ? 'set' : v.keyState === 'unset' ? 'not set' : 'no row' }}</span>
                  @if (canManage()) {
                    <button type="button" class="btn subtle tiny" [disabled]="busy()" (click)="pending.set({ kind: 'enable', vendor: v, on: !v.enabled })">{{ v.enabled ? 'Disable' : 'Enable' }}</button>
                  }
                </div>
                @if (savedTags()[v.name]; as tag) {
                  <span class="faint xsmall">saved this session: {{ tag }}</span>
                }
                @if (v.blocked) {
                  <span class="neg xsmall">enabled without a key — not polled</span>
                }
                @if (canSecrets()) {
                  <form class="filters keyrow" (submit)="askKey(v, keyInput); $event.preventDefault()">
                    <input #keyInput type="password" class="inp mono" autocomplete="off" spellcheck="false" [attr.aria-label]="v.name + ' API key'" placeholder="Paste a new key" />
                    <button type="submit" class="btn">Save key</button>
                  </form>
                } @else {
                  <span class="faint xsmall">key changes need platform.engine.secrets</span>
                }
                <div class="xsmall vv" data-testid="vendor-verify">
                  @if (canManage()) {
                    <button type="button" class="btn subtle tiny" [disabled]="verifying() === v.name" (click)="verify(v.name)">{{ verifying() === v.name ? 'Checking…' : 'Verify' }}</button>
                  }
                  @if (verified()[v.name]; as r) {
                    <span class="pill" [class.ok]="r.ok" [class.warn]="!r.ok">{{ r.status }}</span>
                    @if (r.keyFingerprint) {
                      <span class="mono">#{{ r.keyFingerprint }} ({{ r.keyLength }} chars)</span>
                    }
                    @if (r.ok) {
                      <span class="faint">HTTP {{ r.httpStatus }} · {{ r.itemsParsed }} item(s) · {{ r.elapsedMs }} ms</span>
                    }
                    @if (r.error) {
                      <div class="faint">{{ r.error }}</div>
                    }
                  }
                </div>
              </div>
            }
          </div>
        </app-ni-panel>
      }

      <app-confirm-dialog
        [open]="pending() !== null"
        [title]="dialog().title"
        [message]="dialog().message"
        [confirmLabel]="dialog().confirm"
        [loading]="busy()"
        (confirm)="write()"
        (cancelled)="pending.set(null)"
      />
    </div>
  `,
  styles: [
    `
      .title {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .kpi8 {
        grid-template-columns: repeat(8, minmax(0, 1fr));
      }
      @media (max-width: 1240px) {
        .kpi8 {
          grid-template-columns: repeat(auto-fit, minmax(118px, 1fr));
        }
      }
      .chs {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        margin-top: 4px;
      }
      .notes {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
      }
      .note {
        display: flex;
        gap: 8px;
        align-items: baseline;
        font-size: 11.5px;
        padding: 4px 0;
        border-bottom: 1px solid var(--border);
        line-height: 1.4;
      }
      .note .pill {
        flex: none;
      }
      .sec {
        display: flex;
        flex-direction: column;
        gap: 5px;
        padding: 8px 10px;
        border-radius: 8px;
        background: var(--ni-sunken);
      }
      .sech {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .cur {
        font-size: 11px;
      }
      .sec .inp {
        flex: 1;
        min-width: 160px;
      }
      .pubscroll {
        max-height: 420px;
        overflow-y: auto;
        --lbl-w: 150px;
      }
      .feedtbl {
        max-height: 440px;
      }
      .feedtbl th:first-child,
      .feedtbl td:first-child {
        padding-left: 12px;
      }
      .feedtbl th:last-child,
      .feedtbl td:last-child {
        padding-right: 12px;
      }
      .vendors {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
        gap: 8px;
      }
      .vc {
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 8px 10px;
        display: flex;
        flex-direction: column;
        gap: 6px;
        background: var(--ni-sunken);
      }
      .vc.on {
        background: var(--ni-panel);
        box-shadow: inset 2px 0 0 var(--ni-ok);
      }
      .vh {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-wrap: wrap;
      }
      .vh b {
        font-size: 12.5px;
        margin-right: auto;
      }
      .keyrow .inp {
        flex: 1;
        min-width: 120px;
      }
      .vv {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px;
      }
      .btn.tiny {
        padding: 0 8px;
        line-height: 20px;
        font-size: 11px;
      }
    `,
  ],
})
export class NewsSourcesPageComponent {
  private readonly svc = inject(NewsIntelService);
  private readonly configs = inject(ConfigService);
  private readonly auth = inject(AuthService);

  protected readonly pct = pct;

  readonly status = createPolledResource(() => this.svc.getStatus(24, { silent: true }), {
    intervalMs: 60_000,
  });
  readonly entries = signal<NewsConfigEntry[]>([]);
  readonly allPublishers = signal(false);
  readonly pending = signal<PendingWrite | null>(null);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly notice = signal<string | null>(null);
  readonly secDraft = signal('');
  readonly savedTags = signal<Record<string, string>>({});
  readonly verifying = signal<string | null>(null);
  readonly verified = signal<Record<string, NewsVendorVerifyResult>>({});

  readonly canManage = computed(() => this.auth.hasPermission(Permission.PlatformEngineManage));
  readonly canSecrets = computed(() => this.auth.hasPermission(Permission.PlatformEngineSecrets));

  readonly latency = computed(() => latencyRows(this.status.value()?.latency));
  readonly publishers = computed(() =>
    this.allPublishers() ? this.latency().publishers : this.latency().publishers.slice(0, 15),
  );
  readonly feeds = computed(() => feedSummary(this.status.value()?.feeds));
  readonly notes = computed(() => (this.status.value()?.sourceNotes ?? []).map(parseSourceNote));
  readonly vendors = computed(() => vendorRows(this.entries()));
  readonly secUa = computed(() => configValue(this.entries(), SEC_UA) ?? '');

  readonly dialog = computed(() => {
    const p = this.pending();
    if (!p) return { title: '', message: '', confirm: 'Save' };
    switch (p.kind) {
      case 'apiKey':
        return {
          title: `Replace the ${p.vendor.name} API key?`,
          message: `The pasted key (${pastedKeyTag(p.value)}) replaces whatever is stored. It is sent once and never shown again.`,
          confirm: 'Save key',
        };
      case 'enable':
        return {
          title: `${p.on ? 'Enable' : 'Disable'} ${p.vendor.name}?`,
          message: p.on
            ? `The engine starts polling ${p.vendor.name}${p.vendor.keyState === 'set' ? '' : ' once a key is set'}; its articles enter classification (model calls shared with spot analysis).`
            : `${p.vendor.name} stops being polled.`,
          confirm: p.on ? 'Enable' : 'Disable',
        };
      default:
        return {
          title: 'Set the SEC user agent?',
          message: `SEC EDGAR 8-K filings start being polled with the user agent "${p.value}".`,
          confirm: 'Set',
        };
    }
  });

  constructor() {
    this.loadConfig();
  }

  loadConfig(): void {
    this.svc.getConfig().subscribe({
      next: (e) => this.entries.set(e),
      error: (e) => this.error.set(errorText(e, 'Could not load the module configuration.')),
    });
  }

  m(v: number | null | undefined): string {
    return formatMinutes(v);
  }

  host(url: string): string {
    return feedHost(url);
  }

  path(url: string): string {
    try {
      const u = new URL(url);
      return u.pathname.length > 40 ? u.pathname.slice(0, 40) + '…' : u.pathname;
    } catch {
      return '';
    }
  }

  channelStale(channel: string): { stale: boolean; minutes: number } | null {
    const c = this.status.value()?.channelBreakdown.find((x) => x.kind === channel);
    return c ? { stale: c.stale, minutes: c.staleMinutes } : null;
  }

  /** Takes the pasted value and clears the field at once, so the key is not left in the DOM. */
  /** One bounded vendor call with the stored key; the answer carries a fingerprint, never the key. */
  verify(name: string): void {
    this.verifying.set(name);
    this.svc.verifyVendor(name).subscribe({
      next: (r) => {
        this.verified.update((v) => ({ ...v, [name]: r }));
        this.verifying.set(null);
      },
      error: (e) => {
        this.verifying.set(null);
        this.verified.update((v) => ({
          ...v,
          [name]: {
            vendor: name,
            keySet: false,
            keyFingerprint: null,
            keyLength: null,
            ok: false,
            status: 'unavailable',
            httpStatus: null,
            itemsParsed: null,
            error: errorText(e, 'This engine build has no vendor verify call.'),
            enabled: false,
            checkedAtUtc: new Date().toISOString(),
            elapsedMs: null,
          },
        }));
      },
    });
  }

  askKey(vendor: VendorRow, input: HTMLInputElement): void {
    const value = input.value.trim();
    input.value = '';
    if (!value) return;
    this.pending.set({ kind: 'apiKey', vendor, value });
  }

  write(): void {
    const p = this.pending();
    if (!p) return;
    this.busy.set(true);
    this.error.set(null);
    this.notice.set(null);
    const done = (msg: string) => {
      this.busy.set(false);
      this.pending.set(null);
      this.notice.set(msg);
      this.loadConfig();
      this.status.refresh();
    };
    const fail = (e: unknown, key: string) => {
      this.busy.set(false);
      this.pending.set(null);
      if (/-202-approval/.test(JSON.stringify(e ?? {})))
        this.notice.set(`${key}: sent for approval.`);
      else this.error.set(errorText(e, 'The change was not saved.'));
    };

    if (p.kind === 'apiKey') {
      const key = p.vendor.apiKeyKey;
      // PUT /config: the engine demands platform.engine.secrets for a secret key there.
      this.configs
        .upsert({ key, value: p.value, dataType: 'String', isHotReloadable: true })
        .subscribe({
          next: (res) => {
            if (!res.status) {
              if (res.responseCode === '-202-approval') done(`${key}: sent for approval.`);
              else fail({ message: res.message || 'The key was refused.' }, key);
              return;
            }
            this.savedTags.update((t) => ({ ...t, [p.vendor.name]: pastedKeyTag(p.value) }));
            done(
              isQueuedForCoolingOff(res)
                ? `${key}: queued for cooling-off.`
                : `${p.vendor.name} key saved.`,
            );
          },
          error: (e) => fail(e, key),
        });
      return;
    }

    const change =
      p.kind === 'enable'
        ? { key: p.vendor.enabledKey, value: p.on ? 'true' : 'false', dataType: 'Bool' }
        : { key: SEC_UA, value: p.value, dataType: 'String' };
    this.svc.saveConfig([change]).subscribe({
      next: (msgs) => {
        if (p.kind === 'secUa') this.secDraft.set('');
        done(msgs.join(' · ') || `${change.key} saved.`);
      },
      error: (e) => fail(e, change.key),
    });
  }

  // ── Dense layout helpers ──
  readonly channelRows = computed<LatencyRangeRow[]>(() =>
    this.latency().channels.map((r) => ({ label: r.channel, day: r.day, week: r.week })),
  );
  readonly publisherRows = computed<LatencyRangeRow[]>(() =>
    this.publishers().map((r) => ({ label: r.source ?? r.channel, sub: r.channel, day: r.day, week: r.week })),
  );
  readonly sortedFeeds = computed(() =>
    [...(this.status.value()?.feeds ?? [])].sort(
      (a, b) =>
        Number(b.lastStatus >= 400 || b.lastStatus === 0) - Number(a.lastStatus >= 400 || a.lastStatus === 0) ||
        feedHost(a.url).localeCompare(feedHost(b.url)),
    ),
  );
  readonly vendorShort = computed(() => {
    const vs = this.vendors();
    return `${vs.filter((v) => v.enabled).length}/${vs.length} vendors on`;
  });
  readonly vendorSub = computed(() => {
    const vs = this.vendors();
    return `${vs.filter((v) => v.enabled).length}/${vs.length} vendors on · ${vs.filter((v) => v.keyState === 'set').length} keyed`;
  });
  readonly kpi = computed(() => {
    const st = this.status.value();
    const ch = st?.channelBreakdown ?? [];
    const stale = ch.filter((c) => c.stale);
    const day = this.latency().channels.filter((r) => r.day && r.day.count > 0);
    const week = this.latency().channels.filter((r) => r.week && r.week.count > 0);
    const wavg = (rows: typeof day, pick: (r: (typeof day)[number]) => { count: number; p50: number; p90: number } | null, f: 'p50' | 'p90') => {
      const n = rows.reduce((s, r) => s + (pick(r)?.count ?? 0), 0);
      return n ? rows.reduce((s, r) => s + (pick(r)![f] * pick(r)!.count), 0) / n : null;
    };
    return {
      channels: st ? `${ch.length - stale.length}/${ch.length}` : '—',
      channelsSub: stale.length ? `stale: ${stale.map((c) => c.kind).join(', ')}` : ch.length ? 'all fresh' : null,
      channelsTone: (st ? (stale.length ? 'bad' : 'ok') : null) as 'bad' | 'ok' | null,
      p50: this.m(wavg(day, (r) => r.day, 'p50')),
      p90: this.m(wavg(day, (r) => r.day, 'p90')),
      p90w: this.m(wavg(week, (r) => r.week, 'p90')),
    };
  });
}
