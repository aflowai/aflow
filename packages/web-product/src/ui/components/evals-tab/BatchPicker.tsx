/**
 * Which run is on screen, and a way to reach a recent one.
 *
 * A select rather than a list: picking one of many is what the control is for,
 * it costs one line whatever the count, and it is reachable from the keyboard
 * without a custom key handler. The list it replaced spent the top of the page
 * on runs nobody had asked to see.
 */
import { Badge, Column, Icon, Row, Select, Text } from '@aflow/design-system';
import type { EvalBatchHeadView } from '@aflow/schemas';

import type { ApiError } from '../../lib/query-client.js';
import { NON_TERMINAL } from './evalsStyles.js';

/** How far back the picker reaches. Older runs are history, not a working set. */
const RECENT_LIMIT = 10;

function optionLabel(batch: EvalBatchHeadView, isBaseline: boolean): string {
  const when = new Date(batch.createdAt).toLocaleString();
  const state = batch.status === 'completed' ? '' : ` · ${batch.status}`;
  return `${when}${state}${isBaseline ? ' · baseline' : ''}`;
}

export function BatchPicker({
  batches,
  selectedBatchId,
  baselineBatchId,
  onSelectBatch,
  batchesError,
  onRetryBatches,
}: {
  batches: EvalBatchHeadView[];
  selectedBatchId: string | null;
  baselineBatchId: string | null | undefined;
  onSelectBatch: (batchId: string) => void;
  batchesError: ApiError | null;
  onRetryBatches: () => void;
}) {
  const selected = batches.find((batch) => batch.batchId === selectedBatchId) ?? batches[0];
  const recent = batches.slice(0, RECENT_LIMIT);

  if (batchesError !== null) {
    return (
      <Row gap="sm" align="center" wrap>
        <Text size="xs" tone="danger">
          Could not load the run list. {batchesError.message}
        </Text>
        <Text size="xs" color="muted" onClick={onRetryBatches} style={{ cursor: 'pointer' }}>
          Retry
        </Text>
      </Row>
    );
  }
  if (selected === undefined) return null;

  return (
    <Column gap="xs">
      <Row gap="sm" align="center" wrap>
        <Text size="xs" color="muted" id="batch-picker-label" style={{ flex: 'none' }}>
          Batch
        </Text>
        {selected.status === 'completed' ? (
          <Icon name="check" size="xs" style={{ color: 'var(--color-success-default)' }} />
        ) : (
          <Badge variant={NON_TERMINAL.has(selected.status) ? 'running' : 'failed'}>
            {selected.status}
          </Badge>
        )}
        <Select
          value={selected.batchId}
          onChange={(event) => {
            onSelectBatch(event.target.value);
          }}
          aria-labelledby="batch-picker-label"
          style={{ maxWidth: 320 }}
        >
          {recent.map((batch) => (
            <option key={batch.batchId} value={batch.batchId}>
              {optionLabel(batch, batch.batchId === baselineBatchId)}
            </option>
          ))}
        </Select>
      </Row>
    </Column>
  );
}
