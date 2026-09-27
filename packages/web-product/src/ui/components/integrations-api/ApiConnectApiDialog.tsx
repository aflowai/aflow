'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button,
  Column,
  Dialog,
  Divider,
  Field,
  Icon,
  Input,
  Label,
  Row,
  Select,
  Text,
} from '@aflow/design-system';
import {
  getAllOAuthIssuers,
  getOAuthIssuer,
  type OAuthClientScope,
  type OAuthConsentOwnerScope,
} from '@aflow/schemas';
import type { ApiBindingSummary, ApiBindingVariableMeta } from '../../hooks/use-integrations.js';
import { useTenantOAuthPolicy } from '../../hooks/use-tenant-oauth-clients.js';
import { preservedBindingScope } from '../integrations/bindingScope.js';
import { getAuthSlots, type AuthSlot } from '../integrations/authSlots.js';
import { IntegrationWriteErrorNotice } from '../integrations/IntegrationWriteErrorNotice.js';
import { defaultBindingName, nextFreeBindingId } from './bindingIds.js';

const AUTH_TYPES = [
  { value: 'bearer', label: 'Bearer Token' },
  { value: 'api_key', label: 'API Key' },
  { value: 'basic', label: 'Basic Auth' },
  { value: 'oauth2', label: 'OAuth2 (Client Credentials)' },
  { value: 'oauth2_authorization_code', label: 'OAuth (sign in with an account)' },
  { value: 'none', label: 'No Auth' },
] as const;

const OWNER_SCOPE_OPTIONS: Array<{
  value: OAuthConsentOwnerScope;
  label: string;
  help: string;
}> = [
  {
    value: 'user',
    label: 'Each user connects their own account',
    help: 'Every member signs in once and acts as themselves. Tokens are stored per user.',
  },
  {
    value: 'space',
    label: 'One shared connection for this space',
    help: 'A single account everyone in the space shares.',
  },
];

// API issuers have no platform-provided OAuth app (the platform app is the
// MCP-only CIMD client), so only tenant/space-registered apps are offered here.
type ApiClientScope = Exclude<OAuthClientScope, 'platform'>;

const CLIENT_SCOPE_OPTIONS: Array<{ value: ApiClientScope; label: string }> = [
  { value: 'tenant', label: 'A tenant-registered OAuth app' },
  { value: 'space', label: 'A space-registered OAuth app' },
];

interface OAuthAuthSeed {
  issuerKey: string;
  authorizationServer: string;
  tokenEndpoint: string;
  scopes: string;
  ownerScope: OAuthConsentOwnerScope | '';
  clientScope: ApiClientScope | '';
}

const EMPTY_OAUTH_SEED: OAuthAuthSeed = {
  issuerKey: '',
  authorizationServer: '',
  tokenEndpoint: '',
  scopes: '',
  ownerScope: '',
  clientScope: '',
};

/** Hydrate the OAuth form fields from a stored `oauth2_authorization_code` auth profile. */
function readOAuthAuthSeed(auth: Record<string, unknown> | undefined): OAuthAuthSeed {
  if (auth?.['type'] !== 'oauth2_authorization_code') return EMPTY_OAUTH_SEED;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const owner = auth['ownerScope'];
  const client = auth['clientScope'];
  return {
    issuerKey: str(auth['issuerKey']),
    authorizationServer: str(auth['authorizationServer']),
    tokenEndpoint: str(auth['tokenEndpoint']),
    scopes: Array.isArray(auth['scopes'])
      ? (auth['scopes'] as unknown[]).map(String).join(', ')
      : '',
    ownerScope: owner === 'user' || owner === 'space' ? owner : '',
    clientScope: client === 'tenant' || client === 'space' ? client : '',
  };
}

