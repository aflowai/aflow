'use client';

import { Button, Row, Text } from '@aflow/design-system';
import { useApiMutation } from '../../hooks/useApiQuery.js';
import { llmReadinessQueryKey, type LocalFit } from '../../hooks/useSpaceLlmReadiness.js';
import { localModelsQueryKey } from '../../hooks/useLocalModels.js';
import { describeLocalFit } from './ModelDefaultsEditor.js';

const gb = (bytes: number): string => `${(bytes / 1e9).toFixed(1)} GB`;

/**
 * What a model on this computer is doing right now, and the operator's two
 * actions on it: load it before the first request has to, or unload it to give
 * the machine its memory back (Plan 323 D8, D10). A loaded model holds every
 * conversation's cache it has read, so the loaded size is shown beside what
 * the GPU allows — past it the model is spilling, which is the slowness.
 */
export function LocalModelStatus({
  spaceId,
  model,
  fit,
}: {
  spaceId: string;
  model: string;
  fit: LocalFit;
}) {
  const action = useApiMutation<{ action: 'warm' | 'unload' }>({
    path: () => `/spaces/${spaceId}/local-models/actions`,
    serialize: ({ action: which }) => JSON.stringify({ action: which, model }),
    spaceId,
    invalidate: [llmReadinessQueryKey(spaceId), localModelsQueryKey(spaceId)],
  });
  const spilling =
    fit.loadedBytes !== null &&
    fit.gpuWorkingSetBytes !== null &&
    fit.loadedBytes > fit.gpuWorkingSetBytes;

  return (
    <div style={{ marginTop: 'var(--space-1)' }}>
      <Text
        size="xs"
        variant="muted"
        style={{
          display: 'block',
          ...(fit.status === 'does_not_fit' ? { color: 'var(--color-status-warning)' } : {}),
        }}
      >
        {describeLocalFit(fit)}
      </Text>
      <Row gap="2" align="center" style={{ marginTop: 'var(--space-1)', flexWrap: 'wrap' }}>
        <Text
          size="xs"
          variant="muted"
          style={spilling ? { color: 'var(--color-status-warning)' } : undefined}
        >
          {!fit.runtimeReachable
            ? 'Ollama is not answering on this computer.'
            : fit.loadedBytes === null
              ? 'Not loaded — the first request loads it, which takes a minute or more.'
              : spilling
                ? `Loaded at ${gb(fit.loadedBytes)}, past the ${gb(fit.gpuWorkingSetBytes ?? 0)} the GPU allows: it holds the cache of every conversation it has read, and is spilling. Unloading frees it.`
                : `Loaded, ${gb(fit.loadedBytes)}.`}
        </Text>
        {fit.runtimeReachable && (
          <Button
            variant="ghost"
            size="sm"
            loading={action.isPending}
            onClick={() => {
              action.mutate({ action: fit.loadedBytes === null ? 'warm' : 'unload' });
            }}
          >
            {fit.loadedBytes === null ? 'Load now' : 'Unload'}
          </Button>
        )}
      </Row>
    </div>
  );
}
