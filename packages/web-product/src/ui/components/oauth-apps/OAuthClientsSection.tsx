'use client';

import { useMemo, useState } from 'react';
import {
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
  Select,
} from '@aflow/design-system';
import { getAllOAuthIssuers, getOAuthIssuer, type OAuthClientMeta } from '@aflow/schemas';
import type { ApiError } from '../../lib/query-client.js';
import type { TenantOAuthClientCreateInput } from '../../hooks/use-tenant-oauth-clients.js';

// ---------------------------------------------------------------------------
// OAuth Apps registration + list (Plan 185 §11)
// ---------------------------------------------------------------------------
//
// Shared between the tenant ("OAuth Apps") tab and the space settings tab. The
// scope difference (tenant vs space) is owned by the route the mutations target,
// so this component is scope-agnostic — it just registers/lists/rotates/deletes.
//
// The client_secret is WRITE-ONLY: stored values are never returned, so a row
// only ever shows "Secret set" (via `hasSecret`) and offers a Rotate action.

const FREE_FORM_ISSUER = '__custom__';

function issuerLabel(client: OAuthClientMeta): string {
  return getOAuthIssuer(client.issuerKey)?.displayName ?? client.issuerKey;
}

interface RegisterFormState {
  issuerKey: string;
  customIssuerKey: string;
  clientId: string;
  clientSecret: string;
  label: string;
  authorizationServer: string;
  scopesText: string;
}

const EMPTY_FORM: RegisterFormState = {
  issuerKey: '',
  customIssuerKey: '',
  clientId: '',
  clientSecret: '',
  label: '',
  authorizationServer: '',
  scopesText: '',
};

export interface OAuthClientsSectionProps {
  title: string;
  description: string;
  clients: OAuthClientMeta[];
  /** Register a new client. Throws `ApiError` on failure. */
  onRegister: (input: TenantOAuthClientCreateInput) => Promise<unknown>;
  /** Rotate the stored secret for a client. */
  onRotateSecret: (input: { id: string; clientSecret: string }) => Promise<unknown>;
  /** Delete a client. */
  onDelete: (id: string) => Promise<unknown>;
}

