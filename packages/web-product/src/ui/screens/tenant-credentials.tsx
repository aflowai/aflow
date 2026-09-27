'use client';

import { useState, useMemo, useCallback } from 'react';
import {
  PageContainer,
  Column,
  Row,
  Card,
  CardBody,
  Text,
  Heading,
  Icon,
  Badge,
  Button,
  Dialog,
  Field,
  Label,
  Input,
} from '@aflow/design-system';
import type { IconName } from '@aflow/design-system';
import {
  PROVIDER_CATEGORY_ORDER,
  PROVIDER_CATEGORY_LABELS,
  PROVIDER_CATEGORY_DESCRIPTIONS,
} from '@aflow/schemas';
import { useCredentials } from '../hooks/use-credentials.js';
import type {
  ProviderDefinition,
  CredentialMeta,
  CredentialStatus,
} from '../hooks/use-credentials.js';
import { useCurrentUser } from '../components/user-avatar.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Scope = 'user' | 'space' | 'tenant';

interface DialogState {
  open: boolean;
  provider: ProviderDefinition | null;
  scope: Scope;
  existingCredential: CredentialMeta | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function scopeLabel(scope: Scope): string {
  switch (scope) {
    case 'user':
      return 'Your key';
    case 'space':
      return 'Space key';
    case 'tenant':
      return 'Tenant key';
  }
}

function resolutionBadge(
  status: CredentialStatus | undefined,
  credential: CredentialMeta | undefined,
): { variant: 'success' | 'info' | 'neutral' | 'danger' | 'warning'; label: string } {
  if (!status?.resolved) {
    return { variant: 'danger', label: 'Not configured' };
  }
  if (credential?.status === 'error') {
    return { variant: 'warning', label: `Error (${credential.lastErrorCode ?? 'auth'})` };
  }
  return { variant: 'success', label: `Active (${scopeLabel(status.resolvedScope!)})` };
}

// ---------------------------------------------------------------------------
// Provider Row (used in both sections)
// ---------------------------------------------------------------------------

function ProviderRow({
  provider,
  credential,
  isResolved,
  idx,
  onAdd,
  onUpdate,
  onDelete,
  onTest,
  testing,
}: {
  provider: ProviderDefinition;
  credential: CredentialMeta | undefined;
  /** Whether this scope is the one currently winning resolution */
  isResolved: boolean;
  idx: number;
  onAdd: () => void;
  onUpdate: () => void;
  onDelete: () => void;
  onTest?: () => void;
  testing?: boolean;
}) {
  const hasCred = Boolean(credential);
  const hasError = credential?.status === 'error';

  return (
    <Row
      gap="md"
      wrap
      style={{
        padding: 'var(--space-3) var(--space-4)',
        alignItems: 'center',
        borderTop: idx > 0 ? '1px solid var(--color-border-subtle)' : undefined,
      }}
    >
      <Icon
        name={provider.iconName as IconName}
        size="md"
        style={{ color: 'var(--color-content-secondary)', flexShrink: 0 }}
      />
      <Column gap="0" style={{ flex: '1 1 180px', minWidth: 0 }}>
        <Text size="sm" weight="medium">
          {provider.displayName}
        </Text>
        <Text
          size="xs"
          variant="muted"
          style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
        >
          {provider.description}
        </Text>
      </Column>
      {hasCred ? (
        <Badge variant={hasError ? 'warning' : isResolved ? 'success' : 'info'}>
          {hasError
            ? `Error (${credential?.lastErrorCode ?? 'auth'})`
            : isResolved
              ? 'Active'
              : 'Set (overridden)'}
        </Badge>
      ) : (
        <Badge variant="neutral">Not set</Badge>
      )}
      <Row gap="xs">
        {hasCred ? (
          <>
            {onTest && (
              <Button variant="ghost" size="sm" onClick={onTest} loading={testing ?? false}>
                Test
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={onUpdate}>
              Update
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={onDelete}
              style={{ color: 'var(--color-danger)' }}
            >
              Remove
            </Button>
          </>
        ) : (
          <Button variant="ghost" size="sm" onClick={onAdd}>
            Add key
          </Button>
        )}
      </Row>
    </Row>
  );
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export function TenantCredentialsPage() {
  const {
    providers,
    credentials,
    statuses,
    isLoading,
    error,
    refresh,
    saveCredential,
    deleteCredential,
    validateCredential,
  } = useCredentials();
  const currentUser = useCurrentUser();

  const [dialog, setDialog] = useState<DialogState>({
    open: false,
    provider: null,
    scope: 'user',
    existingCredential: null,
  });
  const [saving, setSaving] = useState(false);
  const [testingKey, setTestingKey] = useState<string | null>(null);
  const [formSecrets, setFormSecrets] = useState<Record<string, string>>({});
  const [formConfig, setFormConfig] = useState<Record<string, string>>({});
  const [formLabel, setFormLabel] = useState('');

  // Group providers by category
  const grouped = useMemo(() => {
    const map = new Map<string, ProviderDefinition[]>();
    for (const p of providers) {
      const list = map.get(p.category) ?? [];
      list.push(p);
      map.set(p.category, list);
    }
    return map;
  }, [providers]);

  // Credential lookups
  const getScopedCredential = useCallback(
    (providerId: string, scope: Scope): CredentialMeta | undefined =>
      credentials.find((c) => c.providerId === providerId && c.scope === scope),
    [credentials],
  );

  const getResolvedCredential = useCallback(
    (providerId: string): CredentialMeta | undefined => {
      const status = statuses.get(providerId);
      if (!status?.resolved) return undefined;
      return credentials.find(
        (c) => c.providerId === providerId && c.scope === status.resolvedScope,
      );
    },
    [credentials, statuses],
  );

  // ── Dialog ─────────────────────────────────────────────────────────────

  const openDialog = useCallback(
    (provider: ProviderDefinition, scope: Scope) => {
      const existing = credentials.find(
        (c) => c.providerId === provider.providerId && c.scope === scope,
      );
      const config: Record<string, string> = {};
      if (existing) {
        for (const [k, v] of Object.entries(existing.configJson)) {
          if (v != null) config[k] = typeof v === 'string' ? v : JSON.stringify(v);
        }
      } else {
        for (const f of provider.fields) {
          if (f.type !== 'secret' && f.defaultValue) {
            config[f.fieldId] = f.defaultValue;
          }
        }
      }

      setFormSecrets({});
      setFormConfig(config);
      setFormLabel(existing?.label ?? '');
      setDialog({ open: true, provider, scope, existingCredential: existing ?? null });
    },
    [credentials],
  );

  const closeDialog = useCallback(() => {
    setDialog({ open: false, provider: null, scope: 'tenant', existingCredential: null });
    setFormSecrets({});
    setFormConfig({});
    setFormLabel('');
  }, []);

  const handleSave = useCallback(async () => {
    if (!dialog.provider) return;
    setSaving(true);
    try {
      const result = await saveCredential(
        dialog.provider.providerId,
        dialog.scope,
        formSecrets,
        Object.keys(formConfig).length > 0 ? formConfig : undefined,
        formLabel || undefined,
      );
      if (result) {
        closeDialog();
      }
    } finally {
      setSaving(false);
    }
  }, [dialog, formSecrets, formConfig, formLabel, saveCredential, closeDialog]);

  const handleDelete = useCallback(
    async (providerId: string, scope: Scope) => {
      await deleteCredential(providerId, scope);
    },
    [deleteCredential],
  );

  const handleTest = useCallback(
    async (providerId: string, scope: Scope) => {
      setTestingKey(`${providerId}:${scope}`);
      try {
        await validateCredential(providerId, scope);
      } finally {
        setTestingKey(null);
      }
    },
    [validateCredential],
  );

  const renderScopeSection = (scope: Scope) => (
    <>
      {PROVIDER_CATEGORY_ORDER.map((category) => {
        const categoryProviders = grouped.get(category);
        if (!categoryProviders?.length) return null;

        return (
          <Column key={category} gap="sm">
            <Heading level={5}>{PROVIDER_CATEGORY_LABELS[category] ?? category}</Heading>
            {PROVIDER_CATEGORY_DESCRIPTIONS[category] && (
              <Text size="xs" variant="muted">
                {PROVIDER_CATEGORY_DESCRIPTIONS[category]}
              </Text>
            )}
            <Card>
              <CardBody style={{ padding: 0 }}>
                {categoryProviders.map((provider, idx) => {
                  const status = statuses.get(provider.providerId);
                  const scopedCred = getScopedCredential(provider.providerId, scope);
                  const isResolved = status?.resolvedScope === scope;
                  const testable = provider.category === 'llm' && Boolean(scopedCred);

                  return (
                    <ProviderRow
                      key={provider.providerId}
                      provider={provider}
                      credential={scopedCred}
                      isResolved={isResolved}
                      idx={idx}
                      onAdd={() => {
                        openDialog(provider, scope);
                      }}
                      onUpdate={() => {
                        openDialog(provider, scope);
                      }}
                      onDelete={() => void handleDelete(provider.providerId, scope)}
                      {...(testable
                        ? {
                            onTest: () => void handleTest(provider.providerId, scope),
                            testing: testingKey === `${provider.providerId}:${scope}`,
                          }
                        : {})}
                    />
                  );
                })}
              </CardBody>
            </Card>
          </Column>
        );
      })}
    </>
  );

  // ── Render ─────────────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <PageContainer>
        <Text variant="muted">Loading providers...</Text>
      </PageContainer>
    );
  }

  return (
    <>
      <PageContainer>
        {error && (
          <Card>
            <CardBody>
              <Row gap="sm" style={{ alignItems: 'center' }}>
                <Icon name="warning-circle" size="sm" style={{ color: 'var(--color-danger)' }} />
                <Text size="sm" style={{ color: 'var(--color-danger)' }}>
                  {error}
                </Text>
                <Button variant="ghost" size="sm" onClick={() => void refresh()}>
                  Retry
                </Button>
              </Row>
            </CardBody>
          </Card>
        )}

        <Column gap="xl">
          {/* ── Your Keys (user scope) ───────────────────────────────────── */}

          <Column gap="lg">
            <Column gap="xs">
              <Heading level={4}>Your Keys</Heading>
              <Text size="sm" variant="muted" style={{ marginBottom: 'var(--space-2xl)' }}>
                Personal keys that follow you across all your workspaces. They take precedence over
                space and tenant keys.
              </Text>
            </Column>

            {renderScopeSection('user')}
          </Column>

          {/* ── Tenant Default Keys (tenant admins only) ─────────────────── */}

          {currentUser?.isAdmin && (
            <Column gap="lg">
              <Column gap="xs">
                <Heading level={4}>Tenant Default Keys</Heading>
                <Text size="sm" variant="muted" style={{ marginBottom: 'var(--space-2xl)' }}>
                  Shared keys available to all members who don't have personal or space-level keys.
                </Text>
              </Column>

              {renderScopeSection('tenant')}
            </Column>
          )}

          {/* ── Effective Resolution ─────────────────────────────────────── */}

          <Column gap="md">
            <Column gap="xs">
              <Heading level={4}>Effective Resolution</Heading>
              <Text size="sm" variant="muted">
                Shows which key will be used for each provider based on the full resolution chain
                (personal &rarr; space &rarr; tenant).
              </Text>
            </Column>

            <Card>
              <CardBody style={{ padding: 0 }}>
                {providers.map((provider, idx) => {
                  const status = statuses.get(provider.providerId);
                  const resolvedCred = getResolvedCredential(provider.providerId);
                  const badge = resolutionBadge(status, resolvedCred);

                  return (
                    <Row
                      key={provider.providerId}
                      gap="md"
                      style={{
                        padding: 'var(--space-2) var(--space-4)',
                        alignItems: 'center',
                        borderTop: idx > 0 ? '1px solid var(--color-border-subtle)' : undefined,
                      }}
                    >
                      <Icon
                        name={provider.iconName as IconName}
                        size="sm"
                        style={{ color: 'var(--color-content-secondary)', flexShrink: 0 }}
                      />
                      <Text size="sm" style={{ flex: 1 }}>
                        {provider.displayName}
                      </Text>
                      <Badge variant={badge.variant}>{badge.label}</Badge>
                    </Row>
                  );
                })}
              </CardBody>
            </Card>
          </Column>
        </Column>
      </PageContainer>

      {/* ── Credential Dialog ────────────────────────────────────────────── */}

      <Dialog
        open={dialog.open}
        onClose={closeDialog}
        title={
          dialog.existingCredential
            ? `Update ${scopeLabel(dialog.scope)} — ${dialog.provider?.displayName ?? ''}`
            : `Add ${scopeLabel(dialog.scope)} — ${dialog.provider?.displayName ?? ''}`
        }
        width="lg"
        footer={
          <Row gap="sm">
            <Button variant="ghost" size="sm" onClick={closeDialog} disabled={saving}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" onClick={() => void handleSave()} loading={saving}>
              {dialog.existingCredential ? 'Update' : 'Save'}
            </Button>
          </Row>
        }
      >
        {dialog.provider && (
          <Column gap="md">
            <Badge variant="info">
              {dialog.scope === 'tenant'
                ? 'Tenant key — shared with all members'
                : 'Personal key — used across all your workspaces'}
            </Badge>

            {dialog.provider.docsUrl && (
              <Text size="xs" variant="muted">
                <a
                  href={dialog.provider.docsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: 'var(--color-content-link)' }}
                >
                  Provider documentation
                </a>
              </Text>
            )}

            {/* Secret fields */}
            {dialog.provider.fields
              .filter((f) => f.type === 'secret')
              .map((field) => (
                <Field key={field.fieldId}>
                  <Label>
                    {field.label}
                    {field.required && <span style={{ color: 'var(--color-danger)' }}> *</span>}
                  </Label>
                  <Input
                    type="password"
                    placeholder={
                      dialog.existingCredential
                        ? 'Enter new value to replace'
                        : (field.placeholder ?? '')
                    }
                    value={formSecrets[field.fieldId] ?? ''}
                    onChange={(e) => {
                      setFormSecrets((prev) => ({
                        ...prev,
                        [field.fieldId]: (e.target as HTMLInputElement).value,
                      }));
                    }}
                  />
                  {field.helpText && (
                    <Text size="xs" variant="muted">
                      {field.helpText}
                    </Text>
                  )}
                </Field>
              ))}

            {/* Config fields */}
            {dialog.provider.fields
              .filter((f) => f.type !== 'secret')
              .map((field) => (
                <Field key={field.fieldId}>
                  <Label>
                    {field.label}
                    {field.required && <span style={{ color: 'var(--color-danger)' }}> *</span>}
                  </Label>
                  <Input
                    type={field.type === 'number' ? 'number' : 'text'}
                    placeholder={field.placeholder ?? ''}
                    value={formConfig[field.fieldId] ?? ''}
                    onChange={(e) => {
                      setFormConfig((prev) => ({
                        ...prev,
                        [field.fieldId]: (e.target as HTMLInputElement).value,
                      }));
                    }}
                  />
                  {field.helpText && (
                    <Text size="xs" variant="muted">
                      {field.helpText}
                    </Text>
                  )}
                </Field>
              ))}

            {/* Label */}
            <Field>
              <Label>Label (optional)</Label>
              <Input
                placeholder="e.g. Company shared key"
                value={formLabel}
                onChange={(e) => {
                  setFormLabel((e.target as HTMLInputElement).value);
                }}
              />
            </Field>

            <Text size="xs" variant="muted">
              Secret values are encrypted at rest and never shown again after saving.
            </Text>
          </Column>
        )}
      </Dialog>
    </>
  );
}
