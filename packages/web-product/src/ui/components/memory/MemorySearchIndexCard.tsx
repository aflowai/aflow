'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  Badge,
  Button,
  Card,
  CardBody,
  Column,
  Dialog,
  Field,
  Heading,
  Row,
  Select,
  Text,
} from '@aflow/design-system';
import type { EmbeddingModelChoice, SpaceMemoryEmbedding } from '@aflow/schemas';
import { useApiMutation } from '../../hooks/useApiQuery.js';
import { memoryEmbeddingKey, useSpaceMemoryEmbedding } from '../../hooks/use-memory-embedding.js';
import { spaceRoute } from '../../lib/space-routes.js';

function formatCost(tokens: number, pricePer1M: number | null): string {
  if (pricePer1M === null) return 'an unpriced amount';
  const usd = (tokens / 1_000_000) * pricePer1M;
  return usd < 0.01 ? 'under $0.01' : `about $${usd.toFixed(2)}`;
}

function modelLabel(choice: EmbeddingModelChoice): string {
  return `${choice.displayName} (${choice.provider})`;
}

/** Documents a model switch embeds again: every one not excluded from indexing. */
function reindexCount(docs: SpaceMemoryEmbedding['documents']): number {
  return (docs.indexed ?? 0) + (docs.pending ?? 0) + (docs.failed ?? 0) + (docs.unconfigured ?? 0);
}

export function MemorySearchIndexCard({
  spaceId,
  spaceSlug,
  canEdit,
}: {
  spaceId: string;
  spaceSlug: string | undefined;
  canEdit: boolean;
}) {
  const { data, isLoading, error } = useSpaceMemoryEmbedding(spaceId);
  const [proposed, setProposed] = useState<EmbeddingModelChoice | null>(null);
  const key = memoryEmbeddingKey(spaceId);

  const choose = useApiMutation<{ model: string }, SpaceMemoryEmbedding>({
    path: `/spaces/${spaceId}/memory/embedding`,
    method: 'PUT',
    invalidate: [key],
    onSuccess: () => {
      setProposed(null);
    },
  });
  const retry = useApiMutation<undefined, SpaceMemoryEmbedding>({
    path: `/spaces/${spaceId}/memory/embedding/retry`,
    invalidate: [key],
  });

  if (isLoading) return <Text variant="muted">Loading…</Text>;
  if (error) return <Text tone="danger">{error.message}</Text>;
  if (!data) return null;

  const docs = data.documents;
  const pending = docs.pending ?? 0;
  const failed = docs.failed ?? 0;
  const unconfigured = docs.unconfigured ?? 0;
  const retryable = failed + unconfigured;
  const credentialsHref = spaceRoute(spaceSlug, '/settings/credentials');

  return (
    <Card>
      <CardBody>
        <Column gap="md">
          <Column gap="xs">
            <Row gap="sm" align="center" wrap>
              <Heading level={4}>Search index</Heading>
              {data.state === 'ready' ? (
                <Badge variant="success">Searches by meaning</Badge>
              ) : (
                <Badge variant="warning">Keyword search only</Badge>
              )}
            </Row>
            <Text variant="muted">
              Memory is searched by meaning through an embedding model. Every document in a space is
              embedded by the same model, so changing it embeds them all again.
            </Text>
          </Column>

          {data.model && (
            <Text>
              {modelLabel(data.model)}
              {data.funding === 'space' && ' — billed to this space’s key'}
              {data.funding === 'platform' && ' — provided by the platform'}
              {!data.pinned && ' — chosen by default, kept once the first document is indexed'}
            </Text>
          )}

          {data.reason && (
            <Column gap="xs">
              <Text tone="warning">{data.reason}</Text>
              <Link
                href={credentialsHref}
                style={{ color: 'var(--color-content-link)', fontSize: 'var(--font-size-sm)' }}
              >
                Open Credentials →
              </Link>
            </Column>
          )}

          <Row gap="sm" wrap>
            <Badge variant="neutral">{docs.indexed ?? 0} indexed</Badge>
            {pending > 0 && <Badge variant="info">{pending} waiting to be embedded</Badge>}
            {unconfigured > 0 && (
              <Badge variant="warning">{unconfigured} waiting for a provider</Badge>
            )}
            {failed > 0 && <Badge variant="failed">{failed} failed</Badge>}
            {(docs.disabled ?? 0) > 0 && (
              <Badge variant="neutral">{docs.disabled} not indexed</Badge>
            )}
          </Row>

          {data.lastError && (
            <Text size="sm" tone="danger">
              Latest failure, {data.lastError.path}: {data.lastError.message}
            </Text>
          )}

          {canEdit && (
            <Row gap="sm" align="end" wrap>
              <Field label="Embedding model" htmlFor="memory-embedding-model">
                <Select
                  id="memory-embedding-model"
                  value={data.model?.id ?? ''}
                  placeholder="Choose a model"
                  onChange={(e) => {
                    const next = data.choices.find((c) => c.id === e.target.value);
                    if (next && next.id !== data.model?.id) setProposed(next);
                  }}
                  disabled={choose.isPending}
                >
                  {data.choices.map((c) => (
                    <option key={c.id} value={c.id} disabled={!c.available}>
                      {modelLabel(c)}
                      {c.available ? '' : ` — ${c.unavailableReason ?? 'unavailable'}`}
                    </option>
                  ))}
                </Select>
              </Field>
              {retryable > 0 && data.state === 'ready' && (
                <Button
                  variant="secondary"
                  onClick={() => {
                    retry.mutate(undefined);
                  }}
                  disabled={retry.isPending}
                >
                  Embed {retryable} again
                </Button>
              )}
            </Row>
          )}
          {(choose.error ?? retry.error) && (
            <Text tone="danger">{(choose.error ?? retry.error)?.message}</Text>
          )}
        </Column>
      </CardBody>

      <Dialog
        open={proposed !== null}
        onClose={() => {
          setProposed(null);
        }}
        title="Change the embedding model?"
        width="sm"
        footer={
          <Row gap="sm" justify="end">
            <Button
              variant="ghost"
              onClick={() => {
                setProposed(null);
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (proposed) choose.mutate({ model: proposed.id });
              }}
              disabled={choose.isPending}
            >
              Re-index with {proposed?.displayName}
            </Button>
          </Row>
        }
      >
        {proposed && (
          <Column gap="sm">
            <Text>
              {reindexCount(docs)} documents will be embedded again with {modelLabel(proposed)}:
              about {data.reindexTokens.toLocaleString()} tokens,{' '}
              {formatCost(data.reindexTokens, proposed.pricePer1M)}.
            </Text>
            <Text variant="muted">
              Search keeps working meanwhile: documents already embedded with the new model are
              found by meaning, the rest by keyword, until every document is done.
            </Text>
          </Column>
        )}
      </Dialog>
    </Card>
  );
}
