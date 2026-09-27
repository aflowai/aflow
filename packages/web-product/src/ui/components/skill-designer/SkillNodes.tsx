'use client';

import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Icon, type IconName } from '@aflow/design-system';
import type { WorkflowWhenView } from '@aflow/schemas';

import {
  DATA_SEMANTIC_COLOR,
  type SkillNodeData,
  type TaskNodeData,
  type TaskDispatch,
  type NodeSeverity,
  type CapabilityChip,
} from './skill-graph.js';

// ---------------------------------------------------------------------------
// Shared tokens
// ---------------------------------------------------------------------------

const DISPATCH_META: Record<TaskDispatch, { icon: IconName; color: string; label: string }> = {
  agent: { icon: 'robot', color: 'var(--color-interactive-default)', label: 'Agent' },
  operation: { icon: 'lightning', color: 'var(--color-warning-default)', label: 'Operation' },
  human: { icon: 'user', color: 'var(--color-info-default)', label: 'Human' },
};

const SOURCE_DOT: Record<CapabilityChip['source'], string> = {
  api: 'var(--color-success-default)',
  mcp: 'var(--color-accent-default)',
  operation: 'var(--color-warning-default)',
};

const SEVERITY_COLOR: Record<'error' | 'advisory', string> = {
  error: 'var(--color-error-default, #ef4444)',
  advisory: 'var(--color-warning-default)',
};

/** True when the node is selected on the canvas OR via the Outline/Issues panels
 *  (the latter is mirrored into `data.isSelected` by SkillDesigner). */
function pickSel(selected: boolean, data: unknown): boolean {
  return selected || (data as { isSelected?: boolean }).isSelected === true;
}

function ValidityDot({ severity }: { severity: NodeSeverity }) {
  const color = severity ? SEVERITY_COLOR[severity] : 'var(--color-success-default)';
  return (
    <span
      title={severity ? severity : 'valid'}
      style={{
        width: 9,
        height: 9,
        borderRadius: '50%',
        background: color,
        boxShadow: `0 0 0 3px ${color}22`,
        flexShrink: 0,
      }}
    />
  );
}

const NODE_W = 300;

function shellStyle(
  accent: string,
  selected: boolean,
  extra?: React.CSSProperties,
): React.CSSProperties {
  const borderColor = selected ? accent : 'var(--color-border-default)';
  // Per-side longhand only — never the `border` shorthand. Anchor/task nodes
  // override a single side (borderLeft/borderRight) and mixing shorthand with
  // longhand triggers React's "conflicting style property" warning.
  return {
    background: 'var(--color-surface-3)',
    borderTop: `1px solid ${borderColor}`,
    borderRight: `1px solid ${borderColor}`,
    borderBottom: `1px solid ${borderColor}`,
    borderLeft: `1px solid ${borderColor}`,
    borderRadius: 'var(--radius-lg)',
    width: NODE_W,
    boxShadow: selected
      ? `0 0 0 2px ${accent}44, 0 6px 18px rgba(0,0,0,0.18)`
      : '0 1px 3px rgba(0,0,0,0.10)',
    transition: 'border-color 150ms, box-shadow 150ms',
    position: 'relative',
    ...extra,
  };
}

const HANDLE_STYLE = { background: 'var(--color-border-strong, #6b7280)', width: 9, height: 9 };

/** Handles flip to the node's sides in horizontal layout so edges enter/exit
 *  left↔right instead of top↔bottom. Direction is threaded through node data. */