function CredentialSlotFields({
  slot,
  credKey,
  secretValue,
  onChangeKey,
  onChangeSecret,
}: {
  slot: AuthSlot;
  credKey: string;
  secretValue: string;
  onChangeKey: (v: string) => void;
  onChangeSecret: (v: string) => void;
}) {
  return (
    <>
      <Field>
        <Label>{slot.keyInputLabel}</Label>
        <Input
          value={credKey}
          onChange={(e) => {
            onChangeKey(e.target.value);
          }}
          placeholder={slot.defaultKey('binding')}
          autoComplete="off"
        />
        <Text size="xs" color="secondary" style={{ marginTop: 'var(--space-1)' }}>
          Reference name only — paste the actual secret in the field below, not here.
        </Text>
      </Field>

      <div className="ds-secret-field-group">
        <Field>
          <Label>
            <span
              style={{
                display: 'inline-flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                gap: 'var(--space-2)',
              }}
            >
              <Icon name="lock-key" size="sm" style={{ color: 'var(--color-success-fg)' }} />
              <span>
                {slot.secretInputLabel}{' '}
                <Text as="span" size="xs" color="secondary">
                  (optional — you can add it later)
                </Text>
              </span>
            </span>
          </Label>
          <Input
            className="ds-input--secret"
            type="password"
            value={secretValue}
            onChange={(e) => {
              onChangeSecret(e.target.value);
            }}
            placeholder="Paste the secret to save it now"
            autoComplete="new-password"
          />
          <Text size="xs" tone="success" style={{ marginTop: 'var(--space-1)' }}>
            Encrypted at rest. Never shown again after you save.
          </Text>
        </Field>
      </div>
    </>
  );
}

/**
 * Combined: creates the connection AND optionally lets you paste the secret
 * right here instead of going to a separate dialog.
 */
