import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import { ResponseData } from '@core/api/api.types';

@Injectable({ providedIn: 'root' })
export class RateLimitService {
  private readonly api = inject(ApiService);

  getQuota(brokerKey: string): Observable<ResponseData<any>> {
    return this.api.get(`/rate-limit/quota/${brokerKey}`);
  }
}