function NodeHandles({
  data,
  target,
  source,
}: {
  data: unknown;
  target?: boolean | undefined;
  source?: boolean | undefined;
}) {
  const horizontal = (data as { direction?: 'RIGHT' | 'DOWN' }).direction === 'RIGHT';
  return (
    <>
      {target && (
        <Handle
          type="target"
          position={horizontal ? Position.Left : Position.Top}
          style={HANDLE_STYLE}
        />
      )}
      {source && (
        <Handle
          type="source"
          position={horizontal ? Position.Right : Position.Bottom}
          style={HANDLE_STYLE}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Goal anchor
// ---------------------------------------------------------------------------

const MODE_ICON: Record<string, IconName> = {
  optimization: 'bullseye',
  process: 'gears',
  project: 'slalom',
};

function GoalNodeImpl({ data, selected }: NodeProps) {
  const d = data as unknown as Extract<SkillNodeData, { nodeKind: 'goal' }>;
  const accent = 'var(--color-accent-default)';
  return (
    <div
      style={shellStyle(accent, pickSel(selected, data), {
        width: 356,
        background: 'var(--color-surface-3)',
      })}
    >
      <div style={{ padding: 'var(--space-3)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
          <Icon name="bullseye" size="md" weight="bold" />
          <span
            style={{
              fontSize: 'var(--font-size-base)',
              fontWeight: 700,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              color: accent,
            }}
          >
            Skill goal
          </span>
          <span
            style={{
              marginLeft: 'auto',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              fontSize: 'var(--font-size-base)',
              fontWeight: 600,
              color: 'var(--color-text-secondary)',
              textTransform: 'capitalize',
            }}
          >
            <Icon name={MODE_ICON[d.mode] ?? 'bullseye'} size="xs" />
            {d.mode}
          </span>
        </div>
        <div
          style={{
            fontSize: 'var(--font-size-lg)',
            fontWeight: 700,
            color: 'var(--color-text-primary)',
            marginTop: 'var(--space-2)',
            lineHeight: 1.25,
          }}
        >
          {d.skillName}
        </div>
        {d.goal && (
          <div
            style={{
              fontSize: 'var(--font-size-base)',
              color: 'var(--color-text-secondary)',
              marginTop: 'var(--space-1-5)',
              lineHeight: 1.45,
            }}
          >
            {d.goal}
          </div>
        )}
        <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-2)' }}>
          <CountPill icon="step" label={`${d.taskCount} tasks`} />
          <CountPill icon="flag" label={`${d.outcomeCount} outcomes`} />
        </div>
      </div>
      <NodeHandles data={data} source />
    </div>
  );
}

function CountPill({ icon, label }: { icon: IconName; label: string }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontSize: 'var(--font-size-base)',
        fontWeight: 600,
        color: 'var(--color-text-secondary)',
        background: 'var(--color-surface-2)',
        border: '1px solid var(--color-border-subtle)',
        borderRadius: 'var(--radius-sm)',
        padding: '3px 8px',
      }}
    >
      <Icon name={icon} size="xs" />
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Activation anchor
// ---------------------------------------------------------------------------

function ActivationNodeImpl({ data, selected }: NodeProps) {
  const d = data as unknown as Extract<SkillNodeData, { nodeKind: 'activation' }>;
  const accent = 'var(--color-success-default)';
  const empty = d.triggerPatterns.length === 0 && !d.activationHint;
  return (
    <div
      style={shellStyle(accent, pickSel(selected, data), {
        borderLeft: `3px solid ${accent}`,
        background: 'var(--color-surface-3)',
      })}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-2)',
          padding: 'var(--space-2) var(--space-3)',
          borderBottom: '1px solid var(--color-border-subtle)',
          background: `${accent}0c`,
        }}
      >
        <Icon name="lightning" size="sm" weight="bold" />
        <span
          style={{
            fontSize: 'var(--font-size-base)',
            fontWeight: 700,
            letterSpacing: '0.05em',
            textTransform: 'uppercase',
            color: accent,
          }}
        >
          Activation
        </span>
        <span
          style={{
            marginLeft: 'auto',
            fontSize: 'var(--font-size-base)',
            fontWeight: 600,
            color: 'var(--color-success-default)',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
          }}
        >
          start
        </span>
        <ValidityDot severity={d.severity} />
      </div>
      <div style={{ padding: 'var(--space-3)' }}>
        {empty ? (
          <div
            style={{
              fontSize: 'var(--font-size-base)',
              color: 'var(--color-text-muted)',
              fontStyle: 'italic',
            }}
          >
            No triggers configured
          </div>
        ) : (
          <>
            {d.activationHint && (
              <div
                style={{
                  fontSize: 'var(--font-size-base)',
                  color: 'var(--color-text-secondary)',
                  lineHeight: 1.4,
                  marginBottom: 'var(--space-2)',
                }}
              >
                {d.activationHint}
              </div>
            )}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-1-5)' }}>
              {d.triggerPatterns.slice(0, 4).map((p) => (
                <span
                  key={p}
                  style={{
                    fontSize: 'var(--font-size-base)',
                    color: 'var(--color-text-secondary)',
                    background: 'var(--color-surface-2)',
                    border: '1px solid var(--color-border-subtle)',
                    borderRadius: 'var(--radius-sm)',
                    padding: '2px 8px',
                  }}
                >
                  {p}
                </span>
              ))}
              {d.triggerPatterns.length > 4 && (
                <span
                  style={{ fontSize: 'var(--font-size-base)', color: 'var(--color-text-muted)' }}
                >
                  +{d.triggerPatterns.length - 4}
                </span>
              )}
            </div>
          </>
        )}
        <div
          style={{
            display: 'flex',
            gap: 'var(--space-1-5)',
            marginTop: 'var(--space-2)',
            flexWrap: 'wrap',
          }}
        >
          {d.priority != null && <MiniBadge>priority {d.priority}</MiniBadge>}
          {d.iterationAuto && <MiniBadge>auto-iterate</MiniBadge>}
          {d.hasBudget && <MiniBadge>budgeted</MiniBadge>}
        </div>
      </div>
      <NodeHandles data={data} target source />
    </div>
  );
}

