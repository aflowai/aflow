'use client';

/**
 * STATUS LINE — the one band that never scrolls away: what the newest batch
 * produced, and the control that starts another. It is the answer to "what
 * happened" with no interaction, so it reads the newest batch and offers a
 * way back to it when the panel below is showing an older one.
 */
import { Badge, Button, Column, Icon, Row, Text } from '@aflow/design-system';
import type { EvalBatchHeadView } from '@aflow/schemas';

import type { ApiError } from '../../lib/query-client.js';
import { formatBatchSize, formatTrialTally, type TrialTally } from './evalsDerive.js';
import { STATUS_BADGE } from './evalsStyles.js';

export function EvalsStatusLine({
  latest,
  latestIsSelected,
  latestTally,
  batchesError,
  canLaunch,
  onLaunch,
  onShowLatest,
}: {
  /** The newest batch, or undefined when the list is empty or unreadable. */
  latest: EvalBatchHeadView | undefined;
  /** True when the panel below is showing this same batch. */
  latestIsSelected: boolean;
  /** The newest batch's trial tally — known only while its detail is the loaded one. */
  latestTally: TrialTally | undefined;
  /** Set when the batch list read failed with nothing cached — the list is unknown, not empty. */
  batchesError: ApiError | null;
  canLaunch: boolean;
  onLaunch: () => void;
  onShowLatest: () => void;
}) {
  const tally = latestTally !== undefined ? formatTrialTally(latestTally) : null;

  return (
    <Row
      gap="sm"
      align="center"
      wrap
      style={{
        padding: 'var(--space-2) var(--space-3)',
        border: '1px solid var(--color-border-subtle)',
        borderRadius: 'var(--radius-md)',
        background: 'var(--color-surface-1)',
      }}
    >
      {batchesError !== null ? (
        <Text size="sm" tone="danger">
          The batch list could not be read — no batch is shown. {batchesError.message}
        </Text>
      ) : latest === undefined ? (
        <Column gap="xs">
          <Text size="sm">No batch yet</Text>
          <Text size="xs" color="muted">
            A batch replays every case in the golden dataset against one skill revision.
          </Text>
        </Column>
      ) : (
        <>
          <Text size="xs" color="muted">
            Latest
          </Text>
          <Badge variant={STATUS_BADGE[latest.status]}>{latest.status}</Badge>
          <Text size="sm">{new Date(latest.createdAt).toLocaleString()}</Text>
          {tally !== null ? (
            <Text size="sm" weight="semibold">
              {tally}
            </Text>
          ) : (
            <Text size="xs" color="muted">
              {formatBatchSize(latest)}
            </Text>
          )}
          {!latestIsSelected && (
            <Button variant="ghost" size="sm" onClick={onShowLatest}>
              Show the latest
            </Button>
          )}
        </>
      )}

      <Row gap="xs" align="center" style={{ marginLeft: 'auto' }}>
        <Button
          variant="secondary"
          size="sm"
          onClick={onLaunch}
          disabled={!canLaunch || batchesError !== null}
          title={
            batchesError !== null
              ? 'The batch list could not be read — retry it first so a launch cannot duplicate an existing batch.'
              : canLaunch
                ? undefined
                : 'The dataset needs at least one active case first.'
          }
        >
          <Icon name="play" size="xs" /> Launch batch
        </Button>
      </Row>
    </Row>
  );
}
