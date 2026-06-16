import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';

/** A role reference embedded in an admin-user record. */
export interface AdminUserRoleRef {
  id: number;
  name: string;
}

/** Shape of `GET /admin/users` rows. */
export interface AdminUserDto {
  id: number;
  username: string;
  email: string;
  displayName: string;
  isActive: boolean;
  isSuperAdmin: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  roles: AdminUserRoleRef[];
}

/** `POST /admin/users` request body. */
export interface CreateAdminUserBody {
  username: string;
  email: string;
  displayName: string;
  roleIds: number[];
}

/** `PUT /admin/users/{id}` request body. */
export interface UpdateAdminUserBody {
  email: string;
  displayName: string;
}

/** Returned by create + reset-password — the temp password is shown once. */
export interface AdminUserCredentialDto {
  id: number;
  username: string;
  temporaryPassword: string;
}

/**
 * Thin wrapper over the admin-only `/admin/users` endpoints. Every method
 * requires the `users.manage` permission server-side; the route guard keeps
 * unauthorized operators out of the page in the first place.
 */
@Injectable({ providedIn: 'root' })
export class AdminUsersService {
  private readonly api = inject(ApiService);

  getUsers(search?: string): Observable<AdminUserDto[]> {
    const qs = search && search.trim() ? `?search=${encodeURIComponent(search.trim())}` : '';
    return this.api.getEnvelope<AdminUserDto[]>(`/admin/users${qs}`);
  }

  createUser(body: CreateAdminUserBody): Observable<AdminUserCredentialDto> {
    return this.api.postEnvelope<AdminUserCredentialDto>('/admin/users', body);
  }

  updateUser(id: number, body: UpdateAdminUserBody): Observable<string> {
    return this.api.putEnvelope<string>(`/admin/users/${id}`, body);
  }

  assignRoles(id: number, roleIds: number[]): Observable<string> {
    return this.api.postEnvelope<string>(`/admin/users/${id}/roles`, { roleIds });
  }

  setActive(id: number, isActive: boolean): Observable<string> {
    return this.api.postEnvelope<string>(`/admin/users/${id}/active`, { isActive });
  }

  resetPassword(id: number): Observable<AdminUserCredentialDto> {
    return this.api.postEnvelope<AdminUserCredentialDto>(`/admin/users/${id}/reset-password`);
  }
}
