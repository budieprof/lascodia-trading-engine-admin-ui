import { computed, signal, type WritableSignal } from '@angular/core';

import {
  RAIL_LAYOUT,
  RAIL_STANDALONE,
  TOOLS,
  toolFor,
  type DrawingKind,
  type ToolSpec,
} from '../../drawings/model';

/** The page's per-browser drawing preferences (synced through the chart preferences once they are bound). */
export interface ChartDrawingToolsDeps {
  readPref<T>(key: string, fallback: T): T;
  writePref(key: string, value: unknown): void;
  /** The favourite drawing tools (DR-I12): starred in the flyouts, on the Favourites bar. */
  favorites: { toggle(kind: DrawingKind): void };
}

/**
 * US02b: the chart page's drawing-tool state — the armed tool, the magnet and its strength, stay-in-drawing, the
 * rail's families, their last-used tool and the open flyout — moved out of ChartAnalysisPageComponent, behaviour
 * for behaviour. The drawing rail reads it directly (the page provides it); the page keeps the keyboard shortcuts
 * and closing every menu at once, and aliases these signals under their old names.
 */
export class ChartDrawingTools {
  constructor(private readonly deps: ChartDrawingToolsDeps) {
    this.magnetStrength = signal<'weak' | 'strong'>(deps.readPref('magnetStrength', 'weak'));
    this.stayInDrawing = signal<boolean>(deps.readPref('stayInDrawing', false));
  }

  readonly tools = TOOLS;
  readonly tool = signal<DrawingKind | null>(null);
  readonly magnet = signal(false);
  /** Strength used when the magnet is on — TradingView's Weak / Strong. */
  readonly magnetStrength: WritableSignal<'weak' | 'strong'>;
  readonly magnetMenuOpen = signal(false);
  /** What the chart applies: off, or the chosen strength. */
  readonly magnetMode = computed(() => (this.magnet() ? this.magnetStrength() : 'off'));
  /** TV "Stay in drawing mode". */
  readonly stayInDrawing: WritableSignal<boolean>;

  readonly toolGroups = computed(() =>
    RAIL_LAYOUT.map((g) => {
      const sections = g.sections.map((sec) => ({
        title: sec.title,
        tools: sec.kinds.map((k) => toolFor(k)).filter((t): t is ToolSpec => !!t),
      }));
      return { name: g.id, title: g.title, sections, tools: sections.flatMap((sec) => sec.tools) };
    }),
  );
  readonly railStandalone = RAIL_STANDALONE.map((k) => toolFor(k)).filter(
    (t): t is ToolSpec => !!t,
  );

  /** Which tool each rail button currently shows — the family's last-used, as on TradingView. */
  readonly railPick = signal<Record<string, DrawingKind>>({});
  /** Group whose flyout is open, or null. */
  readonly railFlyout = signal<string | null>(null);
  /** Vertical offset of the open flyout, aligned to its rail button. */
  readonly railFlyoutTop = signal(0);

  /** Flyout contents for the open group. */
  readonly openRailGroup = computed(() => {
    const name = this.railFlyout();
    return name ? (this.toolGroups().find((g) => g.name === name) ?? null) : null;
  });

  /** The preferences as stored (after the synced preferences load). */
  reloadPrefs(): void {
    this.magnetStrength.set(this.deps.readPref('magnetStrength', 'weak'));
    this.stayInDrawing.set(this.deps.readPref('stayInDrawing', false));
  }

  railTool(group: { name: string; tools: readonly ToolSpec[] }): ToolSpec {
    const kind = this.railPick()[group.name];
    return group.tools.find((t) => t.kind === kind) ?? group.tools[0];
  }

  railGroupActive(group: { tools: readonly ToolSpec[] }): boolean {
    const t = this.tool();
    return t !== null && group.tools.some((x) => x.kind === t);
  }

  toggleRailFlyout(name: string, ev: MouseEvent): void {
    ev.stopPropagation();
    if (this.railFlyout() === name) {
      this.railFlyout.set(null);
      return;
    }
    const btn = (ev.currentTarget as HTMLElement).closest('.rail-slot') as HTMLElement | null;
    const rail = btn?.closest('.chart-body') as HTMLElement | null;
    if (btn && rail) {
      this.railFlyoutTop.set(btn.getBoundingClientRect().top - rail.getBoundingClientRect().top);
    }
    this.railFlyout.set(name);
  }

  /** Star / unstar a tool in a rail flyout (the click does not arm it). */
  toggleFavoriteTool(kind: DrawingKind, ev: Event): void {
    ev.stopPropagation();
    this.deps.favorites.toggle(kind);
  }

  pickRailTool(group: string, kind: DrawingKind): void {
    this.railPick.update((m) => ({ ...m, [group]: kind }));
    this.railFlyout.set(null);
    this.tool.set(kind);
  }

  selectTool(kind: DrawingKind | null): void {
    this.tool.set(this.tool() === kind ? null : kind);
  }

  toggleMagnetMenu(ev: MouseEvent): void {
    ev.stopPropagation();
    this.railFlyout.set(null);
    if (this.magnetMenuOpen()) {
      this.magnetMenuOpen.set(false);
      return;
    }
    const btn = (ev.currentTarget as HTMLElement).closest('.rail-slot') as HTMLElement | null;
    const body = btn?.closest('.chart-body') as HTMLElement | null;
    if (btn && body)
      this.railFlyoutTop.set(btn.getBoundingClientRect().top - body.getBoundingClientRect().top);
    this.magnetMenuOpen.set(true);
  }

  setMagnetStrength(mode: 'weak' | 'strong'): void {
    this.magnetStrength.set(mode);
    this.magnet.set(true);
    this.magnetMenuOpen.set(false);
    this.deps.writePref('magnetStrength', mode);
  }

  toggleStayInDrawing(): void {
    this.stayInDrawing.set(!this.stayInDrawing());
    this.deps.writePref('stayInDrawing', this.stayInDrawing());
  }
}
