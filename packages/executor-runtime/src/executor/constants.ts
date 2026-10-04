/** Heartbeat interval: refresh every 10 seconds (TTL is 60s, `EXECUTOR_HEARTBEAT_TTL_SECONDS`) */
export const HEARTBEAT_INTERVAL_MS = 10_000;

/** Per-step proof-of-life heartbeat interval (30s). */
export const STEP_HEARTBEAT_INTERVAL_MS = 30_000;

/** Periodic pending message claim interval in consume loop. */
export const CLAIM_INTERVAL_MS = 60_000;
