import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { ChartWorkspaceSync } from '../../workspace/workspace-sync.service';
import { ZonedDatePipe } from '../zoned-time';
import { ChartPanelsService } from './chart-panels.service';
import { captureChart } from './chart-snapshot';
import type { ChartNote, NoteBias } from './chart-panels.types';
import { ScriptDialogService } from '@features/scripting/shared/script-dialog.service';
import { confirmDelete } from '../../dialog/chart-dialogs';

/**
 * Notes and trade ideas on the chart (SP-I9), stored in the engine (`chart-note`), private to the operator: text, an
 * optional Long/Short bias, the timeframe, a picture of the chart as it was and the layout it was written on — so a
 * note can be read back on another machine and its layout reopened. Notes inform the operator only; nothing trades on
 * them.
 */
@Component({
  selector: 'app-notes-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ZonedDatePipe],
  template: `
    <div class="np-tools">
      <label
        ><input
          type="checkbox"
          [checked]="allSymbols()"
          (change)="allSymbols.set($any($event.target).checked)"
        />
        All symbols</label
      >
      <button type="button" class="np-link" (click)="composing.set(!composing())" data-testid="note-new">
        {{ composing() ? 'Cancel' : '+ New note' }}
      </button>
    </div>

    @if (composing()) {
      <form class="np-form" (submit)="$event.preventDefault(); save()">
        <input
          class="np-input"
          placeholder="Title (optional)"
          maxlength="160"
          [value]="title()"
          (input)="title.set($any($event.target).value)"
        />
        <textarea
          class="np-input"
          rows="4"
          maxlength="20000"
          placeholder="What do you see on {{ symbol() }}?"
          [value]="text()"
          (input)="text.set($any($event.target).value)"
          data-testid="note-text"
        ></textarea>
        <div class="np-row">
          <select
            class="np-input"
            (change)="bias.set($any($event.target).value || null)"
            aria-label="Bias"
          >
            <option value="" [selected]="!bias()">Note (no bias)</option>
            <option value="Long" [selected]="bias() === 'Long'">Idea · Long</option>
            <option value="Short" [selected]="bias() === 'Short'">Idea · Short</option>
          </select>
          <label title="A picture of the chart as it is now (price, studies, drawings)"
            ><input type="checkbox" [checked]="withPicture()" (change)="withPicture.set($any($event.target).checked)" />
            Picture</label
          >
          @if (layoutId() !== null) {
            <label [title]="'Reopen the layout ' + layoutName() + ' from the note'"
              ><input type="checkbox" [checked]="withLayout()" (change)="withLayout.set($any($event.target).checked)" />
              Layout</label
            >
          }
        </div>
        <button type="submit" class="np-save" [disabled]="saving() || !text().trim()">
          {{ saving() ? 'Saving…' : 'Save note on ' + symbol() + ' · ' + timeframe() }}
        </button>
      </form>
    }

    @if (error(); as e) {
      <div class="pane-empty np-error">{{ e }}</div>
    }
    @if (loading() && !notes().length) {
      <div class="pane-empty">Loading…</div>
    } @else if (!notes().length && !error()) {
      <div class="pane-empty">
        No notes {{ allSymbols() ? 'yet' : 'on ' + symbol() + ' yet' }} — "+ New note" writes one.
      </div>
    }

    <ul class="np-list">
      @for (n of notes(); track n.id) {
        <li class="np-note" [class.pinned]="n.isPinned">
          <div class="np-head">
            @if (n.bias) {
              <span class="np-bias" [class.long]="n.bias === 'Long'" [class.short]="n.bias === 'Short'">{{
                n.bias
              }}</span>
            }
            <strong class="np-title">{{ n.title || firstLine(n.text) }}</strong>
            <button
              type="button"
              class="np-icon"
              [class.on]="n.isPinned"
              (click)="togglePin(n)"
              [title]="n.isPinned ? 'Unpin' : 'Pin to the top'"
            >
              📌
            </button>
          </div>
          <div class="np-meta">
            {{ n.symbol }}{{ n.timeframe ? ' · ' + n.timeframe : '' }} ·
            {{ n.updatedAt | zonedDate: timeZone() : 'dateTime' }}
          </div>
          @if (editingId() === n.id) {
            <textarea
              class="np-input"
              rows="4"
              [value]="editText()"
              (input)="editText.set($any($event.target).value)"
            ></textarea>
            <div class="np-actions">
              <button type="button" class="np-link" (click)="saveEdit(n)" [disabled]="!editText().trim()">Save</button>
              <button type="button" class="np-link" (click)="editingId.set(null)">Cancel</button>
            </div>
          } @else {
            <p class="np-text">{{ n.text }}</p>
          }
          @if (pictures()[n.id]; as src) {
            <img class="np-picture" [src]="src" [alt]="'Chart of ' + n.symbol + ' when the note was written'" />
          }
          <div class="np-actions">
            @if (n.hasSnapshot && !pictures()[n.id]) {
              <button type="button" class="np-link" (click)="showPicture(n)">Show picture</button>
            }
            @if (n.symbol !== symbol()) {
              <button type="button" class="np-link" (click)="symbolSelected.emit(n.symbol)">Open {{ n.symbol }}</button>
            }
            @if (n.layoutId !== null && n.layoutId !== layoutId()) {
              <button type="button" class="np-link" (click)="openLayout(n)" title="Switch the chart to the layout this note was written on">
                Open its layout
              </button>
            }
            @if (editingId() !== n.id) {
              <button type="button" class="np-link" (click)="startEdit(n)">Edit</button>
            }
            <button type="button" class="np-link danger" (click)="remove(n)">Delete</button>
          </div>
        </li>
      }
    </ul>
  `,
  styles: [
    `
      :host {
        display: block;
        font-size: 12px;
      }
      .np-tools,
      .np-row,
      .np-actions,
      .np-head {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .np-tools {
        justify-content: space-between;
        padding: 0 12px 8px;
        color: var(--tv-muted, #787b86);
      }
      .np-tools label,
      .np-row label {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        cursor: pointer;
      }
      .np-tools input[type='checkbox'],
      .np-row input[type='checkbox'] {
        margin: 0;
      }
      /* The page's .pane-empty style does not reach inside this component (style encapsulation), so the empty, loading
         and error states are styled here — otherwise they sat flush against the pane's left border. */
      .pane-empty {
        padding: 10px 12px;
        line-height: 1.45;
        color: var(--tv-muted, #787b86);
      }
      .np-error {
        color: #f23645;
      }
      .np-form {
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: 0 10px 10px;
      }
      .np-input {
        font: inherit;
        color: inherit;
        background: transparent;
        border: 1px solid var(--tv-line, #e0e3eb);
        border-radius: 4px;
        padding: 4px 6px;
        width: 100%;
        box-sizing: border-box;
      }
      .np-row .np-input {
        width: auto;
      }
      .np-save {
        font: inherit;
        color: #fff;
        background: var(--tv-blue, #2962ff);
        border: 0;
        border-radius: 4px;
        padding: 5px 8px;
        cursor: pointer;
      }
      .np-save:disabled {
        opacity: 0.5;
        cursor: default;
      }
      .np-link {
        font: inherit;
        color: var(--tv-blue, #2962ff);
        background: transparent;
        border: 0;
        padding: 0;
        cursor: pointer;
      }
      .np-link.danger {
        color: #f23645;
      }
      .np-link:disabled {
        opacity: 0.5;
      }
      .np-list {
        list-style: none;
        margin: 0;
        padding: 0;
      }
      .np-note {
        padding: 8px 10px;
        border-bottom: 1px solid var(--tv-line, #e0e3eb);
      }
      .np-note.pinned {
        background: var(--tv-hover, #f0f3fa);
      }
      .np-title {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .np-bias {
        font-size: 10px;
        font-weight: 700;
        padding: 0 5px;
        border-radius: 3px;
        color: #fff;
      }
      .np-bias.long {
        background: #089981;
      }
      .np-bias.short {
        background: #f23645;
      }
      .np-icon {
        font: inherit;
        background: transparent;
        border: 0;
        padding: 0;
        cursor: pointer;
        opacity: 0.35;
      }
      .np-icon.on {
        opacity: 1;
      }
      .np-meta {
        margin: 2px 0 4px;
        color: var(--tv-muted, #787b86);
        font-size: 11px;
      }
      .np-text {
        margin: 0 0 4px;
        white-space: pre-wrap;
        line-height: 1.4;
      }
      .np-picture {
        display: block;
        max-width: 100%;
        margin: 4px 0;
        border: 1px solid var(--tv-line, #e0e3eb);
        border-radius: 3px;
      }
      .np-error {
        color: #f23645;
      }
    `,
  ],
})
export class NotesPanelComponent {
  private readonly api = inject(ChartPanelsService);
  private readonly workspace = inject(ChartWorkspaceSync);
  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly dialogs = inject(ScriptDialogService);

