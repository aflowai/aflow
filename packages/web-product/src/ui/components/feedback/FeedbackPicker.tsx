'use client';

/**
 * FeedbackPicker — shared reason-code picker for user feedback (104e §4.5).
 *
 * Used by RunFeedbackPrompt, proposal reject flow, and skill detail page.
 * Renders the closed-set reason codes as selectable chips + optional note.
 */

import { useCallback, useState } from 'react';
import { Badge, Button, Card, CardBody, Column, Inline, Row, Text } from '@aflow/design-system';

import { useApi } from '../providers.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const REASONS = [
  { code: 'wrong_outcome', label: 'Wrong outcome' },
  { code: 'wrong_approach', label: 'Wrong approach' },
  { code: 'missing_context', label: 'Missing context' },
  { code: 'too_slow', label: 'Too slow' },
  { code: 'too_expensive', label: 'Too expensive' },
  { code: 'unclear_communication', label: 'Unclear' },
  { code: 'good_as_is', label: 'Good as is' },
  { code: 'other', label: 'Other' },
] as const;

type ReasonCode = (typeof REASONS)[number]['code'];

interface FeedbackPickerProps {
  spaceId: string;
  subjectKind: 'run' | 'proposal' | 'skill' | 'message';
  subjectId: string;
  onSubmitted?: () => void;
  onDismiss?: () => void;
  compact?: boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function FeedbackPicker({
  spaceId,
  subjectKind,
  subjectId,
  onSubmitted,
  onDismiss,
  compact,
}: FeedbackPickerProps) {
  const { apiUrl, headers } = useApi();
  const [selected, setSelected] = useState<ReasonCode | null>(null);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const canSubmit = selected !== null && (selected !== 'other' || note.trim().length > 0);

  const handleSubmit = useCallback(async () => {
    if (!canSubmit || !selected) return;
    setSaving(true);
    setError(null);

    try {
      const body: Record<string, unknown> = {
        subjectKind,
        subjectId,
        reasonCode: selected,
      };
      if (note.trim().length > 0) body['freeText'] = note.trim();

      const res = await fetch(`${apiUrl}/spaces/${spaceId}/user-feedback`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error ?? `HTTP ${String(res.status)}`);
      }
      setDone(true);
      onSubmitted?.();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [canSubmit, selected, subjectKind, subjectId, note, apiUrl, headers, spaceId, onSubmitted]);

  if (done) {
    return (
      <Inline gap="2" align="center">
        <Badge variant="success">Feedback recorded</Badge>
        {onDismiss && (
          <Button variant="ghost" size="sm" onClick={onDismiss}>
            Dismiss
          </Button>
        )}
      </Inline>
    );
  }

  return (
    <Card>
      <CardBody>
        <Column gap="sm">
          {!compact && (
            <Text size="sm" weight="semibold">
              How was this {subjectKind}?
            </Text>
          )}

          <Row gap="xs" wrap>
            {REASONS.map((r) => (
              <button
                key={r.code}
                type="button"
                onClick={() => {
                  setSelected(r.code);
                }}
                style={{
                  padding: 'var(--space-1) var(--space-2)',
                  borderRadius: 'var(--radius-sm)',
                  border:
                    selected === r.code
                      ? '2px solid var(--color-primary-default)'
                      : '1px solid var(--color-border-default)',
                  background:
                    selected === r.code ? 'var(--color-primary-subtle)' : 'var(--color-surface-0)',
                  cursor: 'pointer',
                  fontSize: 'var(--font-size-sm)',
                }}
              >
                {r.label}
              </button>
            ))}
          </Row>

          {selected && (
            <textarea
              value={note}
              onChange={(e) => {
                setNote(e.target.value);
              }}
              placeholder={
                selected === 'other' ? 'Please describe (required)...' : 'Optional note...'
              }
              maxLength={1000}
              rows={2}
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
          )}

          {error && (
            <Text size="sm" style={{ color: 'var(--color-danger-default)' }}>
              {error}
            </Text>
          )}

          <Row gap="sm">
            <Button
              variant="primary"
              size="sm"
              onClick={() => void handleSubmit()}
              disabled={!canSubmit || saving}
            >
              {saving ? 'Saving...' : 'Submit feedback'}
            </Button>
            {onDismiss && (
              <Button variant="ghost" size="sm" onClick={onDismiss}>
                Skip
              </Button>
            )}
          </Row>
        </Column>
      </CardBody>
    </Card>
  );
}
