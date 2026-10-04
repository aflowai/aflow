/**
 * Why a session failed, as its stored error says it.
 *
 * The failing step is found from the session's failure event, its current
 * step and its step list; the error from the failed step's stored error, else
 * the session's own. Both are resolved here because the event's message is the
 * one shown to a person, which hides a provider's refusal behind a generic
 * sentence, while the stored error keeps the provider's own words.
 */

import type { Session } from '../auth/SessionStore.js';
import { resolvePayloadRef, type PayloadReadClient } from './payloads.js';
import type { DebugEvent, SessionDebugResponse } from './sessionViews.js';

export interface SessionFailure {
  step_id?: string;
  step_execution_id?: string;
  operation?: string;
  step_name?: string;
  code?: string;
  message: string;
  classification?: string;
  retryable?: boolean;
  provider?: {
    provider: string;
    error_code?: string;
    request_id?: string;
    message?: string;
  };
  details?: unknown;
  user_error?: { title: string; message: string };
  /** The stored error this was read from. */
  error_ref?: string;
  next: string;
}

export type FailureSource = Pick<
  SessionDebugResponse,
  'session' | 'recentEvents' | 'currentStep' | 'dynamicSteps' | 'refs' | 'hotState'
>;

const DETAILS_MAX_CHARS = 2000;

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function newest(events: DebugEvent[] | undefined, type: string): DebugEvent | undefined {
  if (!events) return undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.eventType === type) return events[i];
  }
  return undefined;
}

/** The stored error's own fields, wherever the payload nests them. */
function storedError(decoded: unknown): Record<string, unknown> | undefined {
  const top = record(decoded);
  if (!top || '_ref' in top) return undefined;
  const nested = record(top['error']);
  return nested && str(nested['message']) !== undefined ? nested : top;
}

function boundedDetails(details: unknown): unknown {
  const json = JSON.stringify(details);
  if (json === undefined || json.length <= DETAILS_MAX_CHARS) return details;
  return `${json.slice(0, DETAILS_MAX_CHARS)}…[cut at ${String(DETAILS_MAX_CHARS)} characters]`;
}

export async function resolveSessionFailure(
  client: PayloadReadClient,
  session: Session,
  spaceId: string,
  source: FailureSource,
): Promise<SessionFailure> {
  const failedEvent = newest(source.recentEvents, 'SessionFailed');
  const stepFailedEvent = newest(source.recentEvents, 'StepFailed');
  const meta = failedEvent?.metadata;
  const current = source.currentStep?.status === 'FAILED' ? source.currentStep : undefined;
  const failedStep = [...(source.dynamicSteps ?? [])].reverse().find((s) => s.status === 'FAILED');

  const stepId =
    str(failedEvent?.data?.['stepId']) ??
    current?.stepId ??
    str(stepFailedEvent?.data?.['stepId']) ??
    failedStep?.stepId;
  const stepExecutionId =
    failedEvent?.stepExecutionId ??
    current?.stepExecutionId ??
    stepFailedEvent?.stepExecutionId ??
    failedStep?.stepExecutionId;
  const operation =
    str(meta?.['operationId']) ??
    current?.operationId ??
    str(stepFailedEvent?.metadata?.['operationId']) ??
    failedStep?.operation;

  const stepErrorRef =
    str(failedEvent?.data?.['errorRef']) ??
    current?.errorRef ??
    str(stepFailedEvent?.data?.['errorRef']);
  const errorRef = stepErrorRef ?? source.session.errorRef ?? source.refs?.['errorRef'];

  const stored =
    errorRef === undefined
      ? undefined
      : storedError(await resolvePayloadRef(client, session, errorRef, spaceId, 'eager'));

  const userError = record(meta?.['userError']);
  const userTitle = str(userError?.['title']);
  const userMessage = str(userError?.['message']);

  const message =
    str(stored?.['message']) ??
    str(stored?.['title']) ??
    str(meta?.['errorMessage']) ??
    userMessage ??
    failedStep?.error?.message ??
    str(stepFailedEvent?.metadata?.['errorMessage']) ??
    unreadableFailure(source, errorRef);

  const failure: SessionFailure = {
    message,
    next:
      'retry_session (same session_id and space_id) runs the session again from the failed step, ' +
      'or from the agent turn that called it; ' +
      'it fails again the same way unless what the error names has changed.',
  };
  if (stepId !== undefined) failure.step_id = stepId;
  if (stepExecutionId !== undefined) failure.step_execution_id = stepExecutionId;
  if (operation !== undefined) failure.operation = operation;
  const stepName = str(meta?.['stepName']);
  if (stepName !== undefined && stepName !== stepId) failure.step_name = stepName;
  const code = str(stored?.['code']) ?? str(meta?.['errorCode']);
  if (code !== undefined) failure.code = code;
  const classification = str(stored?.['classification']) ?? str(meta?.['errorClassification']);
  if (classification !== undefined) failure.classification = classification;
  if (typeof stored?.['retryable'] === 'boolean') failure.retryable = stored['retryable'];

  const details = stored?.['details'];
  const providerDetails = record(details);
  const providerName = str(providerDetails?.['provider']);
  if (providerName !== undefined && providerDetails) {
    failure.provider = { provider: providerName };
    const providerCode = str(providerDetails['providerErrorCode']);
    if (providerCode !== undefined) failure.provider.error_code = providerCode;
    const requestId =
      str(providerDetails['providerRequestId']) ?? str(stored?.['providerRequestId']);
    if (requestId !== undefined) failure.provider.request_id = requestId;
    const providerMessage = str(providerDetails['providerMessage']);
    if (providerMessage !== undefined) failure.provider.message = providerMessage;
  } else if (details !== undefined) {
    failure.details = boundedDetails(details);
  }

  if (userTitle !== undefined && userMessage !== undefined && userMessage !== message) {
    failure.user_error = { title: userTitle, message: userMessage };
  }
  if (stored !== undefined && errorRef !== undefined) failure.error_ref = errorRef;
  return failure;
}

function unreadableFailure(source: FailureSource, errorRef: string | undefined): string {
  const events = source.recentEvents?.length ?? 0;
  const where =
    errorRef !== undefined
      ? `its stored error (${errorRef.slice(0, 80)}) could not be read`
      : `no failure event is among its ${String(events)} newest events, and neither the session ` +
        'nor a failed step names a stored error';
  const expired = source.hotState === 'expired' ? '; its hot state has expired' : '';
  return `The session failed, but ${where}${expired}.`;
}
