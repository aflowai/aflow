'use client';

import { useCallback, useMemo } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigation } from '../components/navigation-provider.js';
import { Button, Column, EmptyState, Icon } from '@aflow/design-system';
import { FlowEditor } from '../components/agent-editor/index.js';
import type { AgentSlug, StepId } from '@aflow/schemas';
import type { AgentDefinition } from '../lib/flow-to-graph.js';
import { useApiMutation, useApiQuery } from '../hooks/useApiQuery.js';
import { useApi, useSpace, useSpaceFromRoute } from '../components/providers.js';
import { spaceRoute } from '../lib/space-routes.js';

export function AgentEditPage() {
  const { agentId } = useParams<{ agentId: string }>();
  const { push } = useNavigation();
  const { activeSpace } = useSpace();
  const routeSpace = useSpaceFromRoute();
  const spaceId = routeSpace?.id ?? '';
  const spaceSlug = routeSpace?.slug ?? activeSpace?.slug;
  const { apiUrl, headers, authFetch } = useApi();
  const searchParams = useSearchParams();
  const fromChat = searchParams.get('from') === 'chat';
  const queryClient = useQueryClient();

  const agentDetailKey = ['space', spaceId, 'agents', agentId] as const;

  const {
    data,
    isLoading,
    error: queryError,
  } = useApiQuery<{ definition: Record<string, unknown> }>({
    key: agentDetailKey,
    path: `/agents/${encodeURIComponent(agentId)}`,
    ...(spaceId ? { spaceId } : {}),
    enabled: !!spaceId,
    staleTime: 60_000,
  });

  const initialFlow = useMemo<AgentDefinition | null>(
    () => (data ? normalizeFlowDef(data.definition) : null),
    [data],
  );
  const error = queryError ? 'Flow not found' : null;

  // Publish mutation — invalidates both the list and this agent's cache
  // entry so the editor's next re-read picks up server-side changes
  // (e.g. auto-chained transitions for steps without explicit next steps).
  const publishMutation = useApiMutation<{ definition: AgentDefinition }>({
    path: '/agents',
    method: 'POST',
    ...(spaceId ? { spaceId } : {}),
    invalidate: spaceId ? [['space', spaceId, 'agents']] : [],
  });

  const handlePublish = useCallback(
    async (flow: AgentDefinition): Promise<AgentDefinition | undefined> => {
      await publishMutation.mutateAsync({ definition: flow });
      // Force the per-agent key to refetch so the editor re-renders with
      // the canonical server shape; await the fetch so we can return the
      // normalized definition to FlowEditor.
      try {
        const refreshed = await queryClient.fetchQuery<{ definition: Record<string, unknown> }>({
          queryKey: ['space', spaceId, 'agents', flow.flowId],
          queryFn: async () => {
            const h = headers();
            if (spaceId) h['X-Space-ID'] = spaceId;
            const res = await authFetch(`${apiUrl}/agents/${encodeURIComponent(flow.flowId)}`, {
              headers: h,
            });
            if (!res.ok) throw new Error('refresh failed');
            return (await res.json()) as { definition: Record<string, unknown> };
          },
        });
        return normalizeFlowDef(refreshed.definition);
      } catch {
        // Non-critical — editor stays with local state.
        return undefined;
      }
    },
    [publishMutation, queryClient, spaceId, apiUrl, headers, authFetch],
  );

  if (!routeSpace || isLoading) {
    return null;
  }

  if (error || !initialFlow) {
    return (
      <div style={{ padding: 'var(--space-8)' }}>
        <EmptyState
          icon={<Icon name="git-branch" size={48} weight="thin" />}
          title="Cannot edit flow"
          description={error ?? 'Flow definition could not be loaded.'}
          action={
            <Button
              variant="secondary"
              onClick={() => {
                push(spaceRoute(spaceSlug, '/agents'));
              }}
            >
              Back to flows
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <Column grow style={{ height: '100%' }}>
      <FlowEditor
        initialFlow={initialFlow}
        onPublish={handlePublish}
        backToChatHref={
          fromChat && agentId
            ? spaceRoute(spaceSlug, `/chat?agentId=${encodeURIComponent(agentId)}`)
            : undefined
        }
      />
    </Column>
  );
}

/**
 * Normalize a flow definition loaded from the API by filling missing fields
 * that older definitions may not have (e.g. stateVariables, metadata.tags).
 */
function normalizeFlowDef(raw: Record<string, unknown>): AgentDefinition {
  const meta = (raw['metadata'] ?? {}) as Record<string, unknown>;
  const rawSteps = (raw['steps'] ?? []) as Array<Record<string, unknown>>;
  const firstStepId = rawSteps[0]?.['stepId'] as string | undefined;

  return {
    schemaVersion: (raw['schemaVersion'] as number) ?? 1,
    flowId: ((raw['slug'] as string) ??
      (raw['flowId'] as string) ??
      (raw['agentId'] as string) ??
      'unknown') as AgentSlug,
    systemRole: (raw['systemRole'] as AgentDefinition['systemRole']) ?? null,
    version: (raw['version'] as string) ?? '1',
    metadata: {
      name:
        (meta['name'] as string) ??
        (raw['agentId'] as string) ??
        (raw['flowId'] as string) ??
        'Untitled',
      description: meta['description'] as string | undefined,
      author: meta['author'] as string | undefined,
      category: meta['category'] as string | undefined,
      tags: (meta['tags'] as string[]) ?? [],
      public: (meta['public'] as boolean) ?? false,
      system: (meta['system'] as boolean) ?? false,
      custom: (meta['custom'] as Record<string, unknown>) ?? {},
    },
    stateVariables: (raw['stateVariables'] as AgentDefinition['stateVariables']) ?? [],
    steps: rawSteps.map((s): AgentDefinition['steps'][0] => {
      const stepType = (s['stepType'] ??
        s['type'] ??
        'ai') as AgentDefinition['steps'][0]['stepType'];
      return {
        stepId: ((s['stepId'] as string) ?? 'step') as StepId,
        stepType,
        operation: ((s['operation'] as string) ??
          `${stepType}.default`) as AgentDefinition['steps'][0]['operation'],
        name: s['name'] as string | undefined,
        description: s['description'] as string | undefined,
        config: (s['config'] as Record<string, unknown>) ?? {},
        outputMapping: s['outputMapping'] as Record<string, string> | undefined,
        outputOptions: s['outputOptions'] as
          AgentDefinition['steps'][0]['outputOptions'] | undefined,
        optional: (s['optional'] as boolean) ?? false,
        condition: s['condition'] as string | undefined,
        tags: (s['tags'] as string[]) ?? [],
        onSuccess: (s['onSuccess'] as {
          next: AgentDefinition['steps'][0]['onSuccess']['next'];
        }) ?? {
          next: [],
        },
        onFailure: (s['onFailure'] as {
          next: AgentDefinition['steps'][0]['onFailure']['next'];
        }) ?? {
          next: [],
        },
        onResume: s['onResume'] as AgentDefinition['steps'][0]['onResume'],
        retryPolicy: s['retryPolicy'] as AgentDefinition['steps'][0]['retryPolicy'],
        timeout: s['timeout'] as AgentDefinition['steps'][0]['timeout'],
      };
    }),
    startStepId: ((raw['startStepId'] as string) ?? firstStepId ?? '') as StepId,
    allowedOperations: (raw['allowedOperations'] as AgentDefinition['allowedOperations']) ?? [],
    supportedModes: (raw['supportedModes'] as AgentDefinition['supportedModes']) ?? ['chat'],
    defaultBudgets: raw['defaultBudgets'] as AgentDefinition['defaultBudgets'],
    inputSchema: raw['inputSchema'] as Record<string, unknown> | undefined,
    outputSchema: raw['outputSchema'] as Record<string, unknown> | undefined,
    status: (raw['status'] as AgentDefinition['status']) ?? 'draft',
  };
}
