import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  computed,
  inject,
  signal,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { catchError, map, of } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { NotificationsFeedService } from '@core/services/notifications-feed.service';
import { RealtimeService } from '@core/realtime/realtime.service';
import type { NotificationFeedItem, NotificationFeedResult } from '@core/api/api.types';
import { createPolledResource } from '@core/polling/polled-resource';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';
import { NotificationService } from '@core/notifications/notification.service';

const ALL_SEVERITIES = ['Info', 'Medium', 'High', 'Critical'] as const;
type Severity = (typeof ALL_SEVERITIES)[number];

/**
 * Top-bar notification bell.  Aggregates the engine's unified notification
 * feed (alerts + EA error log + signal rejections + EA-state) into a single
 * attention surface beside the user pill:
 *
 * - Badge with the unread count (capped at "9+", red on Critical).
 * - Click opens a slide-down panel listing the most recent items.
 * - **Severity chips** filter the list in-panel.
 * - **Per-row mute menu** silences the item's type-key for 1h / 24h / 7d.
 * - "Mark all read" updates the operator's high-water mark on the engine.
 * - "View all" link routes to `/alert-triage` for the full workflow.
 *
 * **Push delivery**: subscribed to the engine's `notificationsChanged`
 * SignalR event (via `RealtimeService`); the bell triggers an immediate
 * refresh on every tickle.  Falls back to 30s polling when the hub is
 * disconnected so the badge stays roughly current even without push.
 */
