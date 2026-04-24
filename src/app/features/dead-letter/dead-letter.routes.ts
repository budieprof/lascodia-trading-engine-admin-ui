import { Routes } from '@angular/router';
import { DeadLetterPageComponent } from './pages/dead-letter-page/dead-letter-page.component';

export const DEAD_LETTER_ROUTES: Routes = [
  { path: '', component: DeadLetterPageComponent, data: { breadcrumb: 'Dead Letters' } },
];
