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
  imports: [DatePipe, NewsIntelNavComponent, ConfirmDialogComponent],
  styleUrls: ['../news-intel-shared.scss'],
  template: `
    <div class="page">
      <header>
        <h1>News sources</h1>
        <p class="muted small">
          How fast each channel delivers (publisher timestamp → first seen by the engine), which
          feeds answer conditional GETs, and which sources are switched off and why.
        </p>
      </header>
      <app-news-intel-nav
        [showRefresh]="true"
        [refreshing]="status.refreshing()"
        (refresh)="status.refresh(); loadConfig()"
      />

      @if (error(); as e) {
        <div class="banner error">{{ e }}</div>
      }
      @if (notice(); as n) {
        <div class="banner info">{{ n }}</div>
      }

      @if (status.loading()) {
        <p class="muted small">Loading…</p>
      }

      @if (status.value(); as st) {
        @if (!st.latency) {
          <div class="banner warn">
            This engine build does not report intake latency or feed state (sourcing v2 is not
            deployed yet). Channel and publisher counts are on the Overview tab.
          </div>
        }

        <section class="card">
          <h2>Latency by channel</h2>
          <p class="muted xsmall">
            Minutes from the publisher's own timestamp to the engine first holding the item. Search
            is recall, not the fast path; RSS and the wires should be well under an hour.
          </p>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Channel</th>
                  <th class="num">24 h n</th>
                  <th class="num">24 h p50</th>
                  <th class="num">24 h p90</th>
                  <th class="num">7 d n</th>
                  <th class="num">7 d p50</th>
                  <th class="num">7 d p90</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                @for (r of latency().channels; track r.channel) {
                  <tr>
                    <td>{{ r.channel }}</td>
                    <td class="num">{{ r.day?.count ?? '—' }}</td>
                    <td class="num">{{ m(r.day?.p50) }}</td>
                    <td class="num">{{ m(r.day?.p90) }}</td>
                    <td class="num">{{ r.week?.count ?? '—' }}</td>
                    <td class="num">{{ m(r.week?.p50) }}</td>
                    <td class="num">{{ m(r.week?.p90) }}</td>
                    <td>
                      @if (channelStale(r.channel); as s) {
                        <span class="pill" [class.bad]="s.stale" [class.ok]="!s.stale">{{
                          s.stale ? 'stale ' + m(s.minutes) : 'live'
                        }}</span>
                      }
                    </td>
                  </tr>
                } @empty {
                  <tr>
                    <td colspan="8" class="empty">No latency rows reported.</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </section>

        <section class="card">
          <div class="card-head">
            <h2>Latency by publisher</h2>
            <button type="button" class="btn subtle" (click)="allPublishers.set(!allPublishers())">
              {{ allPublishers() ? 'Top 15' : 'Show all (' + latency().publishers.length + ')' }}
            </button>
          </div>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Publisher</th>
                  <th>Channel</th>
                  <th class="num">24 h n</th>
                  <th class="num">24 h p50 / p90</th>
                  <th class="num">7 d n</th>
                  <th class="num">7 d p50 / p90</th>
                </tr>
              </thead>
              <tbody>
                @for (r of publishers(); track r.channel + r.source) {
                  <tr>
                    <td>{{ r.source }}</td>
                    <td class="muted">{{ r.channel }}</td>
                    <td class="num">{{ r.day?.count ?? '—' }}</td>
                    <td class="num">{{ m(r.day?.p50) }} / {{ m(r.day?.p90) }}</td>
                    <td class="num">{{ r.week?.count ?? '—' }}</td>
                    <td class="num">{{ m(r.week?.p50) }} / {{ m(r.week?.p90) }}</td>
                  </tr>
                } @empty {
                  <tr>
                    <td colspan="6" class="empty">No publisher has enough articles to rank.</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </section>

        <section class="card">
          <h2>Polled feeds — conditional GET</h2>
          <div class="tiles">
            <div class="tile">
              <span class="v">{{ feeds().feeds }}</span
              ><span class="k">feeds</span>
            </div>
            <div class="tile">
              <span class="v">{{ feeds().withValidators }}</span
              ><span class="k">send ETag / Last-Modified</span>
            </div>
            <div class="tile">
              <span class="v">{{ pct(feeds().hitRate) }}</span
              ><span class="k">answered 304 at last poll</span>
            </div>
            <div class="tile">
              <span class="v" [class.neg]="feeds().failing > 0">{{ feeds().failing }}</span
              ><span class="k">failing (≥ 400)</span>
            </div>
          </div>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Feed</th>
                  <th class="num">Last status</th>
                  <th class="num">304 streak</th>
                  <th>Validators</th>
                  <th>Last poll (UTC)</th>
                </tr>
              </thead>
              <tbody>
                @for (f of st.feeds ?? []; track f.url) {
                  <tr>
                    <td class="xsmall" [title]="f.url">
                      <span class="mono">{{ host(f.url) }}</span>
                      <span class="muted"> {{ path(f.url) }}</span>
                    </td>
                    <td class="num" [class.neg]="f.lastStatus >= 400 || f.lastStatus === 0">
                      {{ f.lastStatus }}
                    </td>
                    <td class="num">{{ f.notModifiedStreak }}</td>
                    <td>{{ f.hasValidators ? 'yes' : 'no' }}</td>
                    <td class="xsmall">{{ f.lastPolledUtc | date: 'MMM d HH:mm:ss' : 'UTC' }}</td>
                  </tr>
                } @empty {
                  <tr>
                    <td colspan="5" class="empty">No feed state recorded yet.</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </section>

        <section class="card">
          <h2>Sources that are off</h2>
          @for (n of notes(); track n.text) {
            <div class="note">
              @if (n.subject) {
                <span class="pill warn">{{ n.subject }}</span>
              }
              <span class="small">{{ n.text }}</span>
            </div>
          } @empty {
            <p class="empty">The engine reports no disabled source.</p>
          }
          <div class="sec">
            <h3>SEC EDGAR user agent</h3>
            <p class="muted xsmall">
              SEC fair-access policy requires "&lt;Company&gt; &lt;contact email&gt;". Empty keeps
              SEC 8-K filings off. Current: <code>{{ secUa() || '(empty — off)' }}</code>
            </p>
            @if (canManage()) {
              <div class="filters">
                <input
                  class="inp"
                  placeholder="Company Name ops@example.com"
                  aria-label="SEC user agent"
                  [value]="secDraft()"
                  (input)="secDraft.set($any($event.target).value)"
                />
                <button
                  type="button"
                  class="btn"
                  [disabled]="!secDraft().trim() || busy()"
                  (click)="pending.set({ kind: 'secUa', value: secDraft().trim() })"
                >
                  Set
                </button>
              </div>
            }
          </div>
        </section>

        <section class="card">
          <h2>Paid vendors</h2>
          <p class="muted xsmall">
            Adapters are built to each vendor's published API and are unproven against a live
            account until a key is pasted. Keys are write-only and never shown again. "Verify" makes
            one bounded call to the vendor with the stored key (at most once per 30 s) and shows the
            answer plus a fingerprint of the key (first 8 hex of its SHA-256) — never the key — so
            you can tell which key is stored without reading it.
          </p>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Vendor</th>
                  <th>Enabled</th>
                  <th>API key</th>
                  <th></th>
                  <th>Verify</th>
                </tr>
              </thead>
              <tbody>
                @for (v of vendors(); track v.name) {
                  <tr>
                    <td>{{ v.name }}</td>
                    <td>
                      <span class="pill" [class.ok]="v.enabled" [class.warn]="v.blocked">
                        {{ v.enabled === null ? 'off (default)' : v.enabled ? 'on' : 'off' }}
                      </span>
                      @if (canManage()) {
                        <button
                          type="button"
                          class="btn subtle"
                          [disabled]="busy()"
                          (click)="pending.set({ kind: 'enable', vendor: v, on: !v.enabled })"
                        >
                          {{ v.enabled ? 'Disable' : 'Enable' }}
                        </button>
                      }
                    </td>
                    <td>
                      <span class="pill" [class.ok]="v.keyState === 'set'">{{
                        v.keyState === 'set' ? 'set' : v.keyState === 'unset' ? 'not set' : 'no row'
                      }}</span>
                      @if (savedTags()[v.name]; as tag) {
                        <span class="muted xsmall"> saved this session: {{ tag }}</span>
                      }
                      @if (v.blocked) {
                        <span class="neg xsmall"> enabled without a key — not polled</span>
                      }
                    </td>
                    <td>
                      @if (canSecrets()) {
                        <form
                          class="filters"
                          (submit)="askKey(v, keyInput); $event.preventDefault()"
                        >
                          <input
                            #keyInput
                            type="password"
                            class="inp mono"
                            autocomplete="off"
                            spellcheck="false"
                            [attr.aria-label]="v.name + ' API key'"
                            placeholder="Paste a new key"
                          />
                          <button type="submit" class="btn">Save key</button>
                        </form>
                      } @else {
                        <span class="muted xsmall">needs platform.engine.secrets</span>
                      }
                    </td>
                    <td class="xsmall" data-testid="vendor-verify">
                      @if (canManage()) {
                        <button
                          type="button"
                          class="btn subtle"
                          [disabled]="verifying() === v.name"
                          (click)="verify(v.name)"
                        >
                          {{ verifying() === v.name ? 'Checking…' : 'Verify' }}
                        </button>
                      }
                      @if (verified()[v.name]; as r) {
                        <div>
                          <span class="pill" [class.ok]="r.ok" [class.warn]="!r.ok">{{
                            r.status
                          }}</span>
                          @if (r.keyFingerprint) {
                            <span class="mono">
                              key #{{ r.keyFingerprint }} ({{ r.keyLength }} chars)</span
                            >
                          }
                          @if (r.ok) {
                            <span class="muted">
                              · HTTP {{ r.httpStatus }} · {{ r.itemsParsed }} item(s) parsed ·
                              {{ r.elapsedMs }} ms</span
                            >
                          }
                          @if (r.error) {
                            <div class="muted">{{ r.error }}</div>
                          }
                        </div>
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </section>
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
      .note {
        display: flex;
        gap: var(--space-2);
        align-items: baseline;
        flex-wrap: wrap;
      }
      .sec {
        border-top: 1px solid var(--border);
        padding-top: var(--space-3);
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
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
}
