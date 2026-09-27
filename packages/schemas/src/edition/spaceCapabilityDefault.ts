/**
 * Whether a newly created space starts on `Personal Safe` rather than the admin
 * default.
 *
 * On a multi-tenant instance a member's space is held to the safe ceiling and a
 * tenant admin's is not. On a fixed-tenancy instance there is one owner running on
 * their own machine with their own keys, so the restrictions that protect shared
 * infrastructure — web search on the platform's budget, arbitrary API bindings,
 * inbound webhooks — protect nobody, and withholding them withholds the product.
 * The safeguards that matter there are enforced elsewhere in every edition: write
 * approval per endpoint, grant enforcement, and the sandbox's network isolation.
 *
 * Decided by tenancy rather than by the admin flag, because one creation path
 * infers admin-ness from a membership lookup that can miss.
 */
import type { EditionDescriptor } from './descriptor.js';

export function defaultsToSafeProfile(params: {
  isTenantAdmin: boolean;
  edition: EditionDescriptor;
}): boolean {
  return params.edition.tenancy.mode !== 'fixed' && !params.isTenantAdmin;
}
