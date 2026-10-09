import { Injectable, computed, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom, timeout } from 'rxjs';

import { ChartLayoutsService, type ChartLayoutDto } from '@core/services/chart-layouts.service';
import type { ResponseData } from '@core/api/api.types';
import { ChartLayoutStore } from './layout-store.service';
import {
  WORKSPACE_VERSION,
  isWorkspaceState,
  legacyToState,
  type ChartWorkspaceState,
} from './workspace-state';

export const WORKSPACE_CACHE_KEY = 'lascodia.chart.workspace.v1';
export const DEFAULT_LAYOUT_NAME = 'Unnamed';
const SAVE_DEBOUNCE_MS = 1_500;
const LOAD_TIMEOUT_MS = 5_000;
const RETRY_MS = [5_000, 10_000, 20_000, 30_000];

export type WorkspaceSaveStatus =
  | 'idle'
  | 'loading'
  | 'pending'
  | 'saving'
  | 'saved'
  | 'offline'
  | 'error';

/** The offline copy of the open layout: what the engine last confirmed plus any unsent edit. */
interface WorkspaceCache {
  layoutId: number | null;
  name: string;
  /** The engine version this state is based on. */
  version: number;
  state: ChartWorkspaceState | null;
  /** True while the state holds an edit the engine has not confirmed. */
  dirty: boolean;
}

/**
 * Auto-saves the chart-analysis workspace to the engine (`chart/layouts`) and restores it on
 * any browser or machine.
 *
 * <p><b>Source of truth.</b> The engine. localStorage ({@link WORKSPACE_CACHE_KEY}) is only the
 * offline copy: it serves when the engine cannot be reached, and it carries an edit the engine
 * never confirmed (a tab closed mid-save) into the next load — uploaded then only if the engine
 * has not moved on meanwhile.</p>
 *
 * <p><b>Saving.</b> Every state change is debounced ({@link SAVE_DEBOUNCE_MS}) into one `PUT`
 * with `expectedVersion`. A save never runs twice at once; changes made during one are sent
 * after it. `pagehide`/hidden tab flush with a keepalive `fetch`; leaving the route flushes too.
 * Network failures retry with backoff ("offline, retrying").</p>
 *
 * <p><b>Several tabs or machines.</b> Last writer wins, but only with state an operator just
 * produced: a `-409` on a save carrying a fresh edit re-sends it on top of the newer version,
 * while a tab that regains focus with nothing unsaved adopts the newer server state instead of
 * ever writing its stale one back. Applying an incoming state must not trigger a save of it —
 * {@link markDirty} ignores state identical to what was last loaded or saved.</p>
 */
@Injectable({ providedIn: 'root' })
export class ChartWorkspaceSync {
  private readonly remote = inject(ChartLayoutsService);
  private readonly legacy = inject(ChartLayoutStore);

  readonly status = signal<WorkspaceSaveStatus>('idle');
  readonly statusText = computed(() => {
    switch (this.status()) {
      case 'loading':
        return 'Loading…';
      case 'pending':
      case 'saving':
        return 'Saving…';
      case 'saved':
        return 'Saved';
      case 'offline':
        return 'Offline, retrying';
      case 'error':
        return 'Not saved';
      default:
        return '';
    }
  });
  readonly lastError = signal<string | null>(null);
  readonly layouts = signal<ChartLayoutDto[]>([]);
  readonly active = signal<{ id: number | null; name: string; version: number }>({
    id: null,
    name: DEFAULT_LAYOUT_NAME,
    version: 0,
  });
  /** A state the page must apply now (switch, delete, a newer save from elsewhere). */
  readonly incoming = signal<{ state: ChartWorkspaceState | null; seq: number } | null>(null);

  /** The state to open with, settled by {@link load}. */
  initialState: ChartWorkspaceState | null = null;

