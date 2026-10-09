/**
 * The engine permission the script strategy's write endpoints require (PE-I13): editing the
 * script (`PUT strategy/{id}/script`), exporting it (`GET strategy/{id}/export`), account
 * bindings, the execution policy and the news-blackout exemption are all `access.operator`
 * (engine `PermissionCatalog.AccessOperator`). The console hides or disables those controls for
 * anyone without it instead of offering them and failing with 403.
 */
export const OPERATOR_PERMISSION = 'access.operator';

/**
 * The engine permission that queues backtests (`POST backtest`, engine `PermissionCatalog.AccessAnalyst`) —
 * and so a parity reconcile (`POST strategy/{id}/parity/reconcile`, BT-I3 / PE-I2), which is one.
 */
export const ANALYST_PERMISSION = 'access.analyst';
