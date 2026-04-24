import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import {
  CalibrationTrendReportDto,
  DefaultsCalibrationDto,
  PagedData,
  PagerRequest,
  ResponseData,
  ScreeningGateBindingReportDto,
  SignalRejectionEntryDto,
} from '@core/api/api.types';

@Injectable({ providedIn: 'root' })
export class CalibrationService {
  private readonly api = inject(ApiService);

  getTrendReport(): Observable<ResponseData<CalibrationTrendReportDto>> {
    return this.api.get(`/admin/calibration/trend-report`);
  }

  getScreeningGateBinding(): Observable<ResponseData<ScreeningGateBindingReportDto>> {
    return this.api.get(`/admin/calibration/screening-gate-binding-report`);
  }

  listSignalRejections(
    params: PagerRequest,
  ): Observable<ResponseData<PagedData<SignalRejectionEntryDto>>> {
    return this.api.post(`/admin/calibration/signal-rejections`, params);
  }

  getDefaultsCalibration(): Observable<ResponseData<DefaultsCalibrationDto>> {
    return this.api.get(`/health/defaults-calibration`);
  }
}
