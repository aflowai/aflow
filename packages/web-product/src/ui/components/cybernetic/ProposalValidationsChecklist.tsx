'use client';

import { useState } from 'react';
import { Badge, Card, CardBody, Column, Icon, Row, Text } from '@aflow/design-system';
import type { SkillValidity } from '@aflow/schemas';

export interface ProposalReadiness {
  contract: SkillValidity;
  capability: { issues?: string[]; warnings?: string[] };
}

interface ChecklistRow {
  label: string;
  severity: 'hard' | 'soft';
  detail: string;
}

function buildRows(v: ProposalReadiness): ChecklistRow[] {
  const rows: ChecklistRow[] = [];
  for (const d of v.contract.diagnostics) {
    rows.push({
      label: `${d.dimension} · ${d.code}`,
      severity: 'hard',
      detail: d.fixHint ? `${d.detail} — ${d.fixHint}` : d.detail,
    });
  }
  for (const a of v.contract.advisories) {
    rows.push({ label: `${a.dimension} · ${a.code}`, severity: 'soft', detail: a.detail });
  }
  for (const issue of v.capability.issues ?? []) {
    rows.push({ label: 'capability', severity: 'hard', detail: issue });
  }
  for (const warning of v.capability.warnings ?? []) {
    rows.push({ label: 'capability', severity: 'soft', detail: warning });
  }
  return rows;
}

export function ProposalValidationsChecklist({ validations }: { validations: ProposalReadiness }) {
  const rows = buildRows(validations);
  const overallSafe =
    validations.contract.status === 'valid' && (validations.capability.issues?.length ?? 0) === 0;

  return (
    <Card>
      <CardBody>
        {rows.length === 0 ? (
          <AllPassSummary />
        ) : (
          <FullChecklist rows={rows} overallSafe={overallSafe} />
        )}
      </CardBody>
    </Card>
  );
}

/**
 * Compact one-line summary when the contract is valid and there are no
 * capability gaps — the healthy default. A caret reveals nothing more (there
 * are no rows), so it's a plain single line.
 */
function AllPassSummary() {
  return (
    <Row gap="xs" align="center">
      <Badge variant="success">safe</Badge>
      <Text size="sm">Pre-ratification checks · contract valid, no capability gaps</Text>
    </Row>
  );
}

/**
 * Full list shown when any signal is present. The detail text is the
 * actionable part (which task/field broke, or which binding is missing).
 */
function FullChecklist({ rows, overallSafe }: { rows: ChecklistRow[]; overallSafe: boolean }) {
  const [expanded, setExpanded] = useState(true);
  return (
    <Column gap="xs">
      <Row
        gap="sm"
        align="center"
        wrap
        onClick={() => {
          setExpanded((e) => !e);
        }}
        style={{ cursor: 'pointer', userSelect: 'none' }}
        role="button"
        aria-expanded={expanded}
      >
        <Text size="sm" weight="semibold">
          Pre-ratification checks
        </Text>
        <Badge variant={overallSafe ? 'warning' : 'danger'}>
          {overallSafe ? 'review warnings' : 'unsafe'}
        </Badge>
        <Icon name={expanded ? 'caret-up' : 'caret-down'} size="xs" style={{ opacity: 0.6 }} />
      </Row>
      {expanded &&
        rows.map((row, i) => {
          const variant = row.severity === 'hard' ? 'danger' : 'warning';
          const label = row.severity === 'hard' ? 'fail' : 'warning';
          return (
            <Column key={`${row.label}-${String(i)}`} gap="xs">
              <Row gap="xs" align="center">
                <Badge variant={variant}>{label}</Badge>
                <Text size="sm">{row.label}</Text>
              </Row>
              <Text
                size="xs"
                variant="muted"
                style={{ paddingLeft: 'var(--space-4)', wordBreak: 'break-word' }}
              >
                • {row.detail}
              </Text>
            </Column>
          );
        })}
    </Column>
  );
}
