import { signal } from '@angular/core';
import { of, throwError } from 'rxjs';

import type { ScriptSessionSubscription } from '@core/api/scripting.types';
import { WarmSessionBook } from '../../scripts/warm-sessions';
import { ReplayScriptSessions } from '../../replay/replay-script-sessions';

/**
 * The page state warm sessions (PC-I1) and realtime truthfulness (PC-I9) add, for the page specs that build the page
 * from its prototype (`Object.create(ChartAnalysisPageComponent.prototype)`: class fields are not initialised there).
 * The scripting hub is not connected and keeps no session unless a spec says otherwise.
 */
export function realtimePageState(
  hub: {
    usable?: () => boolean;
    isConnected?: () => boolean;
    subscribe?: (id: string) => Promise<ScriptSessionSubscription | null>;
  } = {},
) {
  return {
    warmSessions: new WarmSessionBook(),
    warmKeys: signal<ReadonlySet<string>>(new Set()),
    scriptRepaints: signal<ReadonlyMap<string, string>>(new Map()),
    formingByKey: new Map<string, number | null>(),
    resyncing: new Set<string>(),
    scriptHub: {
      usable: hub.usable ?? (() => true),
      isConnected: hub.isConnected ?? (() => false),
      subscribe: hub.subscribe ?? (async () => null),
      unsubscribe: async () => undefined,
    },
    scriptingApi: {
      endSession: () => of(undefined),
      sessionFrame: () => throwError(() => new Error('no session')),
    },
    // Bar Replay's engine replay sessions (CC-I4): the engine refuses them, so replay runs in full.
    replayScripts: new ReplayScriptSessions({
      startReplay: () => throwError(() => new Error('no replay')),
      stepReplay: () => throwError(() => new Error('no replay')),
      stopReplay: () => of(true),
    }),
  };
}
