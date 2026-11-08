import type { WritableSignal } from '@angular/core';

import type { NotificationService } from '@core/notifications/notification.service';
import type { ScriptDialogService } from '@features/scripting/shared/script-dialog.service';
import type { ActiveIndicator, ChartHostComponent } from '../../chart/chart-host.component';
import { toCsv } from '../../chart/snapshot';
import { askName, confirmDelete } from '../../dialog/chart-dialogs';
import type { ChartLayoutStore, StudyTemplate } from '../../workspace/layout-store.service';
import type { ChartWorkspaceSync } from '../../workspace/workspace-sync.service';

/** What the layout / template / export actions use on the chart page. */
export interface ChartLayoutActionsDeps {
  /** The toolbar's layout menu: every action that leaves it closes it. */
  layoutMenuOpen: WritableSignal<boolean>;
  /** The studies on the chart (a template saves and restores them). */
  active: WritableSignal<ActiveIndicator[]>;
  isFullscreen: WritableSignal<boolean>;
  /** `SYMBOL · 1h · Candles`, as the chart's title reads. */
  title: () => string;
  /** `SYMBOL-1h`, the start of an export's file name. */
  fileStem: () => string;
  closeContextMenu: () => void;
  host: () => Pick<ChartHostComponent, 'snapshotCanvas' | 'exportRows'> | undefined;
  workspace: Pick<ChartWorkspaceSync, 'newLayout' | 'rename' | 'duplicate' | 'switchTo' | 'remove' | 'layouts' | 'active'>;
  layoutStore: Pick<ChartLayoutStore, 'saveTemplate' | 'instantiate' | 'removeTemplate'>;
  dialogs: Pick<ScriptDialogService, 'ask' | 'confirm'>;
  notify: Pick<NotificationService, 'success' | 'error'>;
}

/**
 * b9-maint — the chart page's layout menu (server-backed layouts: new / rename / copy / switch / delete), its indicator
 * templates, the image and CSV exports and fullscreen, moved out of ChartAnalysisPageComponent behaviour for behaviour.
 * The template and the assistant's commands call it as `layoutActions`.
 */
export class ChartLayoutActions {
  constructor(private readonly deps: ChartLayoutActionsDeps) {}

  async newLayout(): Promise<void> {
    const d = this.deps;
    d.layoutMenuOpen.set(false);
    const name = await askName(d.dialogs, {
      title: 'New layout',
      label: 'Layout name',
      value: 'Unnamed',
      confirmLabel: 'Create',
    });
    if (name !== null) void d.workspace.newLayout(name);
  }

  async renameLayout(): Promise<void> {
    const d = this.deps;
    d.layoutMenuOpen.set(false);
    const name = await askName(d.dialogs, {
      title: 'Rename layout',
      label: 'Layout name',
      value: d.workspace.active().name,
      confirmLabel: 'Rename',
    });
    if (name !== null) void d.workspace.rename(name);
  }

  async duplicateLayout(): Promise<void> {
    const d = this.deps;
    d.layoutMenuOpen.set(false);
    const name = await askName(d.dialogs, {
      title: 'Copy layout',
      message: 'The copy keeps this layout’s symbol, studies, scripts and drawings settings.',
      label: 'Name of the copy',
      value: `${d.workspace.active().name} copy`,
      confirmLabel: 'Copy',
    });
    if (name !== null) void d.workspace.duplicate(name);
  }

  switchLayout(id: number): void {
    this.deps.layoutMenuOpen.set(false);
    void this.deps.workspace.switchTo(id);
  }

  removeLayout(id: number, ev: Event): void {
    ev.stopPropagation();
    const l = this.deps.workspace.layouts().find((x) => x.id === id);
    void confirmDelete(this.deps.dialogs, `layout “${l?.name ?? id}”`).then((yes) => {
      if (yes) void this.deps.workspace.remove(id);
    });
  }

  async saveTemplate(): Promise<void> {
    const d = this.deps;
    if (d.active().length === 0) return;
    d.layoutMenuOpen.set(false);
    const name = await askName(d.dialogs, {
      title: 'Save indicator template',
      message: 'The studies on this chart, with their inputs and styles.',
      label: 'Template name',
      value: 'My studies',
      confirmLabel: 'Save',
    });
    if (name !== null) d.layoutStore.saveTemplate(name, d.active());
  }

  applyTemplate(template: StudyTemplate): void {
    this.deps.layoutMenuOpen.set(false);
    this.deps.active.set(this.deps.layoutStore.instantiate(template));
  }

  removeTemplate(id: string, ev: Event): void {
    ev.stopPropagation();
    this.deps.layoutStore.removeTemplate(id);
  }

  private exportName(ext: string): string {
    return `${this.deps.fileStem()}-${new Date()
      .toISOString()
      .slice(0, 16)
      .replace(/[:T]/g, '')}.${ext}`;
  }

  /**
   * Download the chart as a PNG — the chart with its legend, the scripts' tables and a title
   * (CC-22). Says when it could not: the assistant's chart.snapshot reported success with no image.
   */
  takeSnapshot(): { ok: boolean; message: string } {
    const d = this.deps;
    d.closeContextMenu();
    const canvas = d.host()?.snapshotCanvas(d.title());
    let data: string | null = null;
    try {
      data = canvas ? canvas.toDataURL('image/png') : null;
    } catch {
      data = null;
    }
    if (!data || data === 'data:,') {
      const message =
        'The chart could not be captured: it is not drawn yet, or the browser refused.';
      d.notify.error(message);
      return { ok: false, message };
    }
    const name = this.exportName('png');
    const a = document.createElement('a');
    a.href = data;
    a.download = name;
    a.click();
    return { ok: true, message: `Snapshot saved as ${name}.` };
  }

  /** Copy the snapshot to the clipboard as an image (CC-I7), where the browser allows it. */
  async copySnapshot(): Promise<void> {
    const d = this.deps;
    d.closeContextMenu();
    const canvas = d.host()?.snapshotCanvas(d.title());
    const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
    if (!canvas) {
      d.notify.error('The chart could not be captured: it is not drawn yet.');
      return;
    }
    if (!clipboard?.write || typeof ClipboardItem === 'undefined') {
      d.notify.error('This browser does not allow copying images; use Save image instead.');
      return;
    }
    try {
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('no image');
      await clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      d.notify.success('Chart image copied to the clipboard.');
    } catch {
      d.notify.error('The image could not be copied to the clipboard.');
    }
  }

  /**
   * Download the chart's data as CSV (CC-I7): each bar's UTC time, prices and volume, and every
   * value the data window lists for it — studies, and scripts' plots when they provide them.
   */
  exportChartData(): void {
    const d = this.deps;
    d.closeContextMenu();
    const rows = d.host()?.exportRows() ?? [];
    if (rows.length < 2) {
      d.notify.error('There are no bars to export yet.');
      return;
    }
    const url = URL.createObjectURL(new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = this.exportName('csv');
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }

  async toggleFullscreen(): Promise<void> {
    const el = document.querySelector('.chart-page');
    if (!el) return;
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
        this.deps.isFullscreen.set(false);
      } else {
        await (el as HTMLElement).requestFullscreen();
        this.deps.isFullscreen.set(true);
      }
    } catch {
      // Fullscreen is refused without a user gesture in some contexts; the
      // chart is perfectly usable without it, so this is not worth surfacing.
    }
  }
}
