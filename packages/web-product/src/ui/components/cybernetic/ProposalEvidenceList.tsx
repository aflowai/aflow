'use client';

import { Card, CardBody, Text, Stack, Inline, Icon, Badge } from '@aflow/design-system';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ReflectionRef {
  runId: string;
  taskId: string;
  reflectionField: string;
  excerpt: string;
}

interface ProposalEvidenceListProps {
  reflectionRefs: ReflectionRef[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIELD_LABELS: Record<string, string> = {
  condition: 'Condition',
  blockers: 'Blockers',
  missingInputs: 'Missing Inputs',
  missingTools: 'Missing Tools',
};

function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ProposalEvidenceList({ reflectionRefs }: ProposalEvidenceListProps) {
  if (reflectionRefs.length === 0) return null;

  return (
    <Card>
      <CardBody>
        <Stack gap="2">
          <Inline gap="2" align="center">
            <Icon name="list" size="sm" />
            <Text size="sm" style={{ fontWeight: 'var(--font-weight-medium)' }}>
              Reflection Evidence ({String(reflectionRefs.length)})
            </Text>
          </Inline>

          {reflectionRefs.map((ref, i) => (
            <Stack
              key={`${ref.runId}-${ref.taskId}-${ref.reflectionField}-${String(i)}`}
              gap="1"
              style={{
                padding: 'var(--space-2)',
                borderRadius: 'var(--radius-sm)',
                background: 'var(--color-surface-1, var(--color-surface-0))',
                border: '1px solid var(--color-border-default)',
              }}
            >
              <Inline gap="2" align="center">
                <Badge variant="neutral">{fieldLabel(ref.reflectionField)}</Badge>
                <Text size="sm" variant="muted">
                  Task: {ref.taskId}
                </Text>
              </Inline>
              <Text size="sm" style={{ fontStyle: 'italic' }}>
                {ref.excerpt}
              </Text>
            </Stack>
          ))}
        </Stack>
      </CardBody>
    </Card>
  );
}
