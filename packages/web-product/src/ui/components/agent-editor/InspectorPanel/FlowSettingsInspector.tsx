'use client';

import {
  Stack,
  Inline,
  Text,
  Heading,
  Input,
  Textarea,
  Field,
  Label,
  Divider,
  Checkbox,
  Badge,
} from '@aflow/design-system';
import type { AgentDefinition } from '../../../lib/flow-to-graph.js';

interface FlowSettingsInspectorProps {
  flow: AgentDefinition;
  onUpdateMetadata: (metadata: Partial<AgentDefinition['metadata']>) => void;
  onUpdateFlowSettings: (
    patch: Partial<Pick<AgentDefinition, 'supportedModes' | 'defaultBudgets'>>,
  ) => void;
}

export function FlowSettingsInspector({
  flow,
  onUpdateMetadata,
  onUpdateFlowSettings,
}: FlowSettingsInspectorProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'auto' }}>
      <div
        style={{ padding: 'var(--space-3)', borderBottom: '1px solid var(--color-border-subtle)' }}
      >
        <Heading level={6}>Flow Settings</Heading>
      </div>

      <div style={{ padding: 'var(--space-3)' }}>
        <Stack gap="3">
          <div
            style={{
              padding: 'var(--space-2)',
              background: 'var(--color-surface-1)',
              borderRadius: 'var(--radius-md)',
            }}
          >
            <Text variant="muted" size="xs">
              Click on a step or arrow in the canvas to edit it. These are the flow-level settings.
            </Text>
          </div>

          <Field>
            <Label>Flow ID</Label>
            <Input value={flow.flowId} disabled />
          </Field>
          <Field>
            <Label>Name</Label>
            <Input
              value={flow.metadata.name}
              onChange={(e) => {
                onUpdateMetadata({ name: e.target.value });
              }}
            />
          </Field>
          <Field>
            <Label>Description</Label>
            <Textarea
              value={flow.metadata.description ?? ''}
              onChange={(e) => {
                onUpdateMetadata({ description: e.target.value });
              }}
              rows={3}
              placeholder="What this flow does"
            />
          </Field>
          <Field>
            <Label>Category</Label>
            <Input
              value={flow.metadata.category ?? ''}
              onChange={(e) => {
                onUpdateMetadata({ category: e.target.value });
              }}
              placeholder="e.g. productivity, support"
            />
          </Field>
          <Field>
            <Label>Author</Label>
            <Input
              value={flow.metadata.author ?? ''}
              onChange={(e) => {
                onUpdateMetadata({ author: e.target.value });
              }}
              placeholder="Who created this"
            />
          </Field>

          <Divider />

          <Text size="sm" style={{ fontWeight: 600 }}>
            How can this flow be used?
          </Text>
          <Inline gap="3">
            {(['api', 'chat', 'mcp'] as const).map((mode) => (
              <Checkbox
                key={mode}
                checked={(flow.supportedModes ?? []).includes(mode)}
                onChange={(e) => {
                  const current = flow.supportedModes ?? [];
                  const next = e.target.checked
                    ? [...current, mode]
                    : current.filter((m) => m !== mode);
                  onUpdateFlowSettings({ supportedModes: next });
                }}
              >
                {mode === 'api' ? 'API calls' : mode === 'chat' ? 'Chat interface' : 'MCP tools'}
              </Checkbox>
            ))}
          </Inline>

          <Divider />

          <Text size="sm" style={{ fontWeight: 600 }}>
            Status
          </Text>
          <Badge
            variant={
              flow.status === 'published'
                ? 'succeeded'
                : flow.status === 'archived'
                  ? 'cancelled'
                  : 'neutral'
            }
          >
            {flow.status ?? 'draft'}
          </Badge>
        </Stack>
      </div>
    </div>
  );
}
