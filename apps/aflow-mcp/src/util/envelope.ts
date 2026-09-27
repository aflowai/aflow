/**
 * Response envelope helpers for MCP tool responses.
 *
 * All tools return a consistent JSON envelope:
 * { success, data?, message?, error?, conversation_id? }
 */

/**
 * MCP SDK tool result type — uses index signature for compatibility
 * with the SDK's strict `CallToolResult` type.
 */
export interface McpToolResult {
  [x: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export function successResponse(data: unknown, message?: string): McpToolResult {
  const envelope: Record<string, unknown> = { success: true, data };
  if (message !== undefined) envelope['message'] = message;
  return {
    content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }],
  };
}

export function errorResponse(code: string, message: string, hint?: string): McpToolResult {
  const error: Record<string, unknown> = { code, message };
  if (hint !== undefined) error['hint'] = hint;
  return {
    content: [{ type: 'text', text: JSON.stringify({ success: false, error }, null, 2) }],
    isError: true,
  };
}
