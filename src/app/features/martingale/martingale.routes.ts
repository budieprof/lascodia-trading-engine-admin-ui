import { Routes } from '@angular/router';
import { MartingalePageComponent } from './pages/martingale-page/martingale-page.component';
import { MartingaleInternalsPageComponent } from './pages/martingale-internals-page/martingale-internals-page.component';

export const MARTINGALE_ROUTES: Routes = [
  { path: '', component: MartingalePageComponent },
  // Configuration and observation are separate jobs: the root page changes what the ladder WILL
  // do, this one explains what it HAS done. Keeping them apart stops a read-only investigation
  // from sharing a screen with switches that move money.
  { path: 'internals', component: MartingaleInternalsPageComponent },
];
