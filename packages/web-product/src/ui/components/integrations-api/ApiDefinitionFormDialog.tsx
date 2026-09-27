'use client';

import { useCallback, useMemo, useState } from 'react';
import { slugify } from '@aflow/schemas';
import {
  Button,
  Column,
  Dialog,
  Divider,
  Field,
  Input,
  Label,
  Row,
  Text,
  Textarea,
} from '@aflow/design-system';
import type { ApiDefinitionDetail } from '../../hooks/use-integrations.js';
import { IntegrationWriteErrorNotice } from '../integrations/IntegrationWriteErrorNotice.js';

const ENDPOINTS_TEMPLATE =
  '[\n  {\n    "endpointId": "example",\n    "name": "Example Endpoint",\n    "method": "GET",\n    "pathTemplate": "/example",\n    "params": [],\n    "tags": []\n  }\n]';

/**
 * Definition form — used to both create new API integrations and edit
 * existing ones. When `initialDefinition` is provided, the form
 * prefills + locks `apiId` (it's the primary key the server upserts on)
 * and the submit button reads "Save changes". The underlying POST
 * `/integrations/definitions` route is already an upsert
 * (`ON CONFLICT (api_id, space_id) DO UPDATE`), so edit and create share
 * the same backing call.
 */
export function ApiDefinitionFormDialog({
  initialDefinition,
  onSave,
  onClose,
}: {
  initialDefinition?: ApiDefinitionDetail;
  onSave: (body: {
    apiId: string;
    name: string;
    description?: string;
    baseUrl?: string;
    baseUrlTemplate?: string;
    variables?: Array<{ name: string; description: string; example?: string; required?: boolean }>;
    version?: string;
    endpoints: Array<Record<string, unknown>>;
    tags?: string[];
  }) => Promise<void>;
  onClose: () => void;
}) {
  const isEdit = initialDefinition != null;
  const [name, setName] = useState(initialDefinition?.name ?? '');
  // The id is the primary key and must be a normalized slug so it matches what
  // bind-capability and the rest of the system derive from the same name —
  // otherwise a free-text id (e.g. "GitHub API") forks into a duplicate. In
  // create mode it is derived from the name; in edit mode it is the locked key.
  const apiId = isEdit ? (initialDefinition?.apiId ?? '') : slugify(name);
  const [description, setDescription] = useState(initialDefinition?.description ?? '');
  const [baseUrl, setBaseUrl] = useState(
    initialDefinition?.baseUrlTemplate ?? initialDefinition?.baseUrl ?? '',
  );
  // Placeholders typed into the Base URL (e.g. {domain}) make it a template; each
  // becomes a value the user fills when connecting.
  const placeholders = useMemo(() => {
    const seen = new Set<string>();
    for (const m of baseUrl.matchAll(/\{([^}]+)\}/g)) if (m[1]) seen.add(m[1]);
    return [...seen];
  }, [baseUrl]);
  const [variableMeta, setVariableMeta] = useState<
    Record<string, { description: string; example: string }>
  >(() =>
    Object.fromEntries(
      (initialDefinition?.variables ?? []).map((v) => [
        v.name,
        { description: v.description ?? '', example: v.example ?? '' },
      ]),
    ),
  );
  const [version, setVersion] = useState(initialDefinition?.version ?? '1');
  const [tags, setTags] = useState((initialDefinition?.tags ?? []).join(', '));
  const [endpointsJson, setEndpointsJson] = useState(
    initialDefinition ? JSON.stringify(initialDefinition.endpoints, null, 2) : ENDPOINTS_TEMPLATE,
  );
  const [saving, setSaving] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<unknown>(null);

  const handleSave = useCallback(async () => {
    if (!apiId.trim() || !name.trim() || !baseUrl.trim()) return;
    let endpoints: Array<Record<string, unknown>>;
    try {
      endpoints = JSON.parse(endpointsJson) as Array<Record<string, unknown>>;
      if (!Array.isArray(endpoints) || endpoints.length === 0) {
        setParseError('Endpoints must be a non-empty JSON array');
        return;
      }
    } catch {
      setParseError('Invalid JSON for endpoints');
      return;
    }
    setParseError(null);
    setSaveError(null);
    setSaving(true);
    try {
      const tagList = tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      const isTemplate = placeholders.length > 0;
      await onSave({
        apiId: apiId.trim(),
        name: name.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(isTemplate
          ? {
              baseUrlTemplate: baseUrl.trim(),
              variables: placeholders.map((ph) => {
                const meta = variableMeta[ph];
                const example = meta?.example?.trim();
                return {
                  name: ph,
                  description: meta?.description?.trim() ?? '',
                  ...(example ? { example } : {}),
                  required: true,
                };
              }),
            }
          : { baseUrl: baseUrl.trim() }),
        ...(version.trim() ? { version: version.trim() } : {}),
        endpoints,
        ...(tagList.length > 0 ? { tags: tagList } : {}),
      });
    } catch (err) {
      setSaveError(err);
    } finally {
      setSaving(false);
    }
  }, [
    apiId,
    name,
    description,
    baseUrl,
    placeholders,
    variableMeta,
    version,
    tags,
    endpointsJson,
    onSave,
  ]);

  return (
    <Dialog open onClose={onClose} title={isEdit ? 'Edit API integration' : 'Add API'}>
      <Column
        gap="3"
        style={{
          padding: 'var(--space-4)',
          maxWidth: 560,
          width: '100%',
          backdropFilter: 'blur(10px)',
        }}
      >
        <Text size="sm" color="secondary">
          {isEdit
            ? 'Update this API integration. Endpoint changes take effect immediately for all connections.'
            : 'Define an external API your agents can call. You can also let an agent create this via '}
          {!isEdit && <code>platform.api.upsert_definition</code>}
          {!isEdit && '.'}
        </Text>

        <Row gap="3">
          <div style={{ flex: 1 }}>
            <Field>
              <Label>API ID</Label>
              <Input value={apiId} placeholder="auto-generated from the name" disabled readOnly />
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
                placeholder="e.g. GitHub API"
              />
            </Field>
          </div>
        </Row>

        <Field>
          <Label>Base URL</Label>
          <Input
            value={baseUrl}
            onChange={(e) => {
              setBaseUrl(e.target.value);
            }}
            placeholder="https://api.example.com"
          />
          <Text size="xs" color="secondary" style={{ marginTop: 'var(--space-1)' }}>
            Use {'{name}'} for a per-connection part (e.g. https://{'{domain}'}.atlassian.net). Each
            placeholder becomes a value filled when connecting.
          </Text>
        </Field>

        {placeholders.length > 0 && (
          <Column gap="2">
            <Label>Template variables</Label>
            {placeholders.map((ph) => (
              <Field key={ph}>
                <Label>{`{${ph}}`}</Label>
                <Input
                  value={variableMeta[ph]?.description ?? ''}
                  onChange={(e) => {
                    const v = e.target.value;
                    setVariableMeta((prev) => ({
                      ...prev,
                      [ph]: { description: v, example: prev[ph]?.example ?? '' },
                    }));
                  }}
                  placeholder="Description — what to fill (e.g. your Atlassian subdomain)"
                />
                <Input
                  value={variableMeta[ph]?.example ?? ''}
                  onChange={(e) => {
                    const v = e.target.value;
                    setVariableMeta((prev) => ({
                      ...prev,
                      [ph]: { description: prev[ph]?.description ?? '', example: v },
                    }));
                  }}
                  placeholder="Example value (e.g. acme)"
                  style={{ marginTop: 'var(--space-1)' }}
                />
              </Field>
            ))}
          </Column>
        )}

        <Row gap="3">
          <div style={{ flex: 1 }}>
            <Field>
              <Label>Version</Label>
              <Input
                value={version}
                onChange={(e) => {
                  setVersion(e.target.value);
                }}
                placeholder="1"
              />
            </Field>
          </div>
          <div style={{ flex: 1 }}>
            <Field>
              <Label>Tags (comma-separated)</Label>
              <Input
                value={tags}
                onChange={(e) => {
                  setTags(e.target.value);
                }}
                placeholder="rest, github"
              />
            </Field>
          </div>
        </Row>

        <Field>
          <Label>Description</Label>
          <Input
            value={description}
            onChange={(e) => {
              setDescription(e.target.value);
            }}
            placeholder="Optional description"
          />
        </Field>

        <Field>
          <Label>Endpoints (JSON array)</Label>
          <Textarea
            value={endpointsJson}
            onChange={(e) => {
              setEndpointsJson(e.target.value);
            }}
            rows={8}
          />
          {parseError && (
            <Text size="xs" tone="danger" style={{ marginTop: 'var(--space-1)' }}>
              {parseError}
            </Text>
          )}
        </Field>

        {saveError != null && <IntegrationWriteErrorNotice error={saveError} kind="api" />}

        <Divider />

        <Row justify="end" gap="2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => void handleSave()}
            disabled={!apiId.trim() || !name.trim() || !baseUrl.trim() || saving}
          >
            {saving ? 'Saving...' : isEdit ? 'Save changes' : 'Add API'}
          </Button>
        </Row>
      </Column>
    </Dialog>
  );
}
