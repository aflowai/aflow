/**
 * Which model does the Clerk's work, and whether anything can.
 *
 * The Clerk handles bounded background language: naming a conversation,
 * summarizing what happened in one, synthesizing evidence it was handed. It is
 * a model-routing role and nothing else — not an agent, not a participant in
 * any conversation, and it carries no execution authority of its own.
 *
 * Resolution is deliberately separate from `resolveRoleModel`. Every other
 * role falls back to the space default, which is the right answer for work
 * that answers a person. Falling back for background upkeep would spend a
 * reasoning-tier model on a two-sentence summary on every turn of every
 * conversation, and nobody would ever see the bill line that explained why.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { tenants } from '@aflow/database';
import {
  DEFAULT_CYBERNETIC_MODEL,
  clerkCandidateRefs,
  resolveClerkAssignment,
  type ClerkResolutionMode,
  type DirectiveModelDefaults,
} from '@aflow/schemas';
import { createDefaultModelCatalog, inferProviderForModelRef } from '@aflow/ai-client';

export type ClerkModelResolution =
  | {
      resolved: true;
      /** The ref to hand the AI client — always a concrete catalog model. */
      modelRef: string;
      /** The version behind that ref at the moment of resolution. */
      modelId: string;
      providerId: string;
      mode: ClerkResolutionMode;
    }
  | {
      resolved: false;
      mode: ClerkResolutionMode;
      reason: 'no_candidate_for_provider' | 'not_permitted' | 'unknown_model';
      /** The provider `auto` was looking at, where there was one. */
      providerId?: string;
      /** The ref an explicit assignment named, for the operator to correct. */
      requestedRef?: string;
    };

/**
 * Resolve the Clerk's model from a space's assignment and the tenant's
 * permitted set.
 *
 * `auto` follows the space default's provider rather than picking globally:
 * a space that runs on Fireworks has a Fireworks key, and choosing the
 * cheapest model on the whole board would demand a credential nobody brought.
 * The dependency is real and the settings surface says so.
 *
 * Nothing here consults a credential — that is a separate axis, checked at
 * the moment of use, because a key can be revoked between the two.
 */
export function resolveClerkModel(
  defaults: DirectiveModelDefaults | undefined,
  tenantAllowlist: readonly string[] | null | undefined,
): ClerkModelResolution {
  const catalog = createDefaultModelCatalog();
  const assignment = resolveClerkAssignment(defaults);

  if (assignment.mode === 'auto') {
    const spaceDefault = defaults?.default ?? DEFAULT_CYBERNETIC_MODEL;
    const provider =
      catalog.getModel(spaceDefault)?.provider ?? inferProviderForModelRef(spaceDefault);
    if (!provider || provider === 'local') {
      return { resolved: false, mode: 'auto', reason: 'no_candidate_for_provider' };
    }
    // Compared as catalog ids, never as the strings either side happens to
    // hold. The curated list names `glm-flash` and an allowlist stores
    // `accounts/fireworks/models/glm-5p3-flash`; comparing those literally
    // refuses a model the tenant had in fact permitted, and the space then
    // keeps plain titles with a message saying its organization forbade
    // something it had allowed.
    const permittedIds = tenantAllowlist?.length
      ? new Set(
          tenantAllowlist
            .map((ref) => catalog.getModel(ref)?.id)
            .filter((id): id is string => id !== undefined),
        )
      : null;

    let liveCandidates = 0;
    for (const ref of clerkCandidateRefs(provider)) {
      const model = catalog.getModel(ref);
      if (!model || model.deprecated) continue;
      liveCandidates++;
      if (permittedIds && !permittedIds.has(model.id)) continue;
      return {
        resolved: true,
        modelRef: ref,
        modelId: model.id,
        providerId: model.provider,
        mode: 'auto',
      };
    }
    return {
      resolved: false,
      mode: 'auto',
      providerId: provider,
      // A tenant that named its own set and left every small model out of it
      // has said so; `auto` does not step over that to get a cheaper model.
      reason: liveCandidates > 0 && permittedIds ? 'not_permitted' : 'no_candidate_for_provider',
    };
  }

  const model = catalog.getModel(assignment.model);
  if (!model) {
    return {
      resolved: false,
      mode: assignment.mode,
      reason: 'unknown_model',
      requestedRef: assignment.model,
    };
  }
  return {
    resolved: true,
    modelRef: assignment.model,
    modelId: model.id,
    providerId: model.provider,
    mode: assignment.mode,
  };
}

/** The tenant's permitted set, or null when it follows the platform's. */
export async function loadTenantAgentModelAllowlist(
  db: PostgresJsDatabase,
  tenantId: string,
): Promise<readonly string[] | null> {
  const rows = await db
    .select({ allowlist: tenants.agentModelAllowlist })
    .from(tenants)
    .where(eq(tenants.tenantId, tenantId))
    .limit(1);
  const stored = rows[0]?.allowlist;
  return Array.isArray(stored) ? (stored as string[]) : null;
}
