/**
 * API execution error handling.
 */
import type { ExecutorContext, StepResult } from '@aflow/executor-runtime';
import { failureWithError } from '@aflow/executor-runtime';
import { apiError, type ApiErrorCode } from '../../lib/api-errors.js';
import {
  SsrfBlockedError,
  DnsBlockedError,
  isHostAllowed,
  type ResolvedHost,
} from '@aflow/network-safety';
import { ApiExecutionError, type TenantHostGuard } from './types.js';

// ============================================================================

export const SUGGESTED_FIX_BIND_CAPABILITY =
  "Run the 'bind-capability' skill to update this API's egressPolicy " +
  '(add the blocked host to additionalHosts and/or set allowCrossHostRedirects: true). ' +
  'After the operator ratifies the proposal, retry the original task.';

export const DO_NOT_RUNNER_GUIDANCE = [
  'Do NOT synthesize the data — the provenance contract will reject it at submit_output.',
  'Do NOT retry — the allowlist will not change between attempts.',
  'Do NOT fall back to compute.sandbox.exec — the sandbox cannot reach the blocked host either (no network egress).',
  "Emit signal_blocked with category='binding_egress' and the blocked host in the message.",
];

/** Best-effort host extraction from a blocked target; falls back to the raw string. */
function hostOrTarget(target: string): string {
  try {
    return new URL(target).hostname;
  } catch {
    return target;
  }
}

export function buildEgressBlockedMessage(
  blockedTarget: string,
  reason: 'host-not-in-allowlist' | 'cross-host-redirect-blocked',
): string {
  const headline =
    reason === 'host-not-in-allowlist'
      ? `Egress blocked: host for ${blockedTarget} is not in the binding's allowedHosts.`
      : `Egress blocked: redirect to ${blockedTarget} crosses to a host not in allowedHosts (or cross-host redirects are disabled).`;
  return (
    `${headline} ` +
    `This is a binding-configuration issue, NOT a coding problem. ` +
    `${SUGGESTED_FIX_BIND_CAPABILITY} ` +
    `Critical: ${DO_NOT_RUNNER_GUIDANCE.join(' ')}`
  );
}

export function buildTenantPolicyBlockedMessage(blockedHost: string): string {
  return (
    `Egress blocked by the tenant integration policy: host "${blockedHost}" is not covered by ` +
    `the tenant allowlist or this integration's catalog grant. The policy is recomputed at ` +
    `call time, so a connection created before the policy tightened fails closed here. ` +
    `Ask a tenant admin to allow ${blockedHost} under Tenant Admin → Integrations Policy, or use ` +
    `Request access on the space's Integrations page. Do NOT retry — the policy will not change ` +
    `between attempts. Emit signal_blocked with category='binding_egress' and the blocked host in the message.`
  );
}

/**
 * Allowlist-mode backstop for one contacted host: it must sit inside the
 * tenant guard (allowlist ∪ catalog grant) in ADDITION to the binding's
 * egress policy. Shared by the call/redirect path and the OAuth token
 * exchange so every credentialed fetch fails closed the same way.
 */
export function assertTenantPolicyPermitsHost(
  guard: TenantHostGuard | undefined,
  hostname: string,
  refs: { apiId?: string | undefined; bindingId?: string | undefined },
): void {
  if (guard === undefined) return;
  if (
    isHostAllowed(
      hostname.toLowerCase(),
      guard.permittedHosts.map((h) => h.toLowerCase()),
    )
  ) {
    return;
  }
  throw new ApiExecutionError(
    apiError('API_BINDING_EGRESS_BLOCKED', buildTenantPolicyBlockedMessage(hostname), {
      retryable: false,
      details: {
        blockedHost: hostname,
        blockKind: 'tenant_policy_blocked',
        ...(refs.bindingId ? { bindingId: refs.bindingId } : {}),
        ...(refs.apiId ? { apiId: refs.apiId } : {}),
        doNot: DO_NOT_RUNNER_GUIDANCE,
      },
    }),
  );
}

export function pinUrlToIp(
  rawUrl: string,
  validated: { url: URL; resolvedHost: ResolvedHost },
): string {
  const url = new URL(rawUrl);
  url.hostname = validated.resolvedHost.ip;
  return url.toString();
}

export function isRetryableNetworkError(error: Error): boolean {
  const retryablePatterns = [
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'ENOTFOUND',
    'socket hang up',
    'network',
    'fetch failed',
  ];

  const message = error.message.toLowerCase();
  return retryablePatterns.some((p) => message.includes(p.toLowerCase()));
}

export async function handleExecutionError(
  ctx: ExecutorContext,
  error: unknown,
): Promise<StepResult> {
  if (error instanceof ApiExecutionError) {
    ctx.log.debug('API execution error', {
      code: error.aflowError.code,
      message: error.aflowError.message,
    });
    return failureWithError(ctx, error.aflowError);
  }

  if (error instanceof SsrfBlockedError) {
    ctx.log.error('SSRF blocked', {
      target: error.target,
      kind: error.kind,
      range: error.rangeLabel,
    });
    if (error.kind === 'allowlist-host') {
      return failureWithError(
        ctx,
        apiError(
          'API_BINDING_EGRESS_BLOCKED',
          buildEgressBlockedMessage(error.target, 'host-not-in-allowlist'),
          {
            retryable: false,
            details: {
              blockedTarget: error.target,
              reason: 'host-not-in-allowlist',
              // No blockKind: this generic handler cannot tell a direct-URL
              // host failure from a redirect-target one (the redirect path emits
              // its own labelled error in execution.ts). The explicit direct-URL
              // check in resolution.ts is the site that asserts the direct kind.
              blockedHost: hostOrTarget(error.target),
              suggestedFix: SUGGESTED_FIX_BIND_CAPABILITY,
              doNot: DO_NOT_RUNNER_GUIDANCE,
            },
          },
        ),
      );
    }
    return failureWithError(ctx, apiError('API_SSRF_BLOCKED', error.message, { retryable: false }));
  }

  if (error instanceof DnsBlockedError) {
    ctx.log.error('DNS blocked', { hostname: error.hostname });
    return failureWithError(ctx, apiError('API_DNS_BLOCKED', error.message, { retryable: false }));
  }

  if (error instanceof Error) {
    if (error.name === 'AbortError') {
      return failureWithError(
        ctx,
        apiError('API_TIMEOUT', 'Request was aborted (timeout or cancellation)', {
          retryable: true,
        }),
      );
    }

    const code: ApiErrorCode = isRetryableNetworkError(error)
      ? 'API_NETWORK_ERROR'
      : 'API_PROVIDER_ERROR';

    return failureWithError(
      ctx,
      apiError(code, error.message, {
        retryable: isRetryableNetworkError(error),
        details: { name: error.name },
      }),
    );
  }

  return failureWithError(ctx, apiError('API_NETWORK_ERROR', String(error), { retryable: true }));
}
