'use client';

import { useState } from 'react';
import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import { Badge, Button, Icon, Spinner, Text } from '@aflow/design-system';

import { useApi } from '../providers.js';
import { useCurrentUser } from '../user-avatar.js';
import { useApiQuery } from '../../hooks/useApiQuery.js';

type ResolutionRoute = 'tenant_ratification' | 'platform_issue';

interface ProposalSummary {
  id: string;
  kind: string;
  status: string;
  summary: string;
  rationale: string;
  confidence: string;
  targetWorkflowSlug: string | null;
  opCount: number;
  opKinds: string[];
  resolutionRoute: ResolutionRoute;
  lastRatificationError?: { reason: string; op: string; detail: string; at: string };
}

/** Platform-issue diagnostics target platform-owned artifacts, so they are not
 *  ratifiable in a tenant space — they surface to tenant admins, who dismiss
 *  (acknowledge) rather than ratify/reject. */
const isPlatformIssue = (p: ProposalSummary) => p.resolutionRoute === 'platform_issue';
interface LearningSummary {
  learningId: string;
  statement: string;
  confidence: 'low' | 'medium' | 'high';
  status: 'auto_recorded' | 'proposed' | 'ratified' | 'rejected';
  authorityLevel: 'auto_record' | 'stage_for_review';
  scope: { kind: string };
}

function proposalsKey(spaceId: string, slug: string): QueryKey {
  return ['space', spaceId, 'proposals', { workflowSlug: slug, pendingOnly: true }];
}
function learningsKey(spaceId: string, slug: string): QueryKey {
  return ['space', spaceId, 'workflow', slug, 'learnings'];
}

/** Items needing the operator's attention — drives the collapsed-rail badge.
 *  Shares the panel's query keys, so reading it costs no extra fetch. */
export function useCoachCounts(spaceId: string, slug: string): number {
  const isAdmin = useCurrentUser()?.isAdmin ?? false;
  const proposals = useApiQuery<{ proposals: ProposalSummary[] }>({
    key: proposalsKey(spaceId, slug),
    path: `/spaces/${spaceId}/proposals?workflowSlug=${encodeURIComponent(slug)}&pendingOnly=true`,
    spaceId,
    staleTime: 30_000,
    enabled: !!slug,
  });
  const learnings = useApiQuery<{ learnings: LearningSummary[] }>({
    key: learningsKey(spaceId, slug),
    path: `/spaces/${spaceId}/workflows/${slug}/learnings?limit=30`,
    spaceId,
    staleTime: 30_000,
    enabled: !!slug,
  });
  const pendingProposals = (proposals.data?.proposals ?? [])
    .filter((p) => p.status === 'proposed')
    .filter((p) => isAdmin || !isPlatformIssue(p)).length;
  const pendingLearnings = (learnings.data?.learnings ?? []).filter(
    (l) => l.status === 'proposed',
  ).length;
  return pendingProposals + pendingLearnings;
}

/** The Coach panel — pending proposals to ratify, and the skill's learnings
 *  (its durable memory) to ratify or prune. */
