'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  CardBody,
  Column,
  Heading,
  Row,
  Spinner,
  Text,
} from '@aflow/design-system';

import { useApi } from './providers.js';
import { ProposalCard } from './cybernetic/ProposalCard.js';
import type { ProposalCardPayload, ProposalCardSummary } from './cybernetic/ProposalCard.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProposalSummary extends ProposalCardSummary {
  opCount: number;
  expiresAt: string;
}

interface ProposalDetail {
  id: string;
  kind: string;
  status: string;
  source?: string;
  proposal: {
    summary: string;
    rationale: string;
    confidence: string;
    ops: Array<{ op: string; [key: string]: unknown }>;
    validations?: ProposalCardPayload['proposal']['validations'];
  };
  evidence: {
    sourceSessionIds: string[];
    reflectionRefs?: Array<{
      runId: string;
      taskId: string;
      reflectionField: string;
      excerpt: string;
    }>;
  };
  proposedAt: string;
  expiresAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface ProposalsTabProps {
  spaceId: string;
  workflowSlug: string;
}

export function ProposalsTab({ spaceId, workflowSlug }: ProposalsTabProps) {
  const { apiUrl, headers } = useApi();
  const [proposals, setProposals] = useState<ProposalSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const url = new URL(`${apiUrl}/spaces/${spaceId}/proposals`, window.location.origin);
      url.searchParams.set('pendingOnly', showResolved ? 'false' : 'true');
      url.searchParams.set('workflowSlug', workflowSlug);
      const res = await fetch(url.toString(), {
        headers: { ...headers(), 'X-Space-ID': spaceId },
      });
      if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
      const body = (await res.json()) as { proposals: ProposalSummary[] };
      setProposals(body.proposals);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load proposals');
    } finally {
      setLoading(false);
    }
  }, [apiUrl, headers, spaceId, workflowSlug, showResolved]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const loadDetail = useCallback(
    async (proposalId: string): Promise<ProposalCardPayload | null> => {
      try {
        const res = await fetch(`${apiUrl}/spaces/${spaceId}/proposals/${proposalId}`, {
          headers: { ...headers(), 'X-Space-ID': spaceId },
        });
        if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
        const body = (await res.json()) as { proposal: ProposalDetail };
        return {
          kind: body.proposal.kind,
          proposal: {
            ops: body.proposal.proposal.ops,
            validations: body.proposal.proposal.validations,
          },
          ...(body.proposal.evidence.reflectionRefs
            ? { evidence: { reflectionRefs: body.proposal.evidence.reflectionRefs } }
            : {}),
        };
      } catch {
        return null;
      }
    },
    [apiUrl, headers, spaceId],
  );

  const handleAction = useCallback(
    async (proposalId: string, action: 'ratify' | 'reject') => {
      try {
        const res = await fetch(`${apiUrl}/spaces/${spaceId}/proposals/${proposalId}/${action}`, {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify({}),
        });
        if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
        void reload();
      } catch {
        // TODO: surface error
      }
    },
    [apiUrl, headers, spaceId, reload],
  );

  if (loading && proposals.length === 0) {
    return (
      <Row justify="center" style={{ padding: 'var(--space-6)' }}>
        <Spinner size="md" label="Loading proposals" />
      </Row>
    );
  }

  if (error) {
    return (
      <div style={{ padding: 'var(--space-5)' }}>
        <Card>
          <CardBody>
            <Column gap="sm">
              <Row gap="sm" align="center">
                <Heading level={5}>Could not load proposals</Heading>
              </Row>
              <Text size="sm" variant="muted">
                {error}
              </Text>
              <Row>
                <Button variant="secondary" size="sm" onClick={() => void reload()}>
                  Retry
                </Button>
              </Row>
            </Column>
          </CardBody>
        </Card>
      </div>
    );
  }

  return (
    <div style={{ padding: 'var(--space-5)' }}>
      <Column gap="md">
        <Row gap="sm" align="center" wrap>
          <Heading level={5}>Proposals</Heading>
          <Badge variant="neutral">{String(proposals.length)}</Badge>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setShowResolved((v) => !v);
            }}
            style={{ marginLeft: 'auto' }}
          >
            {showResolved ? 'Pending only' : 'Show all'}
          </Button>
        </Row>

        {proposals.length === 0 ? (
          <Card>
            <CardBody>
              <Text size="sm" variant="muted">
                {showResolved
                  ? 'No proposals for this workflow yet.'
                  : 'No pending proposals. The Coach has nothing to suggest right now.'}
              </Text>
            </CardBody>
          </Card>
        ) : (
          proposals.map((p) => (
            <ProposalCard
              key={p.id}
              proposal={p}
              spaceId={spaceId}
              loadDetail={loadDetail}
              onRatify={() => void handleAction(p.id, 'ratify')}
              onReject={() => void handleAction(p.id, 'reject')}
            />
          ))
        )}
      </Column>
    </div>
  );
}
