'use client';

import { useState } from 'react';
import {
  Badge,
  Button,
  Card,
  CardBody,
  Column,
  Heading,
  Row,
  Spinner,
  Text,
} from '@aflow/design-system';

import { useApiQuery } from '../hooks/useApiQuery.js';
import { FeedbackPicker } from './feedback/FeedbackPicker.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FeedbackEntry {
  feedbackId: string;
  subjectKind: string;
  subjectId: string;
  reasonCode: string;
  freeText: string | null;
  createdByUserId: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface SkillFeedbackTabProps {
  spaceId: string;
  skillSlug: string;
}

export function SkillFeedbackTab({ spaceId, skillSlug }: SkillFeedbackTabProps) {
  const [pickerKey, setPickerKey] = useState(0);

  const q = useApiQuery<{ feedback: FeedbackEntry[]; reasonCounts: Record<string, number> }>({
    key: ['space', spaceId, 'skill', skillSlug, 'user-feedback'],
    path: `/spaces/${spaceId}/skills/${encodeURIComponent(skillSlug)}/user-feedback`,
    spaceId,
    staleTime: 30_000,
  });
  const entries = q.data?.feedback ?? [];
  const reasonCounts = q.data?.reasonCounts ?? {};
  const loading = q.isLoading;
  const error = q.error?.message ?? null;
  const reload = () => void q.refetch();

  if (loading && entries.length === 0) {
    return (
      <Row justify="center" style={{ padding: 'var(--space-6)' }}>
        <Spinner size="md" label="Loading feedback" />
      </Row>
    );
  }

  return (
    <div style={{ padding: 'var(--space-5)' }}>
      <Column gap="md">
        {/* Submit new feedback */}
        <FeedbackPicker
          key={pickerKey}
          spaceId={spaceId}
          subjectKind="skill"
          subjectId={skillSlug}
          onSubmitted={() => {
            reload();
            setPickerKey((k) => k + 1);
          }}
          onDismiss={() => {
            setPickerKey((k) => k + 1);
          }}
        />

        {/* Reason code summary */}
        {Object.keys(reasonCounts).length > 0 && (
          <Card>
            <CardBody>
              <Column gap="sm">
                <Heading level={5}>Feedback summary</Heading>
                <Row gap="sm" wrap>
                  {Object.entries(reasonCounts)
                    .sort((a, b) => b[1] - a[1])
                    .map(([reason, count]) => (
                      <Badge key={reason} variant="neutral">
                        {reason}: {String(count)}
                      </Badge>
                    ))}
                </Row>
              </Column>
            </CardBody>
          </Card>
        )}

        {/* History */}
        <Card>
          <CardBody>
            <Column gap="sm">
              <Row gap="sm" align="center">
                <Heading level={5}>Recent feedback</Heading>
                <Badge variant="neutral">{String(entries.length)}</Badge>
              </Row>

              {error && (
                <Text size="sm" style={{ color: 'var(--color-danger-default)' }}>
                  {error}
                </Text>
              )}

              {entries.length === 0 ? (
                <Text size="sm" variant="muted">
                  No feedback yet. Use the picker above to submit structured feedback on this skill
                  or its runs.
                </Text>
              ) : (
                <Column gap="xs">
                  {entries.map((e) => (
                    <Row
                      key={e.feedbackId}
                      gap="sm"
                      align="center"
                      style={{
                        padding: 'var(--space-2)',
                        borderRadius: 'var(--radius-sm)',
                        background:
                          e.reasonCode === 'good_as_is'
                            ? 'var(--color-success-subtle)'
                            : 'var(--color-surface-1)',
                      }}
                    >
                      <Badge variant={e.reasonCode === 'good_as_is' ? 'success' : 'neutral'}>
                        {e.reasonCode}
                      </Badge>
                      <Text size="xs" variant="muted">
                        {e.subjectKind}:{e.subjectId}
                      </Text>
                      {e.freeText && (
                        <Text size="xs" style={{ fontStyle: 'italic' }}>
                          {e.freeText}
                        </Text>
                      )}
                      <Text size="xs" variant="muted" style={{ marginLeft: 'auto' }}>
                        {new Date(e.createdAt).toLocaleDateString()}
                      </Text>
                    </Row>
                  ))}
                </Column>
              )}

              {entries.length > 0 && (
                <Button variant="ghost" size="sm" onClick={reload}>
                  Refresh
                </Button>
              )}
            </Column>
          </CardBody>
        </Card>
      </Column>
    </div>
  );
}