/** The task's `when` guard — combinator header + one monospace clause per line. */
function ConditionBlock({ when }: { when: WorkflowWhenView }) {
  return (
    <div
      style={{
        marginTop: 'var(--space-2)',
        padding: '4px 6px',
        background: 'var(--color-surface-2)',
        borderLeft: '2px solid var(--color-warning-default)',
        borderRadius: 'var(--radius-sm)',
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
      }}
    >
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          fontSize: 'var(--font-size-base)',
          fontWeight: 600,
          color: 'var(--color-warning-default)',
        }}
      >
        <Icon name="git-branch" size="xs" />
        when{when.mode === 'all' ? ' all of' : when.mode === 'any' ? ' any of' : ''}
        {when.onMissingRef === 'error' && (
          <span
            style={{ marginLeft: 'auto', color: 'var(--color-text-muted)' }}
            title="If a referenced task has not completed successfully, the run fails instead of skipping this task."
          >
            missing ref → fail
          </span>
        )}
      </span>
      {when.clauses.map((clause) => (
        <div
          key={clause}
          title={clause}
          style={{
            fontSize: 'var(--font-size-base)',
            fontFamily: 'var(--font-mono, monospace)',
            color: 'var(--color-text-secondary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {clause}
        </div>
      ))}
    </div>
  );
}

function MiniBadge({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        fontSize: 'var(--font-size-base)',
        fontWeight: 600,
        color: 'var(--color-text-secondary)',
        background: 'var(--color-border-default)',
        borderRadius: 'var(--radius-sm)',
        padding: '2px 6px',
      }}
    >
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Task node — the star
// ---------------------------------------------------------------------------

