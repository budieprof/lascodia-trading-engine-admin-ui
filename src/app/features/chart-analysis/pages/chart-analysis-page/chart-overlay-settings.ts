import { computed, signal } from '@angular/core';

import { consolidatedSubset, isConsolidatedId } from '@core/realtime/marketdata.types';
import { VOLUME_PROFILE_MODES, type VolumeProfileMode } from '../../overlays/analysis-overlays';
import { DEFAULT_PROFILE_EXTRAS, type ProfileExtrasSettings } from '../../overlays/profile-levels';
import {
  DEFAULT_LAYER_GROUPS,
  effectiveOpacity,
  persistLayerGroups,
  restoreLayerGroups,
  type LayerGroupId,
  type LayerGroupsState,
} from '../../overlays/layer-groups';
import {
  DEFAULT_ORDER_FLOW,
  restoredOrderFlow,
  type OrderFlowSettings,
} from '../../orderflow/orderflow.types';
import type { ChartWorkspaceState } from '../../workspace/workspace-state';

/** A layout's `overlays` block, as the page saves it. */
export type SavedOverlays = NonNullable<ChartWorkspaceState['overlays']>;

/** An order-flow layer the overlays menu switches on and off. */
export type OrderFlowLayer =
  | 'heatmap'
  | 'cvd'
  | 'footprint'
  | 'ribbon'
  | 'fills'
  | 'trades'
  | 'cmeFlow';

/**
 * US02b: the chart's overlay settings that are saved with a layout — trade lines, analytical overlays and the volume
 * profile's extras, layer groups, order-flow layers, events / blackout and watch marks — moved out of
 * ChartAnalysisPageComponent behaviour for behaviour, with their save ({@link snapshot}) and restore
 * ({@link restore}). The page aliases these signals under their old names (its chart bindings, the assistant's
 * commands and the undo history read them there) and keeps what has side effects of its own (events reload, the
 * delta study, auto analysis). The overlays menu reads it directly.
 */
export class ChartOverlaySettings {
  /**
   * Trade layers on the price chart, each its own toggle (they were one switch — see {@link restore}): open
   * positions (entry/SL/TP), pending orders (working limit/stop orders and their O·SL/O·TP), and signals
   * (trade-signal markers + martingale rungs). `showOverlays` is the signals toggle — the name predates the split and
   * is what saved layouts and the assistant already use.
   */
  readonly showPositions = signal(false);
  readonly showOrders = signal(false);
  readonly showOverlays = signal(false);
  /** Fill markers of the symbol's closed trades (entry and exit; paper apart). Off by default. */
  readonly showClosedTrades = signal(false);
  /**
   * Whether the trade lines widen the price scale's fit (CC-10). On by default: a stop below the
   * visible low stays in view. Off: a distant take-profit no longer squashes the candles.
   */
  readonly fitTradeLines = signal(true);
  /** Any of the three on — the assistant's single "trades" switch reads and drives all three. */
  readonly anyTradeOverlay = computed(
    () => this.showPositions() || this.showOrders() || this.showOverlays(),
  );

  // Analytical overlays: derived from the loaded bars, not fetched; the chart host computes them.
  readonly showVolumeProfile = signal(false);
  readonly volumeProfileMode = signal<VolumeProfileMode>('visible');
  readonly volumeProfileModes = VOLUME_PROFILE_MODES;
  readonly showSupportResistance = signal(false);
  readonly showStructure = signal(false);
  /** The volume profile's naked POCs and developing POC / VA (PR-2, PR-3); saved with the layout. */
  readonly profileExtras = signal<ProfileExtrasSettings>(DEFAULT_PROFILE_EXTRAS);

  /**
   * Layer groups (PR-5): Structure, Profiles, Order flow, Events, Trades — each shown/hidden and faded
   * together from the layer menu; saved with the layout.
   */
  readonly layerGroups = signal<LayerGroupsState>(DEFAULT_LAYER_GROUPS);

  /** Order flow (orderflow/): broker DOM heatmap, tick delta, footprint, spread ribbon, fills. */
  readonly orderFlow = signal<OrderFlowSettings>(DEFAULT_ORDER_FLOW);
  readonly isConsolidatedPick = computed(() => isConsolidatedId(this.orderFlow().sourceId));

  /** Economic events on the time axis, and the lowest importance shown. */
  readonly showEvents = signal(true);
  readonly minEventImpact = signal<'High' | 'Medium' | 'Low'>('Medium');
  /**
   * Shade the news blackout around Tier-1 events (CC-I2): the minutes live refuses new entries in,
   * around each High event of the pair's currencies. Saved with the layout.
   */
  readonly showBlackout = signal(true);
  /** Watches and monitors on the chart — fire / step / call-off marks and their price lines (saved with the layout). */
  readonly showWatchMarks = signal(true);

