import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';

/** Shape of `GET /admin/permissions` catalog entries. */
export interface PermissionDto {
  key: string;
  category: string;
  description: string;
}

/**
 * Read-only catalog of permission keys the engine recognises, grouped by
 * category for the role-editor permission matrix.
 */
@Injectable({ providedIn: 'root' })
export class PermissionsService {
  private readonly api = inject(ApiService);

  getCatalog(): Observable<PermissionDto[]> {
    return this.api.getEnvelope<PermissionDto[]>('/admin/permissions');
  }
}
