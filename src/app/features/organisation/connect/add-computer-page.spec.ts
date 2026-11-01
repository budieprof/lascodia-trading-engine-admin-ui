import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthService } from '@core/auth/auth.service';
import { NotificationService } from '@core/notifications/notification.service';
import { ensureTestBed } from '@core/testing/zoneless-test-bed';
import { OrganisationApiService } from '../organisation-api.service';
import { AddComputerPageComponent } from './add-computer-page.component';
import type { SupervisorSetup } from './add-computer.types';

const { save } = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock('@features/scripting/shared/download', () => ({ saveBlob: save }));

ensureTestBed();

const base = 'https://app.example.com/api/v1/lascodia-trading-engine';

const setup: SupervisorSetup = {
  apiBaseUrl: base,
  installShUrl: `${base}/onboarding/supervisor/install.sh`,
  installPs1Url: `${base}/onboarding/supervisor/install.ps1`,
  macCommandTemplate: `curl -fsSL ${base}/onboarding/supervisor/install.sh | sh -s -- {token}`,
  windowsCommandTemplate: `& ([scriptblock]::Create((irm ${base}/onboarding/supervisor/install.ps1))) {token}`,
  webRequestAllowUrl: 'https://app.example.com',
  platforms: [
    { platform: 'macos-arm64', label: 'macOS (Apple silicon)', available: true, version: '0.4.0', sizeBytes: 1, publishedAtUtc: null },
    { platform: 'macos-x86_64', label: 'macOS (Intel)', available: true, version: '0.4.0', sizeBytes: 1, publishedAtUtc: null },
    { platform: 'windows-x64', label: 'Windows', available: false, version: null, sizeBytes: null, publishedAtUtc: null },
  ],
  autoUpdate: true,
  enrollmentTokenHours: 24,
};

function apiStub() {
  return {
    supervisorSetup: vi.fn(() => of(setup)),
    downloadMacInstaller: vi.fn(() => of({ blob: new Blob(['pkg']), sha256: null, version: '1.0.0' })),
    createEnrollmentToken: vi.fn(() =>
      of({
        id: 77,
        token: 'lsc_enr_abcd1234_SECRET',
        prefix: 'abcd1234',
        kind: 'Daemon',
        tradingAccountId: null,
        accountLogin: null,
        brokerServer: null,
        label: 'Office Mac',
        expiresAtUtc: new Date(Date.now() + 23 * 3_600_000).toISOString(),
      }),
    ),
    enrollmentProgress: vi.fn(() =>
      of({
        tokenId: 77,
        label: 'Office Mac',
        kind: 'Daemon',
        tokenStatus: 'Pending',
        stage: 'waiting',
        connected: false,
        steps: [],
        hints: [],
        daemon: null,
      }),
    ),
  };
}

describe('AddComputerPageComponent', () => {
  let api: ReturnType<typeof apiStub>;

  beforeEach(() => {
    vi.useFakeTimers();
    api = apiStub();
    TestBed.configureTestingModule({
      providers: [
        { provide: OrganisationApiService, useValue: api },
        { provide: NotificationService, useValue: { error: vi.fn(), success: vi.fn() } },
        { provide: AuthService, useValue: { hasPermission: () => true } },
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap({}) } } },
      ],
    });
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    vi.useRealTimers();
  });

  const page = () => TestBed.runInInjectionContext(() => new AddComputerPageComponent());

  it('makes a Daemon token and shows the one line with it for the chosen OS', () => {
    const p = page();
    p.os.set('macos');
    p.label.set('  Office Mac ');
    p.create();
    expect(api.createEnrollmentToken).toHaveBeenCalledWith({ kind: 'Daemon', label: 'Office Mac' });
    expect(p.command()).toBe(`curl -fsSL ${base}/onboarding/supervisor/install.sh | sh -s -- lsc_enr_abcd1234_SECRET`);
    expect(api.enrollmentProgress).toHaveBeenCalledWith(77);
    expect(p.headline().text).toContain('Waiting for your computer');
    expect(p.expiry().expired).toBe(false);
  });

  it('does not make a line for an OS whose installer is not published, nor without a name', () => {
    const p = page();
    p.os.set('windows');
    p.label.set('Office PC');
    p.create();
    expect(p.availability().available).toBe(false);
    p.os.set('macos');
    p.label.set('   ');
    p.create();
    expect(api.createEnrollmentToken).not.toHaveBeenCalled();
  });

  it('follows a line made earlier from ?token=', () => {
    TestBed.overrideProvider(ActivatedRoute, { useValue: { snapshot: { queryParamMap: convertToParamMap({ token: '77' }) } } });
    const p = page();
    expect(p.tokenId()).toBe(77);
    expect(api.enrollmentProgress).toHaveBeenCalledWith(77);
  });

  it('offers the double-click installer on a Mac once it is published, named after the install code', async () => {
    const withPkg: SupervisorSetup = {
      ...setup,
      macInstaller: { platform: 'macos-pkg', label: 'macOS installer (double-click)', available: true, version: '1.0.0', sizeBytes: 12_000, publishedAtUtc: null },
      macInstallerFileNameTemplate: 'Lascodia Setup {token}.pkg',
    };
    api.supervisorSetup.mockReturnValue(of(withPkg));
    save.mockClear();
    const p = page();
    p.os.set('windows');
    expect(p.pkgOffered()).toBe(false);
    p.os.set('macos');
    expect(p.pkgOffered()).toBe(true);
    p.label.set('Office Mac');
    p.create();
    p.downloadInstaller('lsc_enr_abcd1234_SECRET');
    expect(api.downloadMacInstaller).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0][1]).toBe('Lascodia Setup lsc_enr_abcd1234_SECRET.pkg');
    expect(p.downloadingPkg()).toBe(false);
  });

  it('does not offer the installer when the engine has not published one', () => {
    const p = page();
    p.os.set('macos');
    expect(p.pkgOffered()).toBe(false);
  });
});
