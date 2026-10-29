import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

import { AuthService } from '@core/auth/auth.service';
import { Permission } from '@core/auth/permissions.generated';
import { TenantBrandingService } from '@core/branding/tenant-branding.service';
import { NotificationService } from '@core/notifications/notification.service';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { errorText } from '@features/iam/iam.logic';
import { iamResource } from '@features/iam/shared/iam-resource';
import { ago } from '@features/iam/shared/admin-context.logic';
import { AuditTrailComponent } from '@features/iam/shared/audit-trail.component';
import { StatTilesComponent, type StatTile } from '@features/iam/shared/stat-tiles.component';
import { LifecycleApiService } from '../lifecycle-api.service';
import {
  BRANDING_LIMITS,
  formatBytes,
  imageFileProblem,
  isValidColour,
  readableTextOn,
} from '../lifecycle.logic';
import type { BrandingImageKind, TenantBranding } from '../lifecycle.types';

/**
 * The organisation's console look (engine multi-tenancy Phase 7, LC.4, `/tenant/branding`): the name in
 * the header, sidebar and browser title, the primary colour, the sidebar logo and the favicon. Members see
 * it after they sign in; the sign-in page always shows Lascodia. Reading needs `tenant.branding.read`,
 * changing `tenant.branding.manage` (Admin/Owner). Images are checked by their content on the engine
 * (logo PNG/JPEG/WebP ≤ 256 KB; favicon PNG/ICO ≤ 64 KB).
 */
