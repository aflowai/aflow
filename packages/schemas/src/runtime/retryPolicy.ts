/**
 * Retry policy schemas for step execution.
 */
import { z } from 'zod';

// ============================================================================
// Backoff Strategies
// ============================================================================

/**
 * Backoff strategy for retries.
 */
export const BackoffStrategySchema = z.enum([
  /** Fixed delay between retries */
  'fixed',
  /** Exponential backoff with configurable base */
  'exponential',
  /** Linear increase in delay */
  'linear',
]);

export type BackoffStrategy = z.infer<typeof BackoffStrategySchema>;

// ============================================================================
// Retry Policy
// ============================================================================

/**
 * Retry policy configuration for steps.
 */
export const RetryPolicySchema = z.object({
  /** Maximum number of retry attempts (0 = no retries) */
  maxAttempts: z.number().int().min(0).max(10).default(3).describe('Maximum retry attempts'),

  /** Initial delay in milliseconds */
  initialDelayMs: z
    .number()
    .int()
    .min(100)
    .max(60000)
    .default(1000)
    .describe('Initial delay between retries in milliseconds'),

  /** Maximum delay in milliseconds */
  maxDelayMs: z
    .number()
    .int()
    .min(100)
    .max(300000)
    .default(30000)
    .describe('Maximum delay between retries in milliseconds'),

  /** Backoff strategy */
  backoffStrategy: BackoffStrategySchema.default('exponential'),

  /** Backoff multiplier for exponential strategy */
  backoffMultiplier: z
    .number()
    .min(1)
    .max(10)
    .default(2)
    .describe('Multiplier for exponential backoff'),

  /** Add random jitter to delays (0-1 fraction of delay) */
  jitterFraction: z
    .number()
    .min(0)
    .max(1)
    .default(0.1)
    .describe('Jitter fraction to add randomness'),

  /** Error codes that are retryable */
  retryableErrorCodes: z
    .array(z.string().max(64))
    .default([])
    .describe('Specific error codes that should trigger retry'),

  /** Error classifications that are retryable */
  retryableClassifications: z
    .array(z.enum(['timeout', 'rate_limit', 'provider', 'transient']))
    .default(['timeout', 'rate_limit', 'provider', 'transient'])
    .describe('Error classifications that should trigger retry'),
});

export type RetryPolicy = z.infer<typeof RetryPolicySchema>;

// ============================================================================
// Timeout Policy
// ============================================================================

/**
 * Timeout configuration for steps.
 */
export const TimeoutPolicySchema = z.object({
  /** Step execution timeout in milliseconds */
  executionTimeoutMs: z
    .number()
    .int()
    .min(1000)
    .max(3600000)
    .default(30000)
    .describe('Maximum execution time in milliseconds'),

  /** Graceful shutdown period in milliseconds */
  gracePeriodMs: z
    .number()
    .int()
    .min(0)
    .max(30000)
    .default(5000)
    .describe('Grace period for cleanup after timeout'),

  /** Whether to allow timeout extension requests */
  allowExtension: z.boolean().default(false).describe('Whether step can request timeout extension'),
});

export type TimeoutPolicy = z.infer<typeof TimeoutPolicySchema>;

// ============================================================================
// Helpers
// ============================================================================

/**
 * Calculate delay for a given retry attempt.
 */
export function calculateRetryDelay(policy: RetryPolicy, attempt: number): number {
  let delay: number;

  switch (policy.backoffStrategy) {
    case 'fixed':
      delay = policy.initialDelayMs;
      break;
    case 'linear':
      delay = policy.initialDelayMs * attempt;
      break;
    case 'exponential':
      delay = policy.initialDelayMs * Math.pow(policy.backoffMultiplier, attempt - 1);
      break;
  }

  // Cap at max delay
  delay = Math.min(delay, policy.maxDelayMs);

  // Add jitter
  if (policy.jitterFraction > 0) {
    const jitter = delay * policy.jitterFraction * Math.random();
    delay += jitter;
  }

  return Math.round(delay);
}
