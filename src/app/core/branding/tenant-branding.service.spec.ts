import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiService } from '@core/api/api.service';
import { AuthService } from '@core/auth/auth.service';
import { Permission as P } from '@core/auth/permissions.generated';
import { ensureTestBed } from '@core/testing/zoneless-test-bed';
import type { TenantBranding } from './branding.types';
import { DEFAULT_TITLE, TenantBrandingService } from './tenant-branding.service';

ensureTestBed();

const customised: TenantBranding = {
  tenantId: 7001,
  displayName: 'Acme Desk',
  customDisplayName: 'Acme Desk',
  primaryColor: '#1f6feb',
  logo: {
    contentType: 'image/png',
    sizeBytes: 10,
    width: 100,
    height: 40,
    sha256: 'a'.repeat(64),
    url: 'tenant/branding/logo?v=aaaa',
  },
  favicon: {
    contentType: 'image/x-icon',
    sizeBytes: 10,
    width: 32,
    height: 32,
    sha256: 'b'.repeat(64),
    url: 'tenant/branding/favicon?v=bbbb',
  },
  isCustomised: true,
  updatedAtUtc: null,
  updatedBy: null,
};

describe('TenantBrandingService', () => {
  let get: ReturnType<typeof vi.fn>;
  let getBlob: ReturnType<typeof vi.fn>;
  let held: Set<string>;

  beforeEach(() => {
    document.head.innerHTML =
      '<meta name="theme-color" content="#0A84FF"><link rel="icon" type="image/svg+xml" href="favicon.svg"><link rel="icon" href="favicon.ico">';
    document.title = DEFAULT_TITLE;
    document.documentElement.style.cssText = '';
    held = new Set([P.TenantBrandingRead]);
    get = vi.fn(() => of({ status: true, responseCode: '00', message: '', data: customised }));
    getBlob = vi.fn(async () => new Blob(['x'], { type: 'image/png' }));
    // jsdom has no object URLs.
    Object.defineProperty(URL, 'createObjectURL', {
      value: vi.fn(() => 'blob:x'),
      configurable: true,
      writable: true,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      value: vi.fn(),
      configurable: true,
      writable: true,
    });
    TestBed.configureTestingModule({
      providers: [
        { provide: ApiService, useValue: { get, getBlob } },
        {
          provide: AuthService,
          useValue: {
            isAuthenticated: signal(true).asReadonly(),
            hasPermission: (k: string) => held.has(k),
          },
        },
      ],
    });
  });
  afterEach(() => TestBed.resetTestingModule());

  it('applies the organisation look: name, title, colour, logo and favicon', async () => {
    const svc = TestBed.inject(TenantBrandingService);
    await svc.start();

    expect(get).toHaveBeenCalledWith('/tenant/branding', { silent: true });
    expect(svc.displayName()).toBe('Acme Desk');
    expect(document.title).toBe('Acme Desk');
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#1f6feb');
    expect(document.documentElement.style.getPropertyValue('--accent-hover')).not.toBe('');
    expect(document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')!.content).toBe(
      '#1f6feb',
    );
    expect(getBlob).toHaveBeenCalledWith('/tenant/branding/logo?v=aaaa');
    expect(svc.logoUrl()).toBe('blob:x');
    const icons = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]'));
    expect(
      icons.every((l) => l.getAttribute('href') === 'blob:x' && l.type === 'image/x-icon'),
    ).toBe(true);
  });

  it('clear() puts Lascodia back (the sign-in page never shows the organisation look)', async () => {
    const svc = TestBed.inject(TenantBrandingService);
    await svc.start();
    svc.clear();
    expect(svc.displayName()).toBeNull();
    expect(svc.logoUrl()).toBeNull();
    expect(document.title).toBe(DEFAULT_TITLE);
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('');
    expect(document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')!.content).toBe(
      '#0A84FF',
    );
    const icons = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]')).map(
      (l) => l.getAttribute('href'),
    );
    expect(icons).toEqual(['favicon.svg', 'favicon.ico']);
  });

  it('does nothing without tenant.branding.read, and keeps the platform look when nothing is set or it cannot load', async () => {
    held.clear();
    const svc = TestBed.inject(TenantBrandingService);
    await svc.start();
    expect(get).not.toHaveBeenCalled();

    held.add(P.TenantBrandingRead);
    get.mockReturnValueOnce(
      of({
        status: true,
        responseCode: '00',
        message: '',
        data: { ...customised, isCustomised: false },
      }),
    );
    await svc.start();
    expect(svc.displayName()).toBeNull();
    expect(document.title).toBe(DEFAULT_TITLE);

    get.mockReturnValueOnce(throwError(() => new Error('down')));
    await svc.refresh();
    expect(svc.branding()).toBeNull();
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('');
  });
});
