/**
 * The engine permission research runs need: starting an optimization run (`POST strategy-feedback/optimization/trigger`),
 * approving or rejecting one, and starting a walk-forward (`POST walk-forward`) are all `access.analyst` (engine
 * `PermissionCatalog.AccessAnalyst`). Saving or changing a screen is `access.operator` (`OPERATOR_PERMISSION`).
 */
export const ANALYST_PERMISSION = 'access.analyst';
