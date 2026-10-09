import { MapMode, RangeSet, StateEffect, StateField, type Text } from '@codemirror/state';
import { EditorView, GutterMarker, gutter } from '@codemirror/view';

import type { PineProfileLine } from '@shared/pine-chart/model/pine-outputs.types';
import { formatMicros, heatColor, profilerRows } from '@shared/pine-chart/panes/profiler-model';

/**
 * Profiler heat in the editor gutter (PE-I5): after a profiled run, each of the script's own lines
 * that took time shows a bar beside its number, its colour and length growing with the line's time
 * relative to the costliest line; hovering it gives the line's share of the run, its executions and
 * its time per execution — the Profiler pane's numbers. The marks follow their lines while the
 * script is edited, disappear with a deleted line and are cleared when the whole text is replaced
 * (another script loaded) or a new profile arrives.
 */

/** What one line's mark shows (from the Profiler pane's rows). */
export interface ProfileHeat {
  line: number;
  heat: number;
  percent: number;
  executions: number;
  avgMicros: number;
  totalMicros: number;
}

/**
 * The script's own profiled lines that exist in `doc` and took time. Nothing when the profile was
 * taken on another text than `doc` — its line numbers would point at the wrong lines.
 */
export function profileHeat(
  doc: Text,
  profile: readonly PineProfileLine[],
  source: string | null,
): ProfileHeat[] {
  if (source === null || doc.toString() !== source) return [];
  return profilerRows(profile)
    .filter((r) => r.line <= doc.lines && r.totalMicros > 0)
    .map((r) => ({
      line: r.line,
      heat: r.heat,
      percent: r.percent,
      executions: r.executions,
      avgMicros: r.avgMicros,
      totalMicros: r.totalMicros,
    }));
}

/** The hover text of a line's mark. */
export function heatTitle(h: ProfileHeat): string {
  const share = h.percent >= 10 ? h.percent.toFixed(0) : h.percent.toFixed(1);
  return (
    `Line ${h.line}: ${share}% of the script's run time, ${formatMicros(h.totalMicros)} in all — ` +
    `${h.executions.toLocaleString('en-US')} execution(s), ${formatMicros(h.avgMicros)} each`
  );
}

class HeatMarker extends GutterMarker {
  // A line deleted while editing takes its mark with it.
  override mapMode = MapMode.TrackDel;

  constructor(readonly heat: ProfileHeat) {
    super();
  }

  override eq(other: GutterMarker): boolean {
    return (
      other instanceof HeatMarker &&
      other.heat.heat === this.heat.heat &&
      other.heat.line === this.heat.line &&
      other.heat.totalMicros === this.heat.totalMicros
    );
  }

  override toDOM(): Node {
    const el = document.createElement('div');
    el.className = 'cm-pine-heat';
    el.title = heatTitle(this.heat);
    el.setAttribute('aria-label', el.title);
    const bar = document.createElement('span');
    bar.className = 'cm-pine-heat-bar';
    bar.style.width = `${Math.max(15, Math.round(this.heat.heat * 100))}%`;
    bar.style.background = heatColor(this.heat.heat);
    el.appendChild(bar);
    return el;
  }
}

/** Replaces the marks (an empty list clears them). */
export const setProfileHeat = StateEffect.define<ProfileHeat[]>();

function marks(doc: Text, heat: readonly ProfileHeat[]): RangeSet<GutterMarker> {
  return RangeSet.of(
    heat.map((h) => new HeatMarker(h).range(doc.line(h.line).from)),
    true,
  );
}

export const profileHeatField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setProfileHeat)) return marks(tr.state.doc, e.value);
    if (!tr.docChanged || value.size === 0) return value;
    // The whole text replaced (another script loaded): these numbers belong to the old one.
    let replacedAll = false;
    const oldLength = tr.startState.doc.length;
    tr.changes.iterChangedRanges((fromA, toA) => {
      if (fromA === 0 && toA === oldLength && oldLength > 0) replacedAll = true;
    });
    return replacedAll ? RangeSet.empty : value.map(tr.changes);
  },
});

// The width sits on the mark, not the gutter: with no marks the gutter takes no room.
const heatTheme = EditorView.baseTheme({
  '.cm-pine-heat-gutter .cm-gutterElement': { display: 'flex', alignItems: 'center' },
  '.cm-pine-heat': {
    width: '18px',
    height: '100%',
    padding: '0 3px',
    display: 'flex',
    alignItems: 'center',
    cursor: 'help',
  },
  '.cm-pine-heat-bar': { display: 'block', height: '6px', borderRadius: '2px' },
});

/** The gutter and its marks. */
export function pineProfileHeat() {
  return [
    profileHeatField,
    heatTheme,
    gutter({
      class: 'cm-pine-heat-gutter',
      markers: (view) => view.state.field(profileHeatField),
    }),
  ];
}
