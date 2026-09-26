import { AssistantTaskBarComponent } from './assistant-task-bar.component';
import {
  DestroyRef,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { Router, type Routes } from '@angular/router';
import { UiCommandService } from '@core/assistant/ui-command.service';
import type { UiCommand } from '@core/assistant/ui-command.types';
import { fromEvent } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { AnalysisChatComponent } from '@shared/components/analysis-chat/analysis-chat.component';
import { AssistantDockService } from '@core/assistant/assistant-dock.service';
import { AssistantService } from '@core/assistant/assistant.service';
import { PageContextService } from '@core/assistant/page-context.service';
import { ScreenCaptureService } from '@core/assistant/screen-capture.service';
import { NotificationService } from '@core/notifications/notification.service';

/**
 * The console's assistant: a bubble on every page that opens a chat which knows where you
 * are standing.
 *
 * <p>Deliberately NON-MODAL — no scrim, `aria-modal="false"`. The page behind stays
 * readable and clickable, which is the whole point of an assistant that is supposed to be
 * about the page. Z-index follows the app's census: the bubble sits at 90, below the
 * sidebar and every modal, so it never floats over a focused task; the open drawer sits at
 * 1250, above modals because the operator opened it deliberately, and below toasts so an
 * error still reaches them.</p>
 *
 * <p>Shown in wall mode too — do not re-add a `wallMode` guard here. It was hidden there on
 * the assumption that wall mode is a non-interactive kiosk view, and that assumption was
 * simply wrong: wall mode requests fullscreen and collapses the sidebar, nothing more, so
 * the operator is still working normally. The bubble was therefore the one control that
 * vanished, which read as the assistant being missing rather than suppressed — and it cost
 * an operator, then a debugging session, to find. If a genuinely non-interactive display
 * mode ever lands, gate on that, not on wall mode.</p>
 */
@Component({
  selector: 'app-assistant-dock',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AnalysisChatComponent, AssistantTaskBarComponent],
  template: `
    @if (!dock.open()) {
      <button
        type="button"
        class="fab"
        (click)="openDock()"
        aria-label="Open assistant"
        [attr.aria-expanded]="false"
        title="Ask the assistant about this page (⌘/)"
      >
        <span class="fab-glyph" aria-hidden="true">✦</span>
        <span class="fab-label">Ask</span>
      </button>
    } @else {
      <aside
        class="dock"
        role="dialog"
        aria-modal="false"
        aria-label="Assistant"
        [class.maximised]="dock.maximised()"
        [style.width.px]="dock.maximised() ? null : dock.width()"
        #dockEl
      >
        <div
          class="resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize assistant"
          (mousedown)="startResize($event)"
        ></div>

        <header class="dock-head">
          <div class="dock-title">
            <span class="dock-glyph" aria-hidden="true">✦</span>
            <span>Assistant</span>
            @if (contextLabel(); as label) {
              <span class="ctx" [title]="'The assistant can see this page'">{{ label }}</span>
            }
          </div>
          <div class="dock-actions">
            <!--
              Vision. In page mode this costs nothing: no browser prompt, no sharing banner,
              no capture session — the frame is rendered from the live DOM. Screen mode is
              still one click away for what the document cannot show, and it carries the
              browser's own picker and indicator, which the page has no way to waive.
            -->
            @if (capture.supported) {
              <button
                type="button"
                class="icon"
                [class.sharing]="capture.enabled()"
                [class.screen]="capture.sharing()"
                (click)="toggleVision()"
                [title]="
                  capture.enabled()
                    ? 'Stop letting the assistant see (' + capture.mode() + ')'
                    : 'Let the assistant see this page'
                "
                [attr.aria-pressed]="capture.enabled()"
                aria-label="Let the assistant see this page"
              >
                {{ capture.enabled() ? '👁' : '👁‍🗨' }}
              </button>
              @if (capture.enabled() && capture.screenSupported) {
                <button
                  type="button"
                  class="vision-mode"
                  (click)="toggleVisionMode()"
                  [title]="
                    capture.mode() === 'page'
                      ? 'Seeing this page only, with no browser prompt. Switch to the whole screen — the browser will ask, and will show its sharing bar.'
                      : 'Sharing your screen. Switch back to this page only, with no prompt or sharing bar.'
                  "
                >
                  {{ capture.mode() === 'page' ? 'page' : 'screen' }}
                </button>
              }
            }
            <button
              type="button"
              class="icon"
              (click)="newChat()"
              title="New chat"
              aria-label="New chat"
            >
              ✚
            </button>
            @if (dock.conversationId(); as id) {
              <button
                type="button"
                class="icon"
                (click)="openInConversations(id)"
                title="Open in Conversations"
                aria-label="Open in Conversations"
              >
                ↗
              </button>
            }
            <button
              type="button"
              class="icon"
              (click)="dock.toggleMaximised()"
              [title]="dock.maximised() ? 'Restore' : 'Maximise'"
              [attr.aria-label]="dock.maximised() ? 'Restore' : 'Maximise'"
            >
              {{ dock.maximised() ? '❐' : '⛶' }}
            </button>
            <button
              type="button"
              class="icon"
              (click)="dock.close()"
              title="Close (Esc)"
              aria-label="Close"
            >
              ✕
            </button>
          </div>
        </header>

        <div class="dock-body">
          @if (starting()) {
            <div class="dock-state">Opening a session…</div>
          } @else if (startError()) {
            <div class="dock-state error">
              {{ startError() }}
              <button type="button" class="retry" (click)="newChat()">Try again</button>
            </div>
          } @else if (dock.conversationId(); as id) {
            <app-assistant-task-bar [sessionId]="id" />
            <app-analysis-chat
              class="dock-chat"
              [llmInvocationId]="id"
              [fillHeight]="true"
              [showMonitors]="false"
              [showIdBar]="false"
              [placeholder]="'Ask about this page, or anything in the console…'"
              [emptyHint]="emptyHint()"
              [contextProvider]="contextProvider"
              [screenshotProvider]="screenshotProvider"
            />
          }
        </div>
      </aside>
    }
  `,
  styles: [
    `
      /* ── Collapsed bubble ────────────────────────────────────────────────
         90 keeps it under the sidebar (100) and every modal (998+): a bubble
         hovering over a modal backdrop is noise during a focused task. */
      /* A labelled pill rather than a bare glyph. An unlabelled 52px circle in the
         corner of a console this dense is genuinely easy to miss — the first
         operator to use it could not find it. */
      .fab {
        position: fixed;
        right: var(--space-5);
        bottom: calc(var(--space-5) + env(safe-area-inset-bottom, 0px));
        z-index: 90;
        height: 48px;
        padding: 0 var(--space-4) 0 var(--space-3);
        border-radius: 24px;
        border: 1px solid var(--border);
        background: var(--accent);
        color: #fff;
        cursor: pointer;
        box-shadow: 0 6px 20px rgba(0, 0, 0, 0.22);
        display: inline-flex;
        align-items: center;
        gap: var(--space-2);
        font: inherit;
        font-weight: var(--font-semibold);
        font-size: var(--text-sm);
        transition:
          transform var(--dur-base, 0.2s) var(--ease-out-soft, ease),
          box-shadow var(--dur-base, 0.2s) var(--ease-out-soft, ease);
      }
      .fab:hover {
        transform: translateY(-2px);
        box-shadow: 0 10px 28px rgba(0, 0, 0, 0.28);
      }
      .fab-glyph {
        font-size: 18px;
        line-height: 1;
      }
      .fab-label {
        white-space: nowrap;
      }
      /* On a phone the label costs more than it earns; the icon alone returns. */
      @media (max-width: 560px) {
        .fab {
          width: 48px;
          padding: 0;
          border-radius: 50%;
          justify-content: center;
        }
        .fab-label {
          display: none;
        }
      }

      /* ── Expanded drawer ─────────────────────────────────────────────────
         1250 sits above modals (the operator opened this on purpose) and below
         the toast container (10000) so errors still land on top. */
      .dock {
        position: fixed;
        top: 0;
        right: 0;
        bottom: 0;
        z-index: 1250;
        display: flex;
        flex-direction: column;
        background: var(--bg-primary);
        border-left: 1px solid var(--border);
        box-shadow: -12px 0 40px rgba(0, 0, 0, 0.18);
        /* The root view-transition snapshots the whole page on navigation; without its own
           name the drawer crossfades every time the operator follows a link. */
        view-transition-name: assistant-dock;
      }
      .dock.maximised {
        width: min(1100px, 92vw);
      }

      .resize-handle {
        position: absolute;
        left: -3px;
        top: 0;
        bottom: 0;
        width: 6px;
        cursor: col-resize;
        background: transparent;
      }
      .resize-handle:hover {
        background: var(--accent);
        opacity: 0.35;
      }

      .dock-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-3);
        padding: var(--space-3) var(--space-4);
        border-bottom: 1px solid var(--border);
        background: var(--bg-secondary);
        flex-shrink: 0;
      }
      .dock-title {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
        min-width: 0;
      }
      .dock-glyph {
        color: var(--accent);
      }
      .ctx {
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
        color: var(--text-tertiary);
        background: var(--bg-tertiary);
        border-radius: 10px;
        padding: 1px 8px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 18ch;
      }
      /* Vision is a state the operator should be able to see at a glance. Page mode has no
         browser indicator of its own — nothing is being captured off the screen — so this
         badge is the only signal, which is exactly why it is not subtle. */
      .icon.sharing {
        color: #fff;
        background: #1a73e8;
        border-radius: 6px;
      }
      /* Red is reserved for the browser actually capturing the screen. Wearing it in page
         mode would claim a recording that is not happening — and would leave nothing louder
         for the mode that IS. */
      .icon.sharing.screen {
        background: #d93025;
      }
      /* Which source is in use, and the switch between them. Deliberately a word rather than
         an icon: "page" and "screen" differ in what the browser will do to the operator, and
         a glyph cannot carry that. */
      .vision-mode {
        border: 1px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-secondary);
        border-radius: 999px;
        font-size: 10px;
        line-height: 1;
        padding: 4px 7px;
        cursor: pointer;
        align-self: center;
      }
      .vision-mode:hover {
        color: var(--text-primary);
      }

      .dock-actions {
        display: flex;
        gap: 2px;
        flex-shrink: 0;
      }
      .icon {
        width: 28px;
        height: 28px;
        border: none;
        background: transparent;
        color: var(--text-secondary);
        border-radius: var(--radius-sm);
        cursor: pointer;
        font-size: var(--text-sm);
      }
      .icon:hover {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }

      .dock-body {
        flex: 1;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }
      /* The chat is the drawer's content — it must take the remaining height, not sit
         at the top with the composer stranded above empty space. */
      .dock-chat {
        flex: 1;
        min-height: 0;
        display: flex;
        flex-direction: column;
      }
      .dock-state {
        padding: var(--space-5);
        color: var(--text-secondary);
        font-size: var(--text-sm);
        text-align: center;
      }
      .dock-state.error {
        color: var(--loss);
      }
      .retry {
        display: block;
        margin: var(--space-3) auto 0;
        border: 1px solid var(--border);
        background: var(--bg-secondary);
        color: var(--text-primary);
        border-radius: var(--radius-sm);
        padding: 4px 12px;
        cursor: pointer;
        font: inherit;
        font-size: var(--text-xs);
      }

      @media (max-width: 768px) {
        .dock,
        .dock.maximised {
          width: 100vw !important;
          border-left: none;
        }
      }
    `,
  ],
})
export class AssistantDockComponent {
  protected readonly dock = inject(AssistantDockService);
  private readonly assistant = inject(AssistantService);
  private readonly pageContext = inject(PageContextService);
  protected readonly capture = inject(ScreenCaptureService);
  private readonly notifications = inject(NotificationService);
  private readonly router = inject(Router);
  private readonly uiCommands = inject(UiCommandService);

