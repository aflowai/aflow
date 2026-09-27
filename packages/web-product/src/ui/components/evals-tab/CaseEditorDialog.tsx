'use client';

/**
 * Create / edit / ratify a golden case via `<SchemaForm>` over the
 * GoldenCaseContent JSON Schema — derived from the Zod contract, never a
 * hand-maintained field list. Ratifying a draft IS the update path (the
 * operator reviews the promoted content, then the same PUT turns it
 * active). Server 422s return structured GoldenCaseDiagnostics; they render
 * inline so the schema teaches instead of a bare failure.
 */
import { useMemo, useState } from 'react';
import { Button, Column, Dialog, SchemaForm, Text } from '@aflow/design-system';
import { GoldenCaseContentSchema, toJsonSchemaSync } from '@aflow/schemas';
import type { GoldenCaseContent, GoldenCaseDiagnostic } from '@aflow/schemas';

import { useApiMutation } from '../../hooks/useApiQuery.js';
import type { ApiError } from '../../lib/query-client.js';
import { evalsKeys } from './evalsApi.js';

export type CaseEditorMode = 'create' | 'edit' | 'ratify';

interface CaseWriteResponse {
  ok: true;
  datasetVersion: number;
  advisories: GoldenCaseDiagnostic[];
}

function extractDiagnostics(error: ApiError): GoldenCaseDiagnostic[] {
  const body = error.body as { diagnostics?: GoldenCaseDiagnostic[] } | undefined;
  return Array.isArray(body?.diagnostics) ? body.diagnostics : [];
}

export function CaseEditorDialog({
  open,
  onClose,
  spaceId,
  workflowSlug,
  mode,
  caseId,
  initialContent,
  expectedDatasetVersion,
}: {
  open: boolean;
  onClose: () => void;
  spaceId: string;
  workflowSlug: string;
  mode: CaseEditorMode;
  /** Required for edit/ratify — the case the PUT targets. */
  caseId?: string | undefined;
  initialContent?: GoldenCaseContent | undefined;
  expectedDatasetVersion?: number | undefined;
}) {
  const jsonSchema = useMemo(
    () => toJsonSchemaSync(GoldenCaseContentSchema) as unknown as Record<string, unknown>,
    [],
  );
  const [value, setValue] = useState<unknown>(initialContent ?? undefined);
  const [valid, setValid] = useState(false);
  const [diagnostics, setDiagnostics] = useState<GoldenCaseDiagnostic[]>([]);
  const [errorText, setErrorText] = useState<string | null>(null);

  const mutation = useApiMutation<
    { case: unknown; expectedDatasetVersion?: number },
    CaseWriteResponse
  >({
    path:
      mode === 'create'
        ? `/spaces/${spaceId}/workflows/${workflowSlug}/golden-cases`
        : `/spaces/${spaceId}/workflows/${workflowSlug}/golden-cases/${caseId ?? ''}`,
    method: mode === 'create' ? 'POST' : 'PUT',
    spaceId,
    invalidate: [evalsKeys.dataset(spaceId, workflowSlug)],
    onSuccess: () => {
      onClose();
    },
    onError: (error) => {
      setDiagnostics(extractDiagnostics(error));
      setErrorText(error.message);
    },
  });

  const submit = () => {
    setDiagnostics([]);
    setErrorText(null);
    mutation.mutate({
      case: value,
      ...(expectedDatasetVersion !== undefined ? { expectedDatasetVersion } : {}),
    });
  };

  const title =
    mode === 'create' ? 'Add golden case' : mode === 'ratify' ? 'Ratify draft case' : 'Edit case';
  const submitLabel =
    mode === 'create' ? 'Add case' : mode === 'ratify' ? 'Ratify into dataset' : 'Save case';

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      width="lg"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={submit}
            disabled={!valid || mutation.isPending}
          >
            {mutation.isPending ? 'Saving…' : submitLabel}
          </Button>
        </>
      }
    >
      <Column gap="md">
        <Text size="sm" color="muted">
          {mode === 'ratify'
            ? 'Review the promoted draft — expectations must describe CORRECT behavior, not the observed failure. Accepting it adds the case to every future run.'
            : 'A case is a replayable scenario with labeled expected behavior: stratum (scenario / direction / tier), trigger inputs, context fixture, and deterministic expectations.'}
        </Text>
        <SchemaForm
          schema={jsonSchema}
          value={value}
          onChange={setValue}
          onValidityChange={setValid}
          disabled={mutation.isPending}
        />
        {errorText !== null && (
          <Text size="sm" tone="danger">
            {errorText}
          </Text>
        )}
        {diagnostics.length > 0 && (
          <Column gap="xs">
            {diagnostics.map((diagnostic, index) => (
              <Column
                key={`${diagnostic.code}-${String(index)}`}
                gap="xs"
                style={{
                  padding: 'var(--space-2) var(--space-3)',
                  border: '1px solid var(--color-border-subtle)',
                  borderRadius: 'var(--radius-sm)',
                }}
              >
                <Text size="xs" tone={diagnostic.severity === 'error' ? 'danger' : 'warning'}>
                  {diagnostic.code} — {diagnostic.detail}
                </Text>
                {diagnostic.fixHint !== undefined && (
                  <Text size="xs" color="muted">
                    {diagnostic.fixHint}
                  </Text>
                )}
              </Column>
            ))}
          </Column>
        )}
      </Column>
    </Dialog>
  );
}