@Component({
  selector: 'app-notification-bell',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, RouterLink, RelativeTimePipe],
  template: `
    <div class="bell-wrap">
      <button
        type="button"
        class="icon-btn bell-btn"
        (click)="toggleOpen()"
        [attr.aria-pressed]="open()"
        [attr.aria-label]="
          unreadCount() > 0
            ? unreadCount() + ' new notification' + (unreadCount() === 1 ? '' : 's')
            : 'No new notifications'
        "
        [attr.aria-haspopup]="'true'"
        [attr.aria-expanded]="open()"
        title="Notifications"
      >
        <span aria-hidden="true">🔔</span>
        @if (unreadCount() > 0) {
          <span class="bell-badge" [class.bell-badge--critical]="hasCritical()" aria-hidden="true">
            {{ displayCount() }}
          </span>
        }
      </button>

      @if (open()) {
        <div class="bell-backdrop" (click)="close()" aria-hidden="true"></div>
        <aside class="bell-panel" role="dialog" aria-label="Recent notifications">
          <header class="bell-header">
            <div class="bell-title-row">
              <span class="bell-title">Notifications</span>
              @if (unreadCount() > 0) {
                <span class="unread-pill">{{ unreadCount() }} new</span>
              }
            </div>
            <div class="bell-actions">
              @if (unreadCount() > 0) {
                <button
                  type="button"
                  class="link-btn"
                  (click)="markAllRead()"
                  title="Mark all as read"
                >
                  Mark all read
                </button>
              }
            </div>
          </header>

          <!-- Severity filter chips ───────────────────────────────────── -->
          <div class="filter-bar" role="group" aria-label="Filter by severity">
            @for (sev of severities; track sev) {
              <button
                type="button"
                class="chip"
                [class.chip--active]="severityFilter().has(sev)"
                [attr.data-sev]="sev"
                (click)="toggleSeverity(sev)"
                [title]="
                  severityFilter().has(sev) ? 'Hide ' + sev : 'Show only ' + sev + ' (and others)'
                "
              >
                <span class="sev-dot" [attr.data-sev]="sev" aria-hidden="true"></span>
                {{ sev }}
                <span class="chip-count">{{ countBySeverity()[sev] || 0 }}</span>
              </button>
            }
            @if (severityFilter().size > 0) {
              <button type="button" class="link-btn clear-btn" (click)="clearFilters()">
                Clear
              </button>
            }
          </div>

          <div class="bell-list">
            @if (resource.loading() && (resource.value()?.items?.length ?? 0) === 0) {
              <div class="bell-empty">Loading…</div>
            } @else if (resource.error()) {
              <div class="bell-empty bell-empty--error">
                Couldn't load notifications.
                <button type="button" class="link-btn" (click)="resource.refresh()">Retry</button>
              </div>
            } @else if (visible().length === 0) {
              <div class="bell-empty">
                @if (severityFilter().size > 0) {
                  No items match the active filter.
                } @else {
                  No recent notifications.
                }
              </div>
            } @else {
              @for (item of visible(); track item.id) {
                <div
                  class="bell-row"
                  [class.bell-row--unread]="!item.isRead"
                  [class.bell-row--muted]="item.isMuted"
                >
                  <button
                    type="button"
                    class="bell-row-link"
                    (click)="openDetail(item)"
                    [attr.aria-label]="'Show details for ' + item.title"
                  >
                    <span
                      class="sev-dot"
                      [attr.data-sev]="item.severity"
                      [title]="item.severity + ' • ' + item.source"
                      aria-hidden="true"
                    ></span>
                    <div class="row-body">
                      <div class="row-title">
                        <span class="row-source-tag" [attr.data-src]="item.source">
                          {{ sourceLabel(item.source) }}
                        </span>
                        <span class="alert-type">{{ item.title }}</span>
                        @if (item.symbol) {
                          <span class="alert-sym mono">{{ item.symbol }}</span>
                        }
                      </div>
                      <div class="row-meta">
                        <span [title]="item.occurredAtUtc | date: 'medium'">
                          {{ item.occurredAtUtc | relativeTime }}
                        </span>
                        @if (item.subtitle) {
                          <span class="row-subtitle">· {{ item.subtitle }}</span>
                        }
                        @if (item.isMuted) {
                          <span class="muted-tag">muted</span>
                        }
                      </div>
                    </div>
                  </button>

                  <!-- Per-row kebab → mute / unmute ─────────────────── -->
                  <div class="row-kebab-wrap">
                    <button
                      type="button"
                      class="row-kebab"
                      (click)="$event.stopPropagation(); toggleRowMenu(item.id)"
                      [attr.aria-label]="'Options for ' + item.title + ' (' + item.typeKey + ')'"
                      title="Options"
                    >
                      <span aria-hidden="true">⋯</span>
                    </button>
                    @if (openRowMenu() === item.id) {
                      <div class="row-menu" (click)="$event.stopPropagation()" role="menu">
                        @if (!item.isMuted) {
                          <button type="button" role="menuitem" (click)="mute(item, 1)">
                            Mute this type for 1h
                          </button>
                          <button type="button" role="menuitem" (click)="mute(item, 24)">
                            Mute for 24h
                          </button>
                          <button type="button" role="menuitem" (click)="mute(item, 168)">
                            Mute for 7d
                          </button>
                        } @else {
                          <button type="button" role="menuitem" (click)="unmute(item)">
                            Unmute this type
                          </button>
                        }
                        <hr class="row-menu-sep" />
                        <div class="row-menu-meta">{{ item.typeKey }}</div>
                      </div>
                    }
                  </div>
                </div>
              }
            }
          </div>

          <footer class="bell-footer">
            <span class="footer-mode" [class.footer-mode--live]="realtime.isConnected()">
              {{ realtime.isConnected() ? '⚡ Live' : '⏱ Polling' }}
            </span>
            <a class="link-btn" [routerLink]="['/alert-triage']" (click)="close()">
              View all alerts →
            </a>
          </footer>
        </aside>
      }

      <!-- ── Detail modal ────────────────────────────────────────────────
           Row click opens a full-detail modal anchored to the page
           (not the panel) so the operator can read long content (full
           ERROR messages, gate-rejection metadataJson) without the bell
           dropdown's vertical squeeze.  Actions: Open source page,
           Mute, Mark read (single), Close. -->
      @if (selectedItem(); as sel) {
        <div class="modal-backdrop" (click)="closeDetail()" aria-hidden="true"></div>
        <div class="modal" role="dialog" aria-modal="true" [attr.aria-label]="sel.title">
          <header class="modal-header">
            <div class="modal-title-row">
              <span class="sev-dot" [attr.data-sev]="sel.severity" aria-hidden="true"></span>
              <span class="row-source-tag" [attr.data-src]="sel.source">
                {{ sourceLabel(sel.source) }}
              </span>
              <span class="modal-title">{{ sel.title }}</span>
            </div>
            <button
              type="button"
              class="btn-ghost"
              (click)="closeDetail()"
              aria-label="Close"
              title="Close (Esc)"
            >
              ✕
            </button>
          </header>

          <div class="modal-body">
            <div class="modal-meta-row">
              <span [title]="sel.occurredAtUtc | date: 'medium'">
                {{ sel.occurredAtUtc | relativeTime }}
              </span>
              <span class="modal-meta-sep">·</span>
              <span class="modal-sev" [attr.data-sev]="sel.severity">{{ sel.severity }}</span>
              @if (sel.symbol) {
                <span class="modal-meta-sep">·</span>
                <span class="mono">{{ sel.symbol }}</span>
              }
              @if (sel.instanceId) {
                <span class="modal-meta-sep">·</span>
                <span class="mono small">{{ sel.instanceId }}</span>
              }
              @if (sel.isMuted) {
                <span class="modal-meta-sep">·</span>
                <span class="muted-tag">muted</span>
              }
            </div>

            @if (sel.subtitle) {
              <p class="modal-subtitle">{{ sel.subtitle }}</p>
            }

            @if (sel.details && sel.details.length > 0) {
              <dl class="kv-list">
                @for (kv of sel.details; track kv.label) {
                  <dt>{{ kv.label }}</dt>
                  <dd
                    [class.dd-block]="isMultilineValue(kv.value)"
                    [class.dd-json]="looksLikeJson(kv.value)"
                  >
                    {{ kv.value }}
                  </dd>
                }
              </dl>
            }

            <div class="modal-typekey">
              Mute key:
              <span class="mono small">{{ sel.typeKey }}</span>
            </div>
          </div>

          <footer class="modal-footer">
            <div class="modal-footer-left">
              @if (!sel.isMuted) {
                <button
                  type="button"
                  class="btn-secondary"
                  (click)="muteFromModal(sel, 1)"
                  title="Mute this type for 1 hour"
                >
                  Mute 1h
                </button>
                <button
                  type="button"
                  class="btn-secondary"
                  (click)="muteFromModal(sel, 24)"
                  title="Mute this type for 24 hours"
                >
                  Mute 24h
                </button>
              } @else {
                <button type="button" class="btn-secondary" (click)="unmuteFromModal(sel)">
                  Unmute
                </button>
              }
            </div>
            <div class="modal-footer-right">
              <button type="button" class="btn-ghost" (click)="closeDetail()">Close</button>
              @if (sel.linkRoute) {
                <a
                  class="btn-primary"
                  [routerLink]="resolveRoute(sel)"
                  [queryParams]="sel.linkParams"
                  (click)="closeAll()"
                >
                  Open source →
                </a>
              }
            </div>
          </footer>
        </div>
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: inline-flex;
      }

      .bell-wrap {
        position: relative;
        display: inline-flex;
      }

      /* ── Bell button + badge ───────────────────────────────────────── */
      .bell-btn {
        position: relative;
      }
      .bell-badge {
        position: absolute;
        top: 0;
        right: 0;
        min-width: 16px;
        height: 16px;
        padding: 0 4px;
        border-radius: 8px;
        background: var(--accent);
        color: #fff;
        font-size: 10px;
        font-weight: 600;
        line-height: 16px;
        text-align: center;
        box-shadow: 0 0 0 1.5px var(--bg-primary);
        font-variant-numeric: tabular-nums;
      }
      .bell-badge--critical {
        background: var(--loss, #ff3b30);
      }

      /* ── Panel ─────────────────────────────────────────────────────── */
      .bell-backdrop {
        position: fixed;
        inset: 0;
        background: transparent;
        z-index: 998;
      }
      .bell-panel {
        position: absolute;
        top: calc(100% + 8px);
        right: 0;
        width: min(440px, calc(100vw - 32px));
        max-height: min(640px, calc(100vh - 96px));
        background: var(--bg-primary, #fff);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        box-shadow:
          0 12px 32px rgba(0, 0, 0, 0.12),
          0 2px 8px rgba(0, 0, 0, 0.06);
        z-index: 999;
        display: flex;
        flex-direction: column;
        animation: bell-fade-in 140ms cubic-bezier(0.4, 0, 0.2, 1);
      }
      @keyframes bell-fade-in {
        from {
          opacity: 0;
          transform: translateY(-4px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }
      .bell-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-2);
        padding: var(--space-3) var(--space-4);
        border-bottom: 1px solid var(--border);
      }
      .bell-title-row {
        display: flex;
        align-items: center;
        gap: var(--space-2);
      }
      .bell-title {
        font-weight: 600;
        color: var(--text-primary);
      }
      .unread-pill {
        font-size: var(--text-xs);
        background: var(--accent);
        color: #fff;
        padding: 1px 8px;
        border-radius: 10px;
        font-weight: 500;
      }
      .bell-actions {
        display: flex;
        gap: var(--space-2);
      }
      .link-btn {
        background: transparent;
        border: none;
        color: var(--accent);
        cursor: pointer;
        font-size: var(--text-xs);
        padding: 2px 4px;
        text-decoration: none;
        font-weight: 500;
      }
      .link-btn:hover {
        text-decoration: underline;
      }

      /* ── Severity chips ────────────────────────────────────────────── */
      .filter-bar {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        padding: var(--space-2) var(--space-4);
        border-bottom: 1px solid var(--border);
        background: var(--bg-secondary);
      }
      .chip {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 3px 10px;
        border: 1px solid var(--border);
        background: var(--bg-primary);
        border-radius: 12px;
        font-size: var(--text-xs);
        color: var(--text-secondary);
        cursor: pointer;
        transition:
          background-color 120ms ease-out,
          border-color 120ms ease-out;
      }
      .chip:hover {
        border-color: var(--text-tertiary);
      }
      .chip--active {
        background: rgba(0, 113, 227, 0.08);
        border-color: var(--accent);
        color: var(--text-primary);
        font-weight: 500;
      }
      .chip-count {
        font-size: 10px;
        color: var(--text-tertiary);
        font-variant-numeric: tabular-nums;
      }
      .clear-btn {
        margin-left: auto;
      }

      /* ── List ──────────────────────────────────────────────────────── */
      .bell-list {
        flex: 1;
        overflow-y: auto;
        min-height: 80px;
      }
      .bell-empty {
        padding: var(--space-4);
        text-align: center;
        color: var(--text-tertiary);
        font-size: var(--text-sm);
      }
      .bell-empty--error {
        color: var(--loss, #ff3b30);
      }

      /* Row layout: link occupies most of the width, kebab on the right.  */
      .bell-row {
        display: flex;
        align-items: stretch;
        gap: 0;
        border-bottom: 1px solid var(--border);
        background: transparent;
        transition: background-color 120ms ease-out;
      }
      .bell-row:hover {
        background: var(--bg-secondary);
      }
      .bell-row:last-child {
        border-bottom: none;
      }
      .bell-row--unread {
        background: rgba(0, 113, 227, 0.04);
      }
      .bell-row--unread:hover {
        background: rgba(0, 113, 227, 0.08);
      }
      .bell-row--muted .row-body {
        opacity: 0.5;
      }

      .bell-row-link {
        display: flex;
        align-items: flex-start;
        gap: var(--space-3);
        padding: var(--space-3) var(--space-3) var(--space-3) var(--space-4);
        flex: 1;
        min-width: 0;
        text-decoration: none;
        color: inherit;
        background: transparent;
        border: none;
        font: inherit;
        text-align: left;
        cursor: pointer;
        width: 100%;
      }
      .bell-row-link:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: -2px;
      }
      .sev-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        margin-top: 6px;
        flex-shrink: 0;
        background: var(--text-tertiary);
      }
      .sev-dot[data-sev='Info'] {
        background: #0071e3;
      }
      .sev-dot[data-sev='Medium'] {
        background: #ff9500;
      }
      .sev-dot[data-sev='High'] {
        background: #ff6b35;
      }
      .sev-dot[data-sev='Critical'] {
        background: var(--loss, #ff3b30);
      }
      .row-body {
        flex: 1;
        min-width: 0;
      }
      .row-title {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 6px;
        font-size: var(--text-sm);
        color: var(--text-primary);
      }
      .row-source-tag {
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        padding: 1px 6px;
        border-radius: 8px;
        background: var(--bg-tertiary);
        color: var(--text-tertiary);
        flex-shrink: 0;
      }
      .row-source-tag[data-src='Alert'] {
        color: #0071e3;
      }
      .row-source-tag[data-src='EALog'] {
        color: #ff6b35;
      }
      .row-source-tag[data-src='SignalRejection'] {
        color: #ff9500;
      }
      .row-source-tag[data-src='EAState'] {
        color: var(--loss, #ff3b30);
      }
      .alert-type {
        font-weight: 500;
        word-break: break-word;
      }
      .alert-sym {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
      }
      .row-meta {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 4px 8px;
        margin-top: 2px;
        font-size: var(--text-xs);
        color: var(--text-tertiary);
      }
      .row-subtitle {
        word-break: break-word;
        max-width: 100%;
      }
      .muted-tag {
        background: var(--bg-tertiary);
        color: var(--text-tertiary);
        padding: 1px 6px;
        border-radius: 8px;
        font-size: 10px;
      }
      .mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
      }

      /* ── Per-row kebab + menu ──────────────────────────────────────── */
      .row-kebab-wrap {
        position: relative;
        display: flex;
        align-items: center;
        padding-right: var(--space-2);
      }
      .row-kebab {
        background: transparent;
        border: none;
        color: var(--text-tertiary);
        cursor: pointer;
        font-size: var(--text-lg);
        line-height: 1;
        padding: 4px 6px;
        border-radius: var(--radius-sm);
      }
      .row-kebab:hover {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }
      .row-menu {
        position: absolute;
        top: 100%;
        right: 4px;
        z-index: 1;
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
        padding: 4px;
        min-width: 180px;
        display: flex;
        flex-direction: column;
      }
      .row-menu button {
        background: transparent;
        border: none;
        color: var(--text-primary);
        text-align: left;
        cursor: pointer;
        font-size: var(--text-sm);
        padding: 6px 10px;
        border-radius: var(--radius-sm);
      }
      .row-menu button:hover {
        background: var(--bg-secondary);
      }
      .row-menu-sep {
        border: none;
        border-top: 1px solid var(--border);
        margin: 4px 0;
      }
      .row-menu-meta {
        padding: 4px 10px;
        font-size: 10px;
        color: var(--text-tertiary);
        font-family: 'SF Mono', 'Fira Code', monospace;
        word-break: break-all;
      }

      /* ── Footer ────────────────────────────────────────────────────── */
      .bell-footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-2);
        padding: var(--space-2) var(--space-4);
        border-top: 1px solid var(--border);
        background: var(--bg-secondary);
        border-bottom-left-radius: var(--radius-md);
        border-bottom-right-radius: var(--radius-md);
      }
      .footer-mode {
        font-size: 10px;
        color: var(--text-tertiary);
        letter-spacing: 0.02em;
      }
      .footer-mode--live {
        color: var(--positive, #34c759);
      }

      /* ── Detail modal ──────────────────────────────────────────────── */
      .modal-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.36);
        z-index: 1000;
        animation: modal-fade-in 160ms cubic-bezier(0.4, 0, 0.2, 1);
      }
      .modal {
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        width: min(620px, calc(100vw - 32px));
        max-height: min(80vh, 720px);
        background: var(--bg-primary, #fff);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        box-shadow: 0 24px 64px rgba(0, 0, 0, 0.22);
        z-index: 1001;
        display: flex;
        flex-direction: column;
        animation:
          modal-fade-in 160ms cubic-bezier(0.4, 0, 0.2, 1),
          modal-zoom-in 160ms cubic-bezier(0.4, 0, 0.2, 1);
      }
      @keyframes modal-fade-in {
        from {
          opacity: 0;
        }
        to {
          opacity: 1;
        }
      }
      @keyframes modal-zoom-in {
        from {
          transform: translate(-50%, -50%) scale(0.97);
        }
        to {
          transform: translate(-50%, -50%) scale(1);
        }
      }
      .modal-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-3);
        padding: var(--space-3) var(--space-4);
        border-bottom: 1px solid var(--border);
        background: var(--bg-secondary);
        border-top-left-radius: var(--radius-md);
        border-top-right-radius: var(--radius-md);
      }
      .modal-title-row {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        min-width: 0;
        flex: 1;
      }
      .modal-title {
        font-weight: 600;
        color: var(--text-primary);
        word-break: break-word;
        flex: 1;
        min-width: 0;
      }
      .btn-ghost {
        background: transparent;
        border: none;
        color: var(--text-secondary);
        cursor: pointer;
        font-size: var(--text-md);
        padding: 6px 10px;
        border-radius: var(--radius-sm);
        font: inherit;
      }
      .btn-ghost:hover {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }
      .modal-body {
        flex: 1;
        overflow-y: auto;
        padding: var(--space-4);
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .modal-meta-row {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 6px;
        font-size: var(--text-xs);
        color: var(--text-tertiary);
      }
      .modal-meta-sep {
        color: var(--text-tertiary);
        opacity: 0.5;
      }
      .modal-sev {
        font-weight: 500;
      }
      .modal-sev[data-sev='Info'] {
        color: #0071e3;
      }
      .modal-sev[data-sev='Medium'] {
        color: #ff9500;
      }
      .modal-sev[data-sev='High'] {
        color: #ff6b35;
      }
      .modal-sev[data-sev='Critical'] {
        color: var(--loss, #ff3b30);
      }
      .modal-subtitle {
        margin: 0;
        color: var(--text-primary);
        font-size: var(--text-sm);
        word-break: break-word;
      }
      .kv-list {
        display: grid;
        grid-template-columns: minmax(120px, 1fr) 2.5fr;
        gap: var(--space-1) var(--space-3);
        margin: 0;
      }
      .kv-list dt {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
        align-self: start;
        padding-top: 3px;
      }
      .kv-list dd {
        margin: 0;
        color: var(--text-primary);
        font-size: var(--text-sm);
        word-break: break-word;
      }
      /* Long, multi-paragraph values get a block treatment so they don't
         collapse the kv grid layout. */
      .kv-list dd.dd-block {
        grid-column: 1 / -1;
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        padding: var(--space-2) var(--space-3);
        white-space: pre-wrap;
        max-height: 220px;
        overflow-y: auto;
      }
      .kv-list dd.dd-json {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: var(--text-xs);
      }
      .modal-typekey {
        margin-top: auto;
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        padding-top: var(--space-2);
        border-top: 1px dashed var(--border);
      }
      .modal-footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-2);
        padding: var(--space-3) var(--space-4);
        border-top: 1px solid var(--border);
        background: var(--bg-secondary);
        border-bottom-left-radius: var(--radius-md);
        border-bottom-right-radius: var(--radius-md);
      }
      .modal-footer-left,
      .modal-footer-right {
        display: flex;
        gap: var(--space-2);
        align-items: center;
      }
      .btn-secondary {
        background: var(--bg-primary);
        border: 1px solid var(--border);
        color: var(--text-primary);
        padding: 6px 12px;
        border-radius: var(--radius-sm);
        cursor: pointer;
        font-size: var(--text-xs);
        font: inherit;
      }
      .btn-secondary:hover {
        border-color: var(--text-tertiary);
      }
      .btn-primary {
        background: var(--accent);
        color: #fff;
        padding: 6px 14px;
        border-radius: var(--radius-sm);
        text-decoration: none;
        font-size: var(--text-sm);
        font-weight: 500;
        border: none;
        cursor: pointer;
      }
      .btn-primary:hover {
        opacity: 0.92;
      }
      .small {
        font-size: var(--text-xs);
      }
    `,
  ],
})
export class NotificationBellComponent {
  private readonly feedService = inject(NotificationsFeedService);
  protected readonly realtime = inject(RealtimeService);
  private readonly notify = inject(NotificationService);
  private readonly router = inject(Router);

