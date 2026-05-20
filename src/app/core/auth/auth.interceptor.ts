import { inject } from '@angular/core';
import { HttpInterceptorFn } from '@angular/common/http';
import { AuthService } from './auth.service';

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const authService = inject(AuthService);

  // Endpoints that must NOT receive an Authorization header even when one is
  // available. /auth/token is the legacy dev login; /auth/refresh is the
  // silent-renewal endpoint — it must run with no bearer attached because the
  // JWT bearer middleware (ValidateLifetime=true) would 401 an expired token
  // BEFORE the [AllowAnonymous] controller could renew it, defeating the
  // whole point of refresh. The handler reads the prior token from the
  // request body (or the lascodia-auth cookie) instead.
  if (req.url.includes('/auth/token') || req.url.includes('/auth/refresh')) {
    return next(req);
  }

  const token = authService.getToken();

  if (token) {
    const cloned = req.clone({
      setHeaders: {
        Authorization: `Bearer ${token}`,
      },
    });
    return next(cloned);
  }

  return next(req);
};
