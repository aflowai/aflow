import { z } from 'zod';
import { sanitizeTerminalErrorMessage } from './errorMessageDisplay.js';
import { AflowErrorSchema, type AflowError } from './errors.js';

// =============================================================================
// User-Facing Error Schema
// =============================================================================

export const UserFacingErrorCategorySchema = z.enum([
  'network', // Connection/fetch failures
  'config', // Missing configuration, invalid settings
  'permission', // Auth/authz failures
  'rate_limit', // Rate limiting or quota exceeded
  'timeout', // Operation timed out
  'budget', // Cost/usage budget exceeded
  'validation', // Invalid input or data
  'content_policy', // Content blocked by safety/policy filter
  'context_overflow', // Model context window exceeded
  'system', // Internal platform error
]);

export type UserFacingErrorCategory = z.infer<typeof UserFacingErrorCategorySchema>;

export const UserFacingErrorSchema = z.object({
  /** Short title (e.g., "Connection Failed", "Permission Denied") */
  title: z.string().max(100),

  /** Friendly message explaining what happened */
  message: z.string().max(1000),

  /** Error category for UI styling/routing */
  category: UserFacingErrorCategorySchema,

  /** Suggested next steps for the user */
  suggestedActions: z.array(z.string().max(200)).max(5).optional(),

  /** Whether the user can retry this operation */
  canRetry: z.boolean(),

  /** Support reference (runId + traceId for support tickets) */
  supportRef: z.string().optional(),

  /** Debug info (only for privileged users / dev mode) */
  debug: z
    .object({
      errorCode: z.string().optional(),
      classification: z.string().optional(),
      traceId: z.string().optional(),
      stepId: z.string().optional(),
      attempt: z.number().optional(),
    })
    .optional(),
});

export type UserFacingError = z.infer<typeof UserFacingErrorSchema>;

// =============================================================================
// Mapping from AflowError to UserFacingError
// =============================================================================

interface ErrorMappingContext {
  runId?: string;
  traceId?: string;
  stepId?: string;
  attempt?: number;
  /** Include debug info (for dev mode or privileged users) */
  includeDebug?: boolean;
}

const GENERIC_FAILED_RUN_MESSAGE =
  'This run failed due to an internal platform error. The failure has been logged.';
const OPAQUE_FAILED_RUN_CLASSIFICATIONS = new Set<AflowError['classification']>([
  'internal',
  'transient',
]);

/**
 * Map AflowError classification to UserFacingErrorCategory
 */
function classificationToCategory(
  classification: AflowError['classification'],
): UserFacingErrorCategory {
  switch (classification) {
    case 'validation':
      return 'validation';
    case 'permission':
      return 'permission';
    case 'content_policy':
      return 'content_policy';
    case 'context_overflow':
      return 'context_overflow';
    case 'configuration':
      return 'config';
    case 'not_found':
      return 'config'; // Resource not found is often a config issue
    case 'conflict':
      return 'system';
    case 'provider':
      return 'network';
    case 'rate_limit':
      return 'rate_limit';
    case 'timeout':
      return 'timeout';
    case 'budget':
      return 'budget';
    case 'internal':
    case 'transient':
      return 'system';
    case 'cancelled':
      return 'system';
    default:
      return 'system';
  }
}

/**
 * Get a user-friendly title based on error classification
 */
function getTitle(classification: AflowError['classification']): string {
  switch (classification) {
    case 'validation':
      return 'Invalid Input';
    case 'permission':
      return 'Access Denied';
    case 'content_policy':
      return 'Content Blocked';
    case 'context_overflow':
      return 'Context Limit Exceeded';
    case 'configuration':
      return 'Configuration Error';
    case 'not_found':
      return 'Not Found';
    case 'conflict':
      return 'Conflict';
    case 'provider':
      return 'Service Unavailable';
    case 'rate_limit':
      return 'Too Many Requests';
    case 'timeout':
      return 'Operation Timed Out';
    case 'budget':
      return 'Budget Exceeded';
    case 'internal':
      return 'System Error';
    case 'transient':
      return 'Temporary Error';
    case 'cancelled':
      return 'Cancelled';
    default:
      return 'Error';
  }
}

/**
 * Get suggested actions based on error classification
 */