export function ApiConnectApiDialog({
  apiId,
  variables = [],
  baseUrlTemplate,
  editBinding,
  existingBindingIds = [],
  onSave,
  onSaveCredential,
  onClose,
}: {
  apiId: string;
  /** NON-SECRET per-binding (space-scoped) variables the binding's baseUrlTemplate requires. */
  variables?: readonly ApiBindingVariableMeta[];
  /** The definition's baseUrlTemplate (if any) — used to show the live resolved URL. */
  baseUrlTemplate?: string | undefined;
  editBinding?: ApiBindingSummary;
  /** Connection ids already taken for this provider — drives the next-free default + collision guard. */
  existingBindingIds?: string[];
  onSave: (body: {
    bindingId: string;
    apiId: string;
    name: string;
    description?: string;
    scope: { flowId?: string | undefined };
    auth: Record<string, unknown>;
    egressPolicy: Record<string, unknown>;
    variableValues?: Record<string, string>;
    enabled?: boolean;
    expectAbsent?: boolean;
  }) => Promise<void>;
  onSaveCredential: (key: string, value: string, label: string) => Promise<void>;
  onClose: () => void;
}) {
  const isEdit = Boolean(editBinding);
  const [bindingId, setBindingId] = useState(
    () => editBinding?.bindingId ?? nextFreeBindingId(apiId, existingBindingIds),
  );
  const [name, setName] = useState(
    () =>
      editBinding?.name ?? defaultBindingName(apiId, nextFreeBindingId(apiId, existingBindingIds)),
  );
  const [authType, setAuthType] = useState(editBinding?.authType ?? 'bearer');

  // Two credential-key + secret-value pairs. Both render only for `basic` and
  // `oauth2`; `bearer` / `api_key` use only the primary pair; `none` uses
  const [primaryKey, setPrimaryKey] = useState('');
  const [primarySecret, setPrimarySecret] = useState('');
  const [secondaryKey, setSecondaryKey] = useState('');
  const [secondarySecret, setSecondarySecret] = useState('');
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<unknown>(null);

  // === 3-legged OAuth (oauth2_authorization_code) ===
  // The client secret never enters this form — it lives server-side in
  // oauth_clients keyed by (clientScope, issuerKey). The binding carries only
  // the issuer + endpoints + the two ownership axes; consent is launched after
  // save (the binding routes to the OAuth consent flow, not paste-credentials).
  const editOAuth = readOAuthAuthSeed(editBinding?.auth);
  const [issuerKey, setIssuerKey] = useState<string>(editOAuth.issuerKey);
  // Tracks whether the operator has picked a provider yet — gates the rest of
  // the OAuth fields (progressive disclosure). A registered issuer or the
  // explicit "Other" escape hatch both count as a selection; an editing binding
  // already carries one.
  const [issuerMode, setIssuerMode] = useState<'' | 'registered' | 'custom'>(
    editOAuth.issuerKey ? (getOAuthIssuer(editOAuth.issuerKey) ? 'registered' : 'custom') : '',
  );
  const [authorizationServer, setAuthorizationServer] = useState<string>(
    editOAuth.authorizationServer,
  );
  const [tokenEndpoint, setTokenEndpoint] = useState<string>(editOAuth.tokenEndpoint);
  const [oauthScopes, setOauthScopes] = useState<string>(editOAuth.scopes);
  const [ownerScope, setOwnerScope] = useState<OAuthConsentOwnerScope | ''>(editOAuth.ownerScope);
  const [clientScope, setClientScope] = useState<ApiClientScope | ''>(editOAuth.clientScope);

  const { policy: oauthPolicy } = useTenantOAuthPolicy();
  const issuers = useMemo(() => getAllOAuthIssuers(), []);
  const isOAuthCode = authType === 'oauth2_authorization_code';

  // Seed the ownership axes from the tenant policy default the first time the
  // OAuth auth type is selected and the binding doesn't already carry them.
  // The client axis defaults to `space`: API issuers have no platform app, so a
  // policy default of `platform` is not offered and falls back to `space`.
  useEffect(() => {
    if (!isOAuthCode || !oauthPolicy) return;
    setOwnerScope((prev) => prev || oauthPolicy.defaultOwnerScope);
    setClientScope(
      (prev) => prev || (oauthPolicy.defaultClientScope === 'tenant' ? 'tenant' : 'space'),
    );
  }, [isOAuthCode, oauthPolicy]);

  // NON-SECRET baseUrlTemplate variable values (subdomain/region/account-id),
  // seeded from the existing binding when editing.
  const [variableValues, setVariableValues] = useState<Record<string, string>>(
    () => editBinding?.variableValues ?? {},
  );

  // Split the base-URL template into fixed text + variable slots so the URL can
  // be rendered as a fill-in-the-blank: fixed parts as literal text, each {var}
  // as an inline input. The connection's URL IS the config — not a read-only
  // string with the value hidden in a separate field.
  const templateSegments = useMemo(() => {
    if (!baseUrlTemplate) return null;
    return baseUrlTemplate
      .split(/(\{[^}]+\})/)
      .filter((s) => s.length > 0)
      .map((seg) => {
        const name = /^\{([^}]+)\}$/.exec(seg)?.[1];
        return name === undefined
          ? { kind: 'text' as const, text: seg }
          : { kind: 'var' as const, name };
      });
  }, [baseUrlTemplate]);

  const slots = useMemo(() => getAuthSlots(authType), [authType]);

  // Re-seed credential-key inputs when authType (or the binding ID it derives
  // defaults from) changes. For edit, prefer the value already on the binding;
  // otherwise fall back to the sensible default. Secret values are always
  // cleared on auth-type change — a bearer token is not the same shape as a
  // basic-auth password.
  const editAuth = editBinding?.auth ?? null;
  useEffect(() => {
    const fallbackId = bindingId.trim() || `${apiId}-default`;
    if (slots.primary) {
      const existing = editAuth?.[slots.primary.authField];
      setPrimaryKey(
        typeof existing === 'string' && existing.length > 0
          ? existing
          : slots.primary.defaultKey(fallbackId),
      );
    } else {
      setPrimaryKey('');
    }
    if (slots.secondary) {
      const existing = editAuth?.[slots.secondary.authField];
      setSecondaryKey(
        typeof existing === 'string' && existing.length > 0
          ? existing
          : slots.secondary.defaultKey(fallbackId),
      );
    } else {
      setSecondaryKey('');
    }
    setPrimarySecret('');
    setSecondarySecret('');
    // editAuth is stable across renders (taken from props); slots derives
    // entirely from authType. bindingId only affects defaults when the
    // operator hasn't typed a key yet.
  }, [authType, bindingId, apiId, slots, editAuth]);

  const handleSave = useCallback(async () => {
    if (!bindingId.trim() || !name.trim()) return;
    const trimmedBindingId = bindingId.trim();
    // Recompute the collision against the latest ids (a refetch may have landed
    // since mount): a create must never clobber an existing connection.
    if (!isEdit && existingBindingIds.includes(trimmedBindingId)) {
      setErrorMsg(
        `A connection "${trimmedBindingId}" already exists for ${apiId}. Choose a different Connection ID.`,
      );
      return;
    }
    setErrorMsg(null);
    setSaveError(null);
    setSaving(true);
    try {
      const auth: Record<string, unknown> = { type: authType };
      const credentialWrites: Array<{ key: string; value: string; label: string }> = [];

      if (isOAuthCode) {
        if (!issuerKey.trim()) {
          setErrorMsg('Pick an OAuth provider (or enter an issuer key).');
          setSaving(false);
          return;
        }
        // The curated issuer carries its endpoints; the free-form fields are an
        // escape hatch for an unregistered issuer. Endpoints are optional on the
        // profile (the server discovers them from the registry when omitted).
        const scopeList = oauthScopes
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        auth['issuerKey'] = issuerKey.trim();
        auth['ownerScope'] =
          ownerScope || (oauthPolicy?.defaultOwnerScope === 'user' ? 'user' : 'space');
        auth['clientScope'] =
          clientScope || (oauthPolicy?.defaultClientScope === 'tenant' ? 'tenant' : 'space');
        if (authorizationServer.trim()) auth['authorizationServer'] = authorizationServer.trim();
        if (tokenEndpoint.trim()) auth['tokenEndpoint'] = tokenEndpoint.trim();
        if (scopeList.length > 0) auth['scopes'] = scopeList;
      } else {
        if (slots.primary && primaryKey.trim()) {
          const key = primaryKey.trim();
          auth[slots.primary.authField] = key;
          if (primarySecret.trim()) {
            credentialWrites.push({
              key,
              value: primarySecret.trim(),
              label: slots.primary.credentialLabel(trimmedBindingId),
            });
          }
        }
        if (slots.secondary && secondaryKey.trim()) {
          const key = secondaryKey.trim();
          auth[slots.secondary.authField] = key;
          if (secondarySecret.trim()) {
            credentialWrites.push({
              key,
              value: secondarySecret.trim(),
              label: slots.secondary.credentialLabel(trimmedBindingId),
            });
          }
        }
      }

      const filledVariableValues: Record<string, string> = {};
      for (const v of variables) {
        const value = variableValues[v.name]?.trim();
        if (value) filledVariableValues[v.name] = value;
      }

      await onSave({
        bindingId: trimmedBindingId,
        apiId,
        name: name.trim(),
        // Tenant and space are composed by the API from the authenticated
        // request; an edit has to carry its own flow scope or lose it.
        scope: preservedBindingScope(editBinding),
        auth,
        egressPolicy: {},
        ...(variables.length > 0 ? { variableValues: filledVariableValues } : {}),
        enabled: true,
        // Create-intent: the server 409s rather than silently upserting over an
        // existing id (the route is otherwise an unconditional upsert).
        ...(isEdit ? {} : { expectAbsent: true }),
      });

      for (const w of credentialWrites) {
        await onSaveCredential(w.key, w.value, w.label);
      }

      onClose();
    } catch (err) {
      setSaveError(err);
    } finally {
      setSaving(false);
    }
  }, [
    bindingId,
    name,
    authType,
    slots,
    primaryKey,
    primarySecret,
    secondaryKey,
    secondarySecret,
    apiId,
    variables,
    variableValues,
    isOAuthCode,
    issuerKey,
    authorizationServer,
    tokenEndpoint,
    oauthScopes,
    ownerScope,
    clientScope,
    oauthPolicy,
    isEdit,
    existingBindingIds,
    onSave,
    onSaveCredential,
    onClose,
  ]);

  const trimmedBindingId = bindingId.trim();
  const bindingIdCollision =
    !isEdit && trimmedBindingId.length > 0 && existingBindingIds.includes(trimmedBindingId);

  return (
    <Dialog
      open
      onClose={onClose}
      title={isEdit ? `Edit Connection — ${apiId}` : `Connect ${apiId}`}
    >
      <Column gap="3" style={{ padding: 'var(--space-4)', maxWidth: 520, width: '100%' }}>
        {!isEdit && (
          <Text size="sm" color="secondary">
            Set up authentication so your agents can call the <strong>{apiId}</strong> API.
          </Text>
        )}

        <Row gap="3">
          <div style={{ flex: 1 }}>
            <Field>
              <Label>Connection ID</Label>
              <Input
                value={bindingId}
                onChange={(e) => {
                  setBindingId(e.target.value);
                }}
                readOnly={isEdit}
              />
            </Field>
          </div>
          <div style={{ flex: 1 }}>
            <Field>
              <Label>Name</Label>
              <Input
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                }}
              />
            </Field>
          </div>
        </Row>

        {bindingIdCollision && (
          <Text size="xs" tone="danger">
            A connection &quot;{trimmedBindingId}&quot; already exists for {apiId}. Choose a
            different Connection ID.
          </Text>
        )}

        <Divider />

        <Field>
          <Label>Authentication Type</Label>
          <Select
            value={authType}
            onChange={(e) => {
              setAuthType(e.target.value);
            }}
          >
            {AUTH_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </Select>
        </Field>

        {isOAuthCode && (
          <>
            <Field>
              <Label>OAuth provider</Label>
              <Select
                value={issuerMode === 'custom' ? '__custom' : issuerMode === '' ? '' : issuerKey}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === '') {
                    setIssuerMode('');
                    setIssuerKey('');
                    return;
                  }
                  if (v === '__custom') {
                    // Switching to the free-form escape hatch — keep any typed key.
                    setIssuerMode('custom');
                    return;
                  }
                  setIssuerMode('registered');
                  setIssuerKey(v);
                  // Clear the free-form endpoints — a curated issuer carries them.
                  setAuthorizationServer('');
                  setTokenEndpoint('');
                }}
              >
                <option value="">Select a provider…</option>
                {issuers.map((iss) => (
                  <option key={iss.issuerKey} value={iss.issuerKey}>
                    {iss.displayName}
                  </option>
                ))}
                <option value="__custom">Other (enter endpoints manually)</option>
              </Select>
              <Text size="xs" color="secondary" style={{ marginTop: 'var(--space-1)' }}>
                The client secret is never entered here — it lives in the registered OAuth app
                (Settings → OAuth Apps). After saving you&apos;ll be sent to the provider to sign
                in.
              </Text>
            </Field>

            {issuerMode !== '' && (
              <>
                {issuerMode === 'custom' && (
                  <>
                    <Field>
                      <Label>Issuer key</Label>
                      <Input
                        value={issuerKey}
                        onChange={(e) => {
                          setIssuerKey(e.target.value);
                        }}
                        placeholder="e.g. acme-idp"
                        autoComplete="off"
                      />
                    </Field>
                    <Field>
                      <Label>Authorization server URL</Label>
                      <Input
                        value={authorizationServer}
                        onChange={(e) => {
                          setAuthorizationServer(e.target.value);
                        }}
                        placeholder="https://auth.example.com/authorize"
                        autoComplete="off"
                      />
                    </Field>
                    <Field>
                      <Label>Token endpoint URL</Label>
                      <Input
                        value={tokenEndpoint}
                        onChange={(e) => {
                          setTokenEndpoint(e.target.value);
                        }}
                        placeholder="https://auth.example.com/token"
                        autoComplete="off"
                      />
                    </Field>
                  </>
                )}

                <Field>
                  <Label>Scopes (optional, comma-separated)</Label>
                  <Input
                    value={oauthScopes}
                    onChange={(e) => {
                      setOauthScopes(e.target.value);
                    }}
                    placeholder={
                      getOAuthIssuer(issuerKey)?.defaultScopes.join(', ') || 'read, write'
                    }
                    autoComplete="off"
                  />
                </Field>

                <Field>
                  <Label>Who connects the account?</Label>
                  <Select
                    value={
                      ownerScope || (oauthPolicy?.defaultOwnerScope === 'user' ? 'user' : 'space')
                    }
                    onChange={(e) => {
                      setOwnerScope(e.target.value as OAuthConsentOwnerScope);
                    }}
                  >
                    {OWNER_SCOPE_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </Select>
                  <Text size="xs" color="secondary" style={{ marginTop: 'var(--space-1)' }}>
                    {
                      OWNER_SCOPE_OPTIONS.find(
                        (o) =>
                          o.value ===
                          (ownerScope ||
                            (oauthPolicy?.defaultOwnerScope === 'user' ? 'user' : 'space')),
                      )?.help
                    }
                  </Text>
                </Field>

                <Field>
                  <Label>Which OAuth app drives sign-in?</Label>
                  <Select
                    value={
                      clientScope ||
                      (oauthPolicy?.defaultClientScope === 'tenant' ? 'tenant' : 'space')
                    }
                    onChange={(e) => {
                      setClientScope(e.target.value as ApiClientScope);
                    }}
                  >
                    {CLIENT_SCOPE_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </Select>
                  <Text size="xs" color="secondary" style={{ marginTop: 'var(--space-1)' }}>
                    Register tenant or space OAuth apps under Settings → OAuth Apps.
                  </Text>
                </Field>
              </>
            )}
          </>
        )}

        {slots.primary && (
          <CredentialSlotFields
            slot={slots.primary}
            credKey={primaryKey}
            secretValue={primarySecret}
            onChangeKey={setPrimaryKey}
            onChangeSecret={setPrimarySecret}
          />
        )}
        {slots.secondary && (
          <CredentialSlotFields
            slot={slots.secondary}
            credKey={secondaryKey}
            secretValue={secondarySecret}
            onChangeKey={setSecondaryKey}
            onChangeSecret={setSecondarySecret}
          />
        )}

        {(templateSegments || variables.length > 0) && (
          <>
            <Divider />
            {templateSegments ? (
              <Field>
                <Label>Site URL</Label>
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    gap: '4px',
                    fontFamily: 'var(--font-family-mono)',
                    fontSize: 'var(--font-size-sm)',
                  }}
                >
                  {templateSegments.map((seg, i) =>
                    seg.kind === 'text' ? (
                      <span key={i} style={{ color: 'var(--color-text-secondary)' }}>
                        {seg.text}
                      </span>
                    ) : (
                      <Input
                        key={i}
                        value={variableValues[seg.name] ?? ''}
                        onChange={(e) => {
                          const next = e.target.value;
                          setVariableValues((prev) => ({ ...prev, [seg.name]: next }));
                        }}
                        placeholder={
                          variables.find((v) => v.name === seg.name)?.example ?? seg.name
                        }
                        autoComplete="off"
                        style={{ width: '14ch' }}
                      />
                    ),
                  )}
                </div>
                <Text size="xs" color="secondary" style={{ marginTop: 'var(--space-1)' }}>
                  Fill the highlighted part — the rest of the URL is fixed for this connector.
                </Text>
              </Field>
            ) : (
              <Text size="sm" color="secondary">
                Configuration (non-secret) — fill the values this connection needs.
              </Text>
            )}
            {variables
              .filter((v) => !baseUrlTemplate?.includes(`{${v.name}}`))
              .map((variable) => (
                <Field key={variable.name}>
                  <Label>
                    {variable.name}
                    {variable.required ? '' : ' (optional)'}
                  </Label>
                  <Input
                    value={variableValues[variable.name] ?? ''}
                    onChange={(e) => {
                      const next = e.target.value;
                      setVariableValues((prev) => ({ ...prev, [variable.name]: next }));
                    }}
                    placeholder={variable.example ?? ''}
                    autoComplete="off"
                  />
                  {variable.description && (
                    <Text size="xs" color="secondary" style={{ marginTop: 'var(--space-1)' }}>
                      {variable.description}
                    </Text>
                  )}
                </Field>
              ))}
          </>
        )}

        {errorMsg && (
          <Text size="sm" tone="danger">
            {errorMsg}
          </Text>
        )}
        {saveError != null && <IntegrationWriteErrorNotice error={saveError} kind="api" />}

        <Divider />

        <Row justify="end" gap="2">
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => void handleSave()}
            disabled={!bindingId.trim() || !name.trim() || saving || bindingIdCollision}
          >
            {saving ? 'Saving...' : isEdit ? 'Update Connection' : 'Connect'}
          </Button>
        </Row>
      </Column>
    </Dialog>
  );
}