@Component({
  selector: 'app-organisation-branding-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    PageHeaderComponent,
    ConfirmDialogComponent,
    StatTilesComponent,
    AuditTrailComponent,
  ],
  styleUrls: ['../../../iam/shared/iam-page.scss'],
  styles: [
    `
      .preview {
        display: flex;
        align-items: center;
        gap: var(--space-3);
        padding: var(--space-3) var(--space-4);
        border-radius: var(--radius-md);
        border: 1px solid var(--border);
      }
      .preview img {
        max-height: 40px;
        max-width: 160px;
        object-fit: contain;
      }
      .swatch {
        display: inline-flex;
        align-items: center;
        padding: 4px 12px;
        border-radius: var(--radius-full);
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
      }
      .images {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
        gap: var(--space-4);
      }
      .image-box {
        border: 1px dashed var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-3);
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
      }
      .image-box img {
        max-height: 64px;
        max-width: 200px;
        object-fit: contain;
        align-self: flex-start;
      }
      .where {
        margin: 0;
        padding-left: var(--space-5);
        list-style: disc;
        display: grid;
        gap: var(--space-2);
      }
      .colour-row {
        display: flex;
        gap: var(--space-2);
        align-items: center;
      }
      .colour-row input[type='color'] {
        width: 44px;
        height: 34px;
        padding: 0;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: transparent;
      }
    `,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Branding"
        subtitle="How the console looks for your organisation's members once they have signed in."
      >
        <button
          type="button"
          class="btn btn-secondary"
          (click)="branding.reload()"
          [disabled]="branding.loading()"
        >
          {{ branding.loading() ? 'Loading…' : 'Reload' }}
        </button>
      </app-page-header>

      <app-stat-tiles [tiles]="tiles()" label="Branding summary" />

      @if (branding.error(); as err) {
        <section class="card">
          <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
        </section>
      }

      @if (branding.value(); as b) {
        <section class="card">
          <header class="card-head">
            <h3>Preview</h3>
            <span class="spacer"></span>
            @if (b.isCustomised) {
              <span class="chip info">Customised</span>
            } @else {
              <span class="chip">Platform look</span>
            }
          </header>
          <div class="card-body">
            <div class="preview">
              @if (logoPreview(); as src) {
                <img [src]="src" alt="Your organisation's logo" />
              }
              <strong>{{ previewName() }}</strong>
              <span class="spacer"></span>
              @if (previewColour(); as c) {
                <span class="swatch" [style.background]="c" [style.color]="textOn(c)"
                  >Primary colour</span
                >
              }
            </div>
            <p class="note">
              The sign-in page always shows Lascodia. Members see this after they sign in.
            </p>
          </div>
        </section>

        <section class="card">
          <header class="card-head"><h3>Name and colour</h3></header>
          <form class="card-body" (ngSubmit)="saveNameAndColour()">
            <div class="form-grid">
              <label class="field">
                <span class="label">Display name (empty = the organisation's own name)</span>
                <input
                  class="input"
                  name="displayName"
                  maxlength="64"
                  [disabled]="!canManage()"
                  [ngModel]="displayName()"
                  (ngModelChange)="displayName.set($event)"
                />
              </label>
              <label class="field">
                <span class="label">Primary colour (empty = the platform's)</span>
                <span class="colour-row">
                  <input
                    type="color"
                    name="colourPicker"
                    aria-label="Pick the primary colour"
                    [disabled]="!canManage()"
                    [ngModel]="colour() || '#0071e3'"
                    (ngModelChange)="colour.set($event)"
                  />
                  <input
                    class="input"
                    name="colour"
                    placeholder="#1f6feb"
                    maxlength="7"
                    [attr.aria-invalid]="!colourOk()"
                    [disabled]="!canManage()"
                    [ngModel]="colour()"
                    (ngModelChange)="colour.set($event)"
                  />
                </span>
              </label>
            </div>
            @if (!colourOk()) {
              <ul class="errors" role="alert">
                <li>The colour must be a hex colour such as #1f6feb.</li>
              </ul>
            }
            @if (canManage()) {
              <div class="actions-row">
                <button
                  type="submit"
                  class="btn btn-primary"
                  [disabled]="busy() || !colourOk() || !nameDirty()"
                >
                  {{ busy() ? 'Saving…' : 'Save name and colour' }}
                </button>
              </div>
            }
          </form>
        </section>

        <section class="card">
          <header class="card-head"><h3>Logo and favicon</h3></header>
          <div class="card-body images">
            @for (kind of kinds; track kind) {
              <div class="image-box">
                <strong>{{ kind === 'logo' ? 'Logo (sidebar)' : 'Favicon (browser tab)' }}</strong>
                @if (kind === 'logo' ? logoPreview() : faviconPreview(); as src) {
                  <img [src]="src" [alt]="kind === 'logo' ? 'Current logo' : 'Current favicon'" />
                }
                @if (kind === 'logo' ? b.logo : b.favicon; as img) {
                  <span class="small muted"
                    >{{ img.contentType }} · {{ img.width }}×{{ img.height }} px ·
                    {{ size(img.sizeBytes) }}</span
                  >
                } @else {
                  <span class="small muted">None: the platform's {{ kind }} is shown.</span>
                }
                <span class="small muted">{{ limits[kind].label }}.</span>
                @if (canManage()) {
                  <label class="btn btn-secondary btn-sm">
                    Upload…
                    <input
                      type="file"
                      class="sr-only"
                      [attr.aria-label]="'Upload a ' + kind"
                      [accept]="limits[kind].types.join(',') + (kind === 'favicon' ? ',.ico' : '')"
                      (change)="upload(kind, $event)"
                    />
                  </label>
                  @if (kind === 'logo' ? b.logo : b.favicon) {
                    <button
                      type="button"
                      class="btn btn-danger btn-sm"
                      [disabled]="busy()"
                      (click)="removeImage(kind)"
                    >
                      Remove {{ kind }}
                    </button>
                  }
                }
              </div>
            }
          </div>
        </section>

        @if (canManage() && b.isCustomised) {
          <section class="card">
            <div class="card-body actions-row">
              <button
                type="button"
                class="btn btn-danger"
                [disabled]="busy()"
                (click)="confirmingReset.set(true)"
              >
                Go back to the platform look
              </button>
            </div>
          </section>
        }
      }

      <section class="card">
        <header class="card-head"><h3>Where members see it</h3></header>
        <div class="card-body small">
          <ul class="where">
            <li><strong>Name</strong> — the header, the sidebar and the browser tab title.</li>
            <li>
              <strong>Colour</strong> — buttons, links, the selected page in the sidebar and the
              phone's address bar; text on it switches to black or white for contrast.
            </li>
            <li><strong>Logo</strong> — the top of the sidebar, in place of the platform's.</li>
            <li><strong>Favicon</strong> — the browser tab and bookmarks.</li>
            <li>
              Not changed: the sign-in page (always the platform's), e-mails and the public status
              page. A change shows at each member's next page load.
            </li>
          </ul>
        </div>
      </section>

      <app-audit-trail
        heading="Branding changes"
        [actions]="['tenant.branding.']"
        empty="The branding has never been changed: members see the platform's look. Every change of the name, colour or images is recorded here."
      />

      <app-confirm-dialog
        [open]="confirmingReset()"
        title="Remove all branding?"
        message="The name, colour, logo and favicon are removed and members see the platform's look again."
        confirmLabel="Remove branding"
        confirmVariant="destructive"
        [loading]="busy()"
        (confirm)="reset()"
        (cancelled)="confirmingReset.set(false)"
      />
    </div>
  `,
})
export class BrandingPageComponent {
  private readonly api = inject(LifecycleApiService);
  private readonly auth = inject(AuthService);
  private readonly notify = inject(NotificationService);
  private readonly applied = inject(TenantBrandingService);

  protected readonly kinds: readonly BrandingImageKind[] = ['logo', 'favicon'];
  protected readonly limits = BRANDING_LIMITS;
  protected readonly size = formatBytes;
  protected readonly textOn = readableTextOn;

  readonly branding = iamResource<TenantBranding | null>(
    () => this.api.branding(),
    null,
    'Could not load the branding.',
  );
  readonly canManage = computed(() => this.auth.hasPermission(Permission.TenantBrandingManage));
  readonly tiles = computed<StatTile[]>(() => {
    const b = this.branding.value();
    const img = (i: TenantBranding['logo'], what: string): StatTile => ({
      label: what,
      value: i ? `${i.width}×${i.height}` : 'Platform’s',
      caption: i
        ? `${i.contentType.replace('image/', '').toUpperCase()} · ${formatBytes(i.sizeBytes)}`
        : 'none uploaded',
      tone: i ? 'good' : null,
    });
    return [
      {
        label: 'Name shown',
        value: b?.displayName ?? '…',
        caption: b?.customDisplayName ? 'branding name' : 'the organisation’s own name',
      },
      {
        label: 'Colour',
        value: b?.primaryColor ?? 'Platform’s',
        caption: b?.primaryColor ? 'members’ accent colour' : 'no colour set',
      },
      img(b?.logo ?? null, 'Sidebar logo'),
      img(b?.favicon ?? null, 'Favicon'),
      {
        label: 'Last changed',
        value: b?.updatedAtUtc ? ago(b.updatedAtUtc) : 'Never',
        caption: b?.updatedAtUtc ? `by ${b.updatedBy ?? 'someone'}` : 'the platform look is in use',
      },
    ];
  });

  readonly displayName = signal('');
  readonly colour = signal('');
  readonly colourOk = computed(() => isValidColour(this.colour()));
  readonly nameDirty = computed(() => {
    const b = this.branding.value();
    return (
      (b?.customDisplayName ?? '') !== this.displayName().trim() ||
      (b?.primaryColor ?? '') !== this.colour().trim().toLowerCase()
    );
  });
  readonly previewName = computed(
    () => this.displayName().trim() || this.branding.value()?.displayName || '',
  );
  readonly previewColour = computed(() => {
    const c = this.colour().trim();
    return c && isValidColour(c) ? c : null;
  });

  readonly logoPreview = signal<string | null>(null);
  readonly faviconPreview = signal<string | null>(null);
  readonly busy = signal(false);
  readonly confirmingReset = signal(false);

  constructor() {
    effect(() => {
      const b = this.branding.value();
      untracked(() => {
        this.displayName.set(b?.customDisplayName ?? '');
        this.colour.set(b?.primaryColor ?? '');
        void this.loadPreviews(b);
      });
    });
    inject(DestroyRef).onDestroy(() => this.revokePreviews());
    this.branding.reload();
  }

  saveNameAndColour(): void {
    if (!this.colourOk() || this.busy()) return;
    this.busy.set(true);
    this.api
      .updateBranding({
        displayName: this.displayName().trim() || null,
        primaryColor: this.colour().trim() || null,
      })
      .subscribe({
        next: (b) => this.done(b, 'Saved. Members see it at their next page load.'),
        error: (e) => this.failed(e, 'Could not save the name and colour.'),
      });
  }

  upload(kind: BrandingImageKind, event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file || this.busy()) return;
    const problem = imageFileProblem(kind, file);
    if (problem) {
      this.notify.error(problem);
      return;
    }
    this.busy.set(true);
    this.api.uploadImage(kind, file).subscribe({
      next: (b) => this.done(b, kind === 'logo' ? 'Logo saved.' : 'Favicon saved.'),
      error: (e) => this.failed(e, `Could not save the ${kind}.`),
    });
  }

  removeImage(kind: BrandingImageKind): void {
    if (this.busy()) return;
    this.busy.set(true);
    this.api.removeImage(kind).subscribe({
      next: (b) => this.done(b, kind === 'logo' ? 'Logo removed.' : 'Favicon removed.'),
      error: (e) => this.failed(e, `Could not remove the ${kind}.`),
    });
  }

  reset(): void {
    this.busy.set(true);
    this.api.resetBranding().subscribe({
      next: (b) => {
        this.confirmingReset.set(false);
        this.done(b, 'Branding removed: the platform look is back.');
      },
      error: (e) => {
        this.confirmingReset.set(false);
        this.failed(e, 'Could not remove the branding.');
      },
    });
  }

  private done(b: TenantBranding, message: string): void {
    this.busy.set(false);
    this.branding.value.set(b);
    this.notify.success(message);
    void this.applied.refresh();
  }

  private failed(e: unknown, fallback: string): void {
    this.busy.set(false);
    this.notify.error(errorText(e, fallback));
  }

  private async loadPreviews(b: TenantBranding | null): Promise<void> {
    this.revokePreviews();
    const [logo, favicon] = await Promise.all([
      b?.logo ? this.api.imageBlob(b.logo.url) : Promise.resolve(null),
      b?.favicon ? this.api.imageBlob(b.favicon.url) : Promise.resolve(null),
    ]);
    if (this.branding.value() !== b) return;
    this.logoPreview.set(logo ? URL.createObjectURL(logo) : null);
    this.faviconPreview.set(favicon ? URL.createObjectURL(favicon) : null);
  }

  private revokePreviews(): void {
    for (const url of [this.logoPreview(), this.faviconPreview()])
      if (url) URL.revokeObjectURL(url);
    this.logoPreview.set(null);
    this.faviconPreview.set(null);
  }
}