  /** Cap the displayed badge — "9+" once we cross the threshold. */
  private static readonly BADGE_CAP = 9;
  /** Lookback window in hours. */
  private static readonly WINDOW_HOURS = 24;
  /** Visible row cap inside the dropdown. */
  private static readonly LIST_CAP = 100;

  readonly open = signal(false);
  readonly openRowMenu = signal<string | null>(null);
  /**
   * The notification currently shown in the detail modal.  Null = closed.
   * Held separately from `open()` so the modal can stay up after the bell
   * panel itself is dismissed (e.g. operator clicks the bell-icon to clear
   * the badge but leaves the modal open to keep reading).
   */
  readonly selectedItem = signal<NotificationFeedItem | null>(null);

  /** Severity filter — empty set = show all. */
  readonly severityFilter = signal<Set<Severity>>(new Set());
  protected readonly severities = ALL_SEVERITIES;

  protected readonly resource = createPolledResource(
    () =>
      this.feedService
        .getFeed({
          windowHours: NotificationBellComponent.WINDOW_HOURS,
          limit: NotificationBellComponent.LIST_CAP,
        })
        .pipe(
          map((res) => res.data ?? null),
          catchError(() => of<NotificationFeedResult | null>(null)),
        ),
    { intervalMs: 30_000 },
  );

