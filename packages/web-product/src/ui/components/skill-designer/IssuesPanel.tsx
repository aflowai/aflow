'use client';

import { Icon } from '@aflow/design-system';
import type { SkillDiagnostic } from '@aflow/schemas';

import type { DiagnosticsIndex } from './skill-graph.js';

export function IssuesPanel({
  diagnostics,
  onLocate,
}: {
  diagnostics: DiagnosticsIndex;
  onLocate: (taskId: string | null) => void;
}) {
  const errors: SkillDiagnostic[] = [];
  const advisories: SkillDiagnostic[] = [];
  for (const list of diagnostics.byTask.values()) {
    for (const d of list) (d.severity === 'error' ? errors : advisories).push(d);
  }
  for (const d of diagnostics.general) (d.severity === 'error' ? errors : advisories).push(d);

  if (errors.length === 0 && advisories.length === 0) {
    return (
      <div
        style={{
          padding: 'var(--space-3) var(--space-4)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          color: 'var(--color-success-default)',
        }}
      >
        <Icon name="check-circle" size="sm" weight="bold" />
        <span style={{ fontSize: 12.5 }}>Contract valid — no issues. Ready to run.</span>
      </div>
    );
  }

  return (
    <div style={{ padding: 'var(--space-2) var(--space-3)', overflow: 'auto', maxHeight: '100%' }}>
      {errors.map((d, i) => (
        <IssueRow key={`e-${i}`} d={d} onLocate={onLocate} />
      ))}
      {advisories.map((d, i) => (
        <IssueRow key={`a-${i}`} d={d} onLocate={onLocate} />
      ))}
    </div>
  );
}

function IssueRow({
  d,
  onLocate,
}: {
  d: SkillDiagnostic;
  onLocate: (taskId: string | null) => void;
}) {
  const isErr = d.severity === 'error';
  const color = isErr ? 'var(--color-error-default, #ef4444)' : 'var(--color-warning-default)';
  return (
    <button
      type="button"
      onClick={() => {
        onLocate(d.taskId ?? null);
      }}
      style={{
        display: 'flex',
        gap: 10,
        width: '100%',
        textAlign: 'left',
        padding: '8px 10px',
        marginBottom: 4,
        background: 'var(--color-surface-0)',
        border: '1px solid var(--color-border-subtle)',
        borderLeft: `3px solid ${color}`,
        borderRadius: 'var(--radius-sm)',
        cursor: d.taskId ? 'pointer' : 'default',
      }}
    >
      <Icon
        name={isErr ? 'warning-circle' : 'warning'}
        size="sm"
        style={{ color, flexShrink: 0, marginTop: 1 }}
      />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {d.taskId && (
            <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-text-primary)' }}>
              {d.taskId}
            </span>
          )}
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
              color: 'var(--color-text-muted)',
            }}
          >
            {d.dimension}
          </span>
          {d.field && (
            <span
              style={{
                fontSize: 12,
                fontFamily: 'var(--font-mono, monospace)',
                color: 'var(--color-text-muted)',
              }}
            >
              · {d.field}
            </span>
          )}
        </div>
        <div
          style={{
            fontSize: 12,
            color: 'var(--color-text-secondary)',
            marginTop: 2,
            lineHeight: 1.4,
          }}
        >
          {d.detail}
        </div>
        {d.fixHint && (
          <div style={{ fontSize: 12, color: 'var(--color-info-default)', marginTop: 3 }}>
            → {d.fixHint}
          </div>
        )}
      </div>
      {d.taskId && (
        <Icon
          name="arrow-right"
          size="xs"
          style={{ color: 'var(--color-text-muted)', flexShrink: 0 }}
        />
      )}
    </button>
  );
}
