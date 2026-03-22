import { Injectable, inject, signal, computed } from '@angular/core';
import { Observable, tap } from 'rxjs';
import { ApiService } from '../api/api.service';
import { TokenResponseDto } from '../api/api.types';

export interface AuthUser {
  passportId: string;
  firstName: string;
  lastName: string;
  email: string;
}

export interface LoginCredentials {
  userId?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phoneNumber?: string;
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly api = inject(ApiService);

  private readonly _token = signal<string | null>(null);
  private readonly _user = signal<AuthUser | null>(null);

  readonly token = this._token.asReadonly();
  readonly user = this._user.asReadonly();
  readonly isAuthenticated = computed(() => this._token() !== null);

  login(credentials: LoginCredentials): Observable<TokenResponseDto> {
    return this.api
      .post<TokenResponseDto>('/auth/token', {
        userId: credentials.userId || 'dev-user-1',
        firstName: credentials.firstName || 'Dev',
        lastName: credentials.lastName || 'User',
        email: credentials.email || 'dev@lascodia.com',
        phoneNumber: credentials.phoneNumber || '',
      })
      .pipe(
        tap((response) => {
          if (response.token) {
            this._token.set(response.token);
            this._user.set({
              passportId: credentials.userId || 'dev-user-1',
              firstName: credentials.firstName || 'Dev',
              lastName: credentials.lastName || 'User',
              email: credentials.email || 'dev@lascodia.com',
            });
          }
        }),
      );
  }

  logout(): void {
    this._token.set(null);
    this._user.set(null);
  }

  getToken(): string | null {
    return this._token();
  }
}
