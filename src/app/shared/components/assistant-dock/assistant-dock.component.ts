import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { Router } from '@angular/router';
import { fromEvent } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { AnalysisChatComponent } from '@shared/components/analysis-chat/analysis-chat.component';
import { AssistantDockService } from '@core/assistant/assistant-dock.service';
import { AssistantService } from '@core/assistant/assistant.service';
import { PageContextService } from '@core/assistant/page-context.service';
import { WallModeService } from '@core/wall-mode/wall-mode.service';

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
 */
@Component({
  selector: 'app-assistant-dock',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AnalysisChatComponent],
  template: `
    @if (!wallMode.enabled()) {
      @if (!dock.open()) {
        <button
          type="button"
          class="fab"
          (click)="openDock()"
          aria-label="Open assistant"
          [attr.aria-expanded]="false"
          title="Assistant (⌘/)"
        >
          <span class="fab-glyph" aria-hidden="true">✦</span>
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
              <app-analysis-chat
                [llmInvocationId]="id"
                [fillHeight]="true"
                [showMonitors]="false"
                [contextProvider]="contextProvider"
              />
            }
          </div>
        </aside>
      }
    }
  `,
  styles: [
    `
      /* ── Collapsed bubble ────────────────────────────────────────────────
         90 keeps it under the sidebar (100) and every modal (998+): a bubble
         hovering over a modal backdrop is noise during a focused task. */
      .fab {
        position: fixed;
        right: var(--space-5);
        bottom: calc(var(--space-5) + env(safe-area-inset-bottom, 0px));
        z-index: 90;
        width: 52px;
        height: 52px;
        border-radius: 50%;
        border: 1px solid var(--border);
        background: var(--accent);
        color: #fff;
        cursor: pointer;
        box-shadow: 0 6px 20px rgba(0, 0, 0, 0.22);
        display: grid;
        place-items: center;
        transition:
          transform var(--dur-base, 0.2s) var(--ease-out-soft, ease),
          box-shadow var(--dur-base, 0.2s) var(--ease-out-soft, ease);
      }
      .fab:hover {
        transform: translateY(-2px);
        box-shadow: 0 10px 28px rgba(0, 0, 0, 0.28);
      }
      .fab-glyph {
        font-size: 20px;
        line-height: 1;
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
  protected readonly wallMode = inject(WallModeService);
  private readonly assistant = inject(AssistantService);
  private readonly pageContext = inject(PageContextService);
  private readonly router = inject(Router);

  private readonly dockEl = viewChild<ElementRef<HTMLElement>>('dockEl');

  protected readonly starting = signal(false);
  protected readonly startError = signal<string | null>(null);

  /** Short label for the page the assistant can currently see. */
  protected readonly contextLabel = computed(() => this.pageLabel());
  private readonly pageLabel = signal<string | null>(null);

  /** Passed to the chat; called at send time so it reads the page as it is then. */
  protected readonly contextProvider = (): unknown | null => {
    const json = this.pageContext.captureJson();
    return json ? JSON.parse(json) : null;
  };

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