function TaskNodeImpl({ data, selected }: NodeProps) {
  const d = data as unknown as TaskNodeData;
  const meta = DISPATCH_META[d.dispatch];
  const accent = meta.color;
  // Injected by SkillDesigner (same channel as `isSelected` / `direction`).
  const onFanHover = (data as { onFanHover?: (taskId: string | null) => void }).onFanHover;
  return (
    <div
      style={shellStyle(accent, pickSel(selected, data), {
        borderLeft: d.isEntry ? '3px solid var(--color-success-default)' : undefined,
        opacity: d.optional ? 0.92 : 1,
      })}
    >
      {/* header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-2)',
          padding: 'var(--space-2) var(--space-3)',
          borderBottom: '1px solid var(--color-border-subtle)',
          background: `${accent}0c`,
        }}
      >
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 26,
            height: 26,
            borderRadius: 'var(--radius-sm)',
            background: `${accent}1f`,
            color: accent,
            flexShrink: 0,
          }}
        >
          <Icon name={meta.icon} size="sm" weight="bold" />
        </span>
        <span
          style={{
            fontSize: 'var(--font-size-base)',
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            color: accent,
          }}
        >
          {meta.label}
        </span>
        {d.optional && (
          <span
            style={{
              fontSize: 'var(--font-size-base)',
              fontWeight: 600,
              color: 'var(--color-text-muted)',
              textTransform: 'uppercase',
            }}
          >
            opt
          </span>
        )}
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
          <ValidityDot severity={d.severity} />
        </span>
      </div>

      {/* body */}
      <div style={{ padding: 'var(--space-3)' }}>
        <div
          style={{
            fontSize: 'var(--font-size-lg)',
            fontWeight: 600,
            color: 'var(--color-text-primary)',
            lineHeight: 1.25,
          }}
        >
          {d.title}
        </div>
        {d.dispatchLabel && (
          <div
            style={{
              fontSize: 'var(--font-size-base)',
              color: 'var(--color-text-muted)',
              marginTop: 'var(--space-1)',
              fontFamily: 'var(--font-mono, monospace)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {d.dispatchLabel}
          </div>
        )}
        <div
          style={{
            fontSize: 'var(--font-size-base)',
            color: 'var(--color-text-secondary)',
            marginTop: 'var(--space-1-5)',
            lineHeight: 1.4,
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {d.goalPreview}
        </div>

        {/* conditional guard — this task only runs when the clauses pass */}
        {d.when && <ConditionBlock when={d.when} />}

        {/* capability chips */}
        {d.capabilities.length > 0 && (
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 'var(--space-1-5)',
              marginTop: 'var(--space-2)',
            }}
          >
            {d.capabilities.slice(0, 3).map((c, i) => (
              <span
                key={`${c.label}-${i}`}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  fontSize: 'var(--font-size-base)',
                  fontWeight: 600,
                  color: 'var(--color-text-secondary)',
                  background: 'var(--color-surface-2)',
                  border: '1px solid var(--color-border-subtle)',
                  borderRadius: 'var(--radius-sm)',
                  padding: '2px 6px',
                }}
              >
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: SOURCE_DOT[c.source],
                  }}
                />
                {c.label}
              </span>
            ))}
            {d.capabilities.length > 3 && (
              <span style={{ fontSize: 'var(--font-size-base)', color: 'var(--color-text-muted)' }}>
                +{d.capabilities.length - 3}
              </span>
            )}
          </div>
        )}

        {/* named inputs / outputs — "what this task requires & produces" */}
        {(d.inputs.length > 0 || d.outputs.length > 0) && (
          <div
            style={{
              marginTop: 'var(--space-2)',
              paddingTop: 'var(--space-2)',
              borderTop: '1px dashed var(--color-border-subtle)',
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-1)',
            }}
          >
            {d.inputs.length > 0 && (
              <PortList dir="in" items={d.inputs.map((n) => ({ label: n }))} />
            )}
            {d.outputs.length > 0 && (
              <PortList
                dir="out"
                items={d.outputs.map((o) => ({
                  label: o.key,
                  color: DATA_SEMANTIC_COLOR[o.semantics],
                  derived: o.derived,
                }))}
              />
            )}
          </div>
        )}

        {/* footer badges */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-1-5)',
            marginTop: 'var(--space-2)',
            flexWrap: 'wrap',
          }}
        >
          {d.branchSubjects?.map((subject) => (
            <span
              key={subject}
              title={`Downstream tasks branch on this task's ${subject} — the outgoing dashed edges carry the outcomes.`}
              onMouseEnter={() => onFanHover?.(d.taskId)}
              onMouseLeave={() => onFanHover?.(null)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 3,
                fontSize: 'var(--font-size-base)',
                fontWeight: 600,
                color: 'var(--color-warning-default)',
                cursor: 'default',
              }}
            >
              <Icon name="git-branch" size="xs" />
              {subject}?
            </span>
          ))}
          {d.hasEval && (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 3,
                fontSize: 'var(--font-size-base)',
                fontWeight: 600,
                color: 'var(--color-info-default)',
              }}
            >
              <Icon name="check-circle" size="xs" />{' '}
              {d.evalTypes && d.evalTypes.length > 0
                ? d.evalTypes.length > 3
                  ? `${d.evalTypes.slice(0, 2).join(', ')} +${String(d.evalTypes.length - 2)}`
                  : d.evalTypes.join(', ')
                : 'eval'}
            </span>
          )}
          {d.model && <MiniBadge>{d.model}</MiniBadge>}
          {d.retryCount != null && d.retryCount > 0 && <MiniBadge>retry {d.retryCount}</MiniBadge>}
        </div>
      </div>

      <NodeHandles data={data} target source />
    </div>
  );
}

