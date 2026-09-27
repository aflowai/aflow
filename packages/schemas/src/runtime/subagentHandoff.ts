/**
 * Subagent handoff payload — the structural shape carried by a paused step's
 * `requestedInputRef` when the pause is intended for the *parent agent* (not
 * the end user).
 *
 * Why this exists
 * ---------------
 *
 * Phoenix's PAUSED state is overloaded. Today it carries two unrelated
 * shapes:
 *
 *   1. **User-input pause.** A user.interaction.ask / signal_blocked-style
 *      pause where the requestedInputRef contains `missingVariables` + a
 *      `prompt` for the human.
 *
 *   2. **Subagent handoff.** A platform-internal pause where an op (e.g.
 *      `prepare-design-surface`, `agent.control.signal_blocked`) needs to
 *      hand control back to the *parent agent* with a structured payload.
 *      The bubble (`bubbleChildPauseToParent`) detects this and routes it
 *      via the `until_pause` path — a SUCCEEDED step result on the parent's
 *      delegate step containing the handoff payload, NOT a user-facing
 *      pause on the parent.
 *
 * Before this schema, the bubble had no strict discriminator and inferred
 * "is this a handoff?" from duck-typing (`parsed['handoff'] || parsed['missing']
 * || parsed['kind']`). When `delegationWaitMode` was missing on the parent,
 * the wrong path fired silently and the user saw an empty Helmsman pause —
 * the exact bug observed during compose-skill live testing on 2026-05-05.
 *
 * The discriminator is `payloadKind: 'subagent_handoff'`. The bubble
 * Zod-validates against this schema; if it parses cleanly, the handoff path
 * fires; if not, the user-input path fires. No more silent fallback into the
 * wrong branch.
 *
 * The schema is permissive about extra fields (`.passthrough()`) so
 * source-specific extensions (e.g. `compose-skill-handoff` carrying
 * `missing[]` and `handoff.skillSlug`) don't need a schema bump per emitter.
 */
import { z } from 'zod';
import { McpCredentialBlockSchema } from './mcpCredentialFailure.js';

export const SUBAGENT_HANDOFF_PAYLOAD_KIND = 'subagent_handoff' as const;

/**
 * Structured handoff target — points the parent agent at a sub-skill (or
 * other action) that resolves the blocked condition.
 */
export const SubagentHandoffTargetSchema = z.object({
  /** Slug of the skill (or other procedure) the parent agent should run. */
  skillSlug: z.string().min(1),
  /**
   * Prefilled inputs for the target skill. Schema is per-skill; we type as
   * unknown to avoid coupling this canonical schema to every possible
   * downstream skill's input shape.
   */
  prefill: z.record(z.unknown()).optional(),
});
export type SubagentHandoffTarget = z.infer<typeof SubagentHandoffTargetSchema>;

/**
 * Subagent handoff payload — a paused step's `requestedInputRef` carries this
 * when control should return to the parent agent (not the end user).
 *
 * Required fields:
 *   - `payloadKind`     — strict discriminator; lets the bubble distinguish
 *                         this from a user-input pause.
 *   - `handoffSource`   — identifies which emitter produced the payload
 *                         (e.g. `'compose-skill-handoff'`, `'runner-signal-blocked'`).
 *                         The parent agent may pattern-match on this.
 *   - `prompt`          — human-readable summary; renderable in chat /
 *                         activity log.
 *
 * Optional fields are permissive by design — emitters extend with
 * source-specific structure (e.g. compose-skill's `missing[]`,
 * `handoff.skillSlug`, signal_blocked's `blockingCategory` + `needed`).
 */
export const SubagentHandoffPayloadSchema = z
  .object({
    payloadKind: z.literal(SUBAGENT_HANDOFF_PAYLOAD_KIND),
    handoffSource: z.string().min(1),
    prompt: z.string().min(1),

    // Common-but-optional fields surfaced from existing emitters.
    blockingCategory: z.string().optional(),
    blockingReason: z.string().optional(),
    status: z.string().optional(),
    reason: z.string().optional(),
    missing: z.array(z.unknown()).optional(),
    handoff: SubagentHandoffTargetSchema.optional(),

    credentialBlock: McpCredentialBlockSchema.optional(),
  })
  .passthrough();
export type SubagentHandoffPayload = z.infer<typeof SubagentHandoffPayloadSchema>;

/**
 * Convenience: returns true if `value` parses as a SubagentHandoffPayload.
 *
 * Use at the bubble or anywhere else that needs to distinguish "this PAUSED
 * is for the parent agent" from "this PAUSED is for the user". A naive
 * presence check (e.g. `value.handoff != null`) is brittle — older payloads
 * sometimes had partial fields without the discriminator.
 */
export function isSubagentHandoffPayload(value: unknown): value is SubagentHandoffPayload {
  return SubagentHandoffPayloadSchema.safeParse(value).success;
}