  constructor() {
    // SignalR push tickle — refresh immediately on every notificationsChanged.
    // The hub auto-connects via RealtimeService elsewhere in the app shell.
    this.realtime
      .on<{ atUtc: string; advancedSec: number }>('notificationsChanged')
      .pipe(takeUntilDestroyed())
      .subscribe(() => this.resource.refresh());
  }

  // ── Derived state ────────────────────────────────────────────────────

  readonly items = computed<NotificationFeedItem[]>(() => this.resource.value()?.items ?? []);

  /** Items after severity filter is applied (in-panel filtering). */
  readonly visible = computed<NotificationFeedItem[]>(() => {
    const filter = this.severityFilter();
    const rows = this.items();
    if (filter.size === 0) return rows;
    return rows.filter((r) => filter.has(r.severity as Severity));
  });

  readonly unreadCount = computed(() => this.resource.value()?.unreadCount ?? 0);

  readonly displayCount = computed(() => {
    const n = this.unreadCount();
    return n > NotificationBellComponent.BADGE_CAP
      ? `${NotificationBellComponent.BADGE_CAP}+`
      : String(n);
  });

  readonly hasCritical = computed(() =>
    this.items().some((i) => !i.isRead && !i.isMuted && i.severity === 'Critical'),
  );

  readonly countBySeverity = computed<Record<string, number>>(() => {
    const out: Record<string, number> = {};
    for (const r of this.items()) {
      out[r.severity] = (out[r.severity] ?? 0) + 1;
    }
    return out;
  });

