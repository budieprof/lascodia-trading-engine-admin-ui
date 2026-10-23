import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LAYER_GROUPS,
  LAYER_GROUPS,
  effectiveOpacity,
  persistLayerGroups,
  restoreLayerGroups,
  withGroupOpacity,
  withGroupVisible,
} from './layer-groups';

describe('layer groups (PR-5)', () => {
  it('has the five groups, all shown; order flow starts at 0.6', () => {
    expect(LAYER_GROUPS.map((g) => g.id)).toEqual(['structure', 'profiles', 'flow', 'events', 'trades']);
    expect(LAYER_GROUPS.every((g) => DEFAULT_LAYER_GROUPS[g.id].visible)).toBe(true);
    expect(effectiveOpacity(DEFAULT_LAYER_GROUPS, 'flow')).toBe(0.6);
    expect(effectiveOpacity(DEFAULT_LAYER_GROUPS, 'structure')).toBe(1);
  });

  it('hides a group without losing its opacity', () => {
    const faded = withGroupOpacity(DEFAULT_LAYER_GROUPS, 'profiles', 0.4);
    const hidden = withGroupVisible(faded, 'profiles', false);
    expect(effectiveOpacity(hidden, 'profiles')).toBe(0);
    expect(effectiveOpacity(withGroupVisible(hidden, 'profiles', true), 'profiles')).toBe(0.4);
    // Other groups untouched; the input state is not mutated.
    expect(hidden.structure).toEqual(DEFAULT_LAYER_GROUPS.structure);
    expect(DEFAULT_LAYER_GROUPS.profiles.opacity).toBe(1);
  });

  it('clamps the slider to 0.1 … 1 and ignores a non-number', () => {
    expect(withGroupOpacity(DEFAULT_LAYER_GROUPS, 'events', 0).events.opacity).toBe(0.1);
    expect(withGroupOpacity(DEFAULT_LAYER_GROUPS, 'events', 3).events.opacity).toBe(1);
    expect(withGroupOpacity(DEFAULT_LAYER_GROUPS, 'events', Number.NaN)).toBe(DEFAULT_LAYER_GROUPS);
  });

  it('round-trips through the layout', () => {
    let s = withGroupOpacity(DEFAULT_LAYER_GROUPS, 'flow', 0.35);
    s = withGroupVisible(s, 'trades', false);
    s = withGroupOpacity(s, 'structure', 0.75);
    const saved = JSON.parse(JSON.stringify(persistLayerGroups(s)));
    expect(saved.v).toBe(1);
    expect(restoreLayerGroups(saved)).toEqual(s);
  });

  it('opens a layout from before groups, or a damaged one, on the defaults', () => {
    expect(restoreLayerGroups(undefined)).toEqual(DEFAULT_LAYER_GROUPS);
    expect(restoreLayerGroups({ v: 2, groups: { structure: { visible: false } } })).toEqual(
      DEFAULT_LAYER_GROUPS,
    );
    const partial = restoreLayerGroups({
      v: 1,
      groups: { events: { visible: false }, profiles: { opacity: 'x' }, flow: { opacity: -4 } },
    });
    expect(partial.events).toEqual({ visible: false, opacity: 1 });
    expect(partial.profiles).toEqual(DEFAULT_LAYER_GROUPS.profiles);
    expect(partial.flow).toEqual({ visible: true, opacity: 0.1 });
    expect(partial.structure).toEqual(DEFAULT_LAYER_GROUPS.structure);
  });
});
