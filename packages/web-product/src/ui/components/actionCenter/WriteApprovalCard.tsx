'use client';

import { useState, type ReactElement } from 'react';
import { Badge, Button, Card, CardBody, Column, Row, Text } from '@aflow/design-system';
import type {
  ActionCenterItem,
  WriteApprovalExtension,
} from '../../hooks/use-action-center-types.js';
import type { ActionCenterResolution } from '../../hooks/use-action-center.js';

export interface WriteApprovalCardProps {
  item: ActionCenterItem;
  extension: WriteApprovalExtension;
  onResolve: (resolution: ActionCenterResolution) => Promise<void>;
  resolveState: 'idle' | 'submitting' | 'error';
  errorMessage?: string;
}

const TIER_BADGE: Record<
  WriteApprovalExtension['writeRiskTier'],
  { label: string; variant: 'warning' | 'danger' | 'neutral' }
> = {
  read: { label: 'read', variant: 'neutral' },
  low: { label: 'low risk', variant: 'neutral' },
  medium: { label: 'medium risk', variant: 'warning' },
  high: { label: 'high risk', variant: 'danger' },
};

/**
 * "Approve this write" card (Plan 253) for a step paused on a gated write. Shows
 * the exact call the skill wants to make — method, host, endpoint, and a
 * redacted body preview — with Approve / Deny. Approve resolves through the
 * standard route: the orchestrator writes the grant and re-dispatches the step;
 * Deny fails the step (not the run).
 */
export function WriteApprovalCard({
  item,
  extension,
  onResolve,
  resolveState,
  errorMessage,
}: WriteApprovalCardProps): ReactElement {
  const [reason, setReason] = useState('');
  const busy = resolveState === 'submitting';
  const tier = TIER_BADGE[extension.writeRiskTier];
  const canApprove = item.allowedActions.includes('approve');
  const canReject = item.allowedActions.includes('reject');

  return (
    <Card>
      <CardBody>
        <Column gap="sm">
          <Row gap="sm" align="center">
            <Text size="base" weight="semibold">
              {item.title}
            </Text>
            <Badge variant={tier.variant}>{tier.label}</Badge>
          </Row>

          <Row gap="sm" align="center" wrap>
            <Badge variant="neutral">{extension.method}</Badge>
            <Text size="sm" variant="muted">
              {extension.urlHost}
            </Text>
            <Text size="sm" variant="muted">
              {extension.apiId}/{extension.endpointId}
            </Text>
          </Row>

          {extension.operationLabel && (
            <Text size="sm" variant="muted">
              {extension.operationLabel}
            </Text>
          )}

          {extension.bodyPreview && (
            <Column gap="xs">
              <Text size="sm" weight="medium">
                Request body
              </Text>
              <pre
                style={{
                  margin: 0,
                  padding: '8px',
                  borderRadius: '6px',
                  background: 'var(--color-surface-sunken, #f4f4f5)',
                  fontSize: '12px',
                  maxHeight: '220px',
                  overflow: 'auto',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {extension.bodyPreview}
              </pre>
            </Column>
          )}

          {errorMessage && (
            <Text size="sm" style={{ color: 'var(--color-danger-default, #dc2626)' }}>
              {errorMessage}
            </Text>
          )}

          <Row gap="sm" align="center">
            <Button
              variant="primary"
              disabled={!canApprove || busy}
              onClick={() => {
                void onResolve({ kind: 'approve' });
              }}
            >
              {busy ? 'Working…' : 'Approve'}
            </Button>
            <Button
              variant="secondary"
              disabled={!canReject || busy}
              onClick={() => {
                void onResolve(reason ? { kind: 'reject', reason } : { kind: 'reject' });
              }}
            >
              Deny
            </Button>
            <input
              type="text"
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
              }}
              placeholder="Reason (optional)"
              disabled={busy}
              style={{
                flex: 1,
                padding: '6px 8px',
                borderRadius: '6px',
                border: '1px solid var(--color-border-default, #e4e4e7)',
                fontSize: '13px',
              }}
            />
          </Row>
        </Column>
      </CardBody>
    </Card>
  );
}
