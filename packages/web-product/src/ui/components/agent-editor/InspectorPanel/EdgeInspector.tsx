'use client';

import { Column, Row, Text, Heading, Input, Field, Label, Badge, Icon } from '@aflow/design-system';
import type { AgentDefinition, StepDefinition } from '../../../lib/flow-to-graph.js';
import { parseEdgeId } from './helpers.js';

interface EdgeInspectorProps {
  edgeId: string;
  flow: AgentDefinition;
  onUpdateStep: (stepId: string, patch: Partial<StepDefinition>) => void;
}

export function EdgeInspector({ edgeId, flow, onUpdateStep }: EdgeInspectorProps) {
  const parsed = parseEdgeId(edgeId);
  if (!parsed) {
    return (
      <div style={{ padding: 'var(--space-4)' }}>
        <Text variant="muted" size="sm">
          Click an arrow to inspect it
        </Text>
      </div>
    );
  }

  const { sourceId, edgeType, targetId } = parsed;
  const sourceStep = flow.steps.find((s) => s.stepId === sourceId);
  const targetStep = flow.steps.find((s) => s.stepId === targetId);

  const transitionList =
    edgeType === 'failure' ? sourceStep?.onFailure?.next : sourceStep?.onSuccess?.next;
  const edgeIdx = transitionList?.findIndex((e) => e.stepId === targetId) ?? -1;
  const edge = transitionList && edgeIdx >= 0 ? transitionList[edgeIdx] : null;

  /**
   * Clearing a field means removing it, not setting it to `undefined`: the edge
   * type spells `priority` as present, so a spread that carries the key with no
   * value would write a shape the schema does not describe.
   */
  const updateEdge = (patch: {
    when?: string | undefined;
    priority?: number | undefined;
    description?: string | undefined;
  }) => {
    if (!sourceStep || edgeIdx < 0 || !transitionList) return;
    const current = transitionList[edgeIdx];
    if (current === undefined) return;
    const updatedEdge = { ...current };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete updatedEdge[key as keyof typeof updatedEdge];
      else Object.assign(updatedEdge, { [key]: value });
    }
    const nextList: typeof transitionList = [...transitionList];
    nextList[edgeIdx] = updatedEdge;
    if (edgeType === 'failure') {
      onUpdateStep(sourceId, { onFailure: { next: nextList } });
    } else {
      onUpdateStep(sourceId, { onSuccess: { next: nextList } });
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'auto' }}>
      <div
        style={{ padding: 'var(--space-3)', borderBottom: '1px solid var(--color-border-subtle)' }}
      >
        <Heading level={6}>Connection</Heading>
      </div>
      <div style={{ padding: 'var(--space-3)' }}>
        <Column gap="4">
          <div
            style={{
              padding: 'var(--space-3)',
              background: 'var(--color-surface-1)',
              borderRadius: 'var(--radius-md)',
            }}
          >
            <Column gap="2">
              <Row gap="2" align="center">
                <Text size="sm" style={{ fontWeight: 500 }}>
                  {sourceStep?.name ?? sourceId}
                </Text>
                <Icon name="caret-right" size="sm" style={{ color: 'var(--color-text-muted)' }} />
                <Text size="sm" style={{ fontWeight: 500 }}>
                  {targetStep?.name ?? targetId}
                </Text>
              </Row>
              <Badge variant={edgeType === 'failure' ? 'failed' : 'succeeded'}>
                {edgeType === 'failure' ? 'on failure' : 'on success'}
              </Badge>
            </Column>
          </div>

          <Column gap="2">
            <Text size="sm" style={{ fontWeight: 600 }}>
              Take this path when
            </Text>
            <Text variant="muted" size="xs">
              Leave empty to always take this path. Use an expression to make it conditional.
            </Text>
            <Input
              value={edge?.when ?? ''}
              onChange={(e) => {
                updateEdge({ when: e.target.value || undefined });
              }}
              placeholder="Always (no condition)"
              style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--font-size-xs)' }}
            />
          </Column>

          <Column gap="1">
            <Text size="sm" style={{ fontWeight: 600 }}>
              Priority
            </Text>
            <Text variant="muted" size="xs">
              When multiple paths are possible, higher priority paths are checked first.
            </Text>
            <Input
              type="number"
              value={String(edge?.priority ?? 50)}
              onChange={(e) => {
                const val = parseInt(e.target.value, 10);
                if (!isNaN(val)) updateEdge({ priority: val });
              }}
              style={{ width: 80 }}
            />
          </Column>

          <Field>
            <Label>Note</Label>
            <Input
              value={edge?.description ?? ''}
              onChange={(e) => {
                updateEdge({ description: e.target.value || undefined });
              }}
              placeholder="Describe when this path is taken"
            />
          </Field>
        </Column>
      </div>
    </div>
  );
}