  private readonly dockEl = viewChild<ElementRef<HTMLElement>>('dockEl');

  protected readonly starting = signal(false);
  protected readonly startError = signal<string | null>(null);

  /** Short label for the page the assistant can currently see. */
  protected readonly contextLabel = computed(() => this.pageLabel());
  private readonly pageLabel = signal<string | null>(null);

  /** Empty-thread hint, naming the page so the offer is concrete. */
  protected readonly emptyHint = computed(() => {
    const label = this.pageLabel();
    return label
      ? `Ask about ${label}, or anything else in the console — positions, signals, strategies, the EA fleet. I can read live data, and I will ask before changing anything.`
      : 'Ask about this page, or anything else in the console. I can read live data, and I will ask before changing anything.';
  });

  /** Passed to the chat; called at send time so it reads the page as it is then. */
  protected readonly contextProvider = (): unknown | null => {
    const json = this.pageContext.captureJson();
    return json ? JSON.parse(json) : null;
  };

  /**
   * A frame of the operator's screen at send time, or null when they are not sharing.
   *
   * <p>Grabbed per question rather than once per session, because the point is what they are
   * looking at NOW — a still from when sharing started would show a page they have since
   * navigated away from, and the assistant would describe it with total confidence.</p>
   */
  protected readonly screenshotProvider = async (): Promise<string | null> => {
    if (!this.capture.enabled()) return null;
    // Hide this panel for the shot. It is docked right over roughly a third of the page —
    // on the chart that is the price axis and the newest bars, so a frame taken with it up
    // omits exactly what a question about the chart is about. The assistant said as much
    // itself: "covering roughly the right third of the chart including the price axis".
    // '.fab', not '.assistant-fab' — the latter matches nothing, so the floating Ask button
    // used to sit in every frame.
    const frame = await this.capture.grab(['.dock', '.fab']);
    return frame?.base64 ?? null;
  };