  readonly symbol = input.required<string>();
  /** The chart's resolution label ("1h", "1D"), stored with a new note. */
  readonly timeframe = input<string>('');
  readonly timeZone = input<string | null>(null);
  /** "Open EURUSD" on a note about another symbol. */
  readonly symbolSelected = output<string>();

  readonly notes = signal<ChartNote[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly allSymbols = signal(false);
  readonly composing = signal(false);
  readonly title = signal('');
  readonly text = signal('');
  readonly bias = signal<NoteBias | null>(null);
  readonly withPicture = signal(true);
  readonly withLayout = signal(true);
  readonly saving = signal(false);
  readonly editingId = signal<number | null>(null);
  readonly editText = signal('');
  /** Pictures loaded on demand (they can be large), by note id. */
  readonly pictures = signal<Record<number, string>>({});

  readonly layoutId = computed(() => this.workspace.active().id);
  readonly layoutName = computed(() => this.workspace.active().name);
  private seq = 0;

  constructor() {
    effect(() => {
      const symbol = this.symbol();
      const all = this.allSymbols();
      untracked(() => void this.load(all ? null : symbol));
    });
  }

  private async load(symbol: string | null): Promise<void> {
    const n = ++this.seq;
    this.loading.set(true);
    try {
      const rows = await firstValueFrom(this.api.notes(symbol));
      if (n !== this.seq) return;
      this.notes.set(rows ?? []);
      this.error.set(null);
    } catch (e) {
      if (n === this.seq) this.error.set(this.message(e, 'The notes could not be loaded.'));
    } finally {
      if (n === this.seq) this.loading.set(false);
    }
  }

  async save(): Promise<void> {
    const text = this.text().trim();
    if (!text || this.saving()) return;
    this.saving.set(true);
    try {
      // The chart area this panel sits in is the one the picture is of.
      const picture = this.withPicture()
        ? captureChart((this.host.nativeElement as HTMLElement).closest<HTMLElement>('.chart-area'))
        : null;
      const created = await firstValueFrom(
        this.api.createNote({
          symbol: this.symbol(),
          timeframe: this.timeframe() || null,
          title: this.title().trim() || null,
          text,
          bias: this.bias(),
          snapshotDataUrl: picture,
          layoutId: this.withLayout() ? this.layoutId() : null,
        }),
      );
      this.notes.update((list) => [created, ...list]);
      if (picture) this.pictures.update((p) => ({ ...p, [created.id]: picture }));
      this.title.set('');
      this.text.set('');
      this.bias.set(null);
      this.composing.set(false);
      this.error.set(
        this.withPicture() && !picture ? 'Saved — without a picture: the chart could not be captured.' : null,
      );
    } catch (e) {
      this.error.set(this.message(e, 'The note could not be saved.'));
    } finally {
      this.saving.set(false);
    }
  }

  startEdit(n: ChartNote): void {
    this.editingId.set(n.id);
    this.editText.set(n.text);
  }

  async saveEdit(n: ChartNote): Promise<void> {
    const text = this.editText().trim();
    if (!text) return;
    await this.patch(n, { text });
    this.editingId.set(null);
  }

  togglePin(n: ChartNote): Promise<void> {
    return this.patch(n, { isPinned: !n.isPinned }, true);
  }

  private async patch(n: ChartNote, body: { text?: string; isPinned?: boolean }, resort = false): Promise<void> {
    try {
      const saved = await firstValueFrom(this.api.updateNote(n.id, body));
      this.notes.update((list) => {
        const next = list.map((x) => (x.id === n.id ? saved : x));
        return resort ? [...next].sort((a, b) => Number(b.isPinned) - Number(a.isPinned) || b.updatedAt.localeCompare(a.updatedAt)) : next;
      });
      this.error.set(null);
    } catch (e) {
      this.error.set(this.message(e, 'The note could not be saved.'));
    }
  }

  async remove(n: ChartNote): Promise<void> {
    if (!(await confirmDelete(this.dialogs, `the note “${n.title || this.firstLine(n.text)}”`))) return;
    try {
      await firstValueFrom(this.api.deleteNote(n.id));
      this.notes.update((list) => list.filter((x) => x.id !== n.id));
    } catch (e) {
      this.error.set(this.message(e, 'The note could not be deleted.'));
    }
  }

  async showPicture(n: ChartNote): Promise<void> {
    try {
      const full = await firstValueFrom(this.api.note(n.id));
      if (full.snapshotDataUrl) this.pictures.update((p) => ({ ...p, [n.id]: full.snapshotDataUrl! }));
    } catch (e) {
      this.error.set(this.message(e, 'The picture could not be loaded.'));
    }
  }

  async openLayout(n: ChartNote): Promise<void> {
    if (n.layoutId === null) return;
    const ok = await this.workspace.switchTo(n.layoutId);
    if (!ok) this.error.set(this.workspace.lastError() ?? 'That layout could not be opened (it may have been deleted).');
  }

  firstLine(text: string): string {
    const line = text.split('\n')[0].trim();
    return line.length > 60 ? `${line.slice(0, 57)}…` : line;
  }

  private message(e: unknown, fallback: string): string {
    return e instanceof Error && e.message ? e.message : fallback;
  }
}