export function OAuthClientsSection({
  title,
  description,
  clients,
  onRegister,
  onRotateSecret,
  onDelete,
}: OAuthClientsSectionProps) {
  const [registerOpen, setRegisterOpen] = useState(false);
  const [form, setForm] = useState<RegisterFormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [rotateTarget, setRotateTarget] = useState<OAuthClientMeta | null>(null);
  const [rotateSecret, setRotateSecretValue] = useState('');
  const [rotating, setRotating] = useState(false);
  const [rotateError, setRotateError] = useState<string | null>(null);

  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const issuers = useMemo(() => getAllOAuthIssuers(), []);
  const isCustomIssuer = form.issuerKey === FREE_FORM_ISSUER;

  const sortedClients = useMemo(
    () => [...clients].sort((a, b) => a.label.localeCompare(b.label)),
    [clients],
  );

  const openRegister = () => {
    setForm(EMPTY_FORM);
    setFormError(null);
    setRegisterOpen(true);
  };

  const closeRegister = () => {
    setRegisterOpen(false);
    setForm(EMPTY_FORM);
    setFormError(null);
  };

  const selectIssuer = (value: string) => {
    setForm((prev) => {
      const next: RegisterFormState = { ...prev, issuerKey: value };
      if (value !== FREE_FORM_ISSUER) {
        const issuer = getOAuthIssuer(value);
        if (issuer && !prev.label) next.label = issuer.displayName;
        if (issuer && !prev.scopesText) next.scopesText = issuer.defaultScopes.join(', ');
        next.customIssuerKey = '';
      }
      return next;
    });
  };

  const parseScopes = (text: string): string[] =>
    text
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);

  const handleRegister = async () => {
    const issuerKey = isCustomIssuer ? form.customIssuerKey.trim() : form.issuerKey;
    if (!issuerKey) {
      setFormError('Select an issuer or enter a custom issuer key.');
      return;
    }
    if (!form.clientId.trim()) {
      setFormError('Client ID is required.');
      return;
    }
    if (!form.label.trim()) {
      setFormError('Label is required.');
      return;
    }
    const scopes = parseScopes(form.scopesText);
    const input: TenantOAuthClientCreateInput = {
      issuerKey,
      clientId: form.clientId.trim(),
      label: form.label.trim(),
      ...(form.clientSecret ? { clientSecret: form.clientSecret } : {}),
      ...(form.authorizationServer.trim()
        ? { authorizationServer: form.authorizationServer.trim() }
        : {}),
      ...(scopes.length > 0 ? { defaultScopes: scopes } : {}),
    };

    setSaving(true);
    setFormError(null);
    try {
      await onRegister(input);
      closeRegister();
    } catch (err) {
      setFormError((err as ApiError)?.message ?? 'Failed to register OAuth app.');
    } finally {
      setSaving(false);
    }
  };

  const openRotate = (client: OAuthClientMeta) => {
    setRotateTarget(client);
    setRotateSecretValue('');
    setRotateError(null);
  };

  const closeRotate = () => {
    setRotateTarget(null);
    setRotateSecretValue('');
    setRotateError(null);
  };

  const handleRotate = async () => {
    if (!rotateTarget) return;
    if (!rotateSecret) {
      setRotateError('Enter a new client secret.');
      return;
    }
    setRotating(true);
    setRotateError(null);
    try {
      await onRotateSecret({ id: rotateTarget.id, clientSecret: rotateSecret });
      closeRotate();
    } catch (err) {
      setRotateError((err as ApiError)?.message ?? 'Failed to rotate secret.');
    } finally {
      setRotating(false);
    }
  };

  const handleDelete = async (id: string) => {
    setPendingDeleteId(id);
    setDeleteError(null);
    try {
      await onDelete(id);
    } catch (err) {
      setDeleteError((err as ApiError)?.message ?? 'Failed to delete OAuth app.');
    } finally {
      setPendingDeleteId(null);
    }
  };

  return (
    <>
      <Column gap="lg" style={{ maxWidth: 720 }}>
        <Row style={{ alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <Column gap="xs" style={{ flex: 1 }}>
            <Heading level={4}>{title}</Heading>
            <Text size="sm" variant="muted">
              {description}
            </Text>
          </Column>
          <Button variant="primary" size="sm" onClick={openRegister}>
            Register app
          </Button>
        </Row>

        {sortedClients.length === 0 ? (
          <Card>
            <CardBody>
              <Column gap="sm" style={{ alignItems: 'center', padding: 'var(--space-6)' }}>
                <Icon name="key" size="lg" style={{ color: 'var(--color-content-secondary)' }} />
                <Text size="sm" variant="muted" style={{ textAlign: 'center' }}>
                  No OAuth apps registered yet. Register your own OAuth application so connections
                  use its client credentials.
                </Text>
              </Column>
            </CardBody>
          </Card>
        ) : (
          <Card>
            <CardBody style={{ padding: 0 }}>
              {sortedClients.map((client, idx) => (
                <Row
                  key={client.id}
                  gap="md"
                  wrap
                  style={{
                    padding: 'var(--space-3) var(--space-4)',
                    alignItems: 'center',
                    borderTop: idx > 0 ? '1px solid var(--color-border-subtle)' : undefined,
                  }}
                >
                  <Icon
                    name="key"
                    size="md"
                    style={{ color: 'var(--color-content-secondary)', flexShrink: 0 }}
                  />
                  <Column gap="0" style={{ flex: 1, minWidth: 0 }}>
                    <Row gap="sm" style={{ alignItems: 'center' }}>
                      <Text size="sm" weight="medium">
                        {client.label}
                      </Text>
                      <Badge variant="info">{issuerLabel(client)}</Badge>
                    </Row>
                    <Text
                      size="xs"
                      variant="muted"
                      style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                    >
                      {client.clientId}
                    </Text>
                  </Column>
                  <Badge variant={client.hasSecret ? 'success' : 'neutral'}>
                    {client.hasSecret ? 'Secret set' : 'No secret'}
                  </Badge>
                  <Row gap="xs">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        openRotate(client);
                      }}
                    >
                      Rotate
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      loading={pendingDeleteId === client.id}
                      onClick={() => void handleDelete(client.id)}
                      style={{ color: 'var(--color-danger)' }}
                    >
                      Delete
                    </Button>
                  </Row>
                </Row>
              ))}
            </CardBody>
          </Card>
        )}

        {deleteError && (
          <Text size="sm" style={{ color: 'var(--color-danger)' }}>
            {deleteError}
          </Text>
        )}
      </Column>

      {/* ── Register dialog ──────────────────────────────────────────────── */}

      <Dialog
        open={registerOpen}
        onClose={closeRegister}
        title="Register OAuth app"
        width="lg"
        footer={
          <Row gap="sm">
            <Button variant="ghost" size="sm" onClick={closeRegister} disabled={saving}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={saving}
              onClick={() => void handleRegister()}
            >
              Register
            </Button>
          </Row>
        }
      >
        <Column gap="md">
          <Field>
            <Label required>Issuer</Label>
            <Select
              placeholder="Select an issuer"
              value={form.issuerKey}
              onChange={(e) => {
                selectIssuer((e.target as HTMLSelectElement).value);
              }}
            >
              {issuers.map((issuer) => (
                <option key={issuer.issuerKey} value={issuer.issuerKey}>
                  {issuer.displayName}
                </option>
              ))}
              <option value={FREE_FORM_ISSUER}>Other (custom)</option>
            </Select>
          </Field>

          {isCustomIssuer && (
            <>
              <Field>
                <Label required>Issuer key</Label>
                <Input
                  placeholder="e.g. my-provider"
                  value={form.customIssuerKey}
                  onChange={(e) => {
                    setForm((p) => ({
                      ...p,
                      customIssuerKey: (e.target as HTMLInputElement).value,
                    }));
                  }}
                />
              </Field>
              <Field>
                <Label>Authorization server URL</Label>
                <Input
                  placeholder="https://auth.example.com"
                  value={form.authorizationServer}
                  onChange={(e) => {
                    setForm((p) => ({
                      ...p,
                      authorizationServer: (e.target as HTMLInputElement).value,
                    }));
                  }}
                />
                <Text size="xs" variant="muted">
                  Required for issuers not in the curated registry.
                </Text>
              </Field>
            </>
          )}

          <Field>
            <Label required>Client ID</Label>
            <Input
              placeholder="OAuth application client ID"
              value={form.clientId}
              onChange={(e) => {
                setForm((p) => ({ ...p, clientId: (e.target as HTMLInputElement).value }));
              }}
            />
          </Field>

          <Field>
            <Label>Client secret</Label>
            <Input
              type="password"
              placeholder="OAuth application client secret"
              value={form.clientSecret}
              onChange={(e) => {
                setForm((p) => ({ ...p, clientSecret: (e.target as HTMLInputElement).value }));
              }}
            />
            <Text size="xs" variant="muted">
              Encrypted at rest and never shown again. Leave blank for a public client.
            </Text>
          </Field>

          <Field>
            <Label>Default scopes</Label>
            <Input
              placeholder="Comma- or space-separated"
              value={form.scopesText}
              onChange={(e) => {
                setForm((p) => ({ ...p, scopesText: (e.target as HTMLInputElement).value }));
              }}
            />
          </Field>

          <Field>
            <Label required>Label</Label>
            <Input
              placeholder="e.g. Acme Google Workspace app"
              value={form.label}
              onChange={(e) => {
                setForm((p) => ({ ...p, label: (e.target as HTMLInputElement).value }));
              }}
            />
          </Field>

          {formError && (
            <Text size="sm" style={{ color: 'var(--color-danger)' }}>
              {formError}
            </Text>
          )}
        </Column>
      </Dialog>

      {/* ── Rotate-secret dialog ─────────────────────────────────────────── */}

      <Dialog
        open={rotateTarget !== null}
        onClose={closeRotate}
        title={`Rotate secret — ${rotateTarget?.label ?? ''}`}
        width="md"
        footer={
          <Row gap="sm">
            <Button variant="ghost" size="sm" onClick={closeRotate} disabled={rotating}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={rotating}
              onClick={() => void handleRotate()}
            >
              Rotate
            </Button>
          </Row>
        }
      >
        <Column gap="md">
          <Field>
            <Label required>New client secret</Label>
            <Input
              type="password"
              placeholder="New OAuth application client secret"
              value={rotateSecret}
              onChange={(e) => {
                setRotateSecretValue((e.target as HTMLInputElement).value);
              }}
            />
            <Text size="xs" variant="muted">
              Replaces the stored secret. Tokens minted with the old secret may require re-consent.
            </Text>
          </Field>
          {rotateError && (
            <Text size="sm" style={{ color: 'var(--color-danger)' }}>
              {rotateError}
            </Text>
          )}
        </Column>
      </Dialog>
    </>
  );
}