  protected async toggleVision(): Promise<void> {
    if (this.capture.enabled()) {
      this.capture.disable();
      return;
    }
    const started = await this.capture.enable();
    const problem = this.capture.error();
    // A declined prompt is a decision, not a failure — but silence would leave the operator
    // wondering whether the toggle did anything.
    if (!started && problem) this.notifications.info?.(problem);
  }

  /**
   * Swap between seeing this page and seeing the whole screen.
   *
   * <p>Falling back to page mode when the screen prompt is declined matters: the operator
   * turned vision ON, and dropping them to blind because they cancelled a picker they did
   * not expect would be the opposite of what they asked for.</p>
   */
  protected async toggleVisionMode(): Promise<void> {
    const next = this.capture.mode() === 'page' ? 'screen' : 'page';
    const ok = await this.capture.enable(next);
    if (!ok) {
      const problem = this.capture.error();
      if (problem) this.notifications.info?.(problem);
      await this.capture.enable('page');
    }
  }

  constructor() {
    // ⌘/ (Ctrl+/) toggles. ⌘K is the command palette.
    fromEvent<KeyboardEvent>(document, 'keydown')
      .pipe(takeUntilDestroyed())
      .subscribe((e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === '/') {
          e.preventDefault();
          if (this.dock.open()) this.dock.close();
          else this.openDock();
        } else if (e.key === 'Escape' && this.dock.open()) {
          // Only when focus is inside the dock — Esc belongs to whatever the operator is
          // actually working in.
          const el = this.dockEl()?.nativeElement;
          if (el && el.contains(document.activeElement)) this.dock.close();
        }
      });