  private lastJson: string | null = null;
  private current: ChartWorkspaceState | null = null;
  private dirty = false;
  private inFlight: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private retry = 0;
  private seq = 0;
  private loading: Promise<void> | null = null;

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', () => this.flushOnUnload());
      window.addEventListener('focus', () => void this.refreshIfNewer());
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') this.flushOnUnload();
        else void this.refreshIfNewer();
      });
    }
  }

  /** Settle {@link initialState} before the chart renders. Shared per session; never rejects. */
  load(): Promise<void> {
    // A later visit re-reads (the operator may have changed machines in between).
    this.loading ??= this.doLoad().finally(() => (this.loading = null));
    return this.loading;
  }

  /** The page's current state; saved after the debounce when it differs from the last one. */
  markDirty(state: ChartWorkspaceState): void {
    const json = JSON.stringify(state);
    if (json === this.lastJson) return;
    this.lastJson = json;
    this.current = state;
    this.dirty = true;
    this.writeCache();
    if (this.status() !== 'offline') this.status.set('pending');
    this.schedule(SAVE_DEBOUNCE_MS);
  }

  /**
   * The page's reading of a state it just applied: the new baseline. Not an edit, so not saved —
   * applying a layout must never write it back (or two tabs would trade saves forever).
   */
  rebase(state: ChartWorkspaceState): void {
    if (this.dirty) return; // an unconfirmed edit still has to go up
    this.lastJson = JSON.stringify(state);
    this.current = state;
  }

  /** Save now if anything is unsaved (route leave, before a switch). */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.inFlight) await this.inFlight;
    if (this.dirty) await this.save();
  }

  // ── Layout menu ────────────────────────────────────────────────────────────

  async refreshList(): Promise<void> {
    try {
      const res = await firstValueFrom(this.remote.list());
      if (res?.status) this.layouts.set(res.data ?? []);
    } catch {
      /* the menu keeps the last list */
    }
  }

  async switchTo(id: number): Promise<boolean> {
    if (id === this.active().id) return true;
    await this.flush();
    return this.adopt(await this.call(this.remote.activate(id)));
  }

  /** A fresh layout with the default chart, opened at once. */
  async newLayout(name: string): Promise<boolean> {
    await this.flush();
    return this.adopt(
      await this.call(
        this.remote.create({
          name: name.trim() || DEFAULT_LAYOUT_NAME,
          state: { v: WORKSPACE_VERSION },
        }),
      ),
    );
  }

  async duplicate(name?: string): Promise<boolean> {
    const id = this.active().id;
    if (id === null) return false;
    await this.flush();
    return this.adopt(await this.call(this.remote.duplicate(id, name?.trim() || undefined)), false);
  }

  async rename(name: string): Promise<boolean> {
    const id = this.active().id;
    const trimmed = name.trim();
    if (id === null || !trimmed) return false;
    await this.flush();
    const res = await this.call(this.remote.update(id, { name: trimmed }));
    if (!res?.status || !res.data) return this.fail(res);
    this.active.set({ id, name: res.data.name, version: res.data.version });
    this.writeCache();
    void this.refreshList();
    return true;
  }

  async remove(id: number): Promise<boolean> {
    const res = await this.call(this.remote.remove(id));
    if (!res?.status) return this.fail(res);
    if (id === this.active().id) {
      this.dirty = false;
      const next = await this.call(this.remote.active());
      if (next?.status && next.data) this.adopt(next);
      else await this.newLayout(DEFAULT_LAYOUT_NAME);
    }
    void this.refreshList();
    return true;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async doLoad(): Promise<void> {
    this.status.set('loading');
    const cache = readCache();
    let res: ResponseData<ChartLayoutDto | null> | null = null;
    try {
      res = await firstValueFrom(this.remote.active().pipe(timeout(LOAD_TIMEOUT_MS)));
    } catch {
      res = null;
    }

    if (!res || !res.status) {
      // Offline: open with this browser's copy and keep trying to save it.
      this.initialState = cache?.state ?? null;
      this.active.set({
        id: cache?.layoutId ?? null,
        name: cache?.name ?? DEFAULT_LAYOUT_NAME,
        version: cache?.version ?? 0,
      });
      this.lastJson = cache?.state ? JSON.stringify(cache.state) : null;
      this.current = cache?.state ?? null;
      this.dirty = !!cache?.dirty;
      this.status.set('offline');
      this.schedule(RETRY_MS[0]);
      return;
    }

    if (res.data) {
      const l = res.data;
      const serverState = isWorkspaceState(l.state) ? l.state : null;
      if (cache?.dirty && cache.layoutId === l.id && cache.version === l.version && cache.state) {
        // An edit this browser never got confirmed, and nobody saved since: it is the newest.
        this.initialState = cache.state;
        this.active.set({ id: l.id, name: l.name, version: l.version });
        this.current = cache.state;
        this.lastJson = JSON.stringify(cache.state);
        this.dirty = true;
        this.schedule(0);
      } else {
        this.initialState = serverState;
        this.active.set({ id: l.id, name: l.name, version: l.version });
        this.current = serverState;
        this.lastJson = serverState ? JSON.stringify(serverState) : null;
        this.dirty = false;
        this.writeCache();
        this.status.set('saved');
      }
    } else {
      await this.migrate(cache);
    }
    void this.refreshList();
  }

  /** First load for this operator: upload what this browser had, then the engine owns it. */
  private async migrate(cache: WorkspaceCache | null): Promise<void> {
    const { layouts, lastId } = this.legacy.legacyLayouts();
    const last = layouts.find((l) => l.id === lastId) ?? null;
    const initial = cache?.state ?? (last ? legacyToState(last) : null);
    const created = await this.call(
      this.remote.create({
        name: last?.name ?? DEFAULT_LAYOUT_NAME,
        state: initial,
        activate: true,
      }),
    );
    if (!created?.status || !created.data) {
      this.initialState = initial;
      this.current = initial;
      this.dirty = !!initial;
      this.status.set('offline');
      this.schedule(RETRY_MS[0]);
      return;
    }
    let all = true;
    for (const l of layouts) {
      if (l === last) continue;
      const r = await this.call(
        this.remote.create({ name: l.name, state: legacyToState(l), activate: false }),
      );
      all &&= !!r?.status;
    }
    if (all) this.legacy.clearLegacyLayouts();
    this.initialState = initial;
    this.current = initial;
    this.lastJson = initial ? JSON.stringify(initial) : null;
    this.dirty = false;
    this.active.set({
      id: created.data.id,
      name: created.data.name,
      version: created.data.version,
    });
    this.writeCache();
    this.status.set('saved');
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.save();
    }, ms);
  }

  private save(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (!this.dirty || !this.current) return Promise.resolve();
    this.inFlight = this.doSave().finally(() => (this.inFlight = null));
    return this.inFlight;
  }

  private async doSave(conflicts = 0): Promise<void> {
    const state = this.current!;
    const sentJson = this.lastJson;
    const { id, version } = this.active();
    this.status.set('saving');
    let res: ResponseData<ChartLayoutDto> | null;
    try {
      res =
        id === null
          ? await firstValueFrom(
              this.remote.create({ name: this.active().name, state, activate: true }),
            )
          : await firstValueFrom(this.remote.update(id, { state, expectedVersion: version }));
    } catch (err) {
      if (
        err instanceof HttpErrorResponse &&
        err.status >= 400 &&
        err.status < 500 &&
        err.status !== 401 &&
        err.status !== 408
      ) {
        this.lastError.set((err.error as { message?: string })?.message ?? err.message);
        this.status.set('error');
        return;
      }
      this.offlineRetry();
      return;
    }

    if (res?.status && res.data) {
      this.retry = 0;
      this.active.set({ id: res.data.id, name: res.data.name, version: res.data.version });
      // Edits made while this save was in flight are still unsaved.
      this.dirty = this.lastJson !== sentJson;
      this.writeCache();
      this.status.set(this.dirty ? 'pending' : 'saved');
      if (this.dirty) this.schedule(SAVE_DEBOUNCE_MS);
      if (id === null) void this.refreshList();
      return;
    }
    if (res?.responseCode === '-409' && res.data && conflicts < 2) {
      // Saved elsewhere meanwhile. This edit is fresh (the operator just made it): it wins.
      this.active.set({ id: res.data.id, name: res.data.name, version: res.data.version });
      return this.doSave(conflicts + 1);
    }
    if (res?.responseCode === '-14') {
      // Deleted elsewhere: keep the work as a new layout rather than losing it.
      this.active.set({ id: null, name: this.active().name, version: 0 });
      return this.doSave(conflicts + 1);
    }
    this.lastError.set(res?.message ?? 'The layout was not saved.');
    this.status.set('error');
  }

  private offlineRetry(): void {
    this.status.set('offline');
    const ms = RETRY_MS[Math.min(this.retry, RETRY_MS.length - 1)];
    this.retry++;
    this.schedule(ms);
  }

  /** Tab regained focus with nothing unsaved: adopt a newer save from another tab or machine. */
  async refreshIfNewer(): Promise<void> {
    const { id, version } = this.active();
    if (id === null || this.dirty || this.inFlight || this.loading) return;
    let res: ResponseData<ChartLayoutDto | null> | null;
    try {
      res = await firstValueFrom(this.remote.active());
    } catch {
      return;
    }
    if (!res?.status || this.dirty || this.inFlight) return;
    const l = res.data;
    if (!l) return;
    if (l.id !== id || l.version > version) this.adopt(res);
  }

  /** Make a layout the open one and hand its state to the page. */
  private adopt(res: ResponseData<ChartLayoutDto | null> | null, apply = true): boolean {
    if (!res?.status || !res.data) return this.fail(res);
    const l = res.data;
    const state = isWorkspaceState(l.state) ? l.state : null;
    this.active.set({ id: l.id, name: l.name, version: l.version });
    if (apply) {
      this.current = state;
      this.lastJson = state ? JSON.stringify(state) : null;
      this.dirty = false;
      this.incoming.set({ state, seq: ++this.seq });
    }
    this.writeCache();
    this.status.set('saved');
    void this.refreshList();
    return true;
  }

  private fail(res: ResponseData<unknown> | null): false {
    this.lastError.set(res?.message ?? 'The engine could not be reached.');
    if (!res) this.status.set('offline');
    return false;
  }

  private async call<T>(
    obs: import('rxjs').Observable<ResponseData<T>>,
  ): Promise<ResponseData<T> | null> {
    try {
      return await firstValueFrom(obs);
    } catch {
      return null;
    }
  }

  private flushOnUnload(): void {
    const { id } = this.active();
    if (!this.dirty || id === null || !this.current) return;
    // No expectedVersion: this is the newest edit there is. The cache stays dirty on its old
    // version, so if the request is lost the next load still uploads it.
    this.remote.sendOnUnload(`/chart/layouts/${id}`, 'PUT', { state: this.current });
  }

  private writeCache(): void {
    const { id, name, version } = this.active();
    const cache: WorkspaceCache = {
      layoutId: id,
      name,
      version,
      state: this.current,
      dirty: this.dirty,
    };
    try {
      localStorage.setItem(WORKSPACE_CACHE_KEY, JSON.stringify(cache));
    } catch {
      /* too large or blocked: the engine still has it */
    }
  }
}

function readCache(): WorkspaceCache | null {
  try {
    const raw = localStorage.getItem(WORKSPACE_CACHE_KEY);
    const c = raw ? (JSON.parse(raw) as WorkspaceCache) : null;
    return c && typeof c === 'object'
      ? { ...c, state: isWorkspaceState(c.state) ? c.state : null }
      : null;
  } catch {
    return null;
  }
}
