'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Checkbox,
  Column,
  Dialog,
  Field,
  Input,
  Label,
  Row,
  Text,
} from '@aflow/design-system';
import { useApi } from '../providers.js';
import { useApiQuery } from '../../hooks/useApiQuery.js';
import { llmReadinessQueryKey } from '../../hooks/useSpaceLlmReadiness.js';

interface ProviderDef {
  providerId: string;
  displayName: string;
  docsUrl?: string;
  description?: string;
  fields: Array<{
    fieldId: string;
    type: string;
    required?: boolean;
    defaultValue?: string;
    placeholder?: string;
    helpText?: string;
  }>;
}

export interface ConnectProviderDialogProps {
  open: boolean;
  providerId: string | null;
  /** Readiness queries for this space are invalidated after a successful save. */
  spaceId: string;
  onClose: () => void;
  onConnected?: (providerId: string) => void;
}

/**
 * Minimal user-scope key entry with live verification — the standing
 * counterpart of the onboarding connect step, reachable from readiness
 * banners and needs-key pills.
 */
export function ConnectProviderDialog({
  open,
  providerId,
  spaceId,
  onClose,
  onConnected,
}: ConnectProviderDialogProps) {
  const { headers, authFetch } = useApi();
  const queryClient = useQueryClient();
  const [key, setKey] = useState('');
  const [spaceOnly, setSpaceOnly] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const providersQuery = useApiQuery<{ providers: ProviderDef[] }>({
    key: ['catalog', 'credential-providers'],
    path: '/credentials/providers',
    staleTime: 300_000,
    enabled: open,
  });
  const def = providersQuery.data?.providers.find((p) => p.providerId === providerId);
  const keyField = def?.fields.find((f) => f.fieldId === 'api_key');
  // A provider that needs no secret — a runtime on this computer — connects
  // with its registry defaults, so the operator has nothing to type.
  const needsKey = def?.fields.some((f) => f.type === 'secret' && f.required === true) ?? true;
  const defaults = Object.fromEntries(
    (def?.fields ?? [])
      .filter((f) => f.type !== 'secret' && f.defaultValue !== undefined)
      .map((f) => [f.fieldId, f.defaultValue!]),
  );

  const close = () => {
    setKey('');
    setSpaceOnly(false);
    setError(null);
    setSaving(false);
    onClose();
  };

  const save = async () => {
    if (!providerId || (needsKey && !key.trim())) return;
    setSaving(true);
    setError(null);
    const scope = spaceOnly ? 'space' : 'user';
    const scopedHeaders = spaceOnly ? { ...headers(), 'X-Space-ID': spaceId } : headers();
    try {
      const putRes = await authFetch(`/api/credentials/${providerId}`, {
        method: 'PUT',
        headers: scopedHeaders,
        body: JSON.stringify(
          needsKey
            ? { scope, secrets: { api_key: key.trim() } }
            : { scope, secrets: {}, config: defaults },
        ),
      });
      if (!putRes.ok) {
        const body = (await putRes.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? 'Could not save the key.');
        setSaving(false);
        return;
      }
      const valRes = await authFetch(`/api/credentials/${providerId}/validate`, {
        method: 'POST',
        headers: scopedHeaders,
        body: JSON.stringify({ scope }),
      });
      const outcome = (await valRes.json().catch(() => null)) as {
        verified?: boolean;
        message?: string | null;
      } | null;
      if (!valRes.ok || !outcome?.verified) {
        setError(
          outcome?.message ?? 'The key was saved but could not be verified — check it and retry.',
        );
        setSaving(false);
        return;
      }
      await queryClient.invalidateQueries({ queryKey: llmReadinessQueryKey(spaceId) });
      onConnected?.(providerId);
      close();
    } catch {
      setError('Network error — please try again.');
      setSaving(false);
    }
  };

  if (!open || !providerId) return null;

  return (
    <Dialog
      open={open}
      onClose={close}
      title={`Connect ${def?.displayName ?? providerId}`}
      width="md"
      footer={
        <Row gap="sm">
          <Button variant="ghost" size="sm" onClick={close} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            loading={saving}
            disabled={needsKey && !key.trim()}
            onClick={() => {
              void save();
            }}
          >
            {needsKey ? 'Save & test' : 'Connect & test'}
          </Button>
        </Row>
      }
    >
      <Column gap="md">
        {needsKey ? (
          <Badge variant="info">
            {spaceOnly
              ? 'Workspace key — only used by this workspace'
              : 'Personal key — used across all your workspaces'}
          </Badge>
        ) : (
          <Text size="sm">
            {def?.description}
            {defaults['base_url'] ? ` It is reached at ${defaults['base_url']}.` : ''}
          </Text>
        )}
        {def?.docsUrl && (
          <Text size="xs" variant="muted">
            <a
              href={def.docsUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: 'var(--color-content-link)' }}
            >
              Where do I get this key?
            </a>
          </Text>
        )}
        {needsKey && (
          <Field>
            <Label>API key</Label>
            <Input
              type="password"
              placeholder={keyField?.placeholder ?? ''}
              value={key}
              onChange={(e) => {
                setKey((e.target as HTMLInputElement).value);
              }}
            />
            {keyField?.helpText && (
              <Text size="xs" variant="muted">
                {keyField.helpText}
              </Text>
            )}
          </Field>
        )}
        {error && (
          <Text size="sm" role="alert" style={{ color: 'var(--color-status-failed)' }}>
            {error}
          </Text>
        )}
        <Checkbox
          size="sm"
          checked={spaceOnly}
          onChange={(e) => {
            setSpaceOnly(e.target.checked);
          }}
        >
          <span style={{ color: 'var(--color-text-muted)' }}>Store for this workspace only</span>
        </Checkbox>
        <Text size="xs" variant="muted">
          {needsKey
            ? 'Stored encrypted. Model usage is billed to your provider account.'
            : 'Change the address, context window or parallelism under Settings → Credentials.'}
        </Text>
      </Column>
    </Dialog>
  );
}
