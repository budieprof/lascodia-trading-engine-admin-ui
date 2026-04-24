import { Routes } from '@angular/router';
import { MlModelsPageComponent } from './pages/ml-models-page/ml-models-page.component';
import { MLModelDetailPageComponent } from './pages/ml-model-detail-page/ml-model-detail-page.component';

export const ML_MODELS_ROUTES: Routes = [
  { path: '', component: MlModelsPageComponent, data: { breadcrumb: 'ML Models' } },
  { path: ':id', component: MLModelDetailPageComponent, data: { breadcrumb: 'Detail' } },
];
