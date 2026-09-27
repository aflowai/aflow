'use client';

import { useEffect } from 'react';
import { Column, Field, Icon, Input, Label, Select, Text } from '@aflow/design-system';
import type { IntegrationCredentialMeta } from '../../hooks/use-integrations.js';

export type McpAuthType =
  'none' | 'bearer' | 'header' | 'oauth2_client_credentials' | 'oauth2_pkce' | 'oauth2_cimd';

/** Identity axis (whose tokens) for a consent-based OAuth binding. */
export type McpOwnerScope = 'user' | 'space';
/** Client (app) axis (whose OAuth app) for a consent-based OAuth binding. */
export type McpClientScope = 'platform' | 'tenant' | 'space';

export interface McpAuthFormState {
  type: McpAuthType;

  // bearer / header — single credential slot
  credentialKey?: string;
  credentialValue?: string;

  // header — non-secret
  headerName?: string;

  // oauth2_client_credentials — non-secret
  tokenEndpoint?: string;

  // oauth2_* — two credential slots
  clientIdCredentialKey?: string;
  clientIdCredentialValue?: string;
  clientSecretCredentialKey?: string;
  clientSecretCredentialValue?: string;

  scopes?: string;

  // oauth2_pkce / oauth2_cimd — non-secret
  authorizationServer?: string;
  clientIdMetadataUrl?: string;
  resource?: string;

  // Consent-based OAuth (oauth2_pkce / oauth2_cimd) ownership axes. The durable
  // source of truth is the binding's owner_scope/client_scope COLUMNS — carried
  // top-level on SaveMcpBindingInput, hydrated top-level from the binding row.
  // They live on the form state purely to drive the two selectors; they are
  // NOT written into auth_json (the schema strips them there).
  ownerScope?: McpOwnerScope;
  clientScope?: McpClientScope;
}

/** Whether the chosen auth type runs a per-user/space/tenant consent flow with an ownership axis. */
export function isConsentOAuth(type: McpAuthType): boolean {
  return type === 'oauth2_pkce' || type === 'oauth2_cimd';
}