  // ── Open / close + filters ──────────────────────────────────────────

  toggleOpen(): void {
    this.open.update((v) => !v);
    if (this.open()) {
      // Refresh on open — push tickles keep this current but a manual open
      // beats waiting on the 30s fallback interval.
      this.resource.refresh();
    } else {
      this.openRowMenu.set(null);
    }
  }

  close(): void {
    this.open.set(false);
    this.openRowMenu.set(null);
  }

  toggleSeverity(sev: Severity): void {
    this.severityFilter.update((cur) => {
      const next = new Set(cur);
      if (next.has(sev)) next.delete(sev);
      else next.add(sev);
      return next;
    });
  }

  clearFilters(): void {
    this.severityFilter.set(new Set());
  }

  // ── Detail modal ─────────────────────────────────────────────────────

  /**
   * Open the rich-detail modal for a row.  Doesn't close the bell panel
   * automatically — the operator can keep the dropdown context.  Closes
   * any open row-menu so the modal isn't visually competing with it.
   */
  openDetail(item: NotificationFeedItem): void {
    this.openRowMenu.set(null);
    this.selectedItem.set(item);
  }

  closeDetail(): void {
    this.selectedItem.set(null);
  }

  /** Used by "Open source" — close both modal AND bell panel. */
  closeAll(): void {
    this.closeDetail();
    this.close();
  }

