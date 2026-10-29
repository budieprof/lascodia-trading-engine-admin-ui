import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import type { SafeHtml } from '@angular/platform-browser';

/**
 * A rendered guide body (`<div class="md">`). It owns the guide-content styles so the guide page's own
 * stylesheet stays small; clicks bubble to the page, which handles links and screenshot zoom.
 */
@Component({
  selector: 'app-doc-markdown',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './doc-markdown.scss',
  template: `<div class="md" [innerHTML]="html()"></div>`,
})
export class DocMarkdownComponent {
  readonly html = input.required<SafeHtml | string | null>();
}
