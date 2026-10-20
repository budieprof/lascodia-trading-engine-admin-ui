import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import { permissionDefinition, type PermissionDefinition } from '@core/auth/permissions.generated';

/** The usage rules of one permission (catalog v2, contract C3.4). */
export type PermissionFlagSource = Pick<
  PermissionDefinition,
  'stepUp' | 'twoPerson' | 'scopeable' | 'deprecated'
>;

/** One chip beside a permission in a role editor. */
export interface PermissionFlag {
  readonly label: string;
  readonly title: string;
  readonly tone: 'info' | 'warn' | 'plain';
}

/**
 * The chips a role editor shows beside a permission: needs a second factor (step-up, contract
 * C3.2), needs a second person (contract C3.3), only counts organisation-wide (not scopeable), and
 * deprecated (an old access tier). `source` is a catalog entry, or a key looked up in the console's
 * generated catalog; an unknown key has no chips. `scope: false` leaves out "org-wide" where every
 * grant is organisation-wide anyway (the admin-user role editor).
 */
export function permissionFlags(
  source: PermissionFlagSource | string | null | undefined,
  opts: { scope?: boolean } = {},
): PermissionFlag[] {
  const p = typeof source === 'string' ? permissionDefinition(source) : source;
  if (!p) return [];
  const out: PermissionFlag[] = [];
  if (p.stepUp) {
    out.push({
      label: 'MFA',
      title: 'Using it for a change needs a fresh sign-in with a second factor',
      tone: 'info',
    });
  }
  if (p.twoPerson) {
    out.push({
      label: '2-person',
      title: "Needs a second person's approval where two-person rules apply",
      tone: 'warn',
    });
  }
  if ((opts.scope ?? true) && !p.scopeable) {
    out.push({
      label: 'org-wide',
      title: 'Only counts when the role is given for the whole organisation',
      tone: 'plain',
    });
  }
  if (p.deprecated) {
    out.push({
      label: 'deprecated',
      title: 'Still enforced; give the specific keys instead',
      tone: 'plain',
    });
  }
  return out;
}

/** {@link permissionFlags} as chips. */
@Component({
  selector: 'app-permission-flags',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @for (f of flags(); track f.label) {
      <span
        class="flag"
        [class.info]="f.tone === 'info'"
        [class.warn]="f.tone === 'warn'"
        [title]="f.title"
      >
        {{ f.label }}
      </span>
    }
  `,
  styles: [
    `
      :host {
        display: inline-flex;
        flex-wrap: wrap;
        flex-shrink: 0;
        gap: 4px;
        margin-left: 4px;
      }
      :host:empty {
        display: none;
      }
      .flag {
        display: inline-flex;
        align-items: center;
        padding: 2px 8px;
        border-radius: var(--radius-full);
        font-size: 10.5px;
        font-weight: var(--font-semibold);
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        white-space: nowrap;
      }
      .flag.info {
        background: rgba(10, 132, 255, 0.12);
        color: #0a84ff;
      }
      .flag.warn {
        background: rgba(255, 149, 0, 0.16);
        color: #b25000;
      }
    `,
  ],
})
export class PermissionFlagsComponent {
  /** A catalog entry, or a key to look up in the generated catalog. */
  readonly permission = input.required<PermissionFlagSource | string>();
  /** Show "org-wide" for keys that cannot be granted below the organisation. */
  readonly scope = input(true);

  readonly flags = computed(() => permissionFlags(this.permission(), { scope: this.scope() }));
}
