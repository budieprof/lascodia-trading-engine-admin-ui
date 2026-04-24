import {
  Component,
  ChangeDetectionStrategy,
  input,
  output,
  signal,
  ElementRef,
  inject,
  HostListener,
  computed,
} from '@angular/core';
import { LucideAngularModule } from 'lucide-angular';

export interface DropdownMenuItem {
  label: string;
  icon?: string;
  action: string;
  destructive?: boolean;
}

@Component({
  selector: 'ui-dropdown-menu',
  standalone: true,
  imports: [LucideAngularModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="dropdown" (keydown)="onKeydown($event)">
      <div class="dropdown__trigger" (click)="toggleMenu()">
        <ng-content />
      </div>

      @if (isOpen()) {
        <div class="dropdown__menu" role="menu">
          @for (item of items(); track item.action; let i = $index) {
            <button
              type="button"
              role="menuitem"
              class="dropdown__item"
              [class.dropdown__item--destructive]="item.destructive"
              [class.dropdown__item--focused]="focusedIndex() === i"
              (click)="onItemClick(item)"
              (mouseenter)="focusedIndex.set(i)"
            >
              @if (item.icon) {
                <lucide-icon [name]="item.icon" [size]="16" [strokeWidth]="1.5"></lucide-icon>
              }
              <span>{{ item.label }}</span>
            </button>
          }
        </div>
      }
    </div>
  `,
  styles: [
    `
      .dropdown {
        position: relative;
        display: inline-block;
      }

      .dropdown__trigger {
        cursor: pointer;
      }

      .dropdown__menu {
        position: absolute;
        top: calc(100% + var(--space-1));
        right: 0;
        min-width: 180px;
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        box-shadow: var(--shadow-md);
        padding: var(--space-1);
        z-index: 1000;
        transform-origin: top right;
        animation: dropdown-scale-in 0.15s ease-out;
      }

      .dropdown__item {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        width: 100%;
        height: 36px;
        padding: 0 var(--space-3);
        border: none;
        border-radius: var(--radius-sm);
        background: transparent;
        color: var(--text-primary);
        font-family: inherit;
        font-size: 13px;
        font-weight: 400;
        cursor: pointer;
        transition: background-color 0.1s ease;
        text-align: left;
      }

      .dropdown__item:hover,
      .dropdown__item--focused {
        background: var(--bg-tertiary);
      }

      .dropdown__item--destructive {
        color: #ff3b30;
      }

      .dropdown__item--destructive:hover,
      .dropdown__item--destructive.dropdown__item--focused {
        background: rgba(255, 59, 48, 0.1);
      }

      @keyframes dropdown-scale-in {
        0% {
          opacity: 0;
          transform: scale(0.95);
        }
        100% {
          opacity: 1;
          transform: scale(1);
        }
      }
    `,
  ],
})
export class DropdownMenuComponent {
  readonly items = input.required<DropdownMenuItem[]>();
  readonly itemClick = output<string>();

  readonly isOpen = signal(false);
  readonly focusedIndex = signal(-1);

  private readonly elementRef = inject(ElementRef);

  readonly itemCount = computed(() => this.items().length);

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (!this.elementRef.nativeElement.contains(event.target)) {
      this.close();
    }
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.close();
  }

  toggleMenu(): void {
    this.isOpen.update((v) => !v);
    if (this.isOpen()) {
      this.focusedIndex.set(-1);
    }
  }

  close(): void {
    this.isOpen.set(false);
    this.focusedIndex.set(-1);
  }

  onItemClick(item: DropdownMenuItem): void {
    this.itemClick.emit(item.action);
    this.close();
  }

  onKeydown(event: KeyboardEvent): void {
    if (!this.isOpen()) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        this.toggleMenu();
      }
      return;
    }

    const count = this.itemCount();

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.focusedIndex.update((i) => (i + 1) % count);
        break;
      case 'ArrowUp':
        event.preventDefault();
        this.focusedIndex.update((i) => (i - 1 + count) % count);
        break;
      case 'Enter':
      case ' ': {
        event.preventDefault();
        const idx = this.focusedIndex();
        if (idx >= 0 && idx < count) {
          this.onItemClick(this.items()[idx]);
        }
        break;
      }
      case 'Escape':
        event.preventDefault();
        this.close();
        break;
    }
  }
}
