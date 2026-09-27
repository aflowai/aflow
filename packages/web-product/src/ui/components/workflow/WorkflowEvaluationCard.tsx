'use client';

import {
  Card,
  CardHeader,
  CardBody,
  Badge,
  Text,
  Stack,
  Inline,
  Icon,
  JsonViewer,
} from '@aflow/design-system';

// ---------------------------------------------------------------------------
// Shape types (mirrors workflow.evaluate output)
// ---------------------------------------------------------------------------

interface OutcomeResult {
  outcomeId: string;
  met: boolean;
  value?: unknown;
  detail?: string;
}

interface WorkflowEvaluationData {
  outcomeResults: OutcomeResult[];
  allMet: boolean;
}

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

export function isWorkflowEvaluation(data: unknown): data is WorkflowEvaluationData {
  if (!data || typeof data !== 'object') return false;
  const obj = data as Record<string, unknown>;
  return Array.isArray(obj['outcomeResults']) && typeof obj['allMet'] === 'boolean';
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function WorkflowEvaluationCard({ data }: { data: unknown }) {
  if (!isWorkflowEvaluation(data)) {
    return <JsonViewer data={data} collapseDepth={3} maxHeight="400px" />;
  }

  const { outcomeResults, allMet } = data;
  const metCount = outcomeResults.filter((r) => r.met).length;

  return (
    <Card style={{ backgroundColor: 'var(--color-surface-0)' }}>
      <CardHeader>
        <Inline gap="2" align="center" style={{ justifyContent: 'space-between', width: '100%' }}>
          <Inline gap="2" align="center">
            <Icon name="check-circle" size="sm" />
            <Text variant="label" size="sm">
              Workflow Evaluation
            </Text>
            <Badge variant={allMet ? 'succeeded' : 'failed'}>
              {allMet ? 'All Outcomes Met' : 'Not Met'}
            </Badge>
          </Inline>
          <Text size="xs" variant="muted">
            {String(metCount)}/{String(outcomeResults.length)} passed
          </Text>
        </Inline>
      </CardHeader>

      <CardBody>
        <Stack gap="2">
          {outcomeResults.map((r) => (
            <Inline
              key={r.outcomeId}
              gap="2"
              align="center"
              style={{
                padding: 'var(--space-1) var(--space-2)',
                borderRadius: 'var(--radius-sm)',
                background: r.met ? 'var(--color-success-subtle)' : 'var(--color-danger-subtle)',
              }}
            >
              <Icon
                name={r.met ? 'check' : 'x'}
                size="xs"
                style={{
                  color: r.met ? 'var(--color-success-default)' : 'var(--color-danger-default)',
                }}
              />
              <Text size="xs" style={{ fontWeight: 500 }}>
                {r.outcomeId}
              </Text>
              {r.value !== undefined && r.value !== null && (
                <Text size="xs" variant="muted">
                  = {typeof r.value === 'number' ? String(r.value) : JSON.stringify(r.value)}
                </Text>
              )}
              {r.detail && (
                <Text size="xs" variant="muted">
                  {r.detail}
                </Text>
              )}
            </Inline>
          ))}
        </Stack>
      </CardBody>
    </Card>
  );
}
