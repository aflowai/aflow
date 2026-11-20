import {
  oauthDefaultClientScopeChoices,
  type EditionId,
  type TenantOAuthPolicy,
} from '@aflow/schemas';

export interface DefaultClientScopeOption {
  value: TenantOAuthPolicy['defaultClientScope'];
  label: string;
}

const CLIENT_SCOPE_OPTIONS: readonly DefaultClientScopeOption[] = [
  { value: 'platform', label: 'Platform — use the built-in OAuth app' },
  { value: 'tenant', label: 'Tenant — use a tenant-registered OAuth app' },
  { value: 'space', label: 'Space — use a space-registered OAuth app' },
];

/**
 * The Default OAuth app choices the policy editor offers in an edition.
 *
 * The local edition registers tenant apps only, so it offers Tenant alone, as
 * PATCH /tenant/oauth-policy accepts. Local bootstrap moves a stored default
 * onto Tenant on the strength of these two agreeing. A plain fold so the
 * withholding is testable: the web test environment is node-only.
 */
export function defaultClientScopeOptions(edition: EditionId): DefaultClientScopeOption[] {
  const choices = oauthDefaultClientScopeChoices(edition);
  return CLIENT_SCOPE_OPTIONS.filter((option) => choices.includes(option.value));
}