export function CoachPanel({ spaceId, slug }: { spaceId: string; slug: string }) {
  const { apiUrl, headers, authFetch } = useApi();
  const isAdmin = useCurrentUser()?.isAdmin ?? false;
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);

  const proposalsQ = useApiQuery<{ proposals: ProposalSummary[] }>({
    key: proposalsKey(spaceId, slug),
    path: `/spaces/${spaceId}/proposals?workflowSlug=${encodeURIComponent(slug)}&pendingOnly=true`,
    spaceId,
    staleTime: 30_000,
    enabled: !!slug,
  });
  const learningsQ = useApiQuery<{ learnings: LearningSummary[] }>({
    key: learningsKey(spaceId, slug),
    path: `/spaces/${spaceId}/workflows/${slug}/learnings?limit=30`,
    spaceId,
    staleTime: 30_000,
    enabled: !!slug,
  });

  // Platform-issue diagnostics are platform-team concerns — only surface them to
  // tenant admins. Tenant_ratification proposals stay visible to any skill editor.
  const proposals = (proposalsQ.data?.proposals ?? []).filter(
    (p) => isAdmin || !isPlatformIssue(p),
  );
  const learnings = learningsQ.data?.learnings ?? [];

  const act = async (path: string, body: unknown, invalidate: QueryKey, id: string) => {
    setBusy(id);
    try {
      const h = headers();
      h['X-Space-ID'] = spaceId;
      h['Content-Type'] = 'application/json';
      const res = await authFetch(`${apiUrl}${path}`, {
        method: 'POST',
        headers: h,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (res.ok) await qc.invalidateQueries({ queryKey: invalidate });
    } finally {
      setBusy(null);
    }
  };

  const resolveProposal = (id: string, action: 'ratify' | 'reject' | 'dismiss') =>
    void act(
      `/spaces/${spaceId}/proposals/${id}/${action}`,
      undefined,
      proposalsKey(spaceId, slug),
      id,
    );
  const resolveLearning = (id: string, action: 'ratify' | 'reject') =>
    void act(
      `/spaces/${spaceId}/workflows/${slug}/learnings/${id}/resolve`,
      { action },
      learningsKey(spaceId, slug),
      id,
    );

  const loading = proposalsQ.isLoading || learningsQ.isLoading;

  return (
    <div style={{ height: '100%', overflow: 'auto', padding: 'var(--space-md)' }}>
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 'var(--space-sm)' }}
      >
        <Icon name="stethoscope" size="sm" />
        <Text size="base" weight="semibold">
          Coach
        </Text>
      </div>

      {loading && (
        <Row>
          <Spinner size="sm" label="Loading" />
        </Row>
      )}

      <SectionHeader>Proposals</SectionHeader>
      {proposals.length === 0 ? (
        <Hint>No pending proposals.</Hint>
      ) : (
        proposals.map((p) => {
          const platformIssue = isPlatformIssue(p);
          return (
            <Card key={p.id}>
              <div
                style={{
                  display: 'flex',
                  gap: 'var(--space-1)',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                }}
              >
                <Badge variant={platformIssue ? 'info' : 'neutral'}>{p.kind}</Badge>
                {p.confidence && <Badge variant="neutral">{p.confidence}</Badge>}
                {platformIssue && <Badge variant="accent">platform team</Badge>}
              </div>

              <Text size="sm" weight="medium">
                {p.summary || p.kind}
              </Text>
              {p.rationale && (
                <Text size="xs" color="muted">
                  {p.rationale}
                </Text>
              )}

              <MetaLine>
                {p.targetWorkflowSlug ? `target: ${p.targetWorkflowSlug}` : null}
                {p.opKinds.length > 0 ? `ops: ${p.opKinds.join(', ')}` : null}
              </MetaLine>

              {p.lastRatificationError && (
                <Text size="xs" tone="danger">
                  Last apply failed ({p.lastRatificationError.op}): {p.lastRatificationError.detail}
                </Text>
              )}

              {platformIssue ? (
                <>
                  <Text size="xs" color="muted">
                    Platform issues are diagnostics for the platform team and can&apos;t be ratified
                    here. Dismiss to clear it from the queue — the Coach stays free to re-flag it on
                    later runs.
                  </Text>
                  <Actions>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy === p.id}
                      onClick={() => {
                        resolveProposal(p.id, 'dismiss');
                      }}
                    >
                      Dismiss
                    </Button>
                  </Actions>
                </>
              ) : (
                <Actions>
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={busy === p.id}
                    onClick={() => {
                      resolveProposal(p.id, 'ratify');
                    }}
                  >
                    Ratify
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy === p.id}
                    onClick={() => {
                      resolveProposal(p.id, 'reject');
                    }}
                  >
                    Reject
                  </Button>
                </Actions>
              )}
            </Card>
          );
        })
      )}

      <SectionHeader>Learnings · the skill&apos;s memory</SectionHeader>
      {learnings.length === 0 ? (
        <Hint>No learnings yet. The Coach records these from run evidence.</Hint>
      ) : (
        learnings.map((l) => {
          // Only `stage_for_review` learnings land as `proposed` and await
          // ratification; `auto_record` ones are already active — for those the
          // only meaningful action is to prune (reject) a wrong/redundant one.
          const pending = l.status === 'proposed';
          const rejected = l.status === 'rejected';
          return (
            <Card key={l.learningId}>
              <div
                style={{
                  display: 'flex',
                  gap: 'var(--space-1)',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                }}
              >
                <Badge variant="neutral">{l.scope.kind}</Badge>
                <Badge variant="neutral">{l.confidence}</Badge>
                <Badge variant={pending ? 'warning' : rejected ? 'danger' : 'success'}>
                  {l.status}
                </Badge>
              </div>
              <Text size="sm">{l.statement}</Text>
              {!rejected && (
                <Actions>
                  {pending && (
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={busy === l.learningId}
                      onClick={() => {
                        resolveLearning(l.learningId, 'ratify');
                      }}
                    >
                      Ratify
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy === l.learningId}
                    onClick={() => {
                      resolveLearning(l.learningId, 'reject');
                    }}
                    title={pending ? 'Decline this learning' : 'Prune this learning'}
                  >
                    {pending ? 'Reject' : 'Prune'}
                  </Button>
                </Actions>
              )}
            </Card>
          );
        })
      )}
    </div>
  );
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <Text
      size="xs"
      weight="semibold"
      color="muted"
      style={{ display: 'block', textTransform: 'uppercase', margin: 'var(--space-md) 0 4px' }}
    >
      {children}
    </Text>
  );
}
function Card({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-md)',
        padding: 'var(--space-lg)',
        marginBottom: 6,
        borderRadius: 'var(--radius-lg)',
        background: 'var(--color-surface-2)',
      }}
    >
      {children}
    </div>
  );
}
function Actions({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'flex', gap: 'var(--space-xs)' }}>{children}</div>;
}
function MetaLine({ children }: { children: React.ReactNode }) {
  const items = Array.isArray(children) ? children.filter(Boolean) : children ? [children] : [];
  if (items.length === 0) return null;
  return (
    <div style={{ display: 'flex', gap: 'var(--space-md)', flexWrap: 'wrap' }}>
      {items.map((item, i) => (
        <Text key={i} size="xs" color="muted" style={{ fontFamily: 'var(--font-family-mono)' }}>
          {item}
        </Text>
      ))}
    </div>
  );
}
function Hint({ children }: { children: React.ReactNode }) {
  return (
    <Text size="xs" color="muted">
      {children}
    </Text>
  );
}
function Row({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--space-md)' }}>
      {children}
    </div>
  );
}
