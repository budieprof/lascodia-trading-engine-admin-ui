import { Injectable, computed, effect, signal } from '@angular/core';

const STORAGE_KEY = 'lascodia.assistant.dock';
const SESSION_KEY = 'lascodia.assistant.conversationId';

/** Drawer width bounds. Narrower than 340 cannot hold a code block; wider than 760 leaves
 *  no page to be contextual about. */
const MIN_WIDTH = 340;
const MAX_WIDTH = 760;
const DEFAULT_WIDTH = 460;

interface DockState {
  open: boolean;
  width: number;
  maximised: boolean;
}

/**
 * Open/closed, size and current conversation for the assistant dock.
 *
 * <p>Separate from the component so the state survives the component being torn down, and so
 * anything else (a "ask the assistant about this" button on a page) can open it later.</p>
 */
@Injectable({ providedIn: 'root' })
export class AssistantDockService {
  private readonly state = signal<DockState>(this.restore());

  readonly open = computed(() => this.state().open);
  readonly width = computed(() => this.state().width);
  readonly maximised = computed(() => this.state().maximised);

  /** Anchor conversation for the thread currently in the dock. */
  readonly conversationId = signal<number | null>(this.restoreConversation());

  constructor() {
    effect(() => {
      const s = this.state();
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
      } catch {
        /* private window or blocked storage — the dock still works, it just forgets */
      }
    });
    effect(() => {
      const id = this.conversationId();
      try {
        if (id === null) localStorage.removeItem(SESSION_KEY);
        else localStorage.setItem(SESSION_KEY, String(id));
      } catch {
        /* as above */
      }
    });
  }

  toggle(): void {
    this.state.update((s) => ({ ...s, open: !s.open }));
  }

  openDock(): void {
    this.state.update((s) => ({ ...s, open: true }));
  }

  close(): void {
    this.state.update((s) => ({ ...s, open: false }));
  }

  toggleMaximised(): void {
    this.state.update((s) => ({ ...s, maximised: !s.maximised }));
  }

  setWidth(px: number): void {
    const width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(px)));
    this.state.update((s) => ({ ...s, width }));
  }

  /** Forget the current thread; the next open starts a new one. */
  clearConversation(): void {
    this.conversationId.set(null);
  }

  private restore(): DockState {
    const fallback: DockState = { open: false, width: DEFAULT_WIDTH, maximised: false };
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw) as Partial<DockState>;
      return {
        // Deliberately does NOT restore `open`: an operator returning to the console should
        // see their data, not a chat panel they left open three days ago.
        open: false,
        width: Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Number(parsed.width) || DEFAULT_WIDTH)),
        maximised: parsed.maximised === true,
      };
    } catch {
      return fallback;
    }
  }

  private restoreConversation(): number | null {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      const id = raw ? Number(raw) : NaN;
      return Number.isFinite(id) && id > 0 ? id : null;
    } catch {
      return null;
    }
  }
}