const OWNER_SCOPE_OPTIONS: Array<{ value: McpOwnerScope; label: string; help: string }> = [
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

const CLIENT_SCOPE_OPTIONS: Array<{ value: McpClientScope; label: string }> = [
  { value: 'platform', label: 'Phoenix built-in OAuth app' },
  { value: 'tenant', label: 'A tenant-registered OAuth app' },
  { value: 'space', label: 'A space-registered OAuth app' },
];

/** Build an auth profile JSON (the shape stored in `binding.auth`) from the form state. */
export function buildAuthProfile(s: McpAuthFormState): Record<string, unknown> {
  const scopesList =
    s.scopes
      ?.split(',')
      .map((x) => x.trim())
      .filter(Boolean) ?? [];

  switch (s.type) {
    case 'none':
      return { type: 'none' };
    case 'bearer':
      return {
        type: 'bearer',
        ...(s.credentialKey?.trim() ? { credentialKey: s.credentialKey.trim() } : {}),
      };
    case 'header':
      return {
        type: 'header',
        headerName: s.headerName?.trim() ?? '',
        ...(s.credentialKey?.trim() ? { credentialKey: s.credentialKey.trim() } : {}),
      };
    case 'oauth2_client_credentials':
      return {
        type: 'oauth2_client_credentials',
        tokenEndpoint: s.tokenEndpoint?.trim() ?? '',
        ...(s.clientIdCredentialKey?.trim()
          ? { clientIdCredentialKey: s.clientIdCredentialKey.trim() }
          : {}),
        ...(s.clientSecretCredentialKey?.trim()
          ? { clientSecretCredentialKey: s.clientSecretCredentialKey.trim() }
          : {}),
        ...(scopesList.length > 0 ? { scopes: scopesList } : {}),
      };
    case 'oauth2_pkce':
      return {
        type: 'oauth2_pkce',
        ...(s.authorizationServer?.trim()
          ? { authorizationServer: s.authorizationServer.trim() }
          : {}),
        ...(s.clientIdCredentialKey?.trim()
          ? { clientIdCredentialKey: s.clientIdCredentialKey.trim() }
          : {}),
        ...(s.clientSecretCredentialKey?.trim()
          ? { clientSecretCredentialKey: s.clientSecretCredentialKey.trim() }
          : {}),
        ...(scopesList.length > 0 ? { scopes: scopesList } : {}),
        ...(s.resource?.trim() ? { resource: s.resource.trim() } : {}),
      };
    case 'oauth2_cimd':
      return {
        type: 'oauth2_cimd',
        ...(s.authorizationServer?.trim()
          ? { authorizationServer: s.authorizationServer.trim() }
          : {}),
        clientIdMetadataUrl: s.clientIdMetadataUrl?.trim() ?? '',
        ...(scopesList.length > 0 ? { scopes: scopesList } : {}),
        ...(s.resource?.trim() ? { resource: s.resource.trim() } : {}),
      };
  }
}

/**
 * Reverse: hydrate the form state from a stored auth profile (no secrets —
 * values are write-only). NOTE: ownerScope/clientScope are NOT read here — they
 * live in the binding's owner_scope/client_scope columns, hydrated top-level by
 * the dialog, not in auth_json.
 */
export function authProfileToFormState(auth: Record<string, unknown>): McpAuthFormState {
  const type = (auth['type'] as McpAuthType | undefined) ?? 'none';
  const scopesArr = Array.isArray(auth['scopes']) ? (auth['scopes'] as string[]) : undefined;
  return {
    type,
    ...(typeof auth['credentialKey'] === 'string' ? { credentialKey: auth['credentialKey'] } : {}),
    ...(typeof auth['headerName'] === 'string' ? { headerName: auth['headerName'] } : {}),
    ...(typeof auth['tokenEndpoint'] === 'string' ? { tokenEndpoint: auth['tokenEndpoint'] } : {}),
    ...(typeof auth['clientIdCredentialKey'] === 'string'
      ? { clientIdCredentialKey: auth['clientIdCredentialKey'] }
      : {}),
    ...(typeof auth['clientSecretCredentialKey'] === 'string'
      ? { clientSecretCredentialKey: auth['clientSecretCredentialKey'] }
      : {}),
    ...(scopesArr ? { scopes: scopesArr.join(', ') } : {}),
    ...(typeof auth['authorizationServer'] === 'string'
      ? { authorizationServer: auth['authorizationServer'] }
      : {}),
    ...(typeof auth['clientIdMetadataUrl'] === 'string'
      ? { clientIdMetadataUrl: auth['clientIdMetadataUrl'] }
      : {}),
    ...(typeof auth['resource'] === 'string' ? { resource: auth['resource'] } : {}),
  };
}

export interface CredentialWrite {
  key: string;
  value: string;
  label: string;
}

export function extractCredentialWrites(s: McpAuthFormState, bindingId: string): CredentialWrite[] {
  const writes: CredentialWrite[] = [];
  switch (s.type) {
    case 'bearer':
      if (s.credentialKey?.trim() && s.credentialValue?.trim()) {
        writes.push({
          key: s.credentialKey.trim(),
          value: s.credentialValue.trim(),
          label: `Bearer token for ${bindingId}`,
        });
      }
      break;
    case 'header':
      if (s.credentialKey?.trim() && s.credentialValue?.trim()) {
        writes.push({
          key: s.credentialKey.trim(),
          value: s.credentialValue.trim(),
          label: `Header value for ${bindingId}`,
        });
      }
      break;
    case 'oauth2_client_credentials':
    case 'oauth2_pkce':
      if (s.clientIdCredentialKey?.trim() && s.clientIdCredentialValue?.trim()) {
        writes.push({
          key: s.clientIdCredentialKey.trim(),
          value: s.clientIdCredentialValue.trim(),
          label: `OAuth client ID for ${bindingId}`,
        });
      }
      if (s.clientSecretCredentialKey?.trim() && s.clientSecretCredentialValue?.trim()) {
        writes.push({
          key: s.clientSecretCredentialKey.trim(),
          value: s.clientSecretCredentialValue.trim(),
          label: `OAuth client secret for ${bindingId}`,
        });
      }
      break;
    case 'oauth2_cimd':
    case 'none':
      break;
  }
  return writes;
}

interface CredentialSlot {
  /** Field name on `auth_json`. */
  authField: 'credentialKey' | 'clientIdCredentialKey' | 'clientSecretCredentialKey';
  keyLabel: string;
  secretLabel: string;
  defaultKey: (bindingId: string) => string;
}

function getCredentialSlots(authType: McpAuthType): {
  primary?: CredentialSlot;
  secondary?: CredentialSlot;
} {
  switch (authType) {
    case 'bearer':
      return {
        primary: {
          authField: 'credentialKey',
          keyLabel: 'Token credential key',
          secretLabel: 'Bearer token value',
          defaultKey: (id) => `${id}-token`,
        },
      };
    case 'header':
      return {
        primary: {
          authField: 'credentialKey',
          keyLabel: 'Header value credential key',
          secretLabel: 'Header value',
          defaultKey: (id) => `${id}-header-value`,
        },
      };
    case 'oauth2_client_credentials':
    case 'oauth2_pkce':
      return {
        primary: {
          authField: 'clientIdCredentialKey',
          keyLabel: 'Client ID — credential key',
          secretLabel: 'Client ID — value',
          defaultKey: (id) => `${id}-client-id`,
        },
        secondary: {
          authField: 'clientSecretCredentialKey',
          keyLabel: 'Client Secret — credential key',
          secretLabel: 'Client Secret — value',
          defaultKey: (id) => `${id}-client-secret`,
        },
      };
    case 'oauth2_cimd':
    case 'none':
      return {};
  }
}

/**
 * Form field set rendered conditionally based on the chosen auth type.
 * Each credential slot renders a (key, value) pair — the secret value
 * is optional ("you can add it later") so operators can save a binding
 * disabled, register the secret, then test + enable.
 */
export function McpAuthFields({
  state,
  bindingId,
  onChange,
  credentials,
}: {
  state: McpAuthFormState;
  /** Used to derive default credential key names. */
  bindingId: string;
  onChange: (s: McpAuthFormState) => void;
  credentials: IntegrationCredentialMeta[];
}) {
  const set = (patch: Partial<McpAuthFormState>) => {
    onChange({ ...state, ...patch });
  };
  const slots = getCredentialSlots(state.type);

  // Auto-seed empty credential-key slots with the auth-type-specific
  // default (e.g. `${bindingId}-token` for bearer). Mirrors the API form's
  // useEffect in ConnectApiDialog. Without this, leaving the placeholder
  // alone saves the binding with an empty `auth.credentialKey`, which the
  // executor rejects at call time as "missing credentialKey".
  //
  // Only seeds when the slot is empty — so an operator who typed a custom
  // key never gets it overwritten, and edit mode (where `state` was
  // hydrated from a saved binding) is preserved.
  const fallbackId = bindingId.trim() || 'binding';
  const primaryDefault = slots.primary?.defaultKey(fallbackId) ?? '';
  const secondaryDefault = slots.secondary?.defaultKey(fallbackId) ?? '';
  useEffect(() => {
    const patch: Partial<McpAuthFormState> = {};
    if (slots.primary && !getSlotKey(state, slots.primary.authField).trim()) {
      Object.assign(patch, setSlotKey(slots.primary.authField, primaryDefault));
    }
    if (slots.secondary && !getSlotKey(state, slots.secondary.authField).trim()) {
      Object.assign(patch, setSlotKey(slots.secondary.authField, secondaryDefault));
    }
    if (Object.keys(patch).length > 0) onChange({ ...state, ...patch });
    // Depend on the *derived* defaults, not `state` — those only shift when
    // auth type or bindingId changes, which is what should trigger a reseed.
    // state intentionally excluded.
  }, [primaryDefault, secondaryDefault]);

  return (
    <Column gap="3">
      <Field>
        <Label>Auth type</Label>
        <Select
          value={state.type}
          onChange={(e) => {
            set({ type: e.target.value as McpAuthType });
          }}
        >
          <option value="none">No auth (public server)</option>
          <option value="bearer">API token</option>
          <option value="header">Custom header</option>
          <option value="oauth2_client_credentials">OAuth — client credentials</option>
          <option value="oauth2_pkce">OAuth — browser sign-in</option>
          <option value="oauth2_cimd">OAuth — automatic registration</option>
        </Select>
      </Field>

      {state.type === 'header' && (
        <Field>
          <Label>Header name</Label>
          <Input
            value={state.headerName ?? ''}
            onChange={(e) => {
              set({ headerName: e.target.value });
            }}
            placeholder="e.g. X-API-Key"
          />
        </Field>
      )}

      {state.type === 'oauth2_client_credentials' && (
        <Field>
          <Label>Token URL</Label>
          <Input
            value={state.tokenEndpoint ?? ''}
            onChange={(e) => {
              set({ tokenEndpoint: e.target.value });
            }}
            placeholder="https://auth.example.com/oauth/token"
          />
        </Field>
      )}

      {state.type === 'oauth2_pkce' && (
        <Field>
          <Label>Auth server (optional)</Label>
          <Input
            value={state.authorizationServer ?? ''}
            onChange={(e) => {
              set({ authorizationServer: e.target.value });
            }}
            placeholder="Auto-discovered if blank"
          />
        </Field>
      )}

      {state.type === 'oauth2_cimd' && (
        <>
          <Field>
            <Label>Auth server (optional)</Label>
            <Input
              value={state.authorizationServer ?? ''}
              onChange={(e) => {
                set({ authorizationServer: e.target.value });
              }}
              placeholder="Auto-discovered if blank"
            />
          </Field>
          <Field>
            <Label>Client metadata URL</Label>
            <Input
              value={state.clientIdMetadataUrl ?? ''}
              onChange={(e) => {
                set({ clientIdMetadataUrl: e.target.value });
              }}
              placeholder="https://api.aflow.ai/.well-known/cimd"
            />
            <Text size="xs" color="muted">
              No pre-registration needed — Phoenix hosts a public client document for you.
            </Text>
          </Field>
        </>
      )}

      {isConsentOAuth(state.type) && (
        <>
          <Field>
            <Label>Who connects the account?</Label>
            <Select
              value={state.ownerScope ?? 'space'}
              onChange={(e) => {
                set({ ownerScope: e.target.value as McpOwnerScope });
              }}
            >
              {OWNER_SCOPE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </Select>
            <Text size="xs" color="muted">
              {OWNER_SCOPE_OPTIONS.find((o) => o.value === (state.ownerScope ?? 'space'))?.help}
            </Text>
          </Field>
          <Field>
            <Label>Which OAuth app drives sign-in?</Label>
            <Select
              value={state.clientScope ?? 'platform'}
              onChange={(e) => {
                set({ clientScope: e.target.value as McpClientScope });
              }}
            >
              {CLIENT_SCOPE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </Select>
            <Text size="xs" color="muted">
              Register tenant/space OAuth apps under Settings → OAuth Apps. Platform uses the
              built-in app.
            </Text>
          </Field>
        </>
      )}

      {slots.primary && (
        <CredentialSlotFields
          slot={slots.primary}
          credentials={credentials}
          credKey={getSlotKey(state, slots.primary.authField)}
          secretValue={getSlotValue(state, slots.primary.authField)}
          onChangeSecret={(v) => {
            set(setSlotValue(slots.primary!.authField, v));
          }}
        />
      )}
      {slots.secondary && (
        <CredentialSlotFields
          slot={slots.secondary}
          credentials={credentials}
          credKey={getSlotKey(state, slots.secondary.authField)}
          secretValue={getSlotValue(state, slots.secondary.authField)}
          onChangeSecret={(v) => {
            set(setSlotValue(slots.secondary!.authField, v));
          }}
        />
      )}

      {(state.type === 'oauth2_client_credentials' ||
        state.type === 'oauth2_pkce' ||
        state.type === 'oauth2_cimd') && (
        <details>
          <summary style={{ cursor: 'pointer', fontSize: 'var(--font-size-sm)' }}>
            More OAuth options
          </summary>
          <Column gap="3" style={{ marginTop: 'var(--space-2)' }}>
            <Field>
              <Label>Scopes (optional)</Label>
              <Input
                value={state.scopes ?? ''}
                onChange={(e) => {
                  set({ scopes: e.target.value });
                }}
                placeholder="mcp:tools, mcp:resources"
              />
            </Field>
            <Field>
              <Label>Audience (optional)</Label>
              <Input
                value={state.resource ?? ''}
                onChange={(e) => {
                  set({ resource: e.target.value });
                }}
                placeholder="Defaults to the server's URL"
              />
            </Field>
          </Column>
        </details>
      )}

      {state.type === 'none' && (
        <Text size="sm" color="muted">
          Public servers don't need credentials. Save to connect.
        </Text>
      )}
    </Column>
  );
}

function getSlotKey(s: McpAuthFormState, authField: CredentialSlot['authField']): string {
  switch (authField) {
    case 'credentialKey':
      return s.credentialKey ?? '';
    case 'clientIdCredentialKey':
      return s.clientIdCredentialKey ?? '';
    case 'clientSecretCredentialKey':
      return s.clientSecretCredentialKey ?? '';
  }
}

function getSlotValue(s: McpAuthFormState, authField: CredentialSlot['authField']): string {
  switch (authField) {
    case 'credentialKey':
      return s.credentialValue ?? '';
    case 'clientIdCredentialKey':
      return s.clientIdCredentialValue ?? '';
    case 'clientSecretCredentialKey':
      return s.clientSecretCredentialValue ?? '';
  }
}

function setSlotKey(
  authField: CredentialSlot['authField'],
  value: string,
): Partial<McpAuthFormState> {
  switch (authField) {
    case 'credentialKey':
      return { credentialKey: value };
    case 'clientIdCredentialKey':
      return { clientIdCredentialKey: value };
    case 'clientSecretCredentialKey':
      return { clientSecretCredentialKey: value };
  }
}

function setSlotValue(
  authField: CredentialSlot['authField'],
  value: string,
): Partial<McpAuthFormState> {
  switch (authField) {
    case 'credentialKey':
      return { credentialValue: value };
    case 'clientIdCredentialKey':
      return { clientIdCredentialValue: value };
    case 'clientSecretCredentialKey':
      return { clientSecretCredentialValue: value };
  }
}

function CredentialSlotFields({
  slot,
  credentials,
  credKey,
  secretValue,
  onChangeSecret,
}: {
  slot: CredentialSlot;
  credentials: IntegrationCredentialMeta[];
  /** Auto-derived from bindingId — not shown to the operator. */
  credKey: string;
  secretValue: string;
  onChangeSecret: (v: string) => void;
}) {
  // The credential KEY is an internal identifier, auto-derived from the
  // bindingId (see `getCredentialSlots`). We don't expose it as an editable
  // field — operators set a binding name + provide a secret value; the key
  // is plumbing. Sharing a credential across bindings is rare; advanced
  // operators can manage it under /integrations/credentials directly.
  const existing = credentials.find((c) => c.credentialKey === credKey);
  const credentialStatus = !credKey.trim()
    ? 'empty'
    : !existing
      ? 'new'
      : existing.hasValue
        ? 'has-secret'
        : 'no-secret';

  return (
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
              {slot.secretLabel}{' '}
              <Text as="span" size="xs" color="secondary">
                (
                {credentialStatus === 'has-secret'
                  ? 'leave blank to keep existing value'
                  : 'optional — you can add it later'}
                )
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
          placeholder={
            credentialStatus === 'has-secret'
              ? '••••••• (existing — leave blank to keep)'
              : 'Paste the secret to save it now'
          }
          autoComplete="new-password"
        />
        <Text size="xs" tone="success" style={{ marginTop: 'var(--space-1)' }}>
          Encrypted at rest. Never shown again after you save.
        </Text>
      </Field>
    </div>
  );
}
