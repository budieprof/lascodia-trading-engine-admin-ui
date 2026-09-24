import { RangeSetBuilder } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';

import { colorToCss, formatColor, parseColor } from '../pine/pine-inputs';
import { isInCommentOrString, lexicalRanges } from '../pine/pine-scan';
import { pineContext } from './pine-context';

const HEX_RE = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6})(?![0-9a-zA-Z_])/g;
const NAMED_RE = /\bcolor\.[a-z_]+\b(?!\s*\()/g;

class SwatchWidget extends WidgetType {
  constructor(
    readonly color: string,
    /** Hex literals can be edited with the picker; `color.*` constants cannot. */
    readonly editable: boolean,
  ) {
    super();
  }

  override eq(other: SwatchWidget): boolean {
    return other.color === this.color && other.editable === this.editable;
  }

  override toDOM(view: EditorView): HTMLElement {
    const outer = document.createElement('span');
    outer.className = 'cm-pine-swatch';
    outer.setAttribute('aria-hidden', 'true');
    outer.title = this.editable ? `${this.color} — click to pick a colour` : this.color;
    const inner = document.createElement('span');
    inner.style.background = colorToCss(this.color);
    outer.appendChild(inner);
    if (this.editable) {
      outer.addEventListener('mousedown', (e) => {
        e.preventDefault();
        if (!view.state.readOnly) openPicker(view, outer);
      });
    }
    return outer;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

let activePicker: HTMLInputElement | null = null;

/** A native colour picker editing the hex literal right after the swatch (alpha kept). */
function openPicker(view: EditorView, swatch: HTMLElement): void {
  // A cancelled picker fires no `change`; drop it when the next one opens.
  activePicker?.remove();
  const input = document.createElement('input');
  activePicker = input;
  input.type = 'color';
  Object.assign(input.style, { position: 'fixed', left: '-100px', top: '0', opacity: '0' });
  const at = (): { from: number; to: number; alpha: number } | null => {
    const pos = view.posAtDOM(swatch);
    const text = view.state.sliceDoc(pos, pos + 9);
    const m = /^#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6})/.exec(text);
    const parts = m ? parseColor(m[0]) : null;
    return m && parts ? { from: pos, to: pos + m[0].length, alpha: parts.alpha } : null;
  };
  const current = at();
  if (!current) return;
  input.value = parseColor(view.state.sliceDoc(current.from, current.to))!.hex.toLowerCase();
  input.addEventListener('input', () => {
    const range = at();
    if (!range) return;
    const hex = input.value.toUpperCase();
    const literal = range.to - range.from === 9 ? formatColor({ hex, alpha: range.alpha }) : hex;
    view.dispatch({
      changes: { from: range.from, to: range.to, insert: literal },
      userEvent: 'input.color',
    });
  });
  input.addEventListener('change', () => {
    input.remove();
    if (activePicker === input) activePicker = null;
  });
  document.body.appendChild(input);
  input.click();
}

function buildSwatches(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const { index } = pineContext(view.state);
  const doc = view.state.doc;
  for (const { from, to } of view.visibleRanges) {
    const text = doc.sliceString(from, to);
    const ranges = lexicalRanges(text);
    const found: { pos: number; color: string; editable: boolean }[] = [];
    for (const m of text.matchAll(HEX_RE)) {
      const i = m.index ?? 0;
      if (isInCommentOrString(ranges, i + 1)) continue;
      found.push({ pos: from + i, color: m[0], editable: true });
    }
    for (const m of text.matchAll(NAMED_RE)) {
      const i = m.index ?? 0;
      if (isInCommentOrString(ranges, i + 1)) continue;
      const value = index.constants.get(m[0])?.valueText;
      if (value && parseColor(value)) found.push({ pos: from + i, color: value, editable: false });
    }
    found.sort((a, b) => a.pos - b.pos);
    for (const f of found) {
      builder.add(
        f.pos,
        f.pos,
        Decoration.widget({ widget: new SwatchWidget(f.color, f.editable), side: -1 }),
      );
    }
  }
  return builder.finish();
}

/** Colour swatches before `#RRGGBB(AA)` literals (click to edit) and `color.*` constants. */
export const pineColorSwatches = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildSwatches(view);
    }
    update(u: ViewUpdate): void {
      if (u.docChanged || u.viewportChanged || u.transactions.some((t) => t.effects.length)) {
        this.decorations = buildSwatches(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);
