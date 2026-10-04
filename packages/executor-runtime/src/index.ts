/**
 * Executor runtime - shared infrastructure for step executors.
 */

// Core types
export type {
  StepResult,
  SuccessResult,
  FailureResult,
  PausedResult,
  ExecutorContext,
  ExecutorLogger,
  ExecutorPayloadKind,
  StepHandler,
  ExecutorConfig,
  ExecutorDependencies,
  ResolvedInput,
  SlotController,
} from './types.js';

export {
  DEFAULT_EXECUTOR_CONFIG,
  PENDING_TIMEOUT_MS_AI,
  PENDING_TIMEOUT_MS_DEFAULT,
  getDefaultPendingTimeoutMs,
  InputResolutionError,
} from './types.js';

// Main executor runtime
export { ExecutorRuntime, createServiceLogger, type WorkListener } from './executor.js';

// Job correlation
export { deriveExecutionRunId, deriveLogicalExecutionId } from './executor/correlation.js';

// Tenant-bound payload access
export { PayloadAccessError, assertPayloadRefTenant } from './executor/payloadAccess.js';

// Concurrency control
export { ConcurrencyLimiter } from './concurrency.js';

// Timeout utilities
export {
  TimeoutError,
  InterruptedError,
  withTimeout,
  createTimeoutSignal,
  isAbortError,
  isPhoenixTimeoutAbort,
  isPhoenixExternalAbort,
  externalAbortReason,
  type TimedResult,
  type AbortReason,
  type PhoenixTimeoutAbortReason,
  type PhoenixExternalAbortReason,
  type PhoenixTimeoutKind,
  type ProgressAwareTimeoutSpec,
  type TimeoutSpec,
  type WithTimeoutOpts,
} from './timeout.js';

// Result helpers
export {
  success,
  successWithData,
  failure,
  failureWithError,
  paused,
  pausedWithRequest,
  validationError,
  providerError,
  permissionError,
  notFoundError,
  internalError,
} from './results.js';
