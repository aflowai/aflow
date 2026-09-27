'use client';

import { useEffect, useState } from 'react';
import {
  Column,
  Row,
  Card,
  CardBody,
  Text,
  Heading,
  Button,
  Field,
  Label,
  Select,
  Checkbox,
} from '@aflow/design-system';
import type { TenantOAuthPolicy, TenantOAuthPolicyUpdateInput } from '@aflow/schemas';
import type { ApiError } from '../../lib/query-client.js';

// ---------------------------------------------------------------------------
// Per-tenant OAuth default policy editor (Plan 185 §4.5, §11)
// ---------------------------------------------------------------------------
//
// Edits the defaults stamped on new OAuth bindings: which identity owns the
// tokens (ownerScope), which app drives the flow (clientScope), and whether
// end-users may self-connect their own accounts.

const OWNER_SCOPE_OPTIONS: Array<{ value: TenantOAuthPolicy['defaultOwnerScope']; label: string }> =
  [
    { value: 'user', label: 'User — each member connects their own account' },
    { value: 'space', label: 'Space — one shared connection per space' },
  ];

const CLIENT_SCOPE_OPTIONS: Array<{
  value: TenantOAuthPolicy['defaultClientScope'];
  label: string;
}> = [
  { value: 'platform', label: 'Platform — use the built-in OAuth app' },
  { value: 'tenant', label: 'Tenant — use a tenant-registered OAuth app' },
  { value: 'space', label: 'Space — use a space-registered OAuth app' },
];

export interface TenantOAuthPolicyEditorProps {
  policy: TenantOAuthPolicy;
  onSave: (input: TenantOAuthPolicyUpdateInput) => Promise<unknown>;
}

export function TenantOAuthPolicyEditor({ policy, onSave }: TenantOAuthPolicyEditorProps) {
  const [draft, setDraft] = useState<TenantOAuthPolicy>(policy);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(policy);
  }, [policy]);

  const dirty =
    draft.defaultOwnerScope !== policy.defaultOwnerScope ||
    draft.defaultClientScope !== policy.defaultClientScope ||
    draft.allowUserSelfConnect !== policy.allowUserSelfConnect;

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave({
        defaultOwnerScope: draft.defaultOwnerScope,
        defaultClientScope: draft.defaultClientScope,
        allowUserSelfConnect: draft.allowUserSelfConnect,
      });
    } catch (err) {
      setError((err as ApiError)?.message ?? 'Failed to save policy.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Column gap="lg" style={{ maxWidth: 720 }}>
      <Column gap="xs">
        <Heading level={4}>Default policy</Heading>
        <Text size="sm" variant="muted">
          Defaults applied to new OAuth bindings. Individual bindings can override these.
        </Text>
      </Column>

      <Card>
        <CardBody>
          <Column gap="lg">
            <Field>
              <Label>Default identity ownership</Label>
              <Select
                value={draft.defaultOwnerScope}
                onChange={(e) => {
                  setDraft((p) => ({
                    ...p,
                    defaultOwnerScope: (e.target as HTMLSelectElement)
                      .value as TenantOAuthPolicy['defaultOwnerScope'],
                  }));
                }}
              >
                {OWNER_SCOPE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </Select>
            </Field>

            <Field>
              <Label>Default OAuth app</Label>
              <Select
                value={draft.defaultClientScope}
                onChange={(e) => {
                  setDraft((p) => ({
                    ...p,
                    defaultClientScope: (e.target as HTMLSelectElement)
                      .value as TenantOAuthPolicy['defaultClientScope'],
                  }));
                }}
              >
                {CLIENT_SCOPE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </Select>
            </Field>

            <Checkbox
              checked={draft.allowUserSelfConnect}
              onChange={(e) => {
                setDraft((p) => ({ ...p, allowUserSelfConnect: e.target.checked }));
              }}
            >
              Allow members to self-connect their own accounts
            </Checkbox>

            {error && (
              <Text size="sm" style={{ color: 'var(--color-danger)' }}>
                {error}
              </Text>
            )}

            <Row>
              <Button
                variant="primary"
                size="sm"
                loading={saving}
                disabled={!dirty}
                onClick={() => void handleSave()}
              >
                Save policy
              </Button>
            </Row>
          </Column>
        </CardBody>
      </Card>
    </Column>
  );
}