function PortList({
  dir,
  items,
}: {
  dir: 'in' | 'out';
  items: Array<{ label: string; color?: string | undefined; derived?: boolean | undefined }>;
}) {
  const shown = items.slice(0, 6);
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
      <Icon
        name={dir === 'in' ? 'arrow-down' : 'arrow-up'}
        size="xs"
        style={{ color: 'var(--color-text-muted)', flexShrink: 0, marginTop: 1 }}
      />
      <span
        style={{
          fontSize: 'var(--font-size-sm)',
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          color: 'var(--color-text-muted)',
          whiteSpace: 'nowrap',
          flexShrink: 0,
        }}
      >
        {dir}
      </span>
      <span
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '1px 6px',
          fontSize: 'var(--font-size-base)',
          color: 'var(--color-text-secondary)',
        }}
      >
        {shown.map((it, i) => (
          <span
            key={`${it.label}-${i}`}
            title={it.derived ? 'Inferred from downstream usage' : undefined}
            style={{
              color: it.color,
              fontWeight: it.color && !it.derived ? 600 : 400,
              fontStyle: it.derived ? 'italic' : 'normal',
              opacity: it.derived ? 0.8 : 1,
            }}
          >
            {it.label}
            {i < shown.length - 1 ? ' ·' : ''}
          </span>
        ))}
        {items.length > 6 && (
          <span style={{ color: 'var(--color-text-muted)' }}>+{items.length - 6}</span>
        )}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Outcomes anchor
// ---------------------------------------------------------------------------

function OutcomesNodeImpl({ data, selected }: NodeProps) {
  const d = data as unknown as Extract<SkillNodeData, { nodeKind: 'outcomes' }>;
  const accent = 'var(--color-accent-default)';
  return (
    <div
      style={shellStyle(accent, pickSel(selected, data), { borderRight: `3px solid ${accent}` })}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-2)',
          padding: 'var(--space-2) var(--space-3)',
          borderBottom: '1px solid var(--color-border-subtle)',
          background: `${accent}0c`,
        }}
      >
        <Icon name="flag" size="sm" weight="bold" />
        <span
          style={{
            fontSize: 'var(--font-size-base)',
            fontWeight: 700,
            letterSpacing: '0.05em',
            textTransform: 'uppercase',
            color: accent,
          }}
        >
          Outcomes
        </span>
        <span
          style={{
            marginLeft: 'auto',
            fontSize: 'var(--font-size-base)',
            color: 'var(--color-text-muted)',
          }}
        >
          {d.outcomes.length} criteria
        </span>
      </div>
      <div style={{ padding: 'var(--space-3)' }}>
        {d.outcomes.length === 0 ? (
          <div
            style={{
              fontSize: 'var(--font-size-base)',
              color: 'var(--color-text-muted)',
              fontStyle: 'italic',
            }}
          >
            No outcomes defined
          </div>
        ) : (
          <ul
            style={{
              margin: 0,
              padding: 0,
              listStyle: 'none',
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-1-5)',
            }}
          >
            {d.outcomes.slice(0, 5).map((o) => (
              <li
                key={o.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-2)',
                  fontSize: 'var(--font-size-base)',
                  color: 'var(--color-text-secondary)',
                }}
              >
                <span
                  style={{
                    fontSize: 'var(--font-size-sm)',
                    fontWeight: 700,
                    color: accent,
                    textTransform: 'uppercase',
                    whiteSpace: 'nowrap',
                    flexShrink: 0,
                  }}
                >
                  {o.type}
                </span>
                <span
                  style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    minWidth: 0,
                  }}
                >
                  {o.name}
                </span>
              </li>
            ))}
            {d.outcomes.length > 5 && (
              <li style={{ fontSize: 'var(--font-size-base)', color: 'var(--color-text-muted)' }}>
                +{d.outcomes.length - 5} more
              </li>
            )}
          </ul>
        )}
      </div>
      <NodeHandles data={data} target />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Campaign anchor — the skill's campaign contract (read-only field definitions)
// ---------------------------------------------------------------------------

