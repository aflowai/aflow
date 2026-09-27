/**
 * Operation ID utilities.
 *
 * The operationId is always computed from structural components — never hand-written.
 * buildOperationId() is the ONLY sanctioned way to produce an operationId.
 */

/**
 * Build an operationId from its structural components.
 * Structure (stepType, group, verb) is the source of truth.
 *
 *   ('ai', 'text', 'generate') → 'ai.text.generate'
 *   ('memory', 'store', 'query')  → 'memory.store.query'
 */
export function buildOperationId(stepType: string, group: string | null, verb: string): string {
  return group ? `${stepType}.${group}.${verb}` : `${stepType}.${verb}`;
}

export const MEMORY_READ_OPERATION_ID = buildOperationId('memory', 'store', 'get');

/**
 * The run-scoped reread surface (reads /run/outputs/* only). Floor-granted to
 * every agent turn that does not already hold MEMORY_READ_OPERATION_ID, so
 * cleared/truncated tool outputs stay recoverable without opening general
 * memory read.
 */
export const RUN_OUTPUT_READ_OPERATION_ID = buildOperationId('memory', 'run_output', 'get');

/**
 * The blocked-signal escape hatch: pauses the run and bubbles the blocking
 * reason to the supervising agent. The legal exit for an agent that can
 * neither request input nor complete.
 */
export const AGENT_SIGNAL_BLOCKED_OPERATION_ID = buildOperationId(
  'agent',
  'control',
  'signal_blocked',
);

/**
 * Build a qualified groupId from stepType and group.
 * Used for unambiguous group filtering in get_schema.
 *
 *   ('ai', 'image') → 'ai.image'
 *   ('memory', null) → 'memory'
 */
export function buildGroupId(stepType: string, group: string | null): string {
  return group ? `${stepType}.${group}` : stepType;
}

const SNAKE_CASE_RE = /^[a-z][a-z0-9_]*$/;

/**
 * Validate that a group or verb segment is valid snake_case.
 * Throws at build time if invalid.
 */
export function validateSegment(segment: string, label: string): void {
  if (!SNAKE_CASE_RE.test(segment)) {
    throw new Error(`Invalid ${label}: "${segment}" — must be snake_case (${SNAKE_CASE_RE})`);
  }
}
