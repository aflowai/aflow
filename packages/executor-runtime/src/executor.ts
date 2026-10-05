/**
 * Main executor runtime — thin facade re-exporting ExecutorRuntime.
 */
export { ExecutorRuntime, type WorkListener } from './executor/ExecutorRuntime.js';
export type { RunningStep } from './executor/processJob.js';
export { createServiceLogger } from './executor/logger.js';
