import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';

/** Shape of `GET /admin/roles` rows. */
export interface RoleDto {
  id: number;
  name: string;
  description: string;
  isSystem: boolean;
  permissionKeys: string[];
  userCount: number;
}

/** `POST /admin/roles` request body. */
export interface CreateRoleBody {
  name: string;
  description: string;
  permissionKeys: string[];
}

/** `PUT /admin/roles/{id}` request body. */
export interface UpdateRoleBody {
  description: string;
  permissionKeys: string[];
}

/**
 * Thin wrapper over the admin-only `/admin/roles` endpoints. Requires the
 * `roles.manage` permission server-side.
 */
@Injectable({ providedIn: 'root' })
export class RolesService {
  private readonly api = inject(ApiService);

  getRoles(): Observable<RoleDto[]> {
    return this.api.getEnvelope<RoleDto[]>('/admin/roles');
  }

  createRole(body: CreateRoleBody): Observable<RoleDto> {
    return this.api.postEnvelope<RoleDto>('/admin/roles', body);
  }

  updateRole(id: number, body: UpdateRoleBody): Observable<string> {
    return this.api.putEnvelope<string>(`/admin/roles/${id}`, body);
  }

  deleteRole(id: number): Observable<string> {
    return this.api.deleteEnvelope<string>(`/admin/roles/${id}`);
  }
}
