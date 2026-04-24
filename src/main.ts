import { bootstrapApplication } from '@angular/platform-browser';
import { buildAppConfig } from './app/app.config';
import { AppComponent } from './app/app.component';
import { loadRuntimeConfig } from './app/core/config/runtime-config';

loadRuntimeConfig()
  .then((config) => bootstrapApplication(AppComponent, buildAppConfig(config)))
  .catch((err) => console.error(err));
