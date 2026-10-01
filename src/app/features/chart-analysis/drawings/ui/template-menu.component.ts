import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { drawingTemplates, templateStyle, type DrawingTemplate } from '../drawing-templates';
import { styleFor, type Drawing } from '../model';

/**
 * TradingView's "Template ▾" menu: Save Drawing Template As…, Apply Default,
 * Save As Default, then the saved templates for this tool (each removable).
 */
@Component({
  selector: 'app-template-menu',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="tm" (click)="$event.stopPropagation()" (pointerdown)="$event.stopPropagation()">
      @if (naming()) {
        <form class="tm-name" (submit)="$event.preventDefault(); saveAs(nameInput.value)">
          <input #nameInput placeholder="Template name" autofocus (keydown.escape)="naming.set(false)" />
          <button type="submit" class="tm-ok">Save</button>
        </form>
      } @else {
        <button type="button" class="tm-item" (click)="naming.set(true)">Save Drawing Template As…</button>
      }
      <button type="button" class="tm-item" (click)="applyDefault()">Apply Default Drawing Template</button>
      <button type="button" class="tm-item" (click)="saveDefault()">Save As Default</button>
      @if (templates().length) {
        <div class="tm-sep"></div>
        @for (t of templates(); track t.name) {
          <div class="tm-row">
            <button type="button" class="tm-item" (click)="apply.emit(t)">{{ t.name }}</button>
            <button type="button" class="tm-x" title="Remove template" (click)="remove(t.name)">×</button>
          </div>
        }
      }
    </div>
  `,
  styles: `
    .tm {
      min-width: 230px; padding: 6px 0; background: var(--tv-bg, #fff); color: var(--tv-ink, #131722);
      border-radius: 6px; box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2), 0 0 0 1px var(--tv-line, #e0e3eb);
      font-size: 13px;
    }
    .tm-item {
      display: block; width: 100%; text-align: left; padding: 7px 16px; border: 0;
      background: none; color: inherit; font: inherit; cursor: pointer; white-space: nowrap;
    }
    .tm-item:hover, .tm-x:hover { background: var(--tv-hover, #f0f3fa); }
    .tm-row { display: flex; }
    .tm-x { border: 0; background: none; color: var(--tv-muted, #787b86); cursor: pointer; padding: 0 12px; font-size: 16px; }
    .tm-sep { height: 1px; background: var(--tv-line, #e0e3eb); margin: 6px 0; }
    .tm-name { display: flex; gap: 6px; padding: 4px 10px; }
    .tm-name input {
      flex: 1; min-width: 0; padding: 4px 8px; border: 1px solid var(--tv-line, #e0e3eb);
      border-radius: 4px; background: transparent; color: inherit; font: inherit;
    }
    .tm-ok {
      border: 0; border-radius: 4px; background: var(--tv-blue, #2962ff); color: #fff;
      padding: 4px 10px; cursor: pointer; font: inherit;
    }
  `,
})
export class TemplateMenuComponent {
  readonly drawing = input.required<Drawing>();
  readonly apply = output<DrawingTemplate>();

  readonly naming = signal(false);
  /** Bumped after a write so the list re-reads. */
  private readonly rev = signal(0);
  readonly templates = computed(() => {
    this.rev();
    return drawingTemplates.list(this.drawing().kind);
  });

  saveAs(name: string): void {
    const n = name.trim();
    if (!n) return;
    const d = this.drawing();
    drawingTemplates.save(d.kind, { name: n, style: templateStyle(d.style), options: d.options });
    this.naming.set(false);
    this.rev.update((v) => v + 1);
  }

  saveDefault(): void {
    const d = this.drawing();
    drawingTemplates.saveDefault(d.kind, { style: templateStyle(d.style), options: d.options });
  }

  /** Default template if one was saved, else the tool's built-in look. */
  applyDefault(): void {
    const d = this.drawing();
    const saved = drawingTemplates.getDefault(d.kind);
    this.apply.emit(
      saved ?? { name: 'Default', style: templateStyle(styleFor(d.kind)), options: {} },
    );
  }

  remove(name: string): void {
    drawingTemplates.remove(this.drawing().kind, name);
    this.rev.update((v) => v + 1);
  }
}
