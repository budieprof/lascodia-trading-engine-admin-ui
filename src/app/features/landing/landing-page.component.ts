import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  HostListener,
  computed,
  inject,
  signal,
} from '@angular/core';
import { Meta, Title } from '@angular/platform-browser';
import { RouterLink } from '@angular/router';

import { ThemeService } from '@core/theme/theme.service';
import { DemoApiService } from '@features/demo/demo-api.service';
import { OnboardingApiService } from '@features/onboarding/onboarding-api.service';
import type { PublicSignupAvailability } from '@features/onboarding/onboarding.types';
import { LogoComponent } from '@shared/components/logo/logo.component';
import { HeroConsoleComponent } from './components/hero-console.component';
import { LandingAudiencesComponent } from './components/landing-audiences.component';
import { LandingFeaturesComponent } from './components/landing-features.component';
import { LandingOnboardingComponent } from './components/landing-onboarding.component';
import { LandingSafetyComponent } from './components/landing-safety.component';
import { LandingTradePathComponent } from './components/landing-trade-path.component';
import { LandingTrustComponent } from './components/landing-trust.component';
import { SALES_EMAIL, STATS } from './landing.content';
import { primaryCta } from './landing.logic';
import { RevealDirective } from './reveal.directive';

const NAV = [
  { id: 'product', label: 'Platform' },
  { id: 'how-it-works', label: 'How it works' },
  { id: 'safety', label: 'Safety' },
  { id: 'solutions', label: 'Solutions' },
  { id: 'plans', label: 'Plans' },
  { id: 'faq', label: 'FAQ' },
];

const PAGE_TITLE = 'Lascodia — Systematic trading, with the safety built in';
const PAGE_DESCRIPTION =
  'Lascodia turns strategies into orders on your own MetaTrader 5 terminals: live charting and order flow, Pine ' +
  'research, AI analysis and seven layers of risk control in one console for traders, prop firms, brokers and funds.';

/**
 * The public landing page (`/` for visitors who are not signed in, and `/welcome` for anyone). Outside the
 * console layout and session handling: the only engine calls are the anonymous sign-up and demo availability
 * probes, which decide what the buttons offer. Copy lives in `landing.content.ts`.
 */
@Component({
  selector: 'app-landing-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    LogoComponent,
    RevealDirective,
    HeroConsoleComponent,
    LandingTradePathComponent,
    LandingFeaturesComponent,
    LandingSafetyComponent,
    LandingAudiencesComponent,
    LandingOnboardingComponent,
    LandingTrustComponent,
  ],
  templateUrl: './landing-page.component.html',
  styleUrl: './landing-page.component.scss',
  host: { class: 'lp' },
})
export class LandingPageComponent {
  protected readonly theme = inject(ThemeService);
  protected readonly nav = NAV;
  protected readonly stats = STATS;
  protected readonly year = new Date().getFullYear();
  protected readonly salesEmail = SALES_EMAIL;

  protected readonly signup = signal<PublicSignupAvailability | null>(null);
  protected readonly demoAvailable = signal(false);
  protected readonly cta = computed(() => primaryCta(this.signup()));
  protected readonly scrolled = signal(false);
  protected readonly menuOpen = signal(false);

  constructor() {
    const title = inject(Title);
    const meta = inject(Meta);
    const previousTitle = title.getTitle();
    title.setTitle(PAGE_TITLE);
    meta.updateTag({ name: 'description', content: PAGE_DESCRIPTION });
    meta.updateTag({ property: 'og:title', content: PAGE_TITLE });
    meta.updateTag({ property: 'og:description', content: PAGE_DESCRIPTION });
    inject(DestroyRef).onDestroy(() => {
      title.setTitle(previousTitle);
      meta.removeTag("name='description'");
      meta.removeTag("property='og:title'");
      meta.removeTag("property='og:description'");
    });

    // Both probes fail closed: no answer means the main button asks for access and the demo link stays hidden.
    inject(OnboardingApiService)
      .signupAvailability()
      .subscribe({ next: (a) => this.signup.set(a), error: () => this.signup.set(null) });
    inject(DemoApiService)
      .status()
      .subscribe({
        next: (s) => this.demoAvailable.set(s?.available === true),
        error: () => this.demoAvailable.set(false),
      });

    this.onScroll();
  }

  @HostListener('window:scroll')
  protected onScroll(): void {
    this.scrolled.set(typeof window !== 'undefined' && window.scrollY > 8);
  }

  @HostListener('document:keydown.escape')
  protected closeMenu(): void {
    this.menuOpen.set(false);
  }

  /** In-page links: scroll without changing the route (a bare `#id` href would resolve against `<base href="/">`). */
  protected go(event: Event, id: string): void {
    event.preventDefault();
    this.menuOpen.set(false);
    const el = document.getElementById(id);
    if (!el) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
    el.setAttribute('tabindex', '-1');
    el.focus({ preventScroll: true });
  }

  protected toTop(event: Event): void {
    event.preventDefault();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}
