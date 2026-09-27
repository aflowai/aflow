'use client';

import { Text, Icon } from '@aflow/design-system';
import type { StepDefinition } from '../../../lib/flow-to-graph.js';
import type { SchemaProperty } from './types.js';

interface AgentToolBannerProps {
  step: StepDefinition;
  inputFields: Array<[string, SchemaProperty]>;
  requiredInputs: Set<string>;
  parentAgentName?: string | undefined;
  onUpdateStep: (patch: Partial<StepDefinition>) => void;
}

export function AgentToolBanner({
  step,
  inputFields,
  requiredInputs,
  parentAgentName,
  onUpdateStep,
}: AgentToolBannerProps) {
  const agentProvidedCount = inputFields.filter(([field]) => {
    const v = step.config?.[field];
    return typeof v === 'string' && v === `\${input.${field}}`;
  }).length;

  const handleAutoMap = () => {
    const newConfig = { ...step.config };
    for (const [field] of inputFields) {
      if (requiredInputs.has(field) && newConfig[field] === undefined) {
        newConfig[field] = `\${input.${field}}`;
      }
    }
    onUpdateStep({ config: newConfig });
  };

  const showAutoMapButton =
    agentProvidedCount < inputFields.filter(([f]) => requiredInputs.has(f)).length;

  return (
    <div
      style={{
        padding: 'var(--space-2) var(--space-3)',
        borderRadius: 'var(--radius-md)',
        background: 'var(--color-info-muted)',
        border: '1px solid var(--color-info-subtle)',
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-2)',
        flexWrap: 'wrap',
      }}
    >
      <Icon
        name="robot"
        size="sm"
        weight="fill"
        style={{ color: 'var(--color-info-default)', flexShrink: 0 }}
      />
      <Text size="xs" style={{ color: 'var(--color-info-default)', flex: 1 }}>
        Tool of <strong>{parentAgentName ?? 'Agent'}</strong>.
        {agentProvidedCount > 0
          ? ` Agent provides ${agentProvidedCount} input${agentProvidedCount > 1 ? 's' : ''}.`
          : ' Mark inputs as "Agent provides" so the agent produces them.'}
      </Text>
      {showAutoMapButton && (
        <button
          onClick={handleAutoMap}
          style={{
            background: 'var(--color-info-default)',
            border: 'none',
            borderRadius: 'var(--radius-sm)',
            color: 'white',
            fontSize: 'var(--font-size-xs)',
            padding: '2px 8px',
            cursor: 'pointer',
            whiteSpace: 'nowrap',
            fontWeight: 500,
          }}
        >
          Auto-map required
        </button>
      )}
    </div>
  );
}
