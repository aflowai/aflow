import { z } from 'zod';
import { AgentIdSchema, SystemRoleSchema } from './ids.js';
import { PayloadRefSchema } from './payloadRef.js';

/** Common variant: cybernetic ensemble or other registry role. No DB row. */
const PlatformRoleTargetSchema = z.object({
  kind: z.literal('platform-role'),
  systemRole: SystemRoleSchema,
});

/** Common variant: operator-authored agent, UUID into `agents.id`. */
const CustomAgentTargetSchema = z.object({
  kind: z.literal('custom-agent'),
  agentId: AgentIdSchema,
});

/**
 * Inline-agent variant. `definitionRef` is always a real PayloadRef
 * (`inline:<base64>` for small definitions, `gs://...` for larger ones
 * persisted via a session-scoped PayloadStore helper).
 */
const InlineAgentTargetSchema = z.object({
  kind: z.literal('inline-agent'),
  definitionRef: PayloadRefSchema,
});

/** Three-kind union — sessions, hot state, start commands. */
export const SessionAgentTargetSchema = z.discriminatedUnion('kind', [
  PlatformRoleTargetSchema,
  CustomAgentTargetSchema,
  InlineAgentTargetSchema,
]);
export type SessionAgentTarget = z.infer<typeof SessionAgentTargetSchema>;

/** Two-kind union — delegate, schedules, webhooks, space defaults. */
export const PersistentAgentTargetSchema = z.discriminatedUnion('kind', [
  PlatformRoleTargetSchema,
  CustomAgentTargetSchema,
]);
export type PersistentAgentTarget = z.infer<typeof PersistentAgentTargetSchema>;

/**
 * Deterministic, cache-friendly key for any agent target. Used in places
 * that previously keyed on `agentId text` (e.g. guardrail policy cache).
 * Stable across renames — for `custom-agent` we use the UUID, never the
 * slug.
 *
 * Inline targets carry a `definitionRef` that may be a multi-KB
 * `inline:<base64>` blob. Embedding that blob into Redis keys, log lines,
 * and metrics labels would blow up cardinality and entry size. Hash it
 * with FNV-1a (12-hex-char prefix) — collisions across a single space's
 * inline runs are astronomically unlikely for caching purposes.
 */
export function agentTargetKey(target: SessionAgentTarget | PersistentAgentTarget): string {
  switch (target.kind) {
    case 'platform-role':
      return `platform-role:${target.systemRole}`;
    case 'custom-agent':
      return `custom-agent:${target.agentId}`;
    case 'inline-agent':
      return `inline-agent:${fnv1aHex(target.definitionRef)}`;
  }
}

/**
 * 32-bit FNV-1a hash → 12-char hex string. Small, dependency-free, plenty
 * of bits for cache-key dedup. Not cryptographic; do not use for security
 * decisions.
 */
function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16).padStart(8, '0').padEnd(12, '0');
}

/**
 * Maximum size in bytes for an inline AgentDefinition embedded in a
 * SessionAgentTarget's `definitionRef` as `inline:<base64>`. Beyond this,
 * the caller must persist via PayloadStore (session-scoped) and supply a
 * `gs://` ref instead. Chosen well under {@link MAX_STREAM_ENTRY_BYTES}
 * (1KB metadata cap) is not viable for typical definitions, so this is
 * sized to fit Redis stream entry limits comfortably while accommodating
 * the median definition.
 */
export const MAX_INLINE_DEFINITION_BYTES = 32 * 1024;

/**
 * Project the flat (target_kind, target_system_role, target_agent_id,
 * target_inline_def_ref) columns from `sessions` / `agent_schedules` /
 * `webhook_endpoints` / `spaces.default_target_*` rows into a tagged
 * target. The DB CHECK constraints guarantee the input is well-shaped; if
 * we ever read a malformed row, parsing through the Zod schema will fail
 * loudly with a clear error.
 *
 * For tables that only allow persistent targets (schedules, webhooks,
 * defaults), pass `'persistent'` for `kindUnion`. The function still parses
 * via `SessionAgentTargetSchema` for the wider safety net, but rejects
 * `inline-agent` outputs as a typed error so callers don't have to narrow.
 */
export function projectTargetColumns(
  row: {
    targetKind: string | null;
    targetSystemRole: string | null;
    targetAgentId: string | null;
    targetInlineDefRef?: string | null;
  },
  kindUnion: 'session' | 'persistent' = 'session',
): SessionAgentTarget {
  let target: unknown;
  switch (row.targetKind) {
    case 'platform-role':
      target = { kind: 'platform-role', systemRole: row.targetSystemRole };
      break;
    case 'custom-agent':
      target = { kind: 'custom-agent', agentId: row.targetAgentId };
      break;
    case 'inline-agent':
      target = { kind: 'inline-agent', definitionRef: row.targetInlineDefRef };
      break;
    case null:
      throw new Error(
        'Unexpected NULL target_kind — rows that allow NULL targets must be filtered out before calling projectTargetColumns',
      );
    default:
      throw new Error(`Unknown target_kind: ${row.targetKind ?? '<null>'}`);
  }
  const parsed = SessionAgentTargetSchema.parse(target);
  if (kindUnion === 'persistent' && parsed.kind === 'inline-agent') {
    throw new Error(
      `Persistent target column unexpectedly carries inline-agent kind (definitionRef=${parsed.definitionRef})`,
    );
  }
  return parsed;
}

/**
 * Project a tagged target into the flat-column shape suitable for INSERT /
 * UPDATE of `sessions` / `agent_schedules` / `webhook_endpoints` /
 * `spaces.default_target_*`.
 */
export function targetToColumns(target: SessionAgentTarget | PersistentAgentTarget): {
  targetKind: 'platform-role' | 'custom-agent' | 'inline-agent';
  targetSystemRole: string | null;
  targetAgentId: string | null;
  targetInlineDefRef: string | null;
} {
  switch (target.kind) {
    case 'platform-role':
      return {
        targetKind: 'platform-role',
        targetSystemRole: target.systemRole,
        targetAgentId: null,
        targetInlineDefRef: null,
      };
    case 'custom-agent':
      return {
        targetKind: 'custom-agent',
        targetSystemRole: null,
        targetAgentId: target.agentId,
        targetInlineDefRef: null,
      };
    case 'inline-agent':
      return {
        targetKind: 'inline-agent',
        targetSystemRole: null,
        targetAgentId: null,
        targetInlineDefRef: target.definitionRef,
      };
  }
}

const AGENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A workflow task names its agent as a bare string. That string is either a
 * platform role or an operator-authored agent's id, and the id is what tells
 * them apart — a role is never a uuid.
 */
export function isCustomAgentRef(agentRef: string): boolean {
  return AGENT_ID_PATTERN.test(agentRef);
}
