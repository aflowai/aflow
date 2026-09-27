'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  PageContainer,
  Column,
  Row,
  Table,
  Th,
  Td,
  Tr,
  Card,
  CardBody,
  Button,
  Badge,
  Text,
  Icon,
  Dialog,
  Field,
  Label,
  Input,
  Select,
} from '@aflow/design-system';
import { useApi } from '../components/providers.js';

// ============================================================================
// Types
// ============================================================================

interface ApiKey {
  id: string;
  prefix: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

// ============================================================================
// Page
// ============================================================================

export function TenantApiKeysPage() {
  const { apiUrl, headers } = useApi();

  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [createdKey, setCreatedKey] = useState<{ key: string; name: string } | null>(null);

  const fetchKeys = useCallback(async () => {
    setIsLoading(true);
    try {
      const response = await fetch(`${apiUrl}/api-keys`, { headers: headers() });
      if (!response.ok) return;
      const data = (await response.json()) as { keys: ApiKey[] };
      setKeys(data.keys);
    } catch {
      // Non-critical
    } finally {
      setIsLoading(false);
    }
  }, [apiUrl, headers]);

  useEffect(() => {
    void fetchKeys();
  }, [fetchKeys]);

  const handleRevoke = useCallback(
    async (keyId: string, keyName: string) => {
      const confirmed = window.confirm(`Revoke API key "${keyName}"? This cannot be undone.`);
      if (!confirmed) return;
      const response = await fetch(`${apiUrl}/api-keys/${keyId}`, {
        method: 'DELETE',
        headers: headers(),
      });
      if (!response.ok) {
        const err = (await response.json().catch(() => ({}))) as { message?: string };
        alert(err.message ?? 'Failed to revoke key');
        return;
      }
      void fetchKeys();
    },
    [apiUrl, headers, fetchKeys],
  );

  const activeKeys = keys.filter((k) => !k.revokedAt);
  const revokedKeys = keys.filter((k) => k.revokedAt);

  if (isLoading) {
    return (
      <PageContainer>
        <Row justify="center" style={{ padding: 'var(--space-8)' }}>
          <Text variant="muted" size="sm">
            Loading...
          </Text>
        </Row>
      </PageContainer>
    );
  }

  return (
    <>
      <PageContainer>
        <Column gap="lg">
          <Row justify="between" align="center">
            <Column gap="xs">
              <Text size="sm" variant="muted">
                API keys authenticate as you within this tenant. The full key is shown only once at
                creation.
              </Text>
            </Column>
            <Button
              variant="primary"
              size="sm"
              leftIcon={<Icon name="plus" size="sm" />}
              onClick={() => {
                setCreateDialogOpen(true);
              }}
            >
              Create API Key
            </Button>
          </Row>

          {activeKeys.length === 0 ? (
            <Card>
              <CardBody>
                <Column gap="md" style={{ alignItems: 'center', padding: 'var(--space-4)' }}>
                  <Icon name="key" size="lg" style={{ color: 'var(--color-content-tertiary)' }} />
                  <Text variant="muted" size="sm">
                    No API keys yet. Create one to authenticate via the API.
                  </Text>
                </Column>
              </CardBody>
            </Card>
          ) : (
            <Table>
              <thead>
                <Tr>
                  <Th>Name</Th>
                  <Th>Key</Th>
                  <Th>Created</Th>
                  <Th>Last Used</Th>
                  <Th>Expires</Th>
                  <Th style={{ width: 100 }}></Th>
                </Tr>
              </thead>
              <tbody>
                {activeKeys.map((k) => {
                  const isExpired = k.expiresAt && new Date(k.expiresAt) < new Date();
                  return (
                    <Tr key={k.id}>
                      <Td>
                        <Text size="sm" weight="medium">
                          {k.name}
                        </Text>
                      </Td>
                      <Td>
                        <Text
                          size="xs"
                          variant="muted"
                          style={{ fontFamily: 'var(--font-mono, monospace)' }}
                        >
                          {k.prefix}...
                        </Text>
                      </Td>
                      <Td>
                        <Text variant="muted" size="xs">
                          {new Date(k.createdAt).toLocaleDateString()}
                        </Text>
                      </Td>
                      <Td>
                        <Text variant="muted" size="xs">
                          {k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleDateString() : 'Never'}
                        </Text>
                      </Td>
                      <Td>
                        {k.expiresAt ? (
                          <Badge variant={isExpired ? 'danger' : 'neutral'}>
                            {isExpired ? 'Expired' : new Date(k.expiresAt).toLocaleDateString()}
                          </Badge>
                        ) : (
                          <Text variant="muted" size="xs">
                            Never
                          </Text>
                        )}
                      </Td>
                      <Td>
                        <Button
                          variant="danger"
                          size="sm"
                          onClick={() => {
                            void handleRevoke(k.id, k.name);
                          }}
                        >
                          Revoke
                        </Button>
                      </Td>
                    </Tr>
                  );
                })}
              </tbody>
            </Table>
          )}

          {revokedKeys.length > 0 && (
            <Column gap="sm">
              <Text size="sm" variant="muted" weight="medium">
                Revoked Keys
              </Text>
              <Table>
                <thead>
                  <Tr>
                    <Th>Name</Th>
                    <Th>Key</Th>
                    <Th>Created</Th>
                    <Th>Revoked</Th>
                  </Tr>
                </thead>
                <tbody>
                  {revokedKeys.map((k) => (
                    <Tr key={k.id} style={{ opacity: 0.5 }}>
                      <Td>
                        <Text size="sm">{k.name}</Text>
                      </Td>
                      <Td>
                        <Text
                          size="xs"
                          variant="muted"
                          style={{ fontFamily: 'var(--font-mono, monospace)' }}
                        >
                          {k.prefix}...
                        </Text>
                      </Td>
                      <Td>
                        <Text variant="muted" size="xs">
                          {new Date(k.createdAt).toLocaleDateString()}
                        </Text>
                      </Td>
                      <Td>
                        <Badge variant="danger">
                          {new Date(k.revokedAt!).toLocaleDateString()}
                        </Badge>
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </Column>
          )}
        </Column>
      </PageContainer>

      <CreateApiKeyDialog
        open={createDialogOpen}
        onClose={() => {
          setCreateDialogOpen(false);
        }}
        apiUrl={apiUrl}
        headers={headers}
        onCreated={(key, name) => {
          setCreateDialogOpen(false);
          setCreatedKey({ key, name });
          void fetchKeys();
        }}
      />

      <KeyRevealDialog
        keyData={createdKey}
        onClose={() => {
          setCreatedKey(null);
        }}
      />
    </>
  );
}

// ============================================================================
// Create API Key Dialog
// ============================================================================

function CreateApiKeyDialog({
  open,
  onClose,
  apiUrl,
  headers,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  apiUrl: string;
  headers: () => Record<string, string>;
  onCreated: (key: string, name: string) => void;
}) {
  const [name, setName] = useState('');
  const [expiresInDays, setExpiresInDays] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset form when dialog opens
  useEffect(() => {
    if (open) {
      setName('');
      setExpiresInDays('');
      setError(null);
    }
  }, [open]);

  const handleSubmit = useCallback(async () => {
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { name: name.trim() };
      if (expiresInDays) {
        body['expiresInDays'] = parseInt(expiresInDays, 10);
      }
      const response = await fetch(`${apiUrl}/api-keys`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const err = (await response.json().catch(() => ({}))) as { message?: string };
        throw new Error(err.message ?? 'Failed to create API key');
      }
      const data = (await response.json()) as { key: string; name: string };
      onCreated(data.key, data.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create API key');
    } finally {
      setSaving(false);
    }
  }, [name, expiresInDays, apiUrl, headers, onCreated]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Create API Key"
      footer={
        <Row gap="sm">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              void handleSubmit();
            }}
            loading={saving}
            disabled={!name.trim()}
          >
            Create
          </Button>
        </Row>
      }
    >
      <Column gap="md">
        {error && (
          <Text size="sm" style={{ color: 'var(--color-status-failed-fg)' }}>
            {error}
          </Text>
        )}
        <Field>
          <Label>
            Name <span style={{ color: 'var(--color-danger)' }}>*</span>
          </Label>
          <Input
            placeholder="e.g. CI/CD pipeline, Local development"
            value={name}
            onChange={(e) => {
              setName((e.target as HTMLInputElement).value);
            }}
          />
        </Field>
        <Field>
          <Label>Expiration</Label>
          <Select
            value={expiresInDays}
            onChange={(e) => {
              setExpiresInDays(e.target.value);
            }}
          >
            <option value="">No expiration</option>
            <option value="7">7 days</option>
            <option value="30">30 days</option>
            <option value="90">90 days</option>
            <option value="180">180 days</option>
            <option value="365">365 days</option>
          </Select>
        </Field>
        <Text size="xs" variant="muted">
          The key authenticates as you within this tenant. Keep it secret.
        </Text>
      </Column>
    </Dialog>
  );
}

// ============================================================================
// Key Reveal Dialog (shown once after creation)
// ============================================================================

function KeyRevealDialog({
  keyData,
  onClose,
}: {
  keyData: { key: string; name: string } | null;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    if (!keyData) return;
    try {
      await navigator.clipboard.writeText(keyData.key);
      setCopied(true);
      setTimeout(() => {
        setCopied(false);
      }, 2000);
    } catch {
      // Fallback: select the text
    }
  }, [keyData]);

  // Reset copied state when a new key appears
  useEffect(() => {
    setCopied(false);
  }, [keyData]);

  return (
    <Dialog
      open={keyData !== null}
      onClose={onClose}
      title="API Key Created"
      footer={
        <Row gap="sm">
          <Button variant="primary" size="sm" onClick={onClose}>
            Done
          </Button>
        </Row>
      }
    >
      {keyData && (
        <Column gap="md">
          <Text size="sm" style={{ color: 'var(--color-status-failed-fg)' }}>
            Copy this key now. You won't be able to see it again.
          </Text>
          <Column gap="xs">
            <Label>{keyData.name}</Label>
            <Row gap="sm" align="center" wrap>
              <Input
                readOnly
                value={keyData.key}
                style={{
                  fontFamily: 'var(--font-mono, monospace)',
                  fontSize: '13px',
                  flex: '1 1 200px',
                  minWidth: 0,
                }}
                onClick={(e) => {
                  (e.target as HTMLInputElement).select();
                }}
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  void handleCopy();
                }}
                leftIcon={<Icon name={copied ? 'check' : 'copy'} size="sm" />}
              >
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </Row>
          </Column>
          <Text size="xs" variant="muted">
            Use this key as a Bearer token:{' '}
            <code style={{ fontSize: '12px' }}>
              Authorization: Bearer {keyData.key.slice(0, 12)}...
            </code>
          </Text>
        </Column>
      )}
    </Dialog>
  );
}