    // App-wide page commands. Pages register their own while mounted; these belong to the dock,
    // which lives as long as the console, so the assistant can move the operator anywhere —
    // before this it could only act on the chart page, the one page that registered commands.
    this.uiCommands.register(appCommands(this.router), inject(DestroyRef));

    // Keep the page chip current.
    effect(() => {
      if (!this.dock.open()) return;
      const ctx = this.pageContext.capture();
      this.pageLabel.set(ctx.pageLabel ?? ctx.breadcrumbs.at(-1) ?? null);
    });
  }

  protected openDock(): void {
    this.dock.openDock();
    if (this.dock.conversationId() === null) this.newChat();
  }

  /**
   * Starts a session eagerly rather than on the first question, so the thread exists on
   * /conversations from the moment the operator opens the dock and the id is stable.
   */
  protected newChat(): void {
    this.dock.clearConversation();
    this.starting.set(true);
    this.startError.set(null);
    this.assistant.startSession().subscribe({
      next: (res) => {
        this.starting.set(false);
        if (res?.status && res.data?.sessionLlmInvocationId) {
          this.dock.conversationId.set(res.data.sessionLlmInvocationId);
        } else {
          this.startError.set(res?.message || 'Could not open an assistant session.');
        }
      },
      error: () => {
        this.starting.set(false);
        this.startError.set('Could not reach the engine to open a session.');
      },
    });
  }

  protected openInConversations(id: number): void {
    this.router.navigate(['/conversations'], { queryParams: { conversation: id } });
    this.dock.close();
  }

  // ── Resize ──────────────────────────────────────────────────────────────
  protected startResize(ev: MouseEvent): void {
    ev.preventDefault();
    const move = (e: MouseEvent) => this.dock.setWidth(window.innerWidth - e.clientX);
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.body.style.userSelect = '';
    };
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }
}

