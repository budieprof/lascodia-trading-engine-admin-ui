import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import {
  ResponseData,
  SetPaperTradingModeRequest,
} from '@core/api/api.types';

@Injectable({ providedIn: 'root' })
export class PaperTradingService {
  private readonly api = inject(ApiService);

  setMode(data: SetPaperTradingModeRequest): Observable<ResponseData<void>> {
    return this.api.put(`/paper-trading/mode`, data);
  }

  getStatus(): Observable<ResponseData<any>> {
    return this.api.get(`/paper-trading/status`);
  }
}
