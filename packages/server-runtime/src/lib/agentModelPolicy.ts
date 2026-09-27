/**
 * The models a tenant lets a space assign to a cybernetic role.
 *
 * Every ref is compared as its catalog id. Refs reach these gates in whichever
 * spelling the caller used — a space may hold `sonnet`, the picker writes
 * `claude-sonnet-5`, and an admin may enable either — so comparing the strings
 * as given would let a model be enabled under one name and rejected under
 * another. Resolution happens here, in the one place both the governance route
 * and the space write path read, because `@aflow/schemas` cannot reach the
 * catalog to do it itself.
 */
import { createDefaultModelCatalog } from '@aflow/ai-client';
import {
  CLERK_AUTO,
  CLERK_SPACE_DEFAULT,
  DEFAULT_CYBERNETIC_MODEL,
  effectiveAgentModelRefs,
} from '@aflow/schemas';

/** The catalog id behind a ref, or undefined when it names no model. */
export function canonicalModelId(ref: string): string | undefined {
  return createDefaultModelCatalog().getModel(ref)?.id;
}

/** Catalog ids a space may assign, given whatever the tenant stored. */
export function allowedModelIds(stored: readonly string[] | null | undefined): Set<string> {
  const ids = new Set<string>();
  for (const ref of effectiveAgentModelRefs(stored)) {
    const id = canonicalModelId(ref);
    // An unresolvable stored ref is dropped rather than compared literally: it
    // names no model, so nothing can legitimately match it.
    if (id) ids.add(id);
  }
  return ids;
}

/**
 * A ref is allowed when the model it names is. An unresolvable ref is refused —
 * it cannot run either way, and saying so at the write is the earlier failure.
 */
export function isModelIdAllowed(ref: string, allowed: ReadonlySet<string>): boolean {
  const id = canonicalModelId(ref);
  return id !== undefined && allowed.has(id);
}

/** A live chat model that can hold an agent turn, for write-time validation. */
export function isAssignableAgentModel(ref: string): boolean {
  const model = createDefaultModelCatalog().getModel(ref);
  return model !== undefined && model.capabilities.chat && model.deprecated !== true;
}

/**
 * The model a new space starts on: the platform default when the tenant allows
 * it, otherwise the first model it does.
 */
export function tenantDefaultModelId(allowed: ReadonlySet<string>): string | undefined {
  const platformDefault = canonicalModelId(DEFAULT_CYBERNETIC_MODEL);
  if (platformDefault && allowed.has(platformDefault)) return platformDefault;
  return [...allowed][0];
}

/**
 * Replace role assignments the caller never made.
 *
 * `modelDefaults.default` carries a Zod default, so a create request that never
 * mentions a model still arrives naming `glm-pro`. A tenant that excludes it
 * would otherwise fail every ordinary space creation with a teaching error
 * about a choice the caller never made. `chosenRoles` are the roles present in
 * the request as it arrived on the wire, before validation filled anything in —
 * those the caller did pick, and those stay put for the gate to accept or
 * refuse on their merits.
 */
/**
 * A role value that names a resolution strategy rather than a model.
 *
 * The Clerk's `auto` and `space_default` assign nothing, so there is no ref for
 * an allowlist to permit, refuse, or substitute. Read as refs they resolve to
 * nothing: the gate rejects every save the picker's own default can make, and
 * the default-filler quietly replaces the operator's "pick one for me" with a
 * pinned foreground model.
 */
export function isRoleModeNotRef(role: string, value: string): boolean {
  return role === 'clerk' && (value === CLERK_AUTO || value === CLERK_SPACE_DEFAULT);
}

export function withTenantDefaultModels<
  T extends { modelDefaults?: Record<string, string | undefined> },
>(directives: T, allowed: ReadonlySet<string>, chosenRoles: ReadonlySet<string>): T {
  const fallback = tenantDefaultModelId(allowed);
  const defaults = directives.modelDefaults;
  if (!fallback || !defaults) return directives;

  let changed = false;
  const next: Record<string, string | undefined> = { ...defaults };
  for (const [role, ref] of Object.entries(defaults)) {
    if (ref === undefined || isRoleModeNotRef(role, ref)) continue;
    if (isModelIdAllowed(ref, allowed)) continue;
    // The caller named this one. Substituting would hand them a space running
    // a model they did not pick; the gate refuses it instead.
    if (chosenRoles.has(role)) continue;
    next[role] = fallback;
    changed = true;
  }

  return changed ? { ...directives, modelDefaults: next } : directives;
}
