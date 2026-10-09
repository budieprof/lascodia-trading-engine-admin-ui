import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { SCRIPTING_UI_STYLES } from '../components/scripting-ui.styles';
import { describeFailure } from '../shared/api-error';
import { ScriptDialogService } from '../shared/script-dialog.service';
import { ScreensApiService } from './screens-api.service';
import { isoText, scheduleText, screenSourceText, timeframeName } from './screens.model';
import type { ScreenRunDto, ScriptScreenDto } from './screens.types';

/**
 * SS-I6 / BX-6 — the operator's saved screens: open one into the screener, switch its schedule on or off, run it now,
 * or delete it. A screen belongs to the operator who saved it; the engine lists only theirs.
 */
@Component({
  selector: 'app-saved-screens-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card" aria-labelledby="scr-saved-title" data-testid="saved-screens">
      <header class="head">
        <h2 class="card-title" id="scr-saved-title">Saved screens</h2>
        <span class="muted small">{{ screens().length }} saved</span>
      </header>
      @if (problem(); as p) {
        <p class="error-box" role="alert">{{ p }}</p>
      }
      @if (loading() && screens().length === 0) {
        <p class="muted small">Loading screens…</p>
      } @else if (screens().length === 0) {
        <p class="muted small">
          No saved screens yet. Run the screener, then save it below to keep it, run it at every bar
          close and get alerts when symbols start or stop matching.
        </p>
      } @else {
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Screen</th>
                <th scope="col">Script</th>
                <th scope="col">Universe</th>
                <th scope="col">Matching now</th>
                <th scope="col">Schedule</th>
                <th scope="col">Last run</th>
                <th scope="col"><span class="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              @for (s of screens(); track s.id) {
                <tr [class.active]="s.id === activeId()" [attr.data-screen]="s.id">
                  <td>
                    <button type="button" class="link" (click)="opened.emit(s.id)">
                      {{ s.name }}
                    </button>
                  </td>
                  <td class="small">{{ source(s) }}</td>
                  <td class="small">{{ universe(s) }}</td>
                  <td class="small" [attr.title]="s.matched.join(', ')">
                    {{ s.matched.length }}
                  </td>
                  <td class="small">
                    <label class="check">
                      <input
                        type="checkbox"
                        [checked]="s.scheduleEnabled"
                        [disabled]="!canWrite() || busyId() === s.id"
                        [attr.aria-label]="'Run ' + s.name + ' at every bar close'"
                        (change)="setSchedule(s, $any($event.target))"
                      />
                      <span>{{ schedule(s) }}</span>
                    </label>
                  </td>
                  <td class="small">
                    {{ when(s.lastRunAt) }}
                    @if (s.lastRunError) {
                      <span class="chip chip-error" [attr.title]="s.lastRunError">failed</span>
                    }
                  </td>
                  <td class="actions">
                    <button
                      type="button"
                      class="btn btn-sm"
                      [disabled]="!canRun() || busyId() === s.id"
                      (click)="runNow(s)"
                    >
                      @if (busyId() === s.id && running()) {
                        <span class="spinner" aria-hidden="true"></span>
                      }
                      Run now
                    </button>
                    <button
                      type="button"
                      class="btn btn-ghost btn-sm"
                      [disabled]="!canWrite() || busyId() === s.id"
                      (click)="remove(s)"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
    </section>
  `,
  styles: [
    SCRIPTING_UI_STYLES,
    `
      :host {
        display: block;
      }
      .card {
        padding: var(--space-4) var(--space-5);
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
        min-width: 0;
      }
      .head {
        display: flex;
        align-items: baseline;
        gap: 8px;
      }
      .card-title {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .table-wrap {
        overflow-x: auto;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-sm);
      }
      th,
      td {
        text-align: left;
        padding: 6px 8px;
        border-bottom: 1px solid var(--border);
        vertical-align: middle;
      }
      th {
        font-weight: var(--font-medium);
        color: var(--text-secondary);
        font-size: var(--text-xs);
      }
      tr.active td {
        background: rgba(0, 122, 255, 0.06);
      }
      .link {
        background: none;
        border: 0;
        padding: 0;
        color: var(--accent);
        font: inherit;
        cursor: pointer;
        text-align: left;
      }
      .link:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 2px;
      }
      .check {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .actions {
        white-space: nowrap;
        text-align: right;
      }
      p {
        margin: 0;
      }
      .sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border: 0;
      }
    `,
  ],
})
export class SavedScreensPanelComponent {
  private readonly api = inject(ScreensApiService);
  private readonly dialog = inject(ScriptDialogService);

  readonly activeId = input<number | null>(null);
  /** Bumped by the page after a save so the list reads again. */
  readonly refreshKey = input(0);
  readonly canWrite = input(true);
  readonly canRun = input(true);

  readonly opened = output<number>();
  readonly ran = output<ScreenRunDto>();
  readonly removed = output<number>();
  readonly changed = output<ScriptScreenDto>();

  readonly screens = signal<ScriptScreenDto[]>([]);
  readonly loading = signal(false);
  readonly problem = signal<string | null>(null);
  readonly busyId = signal<number | null>(null);
  readonly running = signal(false);

  constructor() {
    effect(() => {
      this.refreshKey();
      untracked(() => void this.load());
    });
  }

  source(s: ScriptScreenDto): string {
    return screenSourceText(s);
  }

  /** "3 symbols · H1 + H4". */
  universe(s: ScriptScreenDto): string {
    const n = s.symbols.length;
    const tfs = [s.timeframe, ...(s.extraTimeframes ?? [])].map(timeframeName).join(' + ');
    return `${n} symbol${n === 1 ? '' : 's'} · ${tfs}`;
  }

  schedule(s: ScriptScreenDto): string {
    return scheduleText(s);
  }

  when(iso: string | null): string {
    return iso ? isoText(iso) : 'never';
  }

  async load(): Promise<void> {
    this.loading.set(true);
    try {
      const res = await firstValueFrom(this.api.list());
      if (!res?.status) throw res;
      this.screens.set(res.data ?? []);
      this.problem.set(null);
    } catch (err) {
      this.problem.set(describeFailure(err, 'Your screens could not be loaded.'));
    } finally {
      this.loading.set(false);
    }
  }

  async setSchedule(s: ScriptScreenDto, box: HTMLInputElement): Promise<void> {
    const enabled = box.checked;
    this.busyId.set(s.id);
    this.problem.set(null);
    try {
      const res = await firstValueFrom(this.api.setSchedule(s.id, enabled));
      if (!res?.status || !res.data) throw res;
      this.replace(res.data);
      this.changed.emit(res.data);
    } catch (err) {
      this.problem.set(describeFailure(err, 'The schedule could not be changed.'));
      // The box shows what the engine has, not what was clicked.
      box.checked = s.scheduleEnabled;
    } finally {
      this.busyId.set(null);
    }
  }

  async runNow(s: ScriptScreenDto): Promise<void> {
    this.busyId.set(s.id);
    this.running.set(true);
    this.problem.set(null);
    try {
      const res = await firstValueFrom(this.api.run(s.id));
      if (!res?.status || !res.data) throw res;
      this.ran.emit(res.data);
      void this.load();
    } catch (err) {
      this.problem.set(describeFailure(err, `${s.name} did not run.`));
    } finally {
      this.busyId.set(null);
      this.running.set(false);
    }
  }

  async remove(s: ScriptScreenDto): Promise<void> {
    const ok = await this.dialog.confirm({
      title: `Delete ${s.name}?`,
      message: s.scheduleEnabled
        ? 'Its schedule stops, alerts not yet sent are dropped, and its run history goes with it.'
        : 'The screen and its run history go.',
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!ok) return;
    this.busyId.set(s.id);
    this.problem.set(null);
    try {
      const res = await firstValueFrom(this.api.delete(s.id));
      if (!res?.status) throw res;
      this.screens.update((list) => list.filter((x) => x.id !== s.id));
      this.removed.emit(s.id);
    } catch (err) {
      this.problem.set(describeFailure(err, `${s.name} could not be deleted.`));
    } finally {
      this.busyId.set(null);
    }
  }

  private replace(dto: ScriptScreenDto): void {
    this.screens.update((list) => list.map((x) => (x.id === dto.id ? dto : x)));
  }
}