/** A top-level console page, as the router declares it. */
interface ConsolePage {
  path: string;
  title: string;
}

/** Every page under the authenticated layout, read from the router so it can never drift. */
export function consolePages(config: Routes): ConsolePage[] {
  const shell = config.find((r) => r.path === '' && Array.isArray(r.children));
  return (shell?.children ?? [])
    .filter((r) => !!r.path && !r.redirectTo && r.path !== '**')
    .map((r) => ({
      path: '/' + r.path,
      title: (r.data?.['breadcrumb'] as string | undefined) ?? r.path!,
    }));
}

/**
 * Whether a navigation target is a real console page (or somewhere beneath one). Deep links —
 * `/monitors/646`, `/positions/123` — are fine; the first segment is what must exist.
 */
export function isConsolePath(url: string, pages: readonly ConsolePage[]): boolean {
  if (!url.startsWith('/') || url.startsWith('//')) return false;
  const first = '/' + (url.slice(1).split(/[/?#]/)[0] ?? '');
  return pages.some((p) => p.path === first);
}

function appCommands(router: Router): UiCommand[] {
  const pages = () => consolePages(router.config);
  return [
    {
      id: 'app.navigate',
      description:
        'Take the operator to any page of the console, e.g. "/monitors", "/positions/123", ' +
        '"/strategies?status=Active". The path must start with a page app.listPages returns.',
      params: [
        {
          name: 'path',
          type: 'string',
          required: true,
          description: 'Absolute in-app path beginning with "/".',
        },
      ],
      run: async (args) => {
        const url = String(args['path'] ?? '').trim();
        if (!isConsolePath(url, pages())) {
          return {
            ok: false,
            message: `"${url}" is not a console page. Call app.listPages for the valid ones.`,
          };
        }
        const ok = await router.navigateByUrl(url);
        return ok
          ? { ok: true, message: `Navigated to ${url}.` }
          : { ok: false, message: `Navigation to ${url} was refused (a guard or permission).` };
      },
    },
    {
      id: 'app.listPages',
      description: 'List every page of the console with its path, for app.navigate.',
      run: () => {
        const list = pages();
        return {
          ok: true,
          message: list.map((p) => `${p.path} — ${p.title}`).join('\n'),
          data: list,
        };
      },
    },
    {
      id: 'app.back',
      description: 'Go back to the page the operator was on before.',
      run: () => {
        history.back();
        return { ok: true, message: 'Went back one page.' };
      },
    },
  ];
}
