/**
 * What a binding request may state about its own scope, and what gets stored.
 *
 * The tenant is resolved before any of these handlers run and the `space_id`
 * column beside the row is the authority for the space, so neither is the
 * caller's to state — a browser cannot know the first, and one that guessed was
 * writing a placeholder straight into `scope_json`.
 *
 * `flowId` is the one member a caller does own: it narrows a binding to a single
 * flow, and it is the only member the API executor scores on, so losing it is
 * losing the narrowing itself.
 *
 * Omission is not a statement. Both upserts write `scope_json` from the request,
 * so a partial update — new credentials, a renamed binding — would otherwise
 * replace a flow-scoped binding with a space-wide one without mentioning it.
 * These routes already preserve `auth`, `egressPolicy`, `fulfillment` and
 * `variableValues` on omission; scope was the one column that did not, which is
 * why the schema below carries no default. An absent `scope` means keep what is
 * stored, and a stated `{}` means make it space-wide.
 */
import { z } from 'zod';

export const RequestBindingScopeSchema = z
  .object({
    // Not merely a string: the API executor scores a binding on a *truthy*
    // `flowId`, so an empty one is read as no flow at all and the binding is
    // selected by its space instead. A caller asking for a flow restriction
    // would get a space-wide credential grant and no indication of it.
    flowId: z.string().min(1, 'flowId must name a flow, or be omitted').optional(),
  })
  .optional();

export type RequestBindingScope = z.infer<typeof RequestBindingScopeSchema>;

export interface BindingScopeIdentity {
  tenantId: string;
  spaceId: string;
}

/** The scope a row is created with, stamped with the identity it belongs to. */
export function composeStoredBindingScope(
  requestScope: RequestBindingScope,
  identity: BindingScopeIdentity,
): Record<string, unknown> {
  return {
    ...(requestScope ?? {}),
    tenantId: identity.tenantId,
    spaceId: identity.spaceId,
  };
}

/**
 * The scope an update should write, or `null` to keep the stored one.
 *
 * Paired with `COALESCE(<this>, <table>.scope_json)` so that omitting the field
 * preserves the narrowing rather than dropping it.
 */
export function statedBindingScope(
  requestScope: RequestBindingScope,
  identity: BindingScopeIdentity,
): Record<string, unknown> | null {
  if (requestScope === undefined) return null;
  return composeStoredBindingScope(requestScope, identity);
}
