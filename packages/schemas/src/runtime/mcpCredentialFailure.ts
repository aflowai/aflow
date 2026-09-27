import { z } from 'zod';
import type { AflowError } from './errors.js';

/** AflowError `code` marking an MCP credential/binding resolution failure. */
export const MCP_CREDENTIALS_UNRESOLVED_CODE = 'MCP_CREDENTIALS_UNRESOLVED' as const;

/**
 * Structured detail identifying the blocked MCP binding/server/credential.
 * Every field except `reason` is best-effort — populated when the failing
 * call site has it in scope (e.g. `no_binding` resolution failures have no
 * bindingId).
 */
export const McpCredentialBlockSchema = z.object({
  bindingId: z.string().optional(),
  serverId: z.string().optional(),
  bindingName: z.string().optional(),
  /** Credential keys / fields that could not be resolved, when known. */
  missingFields: z.array(z.string()).optional(),
  /** Machine-ish reason token (resolution reason or `credential_unresolved`). */
  reason: z.string(),
});
export type McpCredentialBlock = z.infer<typeof McpCredentialBlockSchema>;

/**
 * Build an `AflowError` for an MCP credential/binding resolution failure.
 *
 * Classification `permission` (retryable:false): the agent reads it as an
 * access/credential gate it cannot fix by retrying tool args — so it escalates
 * (signal_blocked) instead of looping. The durable discriminators consumers
 * route on are the `code` and `details.credentialBlock`, not the message.
 */
export function mcpCredentialsError(message: string, block: McpCredentialBlock): AflowError {
  return {
    code: MCP_CREDENTIALS_UNRESOLVED_CODE,
    message,
    classification: 'permission',
    retryable: false,
    details: { credentialBlock: block },
    timestamp: new Date().toISOString(),
  };
}

/** True iff this error is an MCP credential/binding resolution failure. */
export function isMcpCredentialFailure(
  error: { code?: string | undefined } | null | undefined,
): boolean {
  return error?.code === MCP_CREDENTIALS_UNRESOLVED_CODE;
}

/**
 * Extract the structured credential block from an MCP credential failure.
 * Returns `null` for any other error or when the detail is malformed/absent.
 */
export function extractMcpCredentialBlock(
  error: AflowError | null | undefined,
): McpCredentialBlock | null {
  if (!error || !isMcpCredentialFailure(error)) return null;
  const details = error.details;
  if (!details || typeof details !== 'object' || Array.isArray(details)) return null;
  const candidate = (details as Record<string, unknown>)['credentialBlock'];
  const parsed = McpCredentialBlockSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}
