import { signal } from '@angular/core';
import type { DrawingKind, DrawingStyle } from './model';

/**
 * Named per-tool style templates — TradingView's "Template ▾" on the floating
 * toolbar and in the settings dialog: Save Drawing Template As…, Apply
 * Default, Save As Default, and the saved names.
 *
 * Kept in localStorage: a template is a personal preference, like
 * TradingView's, and the drawing itself carries the resulting style to the
 * engine, so nothing is lost across machines that matters to the chart.
 */
export interface DrawingTemplate {
  name: string;
  style: Partial<DrawingStyle>;
  options?: Record<string, unknown>;
}

type Shelf = Partial<
  Record<DrawingKind, { templates: DrawingTemplate[]; default?: DrawingTemplate }>
>;

const KEY = 'lascodia.chart.drawing-templates.v1';

/** Template fields — the drawing's own text is content, not style. */
export function templateStyle(style: DrawingStyle): Partial<DrawingStyle> {
  const { text: _text, ...rest } = style;
  void _text;
  return rest;
}

export class DrawingTemplates {
  private readonly shelf = signal<Shelf>({});

  constructor(private storage: Pick<Storage, 'getItem' | 'setItem'> | null) {
    this.reload();
  }

  /**
   * Switch to another storage (the synced chart preferences) and re-read: the shelf is built at
   * module load, before the engine's preferences were hydrated into the cache.
   */
  useStorage(storage: Pick<Storage, 'getItem' | 'setItem'>): void {
    this.storage = storage;
    this.reload();
  }

  reload(): void {
    try {
      const raw = this.storage?.getItem(KEY);
      this.shelf.set(raw ? (JSON.parse(raw) as Shelf) : {});
    } catch {
      /* unreadable shelf: start empty */
    }
  }

  list(kind: DrawingKind): DrawingTemplate[] {
    return this.shelf()[kind]?.templates ?? [];
  }

  get(kind: DrawingKind, name: string): DrawingTemplate | undefined {
    return this.list(kind).find((t) => t.name === name);
  }

  /** Save (or overwrite, by name) a template for this tool. */
  save(kind: DrawingKind, template: DrawingTemplate): void {
    this.write(kind, (e) => ({
      ...e,
      templates: [...e.templates.filter((t) => t.name !== template.name), template].sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
    }));
  }

  remove(kind: DrawingKind, name: string): void {
    this.write(kind, (e) => ({ ...e, templates: e.templates.filter((t) => t.name !== name) }));
  }

  /** The tool's saved default, applied to every new drawing of this kind. */
  getDefault(kind: DrawingKind): DrawingTemplate | undefined {
    return this.shelf()[kind]?.default;
  }

  saveDefault(kind: DrawingKind, template: Omit<DrawingTemplate, 'name'>): void {
    this.write(kind, (e) => ({ ...e, default: { name: 'Default', ...template } }));
  }

  resetDefault(kind: DrawingKind): void {
    this.write(kind, (e) => ({ templates: e.templates }));
  }

  private write(
    kind: DrawingKind,
    fn: (e: { templates: DrawingTemplate[]; default?: DrawingTemplate }) => {
      templates: DrawingTemplate[];
      default?: DrawingTemplate;
    },
  ): void {
    const next: Shelf = { ...this.shelf(), [kind]: fn(this.shelf()[kind] ?? { templates: [] }) };
    this.shelf.set(next);
    try {
      this.storage?.setItem(KEY, JSON.stringify(next));
    } catch {
      /* kept in memory for this session */
    }
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** App-wide shelf. */
export const drawingTemplates = new DrawingTemplates(safeStorage());
