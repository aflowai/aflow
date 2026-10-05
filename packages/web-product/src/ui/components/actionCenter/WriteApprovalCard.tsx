'use client';

import { useState, type ReactElement } from 'react';
import { Badge, Button, Card, CardBody, Column, Row, Text } from '@aflow/design-system';
import type {
  ActionCenterItem,
  ApiWriteApprovalExtension,
  BrowserWriteApprovalExtension,
  WriteApprovalExtension,
} from '../../hooks/use-action-center-types.js';
import type { ActionCenterResolution } from '../../hooks/use-action-center.js';
import { useApiQuery } from '../../hooks/useApiQuery.js';
import { decodeInlinePayload, isInlinePayloadRef } from '../../lib/fetch-payload.js';
import { browserApprovalView, screenshotSource } from './browserApprovalView.js';

export interface WriteApprovalCardProps {
  item: ActionCenterItem;
  extension: WriteApprovalExtension;
  onResolve: (resolution: ActionCenterResolution) => Promise<void>;
  resolveState: 'idle' | 'submitting' | 'error';
  errorMessage?: string;
}

const TIER_BADGE: Record<
  ApiWriteApprovalExtension['writeRiskTier'],
  { label: string; variant: 'warning' | 'danger' | 'neutral' }
> = {
  read: { label: 'read', variant: 'neutral' },
  low: { label: 'low risk', variant: 'neutral' },
  medium: { label: 'medium risk', variant: 'warning' },
  high: { label: 'high risk', variant: 'danger' },
};

const PREVIEW_STYLE = {
  margin: 0,
  padding: '8px',
  borderRadius: '6px',
  background: 'var(--color-surface-sunken, #f4f4f5)',
  fontSize: '12px',
  maxHeight: '220px',
  overflow: 'auto',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
} as const;

/**
 * The approve/deny card for a step paused on an approval: an API write (Plan
 * 253) — method, host, endpoint and a redacted body preview — or an action in
 * the agent's browser (Plan 320 D7) — the site and page, what will be done to
 * which element, what would be entered, and the page as it stood. Approve
 * resolves through the standard route: the resolve writes the grant and the
 * orchestrator re-dispatches the step; Deny fails the step (not the run).
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
            {extension.target === 'api' ? (
              <Badge variant={TIER_BADGE[extension.writeRiskTier].variant}>
                {TIER_BADGE[extension.writeRiskTier].label}
              </Badge>
            ) : (
              <Badge variant="neutral">browser</Badge>
            )}
          </Row>

          {extension.target === 'api' ? (
            <ApiCallDetail extension={extension} />
          ) : (
            <BrowserActionDetail extension={extension} />
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

function ApiCallDetail({ extension }: { extension: ApiWriteApprovalExtension }): ReactElement {
  return (
    <>
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
          <pre style={PREVIEW_STYLE}>{extension.bodyPreview}</pre>
        </Column>
      )}
    </>
  );
}

function BrowserActionDetail({
  extension,
}: {
  extension: BrowserWriteApprovalExtension;
}): ReactElement {
  const view = browserApprovalView(extension);
  return (
    <>
      <Row gap="sm" align="center" wrap>
        <Badge variant="neutral">{view.site}</Badge>
        <Text size="sm">{view.path}</Text>
        <Text size="sm" variant="muted">
          {view.pageTitle}
        </Text>
      </Row>

      <Text size="sm">{view.doing}</Text>

      {view.askedAgain !== undefined && (
        <Text size="sm" weight="medium">
          {view.askedAgain}
        </Text>
      )}

      {view.value && (
        <Column gap="xs">
          <Text size="sm" weight="medium">
            {view.value.label}
          </Text>
          {view.value.text !== undefined && <pre style={PREVIEW_STYLE}>{view.value.text}</pre>}
        </Column>
      )}

      <Text size="sm" variant="muted">
        {view.askedBy}
      </Text>

      <Text size="sm" variant="muted">
        {view.standsUntil}
      </Text>

      {extension.screenshotRef && <PageScreenshot payloadRef={extension.screenshotRef} />}
    </>
  );
}

function PageScreenshot({ payloadRef }: { payloadRef: string }): ReactElement | null {
  const inline = isInlinePayloadRef(payloadRef);
  const { data } = useApiQuery({
    key: ['payload', payloadRef],
    path: `/payloads?ref=${encodeURIComponent(payloadRef)}`,
    enabled: !inline,
    staleTime: Number.POSITIVE_INFINITY,
    retryOnMount: false,
  });
  const source = screenshotSource(inline ? decodeInlinePayload(payloadRef) : data);
  if (source === undefined) return null;
  return (
    <img
      src={source}
      alt="The page as it stood when the action was asked for"
      style={{
        maxWidth: '100%',
        maxHeight: '320px',
        objectFit: 'contain',
        borderRadius: '6px',
        border: '1px solid var(--color-border-default, #e4e4e7)',
      }}
    />
  );
}
