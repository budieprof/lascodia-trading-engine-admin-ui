import { Component, effect, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ToastContainerComponent } from '@shared/components/toast/toast-container.component';
import { AuthService } from '@core/auth/auth.service';
import { RealtimeService } from '@core/realtime/realtime.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, ToastContainerComponent],
  template: `
    <router-outlet />
    <app-toast-container />
  `,
  styles: [],
})
export class AppComponent {
  private readonly auth = inject(AuthService);
  private readonly realtime = inject(RealtimeService);

  constructor() {
    // Start/stop the SignalR hub connection in lockstep with the auth state.
    // Starts on initial boot if a session was restored from sessionStorage,
    // and on login; tears down on logout / idle-timeout.
    effect(() => {
      if (this.auth.isAuthenticated()) {
        this.realtime.connect();
      } else {
        this.realtime.disconnect();
      }
    });
  }
}