function getSuggestedActions(
  classification: AflowError['classification'],
  retryable: boolean,
): string[] {
  const actions: string[] = [];

  switch (classification) {
    case 'validation':
      actions.push('Check your input and try again');
      break;
    case 'permission':
      actions.push('You do not have access to this resource');
      actions.push('Contact your workspace administrator to request access');
      break;
    case 'content_policy':
      actions.push('Your request was blocked by a content policy');
      actions.push('Try rephrasing your request');
      break;
    case 'context_overflow':
      actions.push('The request exceeded the model context limit');
      actions.push('Try simplifying or shortening your input');
      break;
    case 'configuration':
      actions.push('Check your settings — an API key or configuration may need updating');
      actions.push('Go to Settings → Credentials if a provider key is missing');
      break;
    case 'not_found':
      actions.push('Verify the resource exists and you have access');
      break;
    case 'conflict':
      actions.push('Refresh and try again');
      break;
    case 'provider':
      actions.push('The external service may be temporarily unavailable');
      if (retryable) actions.push('Wait a moment and try again');
      break;
    case 'rate_limit':
      actions.push('Wait a moment before trying again');
      break;
    case 'timeout':
      actions.push('The operation took too long');
      if (retryable) actions.push('Try again with a simpler request');
      break;
    case 'budget':
      actions.push('Review your usage limits');
      actions.push('Contact your administrator to increase limits');
      break;
    case 'internal':
    case 'transient':
      if (retryable) {
        actions.push('Try again in a moment');
      } else {
        actions.push('Try again or check your configuration');
      }
      break;
    case 'cancelled':
      actions.push('The operation was cancelled');
      break;
  }

  return actions;
}

/**
 * Convert an AflowError to a user-facing error.
 *
 * @param error - The internal AflowError
 * @param context - Additional context (runId, traceId, etc.)
 * @returns A safe, user-friendly error representation
 */
export function toUserFacingError(
  error: AflowError,
  context: ErrorMappingContext = {},
): UserFacingError {
  const category = classificationToCategory(error.classification);
  const title = getTitle(error.classification);
  const suggestedActions = getSuggestedActions(error.classification, error.retryable);

  // Build support reference
  const supportRef = context.runId
    ? `Run: ${context.runId}${context.traceId ? ` | Trace: ${context.traceId}` : ''}`
    : undefined;

  // Unwrap nested provider JSON blobs before length cap (avoids truncating mid-JSON)
  const message = sanitizeTerminalErrorMessage(error.message, 500);

  const userError: UserFacingError = {
    title,
    message,
    category,
    suggestedActions: suggestedActions.length > 0 ? suggestedActions : undefined,
    canRetry: error.retryable,
    supportRef,
  };

  // Include debug info if requested
  if (context.includeDebug) {
    userError.debug = {
      errorCode: error.code,
      classification: error.classification,
      traceId: context.traceId,
      stepId: context.stepId,
      attempt: context.attempt,
    };
  }

  return userError;
}

/**
 * Internal platform failures should not surface their raw messages in terminal run banners.
 * They still remain available to operators via logs and error refs.
 */
export function shouldExposeFailedRunUserError(
  classification: AflowError['classification'] | undefined,
): boolean {
  return classification !== undefined && !OPAQUE_FAILED_RUN_CLASSIFICATIONS.has(classification);
}

/**
 * Safe fallback message for failed runs when the raw underlying error should remain operator-facing.
 */
export function getFailedRunFallbackMessage(
  classification: AflowError['classification'] | undefined,
): string {
  if (classification === undefined || OPAQUE_FAILED_RUN_CLASSIFICATIONS.has(classification)) {
    return GENERIC_FAILED_RUN_MESSAGE;
  }
  return 'This run failed.';
}

/**
 * Build the safe error payload used by terminal `FlowRunFailed` events.
 * For internal/transient failures we emit a generic message and omit `userError`.
 */
export function toFailedRunDisplay(
  error: AflowError,
  context: ErrorMappingContext = {},
): {
  errorMessage: string;
  userError?: UserFacingError;
} {
  if (shouldExposeFailedRunUserError(error.classification)) {
    const userError = toUserFacingError(error, context);
    return {
      errorMessage: userError.message,
      userError,
    };
  }

  return {
    errorMessage: getFailedRunFallbackMessage(error.classification),
  };
}

/**
 * Unknown run-fatal errors default to the same generic internal failure message.
 */
export function toFailedRunDisplayFromUnknown(
  error: unknown,
  context: ErrorMappingContext = {},
): {
  errorMessage: string;
  userError?: UserFacingError;
} {
  if (error && typeof error === 'object') {
    const parsed = AflowErrorSchema.safeParse(error);
    if (parsed.success) {
      return toFailedRunDisplay(parsed.data, context);
    }
  }

  void context;
  return {
    errorMessage: getFailedRunFallbackMessage(undefined),
  };
}

/**
 * Create a user-facing error from a raw Error object (fallback for uncaught errors)
 */
export function fromUnknownError(
  error: unknown,
  context: ErrorMappingContext = {},
): UserFacingError {
  const message = error instanceof Error ? error.message : 'An unexpected error occurred';

  return {
    title: 'System Error',
    message: sanitizeTerminalErrorMessage(message, 500),
    category: 'system',
    suggestedActions: ['Try again in a moment', 'Try again or check your configuration'],
    canRetry: true,
    supportRef: context.runId
      ? `Run: ${context.runId}${context.traceId ? ` | Trace: ${context.traceId}` : ''}`
      : undefined,
    debug: context.includeDebug
      ? {
          errorCode: 'UNKNOWN_ERROR',
          classification: 'internal',
          traceId: context.traceId,
          stepId: context.stepId,
          attempt: context.attempt,
        }
      : undefined,
  };
}
