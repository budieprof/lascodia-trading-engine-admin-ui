/**
 * An organisation's console look (engine multi-tenancy Phase 7, LC.4, `/tenant/branding`), as the engine
 * sends it. Used by the service that applies it and by the organisation's branding page.
 */

export interface BrandingImage {
  contentType: string;
  sizeBytes: number;
  width: number;
  height: number;
  sha256: string;
  /** Relative to the API base, with a `v` that changes with the image (cacheable). */
  url: string;
}

export interface TenantBranding {
  tenantId: number;
  /** What the console shows: the branding name, else the organisation's own name. */
  displayName: string;
  /** The branding name only; null = not set. */
  customDisplayName: string | null;
  /** `#rrggbb`, or null for the platform's colour. */
  primaryColor: string | null;
  logo: BrandingImage | null;
  favicon: BrandingImage | null;
  isCustomised: boolean;
  updatedAtUtc: string | null;
  updatedBy: string | null;
}

export interface UpdateBrandingBody {
  displayName: string | null;
  primaryColor: string | null;
}

export type BrandingImageKind = 'logo' | 'favicon';
