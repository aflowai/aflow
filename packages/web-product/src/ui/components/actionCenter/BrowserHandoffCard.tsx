'use client';

import type { ReactElement } from 'react';
import { Badge, Button, Card, CardBody, Column, Row, Text } from '@aflow/design-system';
import type { ActionCenterItem } from '../../hooks/use-action-center-types.js';
import type { ActionCenterResolution } from '../../hooks/use-action-center.js';

type HandoffOrigin = Extract<ActionCenterItem['origin'], { type: 'browser_handoff' }>;

export interface BrowserHandoffCardProps {
  item: ActionCenterItem;
  origin: HandoffOrigin;
  onResolve: (resolution: ActionCenterResolution) => Promise<void>;
  resolveState: 'idle' | 'submitting' | 'error';
  errorMessage?: string;
  /** Links to the waiting runs' conversations. */
  backlinks?: ReactElement | null;
}

const REASON: Record<HandoffOrigin['reason'], string> = {
  sign_in: 'sign-in',
  challenge: 'check',
  confirm: 'confirmation',
};

/**
 * A run's page waiting in the browser window on the operator's machine. One
 * card per site, listing every run waiting on it. **Done** says the operator
 * has finished there: each of those runs goes on as if the page had moved on
 * by itself.
 */
export function BrowserHandoffCard({
  item,
  origin,
  onResolve,
  resolveState,
  errorMessage,
  backlinks,
}: BrowserHandoffCardProps): ReactElement {
  const busy = resolveState === 'submitting';
  const canFinish = item.allowedActions.includes('approve');
  const runs = origin.waiting.length;

  return (
    <Card>
      <CardBody>
        <Column gap="sm">
          <Row gap="sm" align="center">
            <Text size="base" weight="semibold">
              {item.title}
            </Text>
            <Badge variant="warning">{REASON[origin.reason]}</Badge>
          </Row>

          <Text size="sm" variant="muted">
            In the browser window on {origin.machineLabel} · profile {origin.profileId} ·{' '}
            {runs === 1 ? '1 run waiting' : `${String(runs)} runs waiting`}
          </Text>

          <Text size="sm">{item.summary}</Text>

          {backlinks}

          {errorMessage && (
            <Text size="sm" style={{ color: 'var(--color-danger-default, #dc2626)' }}>
              {errorMessage}
            </Text>
          )}

          <Row gap="sm" align="center">
            <Button
              variant="primary"
              disabled={!canFinish || busy}
              onClick={() => {
                void onResolve({ kind: 'approve' });
              }}
            >
              {busy ? 'Working…' : (item.uiHints?.approveLabel ?? 'Done')}
            </Button>
          </Row>
        </Column>
      </CardBody>
    </Card>
  );
}