  muteFromModal(item: NotificationFeedItem, hours: number): void {
    this.feedService.mute({ typeKey: item.typeKey, durationHours: hours }).subscribe({
      next: () => {
        this.notify.info(`Muted ${item.typeKey} for ${humanDuration(hours)}`);
        this.resource.refresh();
        // Reflect the muted state in the currently-open modal without forcing
        // a full re-open.  Mark the local copy so the footer flips actions.
        this.selectedItem.update((cur) =>
          cur && cur.id === item.id ? { ...cur, isMuted: true } : cur,
        );
      },
      error: () => this.notify.error('Failed to mute'),
    });
  }

  unmuteFromModal(item: NotificationFeedItem): void {
    this.feedService.unmute({ typeKey: item.typeKey }).subscribe({
      next: () => {
        this.notify.info(`Unmuted ${item.typeKey}`);
        this.resource.refresh();
        this.selectedItem.update((cur) =>
          cur && cur.id === item.id ? { ...cur, isMuted: false } : cur,
        );
      },
      error: () => this.notify.error('Failed to unmute'),
    });
  }

  /** Heuristic for "this value should be rendered as a block element" — long
   *  strings, anything with a newline, or JSON-looking blobs.  Used by the
   *  template to switch the dd between inline and full-row layout. */
  isMultilineValue(value: string | null | undefined): boolean {
    if (!value) return false;
    return value.length > 80 || value.includes('\n');
  }

