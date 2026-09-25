import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { ApiService } from '@core/api/api.service';
import type { ResponseData } from '@core/api/api.types';

import type {
  ExecutionPolicy,
  StrategyAccountBinding,
  StrategyAccountBindingInput,
} from './scripting-api.types';

/**
 * How a strategy executes live (ADR-0027 DEC-05 / DEC-06): which accounts
 * it may trade on and which signal-pipeline gates its entries pass.
 *
 * Live-capital endpoints — callers must gate REAL-account changes behind an explicit operator
 * confirmation before calling {@link replaceAccountBindings}.
 */
@Injectable({ providedIn: 'root' })
export class StrategyExecutionService {
  private readonly api = inject(ApiService);

  /** `[{tradingAccountId, accountName, lotMultiplier, isEnabled}]`. */
  getAccountBindings(strategyId: number): Observable<ResponseData<StrategyAccountBinding[]>> {
    return this.api.get(`/strategy/${strategyId}/account-bindings`, { silent: true });
  }

  /**
   * Replaces the strategy's binding SET. Accounts left out are unbound; an empty array removes
   * every binding (a script strategy then trades on no account; any other strategy fans out to
   * every account again).
   */
  replaceAccountBindings(
    strategyId: number,
    bindings: StrategyAccountBindingInput[],
  ): Observable<ResponseData<boolean>> {
    return this.api.put(`/strategy/${strategyId}/account-bindings`, bindings, { silent: true });
  }

  /** `{ policy: "Standard" | "Direct" }`. */
  setExecutionPolicy(
    strategyId: number,
    policy: ExecutionPolicy,
  ): Observable<ResponseData<boolean>> {
    return this.api.put(`/strategy/${strategyId}/execution-policy`, { policy }, { silent: true });
  }
}
