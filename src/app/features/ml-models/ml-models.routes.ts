import { Routes } from '@angular/router';
import { MlModelsPageComponent } from './pages/ml-models-page/ml-models-page.component';
import { MLModelDetailPageComponent } from './pages/ml-model-detail-page/ml-model-detail-page.component';

export const ML_MODELS_ROUTES: Routes = [
  { path: '', component: MlModelsPageComponent, data: { breadcrumb: 'ML Models' } },
  {
    path: 'overfit-watchlist',
    data: { breadcrumb: 'Overfit Watchlist' },
    loadComponent: () =>
      import('./pages/overfit-watchlist-page/overfit-watchlist-page.component').then(
        (m) => m.OverfitWatchlistPageComponent,
      ),
  },
  {
    path: 'symbolic-features',
    data: { breadcrumb: 'Symbolic Features' },
    loadComponent: () =>
      import('./pages/symbolic-features-page/symbolic-features-page.component').then(
        (m) => m.SymbolicFeaturesPageComponent,
      ),
  },
  { path: ':id', component: MLModelDetailPageComponent, data: { breadcrumb: 'Detail' } },
];
