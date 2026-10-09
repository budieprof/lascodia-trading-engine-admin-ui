import {
  ApplicationRef,
  EnvironmentInjector,
  Injectable,
  createComponent,
  inject,
} from '@angular/core';

import {
  ScriptChoiceDialogComponent,
  type ScriptDialogOptions,
  type ScriptDialogResult,
  type ScriptDialogTone,
} from './script-choice-dialog.component';

export type {
  ScriptDialogChoice,
  ScriptDialogCompare,
  ScriptDialogOptions,
  ScriptDialogResult,
} from './script-choice-dialog.component';

/**
 * Asks the operator a question and waits for the answer — save conflicts, overwrite checks,
 * unsaved-change guards, live-money confirmations. Callable from anywhere (a route guard, a
 * service, a component method), because the dialog is created on demand and attached to the
 * document body; it never depends on where the caller sits in the page.
 *
 * ```ts
 * const r = await dialogs.ask({ title, message, choices: [{ id: 'overwrite', label: 'Overwrite' }] });
 * if (r.choice === 'overwrite') …
 * ```
 */
@Injectable({ providedIn: 'root' })
export class ScriptDialogService {
  private readonly appRef = inject(ApplicationRef);
  private readonly injector = inject(EnvironmentInjector);
  private open = 0;

  /** True while one of these dialogs is on screen. */
  get isOpen(): boolean {
    return this.open > 0;
  }

  ask<T extends string>(options: ScriptDialogOptions<T>): Promise<ScriptDialogResult<T>> {
    const ref = createComponent(ScriptChoiceDialogComponent, { environmentInjector: this.injector });
    ref.instance.options.set(options as ScriptDialogOptions);
    ref.instance.text.set(options.field?.value ?? '');
    this.appRef.attachView(ref.hostView);
    document.body.appendChild(ref.location.nativeElement as HTMLElement);
    this.open++;
    return new Promise<ScriptDialogResult<T>>((resolve) => {
      const sub = ref.instance.closed.subscribe((result) => {
        sub.unsubscribe();
        this.open--;
        this.appRef.detachView(ref.hostView);
        ref.destroy();
        resolve(result as ScriptDialogResult<T>);
      });
      ref.changeDetectorRef.detectChanges();
      ref.instance.show();
    });
  }

  /** A yes / no question: resolves true only for the confirm button. */
  async confirm(options: {
    title: string;
    message: string;
    details?: readonly string[];
    confirmLabel: string;
    cancelLabel?: string;
    tone?: ScriptDialogTone;
  }): Promise<boolean> {
    const tone = options.tone ?? 'primary';
    const r = await this.ask({
      title: options.title,
      message: options.message,
      details: options.details,
      cancelLabel: options.cancelLabel,
      tone: tone === 'danger' ? 'danger' : 'primary',
      choices: [{ id: 'confirm', label: options.confirmLabel, tone }],
    });
    return r.choice === 'confirm';
  }
}

/** The question every unsaved-change guard asks; true = leave and lose the edits. */
export function confirmDiscard(
  dialogs: ScriptDialogService,
  what = 'This page has unsaved changes',
): Promise<boolean> {
  return dialogs.confirm({
    title: 'Discard unsaved changes?',
    message: `${what}. Leaving now throws them away.`,
    confirmLabel: 'Discard changes',
    cancelLabel: 'Keep editing',
    tone: 'danger',
  });
}