  /** Lightweight JSON-shape sniff for monospace styling.  We don't actually
   *  parse — false negatives are fine (still readable as plain text). */
  looksLikeJson(value: string | null | undefined): boolean {
    if (!value) return false;
    const trimmed = value.trim();
    return (
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))
    );
  }

  // ── Mark all read ────────────────────────────────────────────────────

  markAllRead(): void {
    const asOf = this.items()[0]?.occurredAtUtc;
    this.feedService.markAllRead({ asOfUtc: asOf }).subscribe({
      next: () => this.resource.refresh(),
      error: () => this.notify.error('Failed to mark notifications read'),
    });
  }

  // ── Per-row mute / unmute ────────────────────────────────────────────

  toggleRowMenu(itemId: string): void {
    this.openRowMenu.update((cur) => (cur === itemId ? null : itemId));
  }

  mute(item: NotificationFeedItem, hours: number): void {
    this.feedService.mute({ typeKey: item.typeKey, durationHours: hours }).subscribe({
      next: () => {
        this.openRowMenu.set(null);
        this.notify.info(`Muted ${item.typeKey} for ${humanDuration(hours)}`);
        this.resource.refresh();
      },
      error: () => this.notify.error('Failed to mute'),
    });
  }

  unmute(item: NotificationFeedItem): void {
    this.feedService.unmute({ typeKey: item.typeKey }).subscribe({
      next: () => {
        this.openRowMenu.set(null);
        this.notify.info(`Unmuted ${item.typeKey}`);
        this.resource.refresh();
      },
      error: () => this.notify.error('Failed to unmute'),
    });
  }

  // ── Link helpers ─────────────────────────────────────────────────────

  resolveRoute(item: NotificationFeedItem): unknown[] {
    // Angular's routerLink accepts a path string as a single-element array
    // — slashes in the value are resolved against the current URL tree.
    return [item.linkRoute ?? '/alert-triage'];
  }

  sourceLabel(source: string): string {
    switch (source) {
      case 'Alert':
        return 'Alert';
      case 'EALog':
        return 'EA Error';
      case 'SignalRejection':
        return 'Rejection';
      case 'EAState':
        return 'EA State';
      default:
        return source;
    }
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  @HostListener('document:keydown.escape')
  onEscape(): void {
    // Modal takes precedence — Esc closes it without dismissing the bell.
    if (this.selectedItem()) this.closeDetail();
    else if (this.openRowMenu()) this.openRowMenu.set(null);
    else if (this.open()) this.close();
  }

  @HostListener('document:mousedown', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    // Outside-click closes the bell panel.  The modal has its own backdrop
    // click handler so we don't tear it down here — that would close it
    // every time the operator clicked inside the body to scroll/select.
    if (!this.open() || this.selectedItem()) return;
    const target = event.target as HTMLElement | null;
    if (!target) return;
    const root = target.closest('app-notification-bell');
    if (!root) this.close();
  }
}

function humanDuration(hours: number): string {
  if (hours >= 168) return `${Math.round(hours / 168)}d`;
  if (hours >= 24) return `${Math.round(hours / 24)}d`;
  return `${hours}h`;
}
