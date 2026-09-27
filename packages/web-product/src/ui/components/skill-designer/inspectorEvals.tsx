'use client';

import { useState } from 'react';
import { Badge, Button, Icon, Text } from '@aflow/design-system';
import { formatCampaignParamForDisplay, type EvalCriterion } from '@aflow/schemas';

import { Section, Empty, Mono } from './inspectorShared.js';
import { CriterionForm } from './inspectorEvalForm.js';

// Eval criteria are authored by the Coach from run evidence; operators may also
// author their own (Plan 213). Provenance is shown per criterion ("you" badge);
// "no criteria" remains a valid state, not a setup gap.

const CRIT_LABEL: Record<EvalCriterion['type'], string> = {
  threshold: 'threshold',
  contains: 'contains',
  trace_bound: 'trace',
  judge: 'judge',
};

const OP_SYMBOL: Record<string, string> = {
  lt: '<',
  lte: '≤',
  gt: '>',
  gte: '≥',
  eq: '=',
  between: 'between',
};

export function summarizeCriterion(c: EvalCriterion): string {
  switch (c.type) {
    case 'threshold': {
      const op = formatCampaignParamForDisplay(c.operator);
      return `${c.metric} ${OP_SYMBOL[op] ?? op} ${formatCampaignParamForDisplay(c.target)}`;
    }
    case 'contains':
      return `${c.inField} matches /${c.pattern}/`;
    case 'trace_bound':
      return `${c.metric} ≤ ${c.maxValue}`;
    case 'judge':
      return c.rubric.map((r) => r.criterion).join('; ');
  }
}

/** Read-only list of Coach-authored eval criteria for a goal / task / trajectory. */
export function EvalCriteriaSection({
  label,
  criteria,
  emptyHint,
  onRemove,
  onAdd,
}: {
  label: string;
  criteria: EvalCriterion[];
  emptyHint?: string | undefined;
  /** When present, each criterion gets a remove affordance (edit mode). */
  onRemove?: ((name: string) => void) | undefined;
  /** When present, an "+ Add check" affordance opens the authoring form. */
  onAdd?: ((criterion: EvalCriterion) => void) | undefined;
}) {
  const [adding, setAdding] = useState(false);
  if (criteria.length === 0 && !emptyHint && !onAdd) return null;
  return (
    <Section label={label}>
      {criteria.length === 0 ? (
        <Empty>{emptyHint}</Empty>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {criteria.map((c, i) => (
            <div
              key={i}
              style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}
            >
              <Badge variant="neutral">{CRIT_LABEL[c.type]}</Badge>
              {c.source === 'operator' && (
                <Badge variant="info" icon={<Icon name="user" size="xs" />}>
                  you
                </Badge>
              )}
              <Text size="sm" weight="medium">
                {c.name}
              </Text>
              <Mono>{summarizeCriterion(c)}</Mono>
              {onRemove && (
                <button
                  type="button"
                  onClick={() => {
                    onRemove(c.name);
                  }}
                  title={`Remove "${c.name}"`}
                  style={{
                    marginLeft: 'auto',
                    border: 'none',
                    background: 'transparent',
                    color: 'var(--color-text-muted)',
                    cursor: 'pointer',
                    padding: '0 4px',
                    lineHeight: 1,
                  }}
                >
                  <Icon name="x" size="xs" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {onAdd &&
        (adding ? (
          <div style={{ marginTop: 6 }}>
            <CriterionForm
              onSubmit={(c) => {
                onAdd(c);
                setAdding(false);
              }}
              onCancel={() => {
                setAdding(false);
              }}
            />
          </div>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setAdding(true);
            }}
            style={{ marginTop: 4 }}
          >
            <Icon name="plus" size="xs" /> Add check
          </Button>
        ))}
    </Section>
  );
}
