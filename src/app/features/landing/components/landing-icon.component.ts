import { ChangeDetectionStrategy, Component, input } from '@angular/core';

import type { IconName } from '../landing.content';

/** Line icons for the landing page: 24-unit grid, 1.75 stroke, `currentColor`. Decorative (aria-hidden). */
@Component({
  selector: 'lp-icon',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg
      viewBox="0 0 24 24"
      [attr.width]="size()"
      [attr.height]="size()"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      @switch (name()) {
        @case ('chart') {
          <path d="M3 3v18h18" />
          <path d="M8 15v3M8 9v3M13 11v5M13 6v2M18 8v6M18 4v1" />
          <rect x="6.5" y="11" width="3" height="4" rx=".6" />
          <rect x="11.5" y="8" width="3" height="3" rx=".6" />
          <rect x="16.5" y="5" width="3" height="3" rx=".6" />
        }
        @case ('code') {
          <path d="m8 7-5 5 5 5M16 7l5 5-5 5M13.5 4l-3 16" />
        }
        @case ('spark') {
          <path
            d="M12 3l1.8 4.9L19 9.7l-5.2 1.8L12 16.4l-1.8-4.9L5 9.7l5.2-1.8zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"
          />
        }
        @case ('fleet') {
          <rect x="3" y="4" width="18" height="6" rx="1.5" />
          <rect x="3" y="14" width="18" height="6" rx="1.5" />
          <path d="M7 7h.01M7 17h.01M11 7h6M11 17h6" />
        }
        @case ('shield') {
          <path d="M12 3l8 3v6c0 4.5-3.4 8.2-8 9-4.6-.8-8-4.5-8-9V6z" />
          <path d="m8.5 12 2.5 2.5 4.5-5" />
        }
        @case ('team') {
          <circle cx="9" cy="8" r="3.2" />
          <path
            d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M16 5.2a3 3 0 0 1 0 5.6M18 14.4c1.8.8 3 2.7 3 4.8"
          />
        }
        @case ('lock') {
          <rect x="4.5" y="10.5" width="15" height="10" rx="2" />
          <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3M12 14.5v2" />
        }
        @case ('key') {
          <circle cx="8" cy="15" r="4" />
          <path d="m11 12 9-9M17 6l2.5 2.5M14.5 8.5 16.5 10.5" />
        }
        @case ('approve') {
          <circle cx="8" cy="8" r="3" />
          <circle cx="16" cy="8" r="3" />
          <path d="M2.5 19c.6-2.9 2.8-5 5.5-5 1.3 0 2.5.5 3.4 1.3M14 19l2 2 4-4.5" />
        }
        @case ('audit') {
          <path d="M8 3h8l4 4v14H4V3h4" />
          <path d="M8 11h8M8 15h5M8 7h3" />
        }
        @case ('doc') {
          <rect x="4" y="3" width="16" height="18" rx="2" />
          <path d="M8 8h8M8 12h4" />
          <circle cx="15.5" cy="16" r="2" />
        }
        @case ('isolate') {
          <rect x="3" y="3" width="8" height="8" rx="1.5" />
          <rect x="13" y="13" width="8" height="8" rx="1.5" />
          <path d="M13 7h4a2 2 0 0 1 2 2v1M11 17H7a2 2 0 0 1-2-2v-1" stroke-dasharray="2 2" />
        }
        @case ('user') {
          <circle cx="12" cy="8" r="4" />
          <path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8" />
        }
        @case ('trophy') {
          <path
            d="M7 4h10v5a5 5 0 0 1-10 0zM7 6H4a3 3 0 0 0 3 4M17 6h3a3 3 0 0 1-3 4M12 14v3M8 21h8M9.5 17h5l.5 4h-6z"
          />
        }
        @case ('bank') {
          <path d="M3 9.5 12 4l9 5.5M5 10v8M9.7 10v8M14.3 10v8M19 10v8M3 20.5h18" />
        }
        @case ('fund') {
          <path d="M12 3a9 9 0 1 0 9 9h-9z" />
          <path d="M15 3.5A9 9 0 0 1 20.5 9H15z" />
        }
      }
    </svg>
  `,
  styles: [':host{display:inline-flex;line-height:0}'],
})
export class LandingIconComponent {
  readonly name = input.required<IconName>();
  readonly size = input(22);
}