  toggleProfileExtra(key: keyof ProfileExtrasSettings): void {
    this.profileExtras.update((s) => ({ ...s, [key]: !s[key] }));
  }

  /**
   * What a group's layers draw at: its opacity, 0 when hidden. Reactive (reads the signal), so a template
   * can bind `[opacity]="layerGroupOpacity('flow')"` — the order-flow layers take theirs from here.
   */
  layerGroupOpacity(id: LayerGroupId): number {
    return effectiveOpacity(this.layerGroups(), id);
  }

  toggleOrderFlow(layer: OrderFlowLayer): void {
    this.orderFlow.update((s) => ({ ...s, [layer]: !s[layer] }));
  }
  /** The market-data source for the heatmap / depth / trades ('' = automatic). */
  setOrderFlowSource(sourceId: string): void {
    this.orderFlow.update((s) => restoredOrderFlow({ ...s, sourceId: sourceId || null }));
  }
  /** Whether a source is in the consolidated pick (all are when the pick is plain `consolidated`). */
  consolidatedHas(sourceId: string): boolean {
    const id = this.orderFlow().sourceId;
    const subset = id ? consolidatedSubset(id) : null;
    return !subset || subset.includes(sourceId);
  }
  setTradeMinSize(value: number): void {
    this.orderFlow.update((s) => restoredOrderFlow({ ...s, tradeMinSize: value }));
  }
  setHeatmapOpacity(value: number): void {
    this.orderFlow.update((s) => restoredOrderFlow({ ...s, heatmapOpacity: value }));
  }
  setFootprintRows(points: number | null): void {
    this.orderFlow.update((s) => restoredOrderFlow({ ...s, footprintRowPoints: points }));
  }

  /** The layout's `overlays` block (key order as the page has always written it: undo compares JSON). */
  snapshot(): SavedOverlays {
    return {
      showPositions: this.showPositions(),
      showOrders: this.showOrders(),
      showOverlays: this.showOverlays(),
      showVolumeProfile: this.showVolumeProfile(),
      volumeProfileMode: this.volumeProfileMode(),
      showSupportResistance: this.showSupportResistance(),
      showStructure: this.showStructure(),
      showEvents: this.showEvents(),
      minEventImpact: this.minEventImpact(),
      showBlackout: this.showBlackout(),
      showClosedTrades: this.showClosedTrades(),
      fitTradeLines: this.fitTradeLines(),
      showWatches: this.showWatchMarks(),
      vpNakedPocs: this.profileExtras().nakedPocs,
      vpDeveloping: this.profileExtras().developing,
      orderFlow: { ...this.orderFlow() },
    };
  }

  /** The layout's `layerGroups` block. */
  persistedLayerGroups(): ReturnType<typeof persistLayerGroups> {
    return persistLayerGroups(this.layerGroups());
  }

  /** A layout's overlays (and layer groups), with the chart's defaults for whatever it leaves out. */
  restore(saved: SavedOverlays | undefined, layerGroups: unknown): void {
    const o = saved ?? {};
    // Layouts saved before the split had one "Trades & signals" switch: it drove all three.
    this.showPositions.set(o.showPositions ?? o.showOverlays ?? false);
    this.showOrders.set(o.showOrders ?? o.showOverlays ?? false);
    this.showOverlays.set(o.showOverlays ?? false);
    this.showVolumeProfile.set(o.showVolumeProfile ?? false);
    if (o.volumeProfileMode) this.volumeProfileMode.set(o.volumeProfileMode as VolumeProfileMode);
    this.showSupportResistance.set(o.showSupportResistance ?? false);
    this.showStructure.set(o.showStructure ?? false);
    this.showEvents.set(o.showEvents ?? true);
    this.minEventImpact.set(o.minEventImpact ?? 'Medium');
    this.showBlackout.set(o.showBlackout ?? true);
    this.showClosedTrades.set(o.showClosedTrades ?? false);
    this.fitTradeLines.set(o.fitTradeLines ?? true);
    this.showWatchMarks.set(o.showWatches ?? true);
    this.profileExtras.set({
      nakedPocs: o.vpNakedPocs ?? false,
      developing: o.vpDeveloping ?? false,
    });
    this.layerGroups.set(restoreLayerGroups(layerGroups));
    this.orderFlow.set(restoredOrderFlow(o.orderFlow));
  }
}
