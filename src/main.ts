import { bootstrapApplication } from '@angular/platform-browser';
import { buildAppConfig } from './app/app.config';
import { AppComponent } from './app/app.component';
import { loadRuntimeConfig, RuntimeConfigUnavailableError } from './app/core/config/runtime-config';
import { renderConfigUnavailableScreen } from './app/core/config/config-unavailable-screen';

loadRuntimeConfig()
  .then((config) => bootstrapApplication(AppComponent, buildAppConfig(config)))
  .catch((err) => {
    console.error(err);
    // Never start without the settings (they decide how people sign in): explain and retry.
    if (err instanceof RuntimeConfigUnavailableError) renderConfigUnavailableScreen();
  });
