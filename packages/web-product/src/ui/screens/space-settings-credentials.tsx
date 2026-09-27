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
import {
  useCredentials,
  type ProviderDefinition,
  type CredentialMeta,
} from '../hooks/use-credentials.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface DialogState {
  open: boolean;
  provider: ProviderDefinition | null;
  existingCredential: CredentialMeta | null;
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export function SpaceCredentialsPage() {
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

  const [dialog, setDialog] = useState<DialogState>({
    open: false,
    provider: null,
    existingCredential: null,
  });
  const [saving, setSaving] = useState(false);
  const [testingProvider, setTestingProvider] = useState<string | null>(null);
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

  // Find space-scope credential for a provider
  const getSpaceCredential = useCallback(
    (providerId: string): CredentialMeta | undefined => {
      return credentials.find((c) => c.providerId === providerId && c.scope === 'space');
    },
    [credentials],
  );

  // ── Dialog ─────────────────────────────────────────────────────────────

  const openDialog = useCallback(
    (provider: ProviderDefinition) => {
      const existing = getSpaceCredential(provider.providerId);
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
      setDialog({ open: true, provider, existingCredential: existing ?? null });
    },
    [getSpaceCredential],
  );

  const closeDialog = useCallback(() => {
    setDialog({ open: false, provider: null, existingCredential: null });
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
        'space', // Always space scope on this page
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
    async (providerId: string) => {
      await deleteCredential(providerId, 'space');
    },
    [deleteCredential],
  );

  const handleTest = useCallback(
    async (providerId: string) => {
      setTestingProvider(providerId);
      try {
        await validateCredential(providerId, 'space');
      } finally {
        setTestingProvider(null);
      }
    },
    [validateCredential],
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

      <Column gap="lg">
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
                    const spaceCred = getSpaceCredential(provider.providerId);
                    const hasSpaceKey = Boolean(spaceCred);
                    const hasError = spaceCred?.status === 'error';

                    return (
                      <Row
                        key={provider.providerId}
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
                            style={{
                              whiteSpace: 'nowrap',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                            }}
                          >
                            {provider.description}
                          </Text>
                        </Column>
                        {hasSpaceKey ? (
                          <Badge variant={hasError ? 'warning' : 'success'}>
                            {hasError
                              ? `Error (${spaceCred?.lastErrorCode ?? 'auth'})`
                              : 'Configured'}
                          </Badge>
                        ) : statuses.get(provider.providerId)?.resolved ? (
                          <Badge variant="info">
                            {statuses.get(provider.providerId)?.resolvedScope === 'tenant'
                              ? 'Covered by tenant key'
                              : 'Covered by your key'}
                          </Badge>
                        ) : (
                          <Badge variant="neutral">Not set</Badge>
                        )}
                        <Row gap="xs">
                          {hasSpaceKey ? (
                            <>
                              {provider.category === 'llm' && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => void handleTest(provider.providerId)}
                                  loading={testingProvider === provider.providerId}
                                >
                                  Test
                                </Button>
                              )}
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => {
                                  openDialog(provider);
                                }}
                              >
                                Update
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => void handleDelete(provider.providerId)}
                                style={{ color: 'var(--color-danger)' }}
                              >
                                Remove
                              </Button>
                            </>
                          ) : (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                openDialog(provider);
                              }}
                            >
                              Add key
                            </Button>
                          )}
                        </Row>
                      </Row>
                    );
                  })}
                </CardBody>
              </Card>
            </Column>
          );
        })}
      </Column>

      {/* ── Credential Dialog ────────────────────────────────────────────── */}

      <Dialog
        open={dialog.open}
        onClose={closeDialog}
        title={
          dialog.existingCredential
            ? `Update Space ${dialog.provider?.displayName ?? ''} Key`
            : `Add Space ${dialog.provider?.displayName ?? ''} Key`
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
                placeholder="e.g. Team shared key"
                value={formLabel}
                onChange={(e) => {
                  setFormLabel((e.target as HTMLInputElement).value);
                }}
              />
            </Field>

            <Text size="xs" variant="muted">
              This key will be shared with all members of this space who don't have their own
              personal key. Secret values are encrypted and never shown again.
            </Text>
          </Column>
        )}
      </Dialog>
    </PageContainer>
  );
}
