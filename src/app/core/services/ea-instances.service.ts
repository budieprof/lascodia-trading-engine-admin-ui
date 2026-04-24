import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import { EAInstanceDto, ResponseData } from '@core/api/api.types';

@Injectable({ providedIn: 'root' })
export class EAInstancesService {
  private readonly api = inject(ApiService);

  list(): Observable<ResponseData<EAInstanceDto[]>> {
    return this.api.get<ResponseData<EAInstanceDto[]>>(`/ea/instances`);
  }
}
