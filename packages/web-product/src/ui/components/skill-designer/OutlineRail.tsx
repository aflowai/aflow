'use client';

import { Icon, type IconName } from '@aflow/design-system';
import { inferTaskType, type Workflow } from '@aflow/schemas';

import {
  GOAL_NODE_ID,
  ACTIVATION_NODE_ID,
  OUTCOMES_NODE_ID,
  CAMPAIGN_NODE_ID,
  type DiagnosticsIndex,
  type NodeSeverity,
} from './skill-graph.js';

const DISPATCH_ICON: Record<string, IconName> = {
  agent: 'robot',
  operation: 'lightning',
  human: 'user',
};

export function OutlineRail({
  workflow,
  selectedId,
  diagnostics,
  onSelect,
  hasCampaign = false,
}: {
  workflow: Workflow;
  selectedId: string | null;
  diagnostics: DiagnosticsIndex;
  onSelect: (id: string) => void;
  /** True when the skill declares a campaign contract — adds a Campaign anchor. */
  hasCampaign?: boolean | undefined;
}) {
  return (
    <div
      style={{
        height: '100%',
        overflow: 'auto',
        margin: 'var(--space-2-5)',
      }}
    >
      <div style={{ padding: 'var(--space-3) var(--space-3) var(--space-2)' }}>
        <div
          style={{
            fontSize: 'var(--font-size-base)',
            fontWeight: 'var(--font-weight-normal)',
            textTransform: 'uppercase',
            letterSpacing: 'var(--font-letter-spacing-wide)',
            color: 'var(--color-text-primary)',
          }}
        >
          Outline
        </div>
      </div>

      <OutlineGroup label="North star">
        <OutlineItem
          icon="bullseye"
          label="Goal"
          active={selectedId === GOAL_NODE_ID}
          onClick={() => {
            onSelect(GOAL_NODE_ID);
          }}
        />
        <OutlineItem
          icon="lightning"
          label="Activation"
          active={selectedId === ACTIVATION_NODE_ID}
          onClick={() => {
            onSelect(ACTIVATION_NODE_ID);
          }}
        />
        {hasCampaign && (
          <OutlineItem
            icon="sliders"
            label="Campaign"
            active={selectedId === CAMPAIGN_NODE_ID}
            onClick={() => {
              onSelect(CAMPAIGN_NODE_ID);
            }}
          />
        )}
      </OutlineGroup>

      <OutlineGroup label={`Tasks · ${workflow.tasks.length}`}>
        {workflow.tasks.map((t) => {
          const diags = diagnostics.byTask.get(t.taskId);
          const sev: NodeSeverity = diags?.length
            ? diags.some((d) => d.severity === 'error')
              ? 'error'
              : 'advisory'
            : null;
          return (
            <OutlineItem
              key={t.taskId}
              icon={DISPATCH_ICON[inferTaskType(t)] ?? 'step'}
              label={t.name}
              severity={sev}
              active={selectedId === t.taskId}
              onClick={() => {
                onSelect(t.taskId);
              }}
            />
          );
        })}
      </OutlineGroup>

      <OutlineGroup label={`Outcomes · ${workflow.outcomes.length}`}>
        <OutlineItem
          icon="flag"
          label="Outcomes"
          active={selectedId === OUTCOMES_NODE_ID}
          onClick={() => {
            onSelect(OUTCOMES_NODE_ID);
          }}
        />
      </OutlineGroup>

      {workflow.stateVariables && workflow.stateVariables.length > 0 && (
        <OutlineGroup label={`Run state · ${workflow.stateVariables.length}`}>
          {workflow.stateVariables.map((v) => (
            <div
              key={v.variableId}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '4px 12px',
                fontSize: 12,
                color: 'var(--color-text-secondary)',
              }}
            >
              <Icon name="database" size="xs" />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {v.name}
              </span>
              {v.sensitive && (
                <Icon name="lock" size="xs" style={{ color: 'var(--color-warning-default)' }} />
              )}
            </div>
          ))}
        </OutlineGroup>
      )}
    </div>
  );
}

function OutlineGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 'var(--space-2)' }}>
      <div
        style={{
          fontSize: 12,
          fontWeight: 600,
          color: 'var(--color-text-muted)',
          padding: '4px 12px',
          letterSpacing: '0.03em',
        }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

function OutlineItem({
  icon,
  label,
  active,
  severity,
  onClick,
}: {
  icon: IconName;
  label: string;
  active: boolean;
  severity?: NodeSeverity | undefined;
  onClick: () => void;
}) {
  const dot =
    severity === 'error'
      ? 'var(--color-error-default, #ef4444)'
      : severity === 'advisory'
        ? 'var(--color-warning-default)'
        : null;
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        textAlign: 'left',
        padding: '6px 12px',
        background: active ? 'var(--color-surface-3, var(--color-surface-2))' : 'transparent',
        border: 'none',
        borderLeft: `2px solid ${active ? 'var(--color-interactive-default)' : 'transparent'}`,
        cursor: 'pointer',
        color: active ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
      }}
    >
      <Icon name={icon} size="xs" />
      <span
        style={{
          fontSize: 12.5,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          flex: 1,
        }}
      >
        {label}
      </span>
      {dot && (
        <span
          style={{ width: 7, height: 7, borderRadius: '50%', background: dot, flexShrink: 0 }}
        />
      )}
    </button>
  );
}
