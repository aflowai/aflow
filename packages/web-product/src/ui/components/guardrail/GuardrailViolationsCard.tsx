'use client';

import { Fragment, useState } from 'react';
import {
  Card,
  CardHeader,
  CardBody,
  Badge,
  Text,
  Stack,
  Inline,
  JsonViewer,
} from '@aflow/design-system';

interface Violation {
  railId: string;
  trigger?: string;
  action?: string;
  message?: string;
  details?: unknown;
  [key: string]: unknown;
}

function isViolationArray(data: unknown): data is Violation[] {
  if (!Array.isArray(data) || data.length === 0) return false;
  const first: unknown = data[0];
  return (
    typeof first === 'object' && first !== null && 'railId' in (first as Record<string, unknown>)
  );
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '...';
}

export function GuardrailViolationsCard({ data }: { data: unknown }) {
  const [expandedRows, setExpandedRows] = useState<Set<number>>(new Set());

  try {
    if (!isViolationArray(data)) {
      return <JsonViewer data={data} collapseDepth={3} maxHeight="400px" />;
    }

    const violations = data;

    const toggleRow = (index: number) => {
      setExpandedRows((prev) => {
        const next = new Set(prev);
        if (next.has(index)) {
          next.delete(index);
        } else {
          next.add(index);
        }
        return next;
      });
    };

    return (
      <Card>
        <CardHeader>
          <Inline gap="2" align="center">
            <Text variant="label" size="sm">
              Guardrail Violations
            </Text>
            <Badge variant="danger">
              {violations.length} violation{violations.length !== 1 ? 's' : ''}
            </Badge>
          </Inline>
        </CardHeader>

        <CardBody>
          <div style={{ overflowX: 'auto' }}>
            <table
              style={{
                width: '100%',
                borderCollapse: 'collapse',
                fontSize: 'var(--font-size-sm)',
              }}
            >
              <thead>
                <tr
                  style={{
                    borderBottom: '1px solid var(--color-border-default)',
                    textAlign: 'left',
                  }}
                >
                  <th style={{ padding: 'var(--space-1) var(--space-2)' }}>Rail</th>
                  <th style={{ padding: 'var(--space-1) var(--space-2)' }}>Trigger</th>
                  <th style={{ padding: 'var(--space-1) var(--space-2)' }}>Action</th>
                  <th style={{ padding: 'var(--space-1) var(--space-2)' }}>Message</th>
                </tr>
              </thead>
              <tbody>
                {violations.map((violation, index) => {
                  const isExpanded = expandedRows.has(index);
                  return (
                    <Fragment key={index}>
                      <tr
                        style={{
                          borderBottom: isExpanded
                            ? 'none'
                            : '1px solid var(--color-border-default)',
                          cursor: 'pointer',
                        }}
                        onClick={() => {
                          toggleRow(index);
                        }}
                      >
                        <td
                          style={{
                            padding: 'var(--space-1) var(--space-2)',
                            fontFamily: 'var(--font-family-mono)',
                          }}
                        >
                          {violation.railId}
                        </td>
                        <td style={{ padding: 'var(--space-1) var(--space-2)' }}>
                          {violation.trigger ? (
                            <Badge variant="info">{violation.trigger}</Badge>
                          ) : (
                            <Text as="span" variant="muted" size="xs">
                              -
                            </Text>
                          )}
                        </td>
                        <td style={{ padding: 'var(--space-1) var(--space-2)' }}>
                          {violation.action ? (
                            <Badge variant="warning">{violation.action}</Badge>
                          ) : (
                            <Text as="span" variant="muted" size="xs">
                              -
                            </Text>
                          )}
                        </td>
                        <td style={{ padding: 'var(--space-1) var(--space-2)' }}>
                          <Text as="span" size="sm">
                            {violation.message ? truncate(violation.message, 80) : '-'}
                          </Text>
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr style={{ borderBottom: '1px solid var(--color-border-default)' }}>
                          <td
                            colSpan={4}
                            style={{
                              padding: 'var(--space-2)',
                              backgroundColor: 'var(--color-bg-subtle, rgba(0,0,0,0.02))',
                            }}
                          >
                            <Stack gap="1">
                              {violation.message && (
                                <Text
                                  size="sm"
                                  style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
                                >
                                  {violation.message}
                                </Text>
                              )}
                              {violation.details != null ? (
                                <JsonViewer
                                  data={violation.details}
                                  collapseDepth={2}
                                  maxHeight="200px"
                                />
                              ) : null}
                            </Stack>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardBody>
      </Card>
    );
  } catch {
    return <JsonViewer data={data} collapseDepth={3} maxHeight="400px" />;
  }
}
