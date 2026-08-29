import { Directive, ElementRef, inject } from '@angular/core';

/**
 * Makes the copy buttons that `MarkdownPipe` emits above each code block work.
 *
 * The pipe produces static HTML for [innerHTML], so the button cannot carry an Angular
 * binding. Rather than a document-wide listener, this attaches ONE delegated listener to
 * its own host, so only the subtree that actually renders markdown is wired up and the
 * handler dies with the component.
 *
 * The code is read from the sibling <pre>'s textContent at click time. That deliberately
 * avoids stashing it in a data- attribute: the text would need a second round of escaping,
 * and a diagram full of quotes and angle brackets is exactly the payload that gets that
 * wrong. textContent also gives us the browser's own entity decoding for free.
 */
@Directive({
  selector: '[appMarkdownCopy]',
  standalone: true,
  host: { '(click)': 'onClick($event)' },
})
export class MarkdownCopyDirective {
  private readonly host = inject(ElementRef<HTMLElement>);

  protected onClick(event: Event): void {
    const button = (event.target as HTMLElement | null)?.closest?.('.md-copy');
    if (!button || !this.host.nativeElement.contains(button)) return;

    const code = button.parentElement?.querySelector('pre')?.textContent;
    if (!code) return;

    event.preventDefault();
    // Non-blocking and best-effort: clipboard access can be denied (insecure origin, or the
    // user refused permission). A silent no-op is better than a thrown promise here, but the
    // label still has to tell the truth about what happened.
    void navigator.clipboard
      ?.writeText(code)
      .then(() => this.flash(button as HTMLElement, 'Copied'))
      .catch(() => this.flash(button as HTMLElement, 'Press ⌘C'));
  }

  private flash(button: HTMLElement, message: string): void {
    const original = button.textContent;
    button.textContent = message;
    setTimeout(() => {
      // The transcript may have re-rendered underneath us in the meantime.
      if (button.isConnected) button.textContent = original;
    }, 1200);
  }
}
