import { Routes } from '@angular/router';
import { CalibrationPageComponent } from './pages/calibration-page/calibration-page.component';

export const CALIBRATION_ROUTES: Routes = [
  { path: '', component: CalibrationPageComponent, data: { breadcrumb: 'Calibration' } },
];
