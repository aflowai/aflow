'use client';

import { useCallback, useState } from 'react';
import {
  Card,
  CardHeader,
  CardBody,
  CardFooter,
  Badge,
  Text,
  Stack,
  Inline,
  Icon,
} from '@aflow/design-system';
import { useApi } from '../providers.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Scope disambiguates same-named criteria across goal/task/trajectory. */
type CriterionScope = 'goal' | 'trajectory' | { task: string };

interface JudgeLabelDrawerProps {
  spaceId: string;
  criterionId: string;
  criterionName: string;
  /** Eval suite path (required — server uses it to look up the eval result). */
  evalSuitePath: string;
  /** Which scope the criterion belongs to. */
  scope: CriterionScope;
  /** Pre-fill with a specific run ID. */
  runId?: string;
  onClose: () => void;
  onSaved: () => void;
}

type Label = 'pass' | 'fail';

const LABELS: Label[] = ['pass', 'fail'];

const LABEL_VARIANT: Record<Label, string> = {
  pass: 'succeeded',
  fail: 'failed',
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function JudgeLabelDrawer({
  spaceId,
  criterionId,
  criterionName,
  evalSuitePath,
  scope,
  runId: initialRunId,
  onClose,
  onSaved,
}: JudgeLabelDrawerProps) {
  const { apiUrl, headers } = useApi();
  const [selectedLabel, setSelectedLabel] = useState<Label | null>(null);
  const [runId, setRunId] = useState(initialRunId ?? '');
  const [critique, setCritique] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSave = selectedLabel != null && runId.length > 0 && critique.trim().length > 0;

  const handleSave = useCallback(async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);

    try {
      const body: Record<string, unknown> = {
        criterionId,
        runId,
        scope,
        verdict: selectedLabel,
        critique,
        evalSuitePath,
      };

      const res = await fetch(`${apiUrl}/spaces/${spaceId}/judge-calibration`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(body),
      });

      if (res.status === 404) {
        const data = (await res.json()) as { error?: string };
        setError(data.error ?? 'Eval result or criterion not found for this run.');
        return;
      }
      if (res.status === 409) {
        setError('A label already exists for this criterion + run combination.');
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);

      onSaved();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [
    canSave,
    criterionId,
    runId,
    scope,
    selectedLabel,
    evalSuitePath,
    critique,
    apiUrl,
    headers,
    spaceId,
    onSaved,
  ]);

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        right: 0,
        bottom: 0,
        width: '400px',
        zIndex: 'var(--z-modal)',
        background: 'var(--color-surface-0)',
        borderLeft: '1px solid var(--color-border-default)',
        boxShadow: '-4px 0 16px rgba(0,0,0,0.1)',
        overflow: 'auto',
      }}
    >
      <Card style={{ border: 'none', borderRadius: 0, minHeight: '100%' }}>
        <CardHeader>
          <Inline gap="2" align="center" style={{ justifyContent: 'space-between', width: '100%' }}>
            <Inline gap="2" align="center">
              <Icon name="flag" size="sm" />
              <Text size="sm" style={{ fontWeight: 'var(--font-weight-medium)' }}>
                Label: {criterionName}
              </Text>
            </Inline>
            <button
              type="button"
              onClick={onClose}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: 'var(--space-1)',
              }}
              aria-label="Close"
            >
              <Icon name="x" size="sm" />
            </button>
          </Inline>
        </CardHeader>

        <CardBody>
          <Stack gap="4">
            {/* Run ID input */}
            <Stack gap="1">
              <Text size="sm" variant="muted">
                Run ID
              </Text>
              <input
                type="text"
                value={runId}
                onChange={(e) => {
                  setRunId(e.target.value);
                }}
                placeholder="UUID of the run to label"
                disabled={!!initialRunId}
                style={{
                  padding: 'var(--space-2)',
                  borderRadius: 'var(--radius-sm)',
                  border: '1px solid var(--color-border-default)',
                  background: 'var(--color-surface-0)',
                  fontSize: 'var(--font-size-sm)',
                  width: '100%',
                }}
              />
            </Stack>

            {/* Human label picker */}
            <Stack gap="1">
              <Text size="sm" variant="muted">
                Your assessment
              </Text>
              <Inline gap="2">
                {LABELS.map((l) => (
                  <button
                    key={l}
                    type="button"
                    onClick={() => {
                      setSelectedLabel(l);
                    }}
                    style={{
                      padding: 'var(--space-2) var(--space-3)',
                      borderRadius: 'var(--radius-sm)',
                      border:
                        selectedLabel === l
                          ? '2px solid var(--color-primary-default)'
                          : '1px solid var(--color-border-default)',
                      background:
                        selectedLabel === l
                          ? 'var(--color-primary-subtle)'
                          : 'var(--color-surface-0)',
                      cursor: 'pointer',
                      fontSize: 'var(--font-size-sm)',
                    }}
                  >
                    <Badge variant={LABEL_VARIANT[l] as 'succeeded' | 'failed' | 'warning'}>
                      {l}
                    </Badge>
                  </button>
                ))}
              </Inline>
            </Stack>

            {/* Critique — the raw material for judge few-shots */}
            <Stack gap="1">
              <Text size="sm" variant="muted">
                Critique
              </Text>
              <textarea
                value={critique}
                onChange={(e) => {
                  setCritique(e.target.value);
                }}
                placeholder="Why you chose this verdict..."
                maxLength={2000}
                rows={3}
                style={{
                  padding: 'var(--space-2)',
                  borderRadius: 'var(--radius-sm)',
                  border: '1px solid var(--color-border-default)',
                  background: 'var(--color-surface-0)',
                  fontSize: 'var(--font-size-sm)',
                  width: '100%',
                  resize: 'vertical',
                }}
              />
            </Stack>

            {error && (
              <Text size="sm" style={{ color: 'var(--color-danger-default)' }}>
                {error}
              </Text>
            )}
          </Stack>
        </CardBody>

        <CardFooter>
          <Inline gap="2" style={{ justifyContent: 'flex-end', width: '100%' }}>
            <button
              type="button"
              onClick={onClose}
              style={{
                padding: 'var(--space-2) var(--space-3)',
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--color-border-default)',
                background: 'var(--color-surface-0)',
                cursor: 'pointer',
                fontSize: 'var(--font-size-sm)',
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={!canSave || saving}
              style={{
                padding: 'var(--space-2) var(--space-3)',
                borderRadius: 'var(--radius-sm)',
                border: 'none',
                background: canSave ? 'var(--color-primary-default)' : 'var(--color-surface-2)',
                color: canSave ? 'white' : 'var(--color-text-muted)',
                cursor: canSave ? 'pointer' : 'not-allowed',
                fontSize: 'var(--font-size-sm)',
              }}
            >
              {saving ? 'Saving...' : 'Save label'}
            </button>
          </Inline>
        </CardFooter>
      </Card>
    </div>
  );
}
