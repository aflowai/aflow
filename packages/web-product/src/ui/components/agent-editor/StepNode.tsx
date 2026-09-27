'use client';

import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Icon } from '@aflow/design-system';
import type { IconName } from '@aflow/design-system';
import type { StepNodeData } from '../../lib/flow-to-graph.js';
import { getStepTypeIcon, getStepTypeColor } from '../CatalogPickers.js';

function StepNodeComponent({ data, selected }: NodeProps) {
  const nodeData = data as unknown as StepNodeData;
  const { step, isStartStep, isTerminal, errorCount, warningCount, inputVars, outputVars } =
    nodeData;
  const iconName: IconName = getStepTypeIcon(step.stepType);
  const accentColor = getStepTypeColor(step.stepType);

  return (
    <div
      style={{
        background: 'var(--color-cybernetic-void)',
        borderTop: `1px solid ${selected ? accentColor : 'var(--color-border-default)'}`,
        borderBottom: `1px solid ${selected ? accentColor : 'var(--color-border-default)'}`,
        borderLeft: isStartStep
          ? '3px solid var(--color-success-default)'
          : `1px solid ${selected ? accentColor : 'var(--color-border-default)'}`,
        borderRight: isTerminal
          ? '3px solid var(--color-text-muted)'
          : `1px solid ${selected ? accentColor : 'var(--color-border-default)'}`,
        borderRadius: 'var(--radius-lg)',
        ...(isStartStep && {
          borderTopLeftRadius: 3,
          borderBottomLeftRadius: 3,
        }),
        ...(isTerminal && {
          borderTopRightRadius: 3,
          borderBottomRightRadius: 3,
        }),
        width: 240,
        boxShadow: selected ? `0 0 0 2px ${accentColor}33` : '0 1px 3px rgba(0,0,0,0.06)',
        transition: 'border-color 150ms, box-shadow 150ms',
        position: 'relative',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-2)',
          padding: 'var(--space-2) var(--space-3)',
          borderBottom: '1px solid var(--color-border-subtle)',
          background: `${accentColor}08`,
        }}
      >
        <Icon name={iconName} size="sm" weight="bold" />
        <span
          style={{
            fontSize: '10px',
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            color: accentColor,
          }}
        >
          {step.operation}
        </span>
        {step.optional && (
          <span
            style={{
              fontSize: '9px',
              color: 'var(--color-text-muted)',
              marginLeft: 'auto',
            }}
          >
            optional
          </span>
        )}
      </div>

      {/* Body */}
      <div style={{ padding: 'var(--space-2) var(--space-3)' }}>
        <div
          style={{
            fontSize: 'var(--font-size-sm)',
            fontWeight: 500,
            color: 'var(--color-text-primary)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {step.name ?? step.stepId}
        </div>

        {/* Binding summary */}
        {(inputVars.length > 0 || outputVars.length > 0) && (
          <div
            style={{
              display: 'flex',
              gap: 'var(--space-2)',
              marginTop: 'var(--space-1)',
              fontSize: '10px',
              color: 'var(--color-text-muted)',
              fontFamily: 'var(--font-mono)',
            }}
          >
            {inputVars.length > 0 && (
              <span title={`Inputs: ${inputVars.join(', ')}`}>
                {'↓'}
                {inputVars.length}
              </span>
            )}
            {outputVars.length > 0 && (
              <span title={`Outputs: ${outputVars.join(', ')}`}>
                {'↑'}
                {outputVars.length}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Validation indicators */}
      {(errorCount > 0 || warningCount > 0) && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-1)',
            padding: 'var(--space-1) var(--space-3)',
            borderTop: '1px solid var(--color-border-subtle)',
            fontSize: '10px',
          }}
        >
          {errorCount > 0 && (
            <span
              style={{
                color: 'var(--color-danger-default)',
                display: 'flex',
                alignItems: 'center',
                gap: 2,
              }}
            >
              <Icon name="warning-circle" size="xs" weight="fill" />
              {errorCount}
            </span>
          )}
          {warningCount > 0 && (
            <span
              style={{
                color: 'var(--color-warning-default)',
                display: 'flex',
                alignItems: 'center',
                gap: 2,
              }}
            >
              <Icon name="warning-circle" size="xs" />
              {warningCount}
            </span>
          )}
        </div>
      )}

      {/* Handles */}
      <Handle
        type="target"
        position={Position.Top}
        style={{
          width: 8,
          height: 8,
          background: 'var(--color-border-default)',
          border: '2px solid var(--color-surface-0)',
        }}
      />
      <Handle
        id="success"
        type="source"
        position={Position.Bottom}
        style={{
          width: 8,
          height: 8,
          background: 'var(--color-success-default)',
          border: '2px solid var(--color-surface-0)',
        }}
      />
      <Handle
        id="failure"
        type="source"
        position={Position.Right}
        style={{
          width: 8,
          height: 8,
          background: 'var(--color-danger-default)',
          border: '2px solid var(--color-surface-0)',
          top: '50%',
        }}
      />
    </div>
  );
}

export const StepNode = memo(StepNodeComponent);
