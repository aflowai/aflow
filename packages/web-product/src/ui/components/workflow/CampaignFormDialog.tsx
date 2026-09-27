'use client';

/**
 * Start / update a campaign by filling its contract as a form. The contract is
 * the single source of truth for the fields — the JSON Schema the `<SchemaForm>`
 * renders is derived from it (never a hand-maintained field list). Update mode
 * shows only mutable fields; identity / `mutable:false` fields are immutable for
 * the life of a campaign and are dropped from the form.
 */
import { useMemo, useState } from 'react';
import { Button, Column, Dialog, SchemaForm, Text } from '@aflow/design-system';
import type { SkillCampaignContract } from '@aflow/schemas';
import { isCampaignFieldMutable } from '@aflow/schemas';

import { useApiMutation } from '../../hooks/useApiQuery.js';

/** Derive the JSON Schema the form renders directly from the contract. */
function contractToJsonSchema(
  contract: SkillCampaignContract,
  mutableOnly: boolean,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, field] of Object.entries(contract.fields)) {
    if (mutableOnly && !isCampaignFieldMutable(field)) continue;
    properties[key] = {
      ...field.schema,
      title: field.label,
      ...(field.description !== undefined ? { description: field.description } : {}),
    };
    required.push(key);
  }
  return { type: 'object', properties, required, additionalProperties: false };
}

/**
 * Keep only mutable-field entries of a config. The update form renders only
 * mutable fields, but SchemaForm spreads the whole seed object on edit (it
 * preserves keys it doesn't render), so identity values would otherwise ride
 * along in the PATCH and the backend rejects the whole update as IMMUTABLE.
 * Both the seed and the submit go through this, so the patch carries mutable
 * fields only.
 */
export function pickMutableConfig(
  contract: SkillCampaignContract,
  config: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    const field = contract.fields[key];
    if (field && isCampaignFieldMutable(field)) out[key] = value;
  }
  return out;
}

export function CampaignFormDialog({
  open,
  onClose,
  spaceId,
  workflowSlug,
  contract,
  mode,
  campaignId,
  initialConfig,
}: {
  open: boolean;
  onClose: () => void;
  spaceId: string;
  workflowSlug: string;
  contract: SkillCampaignContract;
  mode: 'start' | 'update';
  /** Required for `update`. */
  campaignId?: string;
  initialConfig?: Record<string, unknown>;
}) {
  const mutableOnly = mode === 'update';
  const schema = useMemo(
    () => contractToJsonSchema(contract, mutableOnly),
    [contract, mutableOnly],
  );
  // Update seeds (and submits) mutable fields only — identity values must never
  // ride along in the PATCH (the backend rejects any immutable field present).
  const [value, setValue] = useState<unknown>(() =>
    mutableOnly ? pickMutableConfig(contract, initialConfig ?? {}) : (initialConfig ?? {}),
  );
  const [valid, setValid] = useState(false);

  const mutation = useApiMutation<{ config: Record<string, unknown> }>({
    path:
      mode === 'start'
        ? `/spaces/${spaceId}/workflows/${workflowSlug}/campaigns`
        : `/spaces/${spaceId}/workflows/${workflowSlug}/campaigns/${campaignId ?? ''}`,
    method: mode === 'start' ? 'POST' : 'PATCH',
    spaceId,
    invalidate: [['space', spaceId, 'workflow', workflowSlug, 'campaigns']],
    onSuccess: () => {
      onClose();
    },
  });

  const submit = () => {
    const config = (value ?? {}) as Record<string, unknown>;
    mutation.mutate({ config: mutableOnly ? pickMutableConfig(contract, config) : config });
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={mode === 'start' ? 'Start campaign' : 'Update campaign'}
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
            {mutation.isPending ? 'Saving…' : mode === 'start' ? 'Start campaign' : 'Save changes'}
          </Button>
        </>
      }
    >
      <Column gap="md">
        <Text size="sm" color="muted">
          {mode === 'start'
            ? 'Set the campaign parameters. Identity fields fix the campaign — a different value is a different campaign.'
            : 'Only mutable fields can change mid-campaign. Identity fields are fixed for the life of the campaign.'}
        </Text>
        <SchemaForm schema={schema} value={value} onChange={setValue} onValidityChange={setValid} />
        {mutation.error && (
          <Text size="sm" tone="danger">
            {mutation.error.message}
          </Text>
        )}
      </Column>
    </Dialog>
  );
}
