import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import {
  ResponseData,
  PagedData,
  PagerRequest,
  SentimentSnapshotDto,
  COTReportDto,
} from '@core/api/api.types';

@Injectable({ providedIn: 'root' })
export class SentimentService {
  private readonly api = inject(ApiService);

  recordSnapshot(data: any): Observable<ResponseData<SentimentSnapshotDto>> {
    return this.api.post(`/sentiment/snapshot`, data);
  }

  ingestCOT(data: any): Observable<ResponseData<COTReportDto>> {
    return this.api.post(`/sentiment/cot`, data);
  }

  getLatest(symbol: string): Observable<ResponseData<SentimentSnapshotDto>> {
    return this.api.get(`/sentiment/latest/${symbol}`);
  }

  listCOT(params: PagerRequest): Observable<ResponseData<PagedData<COTReportDto>>> {
    return this.api.post(`/sentiment/cot/list`, params);
  }
}
