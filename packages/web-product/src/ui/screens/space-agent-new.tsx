'use client';

import { useCallback } from 'react';
import { useNavigation } from '../components/navigation-provider.js';
import { Column } from '@aflow/design-system';
import { FlowEditor } from '../components/agent-editor/index.js';
import { createBlankFlow } from '../lib/flow-to-graph.js';
import type { AgentDefinition } from '../lib/flow-to-graph.js';
import { useApiMutation } from '../hooks/useApiQuery.js';
import { useSpace, useSpaceFromRoute } from '../components/providers.js';
import { spaceRoute } from '../lib/space-routes.js';

export function AgentNewPage() {
  const { push } = useNavigation();
  const { activeSpace } = useSpace();
  const routeSpace = useSpaceFromRoute();
  const spaceId = routeSpace?.id ?? '';
  const spaceSlug = routeSpace?.slug ?? activeSpace?.slug;

  const createMutation = useApiMutation<{ definition: AgentDefinition }, { agentId: string }>({
    path: '/agents',
    method: 'POST',
    ...(spaceId ? { spaceId } : {}),
    invalidate: spaceId ? [['space', spaceId, 'agents']] : [],
  });

  const handlePublish = useCallback(
    async (flow: AgentDefinition): Promise<AgentDefinition | undefined> => {
      const data = await createMutation.mutateAsync({ definition: flow });
      // Navigate to the newly created agent (component unmounts, no need to return definition)
      push(spaceRoute(spaceSlug, `/agents/${encodeURIComponent(data.agentId)}`));
      return undefined;
    },
    [createMutation, push, spaceSlug],
  );

  const blankFlow = createBlankFlow();

  return (
    <Column grow style={{ height: '100%' }}>
      <FlowEditor initialFlow={blankFlow} onPublish={handlePublish} />
    </Column>
  );
}
