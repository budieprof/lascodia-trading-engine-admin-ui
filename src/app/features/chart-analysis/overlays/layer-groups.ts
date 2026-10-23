/**
 * Layer groups (PR-5, Bookmap / TradingView): the chart's derived and engine layers in five groups, each
 * with a show/hide and an opacity, saved with the layout. A group hides or fades its members together
 * without touching their own toggles — hiding Structure and showing it again brings back exactly the
 * structure layers that were on.
 *
 * <p>Pure: the page holds a {@link LayerGroupsState} signal, the host hands each renderer its group's
 * {@link effectiveOpacity}, and the layout stores {@link persistLayerGroups}' shape.</p>
 */

export type LayerGroupId = 'structure' | 'profiles' | 'flow' | 'events' | 'trades';

export interface LayerGroupState {
  visible: boolean;
  /** 0.1 … 1 — the slider; hiding is `visible`, so a faded group is never mistaken for an empty one. */
  opacity: number;
}

export type LayerGroupsState = Readonly<Record<LayerGroupId, LayerGroupState>>;

export interface LayerGroupDef {
  id: LayerGroupId;
  label: string;
  /** What the group holds, for the menu's tooltip. */
  members: string;
}

export const LAYER_GROUPS: readonly LayerGroupDef[] = [
  {
    id: 'structure',
    label: 'Structure',
    members: 'Market structure, support & resistance, auto analysis',
  },
  {
    id: 'profiles',
    label: 'Profiles',
    members: 'Volume profile, session and period profiles, naked and developing POCs, profile studies',
  },
  {
    id: 'flow',
    label: 'Order flow',
    members: 'Liquidity heatmap, tick delta, footprint, spread and tick rate, fills',
  },
  { id: 'events', label: 'Events', members: 'Economic events, their lane and the news-blackout bands' },
  { id: 'trades', label: 'Trades', members: 'Position and pending-order lines' },
];

export const MIN_GROUP_OPACITY = 0.1;

/**
 * Every group shown at full strength, except Order flow at 0.6 — the liquidity heatmap is drawn behind
 * the candles and at full strength buries them (its own default is 0.6).
 */
export const DEFAULT_LAYER_GROUPS: LayerGroupsState = {
  structure: { visible: true, opacity: 1 },
  profiles: { visible: true, opacity: 1 },
  flow: { visible: true, opacity: 0.6 },
  events: { visible: true, opacity: 1 },
  trades: { visible: true, opacity: 1 },
};

/** What a renderer of `id` should draw at: its opacity, or 0 when the group is hidden. */
export function effectiveOpacity(state: LayerGroupsState, id: LayerGroupId): number {
  const g = state[id];
  return g.visible ? g.opacity : 0;
}

function clampOpacity(v: number): number {
  return Math.min(1, Math.max(MIN_GROUP_OPACITY, Math.round(v * 100) / 100));
}

export function withGroupVisible(
  state: LayerGroupsState,
  id: LayerGroupId,
  visible: boolean,
): LayerGroupsState {
  return { ...state, [id]: { ...state[id], visible } };
}

export function withGroupOpacity(
  state: LayerGroupsState,
  id: LayerGroupId,
  opacity: number,
): LayerGroupsState {
  if (!Number.isFinite(opacity)) return state;
  return { ...state, [id]: { ...state[id], opacity: clampOpacity(opacity) } };
}

/** As saved in the layout (`ChartWorkspaceState.layerGroups`). */
export interface PersistedLayerGroups {
  v: 1;
  groups: Partial<Record<LayerGroupId, { visible?: boolean; opacity?: number }>>;
}

export function persistLayerGroups(state: LayerGroupsState): PersistedLayerGroups {
  const groups: PersistedLayerGroups['groups'] = {};
  for (const { id } of LAYER_GROUPS) groups[id] = { visible: state[id].visible, opacity: state[id].opacity };
  return { v: 1, groups };
}

/**
 * A saved shape back to state: a layout from before groups existed, an unknown version, a missing group or
 * a bad value all fall back to the defaults (an out-of-range opacity is clamped), never to a hidden chart.
 */
export function restoreLayerGroups(saved: unknown): LayerGroupsState {
  const out: Record<LayerGroupId, LayerGroupState> = { ...DEFAULT_LAYER_GROUPS };
  const groups =
    saved && typeof saved === 'object' && (saved as { v?: unknown }).v === 1
      ? (saved as PersistedLayerGroups).groups
      : null;
  if (!groups || typeof groups !== 'object') return out;
  for (const { id } of LAYER_GROUPS) {
    const g = groups[id];
    if (!g || typeof g !== 'object') continue;
    out[id] = {
      visible: typeof g.visible === 'boolean' ? g.visible : DEFAULT_LAYER_GROUPS[id].visible,
      opacity:
        typeof g.opacity === 'number' && Number.isFinite(g.opacity)
          ? clampOpacity(g.opacity)
          : DEFAULT_LAYER_GROUPS[id].opacity,
    };
  }
  return out;
}