function CampaignNodeImpl({ data, selected }: NodeProps) {
  const d = data as unknown as Extract<SkillNodeData, { nodeKind: 'campaign' }>;
  const accent = 'var(--color-info-default)';
  return (
    <div style={shellStyle(accent, pickSel(selected, data), { borderLeft: `3px solid ${accent}` })}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-2)',
          padding: 'var(--space-2) var(--space-3)',
          borderBottom: '1px solid var(--color-border-subtle)',
          background: `${accent}0c`,
        }}
      >
        <Icon name="sliders" size="sm" weight="bold" />
        <span
          style={{
            fontSize: 'var(--font-size-base)',
            fontWeight: 700,
            letterSpacing: '0.05em',
            textTransform: 'uppercase',
            color: accent,
          }}
        >
          Campaign
        </span>
        <span
          style={{
            marginLeft: 'auto',
            fontSize: 'var(--font-size-base)',
            color: 'var(--color-text-muted)',
          }}
        >
          {d.fields.length} {d.fields.length === 1 ? 'field' : 'fields'}
        </span>
      </div>
      <div style={{ padding: 'var(--space-3)' }}>
        <ul
          style={{
            margin: 0,
            padding: 0,
            listStyle: 'none',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-1-5)',
          }}
        >
          {d.fields.slice(0, 5).map((f) => (
            <li
              key={f.key}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-2)',
                fontSize: 'var(--font-size-base)',
                color: 'var(--color-text-secondary)',
              }}
            >
              {f.identity && (
                <Icon
                  name="lock"
                  size="xs"
                  weight="bold"
                  color={accent}
                  style={{ flexShrink: 0 }}
                />
              )}
              <span
                style={{
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  minWidth: 0,
                }}
              >
                {f.label}
              </span>
              <span
                style={{
                  marginLeft: 'auto',
                  fontSize: 'var(--font-size-sm)',
                  fontWeight: 700,
                  color: accent,
                  textTransform: 'uppercase',
                  whiteSpace: 'nowrap',
                  flexShrink: 0,
                }}
              >
                {f.type}
              </span>
            </li>
          ))}
          {d.fields.length > 5 && (
            <li style={{ fontSize: 'var(--font-size-base)', color: 'var(--color-text-muted)' }}>
              +{d.fields.length - 5} more
            </li>
          )}
        </ul>
      </div>
      <NodeHandles data={data} target />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Data-source chip (data lens) — run input / campaign field / artifact / feedback
// ---------------------------------------------------------------------------

const RUN_SOURCE_META = {
  icon: 'arrow-square-in' as IconName,
  accent: 'var(--color-info-default)',
};

const SOURCE_META: Record<string, { icon: IconName; accent: string }> = {
  run: RUN_SOURCE_META,
  campaign: { icon: 'sliders', accent: 'var(--color-info-default)' },
  artifact: { icon: 'image', accent: 'var(--color-accent-default)' },
  feedback: { icon: 'chat', accent: 'var(--color-warning-default)' },
};

function SourceNodeImpl({ data, selected }: NodeProps) {
  const d = data as unknown as Extract<SkillNodeData, { nodeKind: 'source' }>;
  const meta = SOURCE_META[d.sourceKind] ?? RUN_SOURCE_META;
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '6px 12px',
        background: 'var(--color-surface-1)',
        border: `1px solid ${pickSel(selected, data) ? meta.accent : 'var(--color-border-subtle)'}`,
        borderRadius: 'var(--radius-full)',
        boxShadow: '0 1px 3px rgba(0,0,0,0.10)',
        position: 'relative',
      }}
    >
      <Icon name={meta.icon} size="sm" style={{ color: meta.accent }} />
      <span
        style={{
          fontSize: 'var(--font-size-base)',
          fontWeight: 600,
          color: 'var(--color-text-secondary)',
        }}
      >
        {d.label}
      </span>
      <NodeHandles data={data} source />
    </div>
  );
}

export const SkillGoalNode = memo(GoalNodeImpl);
export const SkillActivationNode = memo(ActivationNodeImpl);
export const SkillTaskNode = memo(TaskNodeImpl);
export const SkillOutcomesNode = memo(OutcomesNodeImpl);
export const SkillCampaignNode = memo(CampaignNodeImpl);
export const SkillSourceNode = memo(SourceNodeImpl);
