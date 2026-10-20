import {
  Directive,
  Input,
  TemplateRef,
  ViewContainerRef,
  effect,
  inject,
  signal,
} from '@angular/core';

import { AuthService } from './auth.service';
import type { PermissionKey } from './permissions.generated';

/**
 * Renders its element only when the signed-in person holds the permission (any of them, for a
 * list) in the active organisation — and takes it away again the moment they no longer do.
 *
 * ```html
 * <button *lscCan="'iam.grants.manage'" (click)="grant()">Grant role</button>
 * <section *lscCan="['iam.members.read', 'iam.grants.manage']; else noAccess">…</section>
 * ```
 *
 * The engine still refuses what the person may not do; this hides controls that would only fail.
 */
@Directive({ selector: '[lscCan]', standalone: true })
export class LscCanDirective {
  private readonly auth = inject(AuthService);
  private readonly template = inject<TemplateRef<unknown>>(TemplateRef);
  private readonly container = inject(ViewContainerRef);

  private readonly keys = signal<readonly string[] | null>(null);
  private readonly elseTemplate = signal<TemplateRef<unknown> | null>(null);
  private shown: TemplateRef<unknown> | null = null;

  /** One key, or a list (any of). */
  @Input({ required: true })
  set lscCan(value: PermissionKey | readonly PermissionKey[]) {
    this.keys.set(typeof value === 'string' ? [value] : [...value]);
  }

  /** Rendered instead when the person lacks the permission. */
  @Input()
  set lscCanElse(template: TemplateRef<unknown> | null | undefined) {
    this.elseTemplate.set(template ?? null);
  }

  constructor() {
    effect(() => {
      const keys = this.keys();
      if (keys === null) return; // inputs not bound yet
      const allowed = this.auth.hasAnyPermission(keys);
      this.show(allowed ? this.template : this.elseTemplate());
    });
  }

  private show(next: TemplateRef<unknown> | null): void {
    if (next === this.shown) return;
    this.container.clear();
    if (next) this.container.createEmbeddedView(next);
    this.shown = next;
  }
}
