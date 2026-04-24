import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import {
  KeyboardShortcutsService,
  type ShortcutBinding,
} from '@core/keyboard/keyboard-shortcuts.service';

@Component({
  selector: 'app-keyboard-help',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (service.helpOpen()) {
      <div
        class="overlay"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        (click)="service.closeHelp()"
      >
        <div class="dialog" (click)="$event.stopPropagation()">
          <header class="head">
            <h2>Keyboard shortcuts</h2>
            <button type="button" class="close" (click)="service.closeHelp()" aria-label="Close">
              &times;
            </button>
          </header>
          <div class="body">
            @for (group of grouped(); track group.name) {
              <section class="group">
                <h3>{{ group.name }}</h3>
                <ul>
                  @for (binding of group.items; track binding.keys) {
                    <li>
                      <span class="label">{{ binding.label }}</span>
                      <span class="combo">
                        @for (token of tokens(binding.keys); track token) {
                          <kbd>{{ token }}</kbd>
                        }
                      </span>
                    </li>
                  }
                </ul>
              </section>
            }
          </div>
          <footer class="foot">
            <span class="muted">Press <kbd>?</kbd> anywhere to toggle this overlay.</span>
          </footer>
        </div>
      </div>
    }
  `,
  styles: [
    `
      .overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.35);
        backdrop-filter: blur(6px);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: var(--space-5);
        z-index: 1150;
        animation: fadeIn 0.15s ease-out;
      }
      .dialog {
        width: min(640px, 100%);
        max-height: 85vh;
        display: flex;
        flex-direction: column;
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-lg);
        box-shadow: var(--shadow-lg);
        animation: scaleIn 0.2s ease-out;
      }
      .head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: var(--space-4) var(--space-5);
        border-bottom: 1px solid var(--border);
      }
      .head h2 {
        margin: 0;
        font-size: var(--text-lg);
        font-weight: var(--font-semibold);
      }
      .close {
        background: transparent;
        border: none;
        color: var(--text-secondary);
        width: 32px;
        height: 32px;
        border-radius: var(--radius-full);
        cursor: pointer;
        font-size: 20px;
      }
      .close:hover {
        background: var(--bg-tertiary);
      }
      .body {
        padding: var(--space-5);
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: var(--space-5);
      }
      .group h3 {
        margin: 0 0 var(--space-3);
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        font-weight: var(--font-semibold);
      }
      .group ul {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
      }
      .group li {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: var(--space-2) var(--space-3);
        border-radius: var(--radius-sm);
      }
      .group li:hover {
        background: var(--bg-secondary);
      }
      .label {
        font-size: var(--text-sm);
        color: var(--text-primary);
      }
      .combo {
        display: flex;
        gap: var(--space-1);
      }
      kbd {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: 11px;
        padding: 2px 8px;
        border-radius: 4px;
        background: var(--bg-tertiary);
        border: 1px solid var(--border);
        color: var(--text-primary);
      }
      .foot {
        padding: var(--space-3) var(--space-5);
        border-top: 1px solid var(--border);
        font-size: var(--text-xs);
        color: var(--text-tertiary);
      }
      .muted {
        color: var(--text-tertiary);
      }
      @keyframes fadeIn {
        from {
          opacity: 0;
        }
        to {
          opacity: 1;
        }
      }
      @keyframes scaleIn {
        from {
          transform: scale(0.96);
          opacity: 0;
        }
        to {
          transform: scale(1);
          opacity: 1;
        }
      }
    `,
  ],
})
export class KeyboardHelpComponent {
  protected readonly service = inject(KeyboardShortcutsService);

  readonly grouped = computed<Array<{ name: string; items: ShortcutBinding[] }>>(() => {
    const groups = new Map<string, ShortcutBinding[]>();
    for (const binding of this.service.bindings) {
      const list = groups.get(binding.group) ?? [];
      list.push(binding);
      groups.set(binding.group, list);
    }
    return Array.from(groups.entries()).map(([name, items]) => ({ name, items }));
  });

  tokens(combo: string): string[] {
    return combo.split(/\s+/).filter(Boolean);
  }
}
