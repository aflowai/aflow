'use client';

import { useMemo } from 'react';
import { useApiQuery } from './useApiQuery.js';
import type {
  McpServerBindingSummary,
  McpServerDefinitionSummary,
} from '../components/integrations-mcp/use-mcp-integrations.js';

/**
 * Read-only MCP inventory for a space, through the shared cache.
 *
 * The integrations *page* uses `useMcpIntegrations`, which owns the whole
 * write surface and holds its lists in local state. Surfaces that only need to
 * know what exists — the Workbench board, badges — read through here instead so
 * the answer is space-keyed and shared rather than refetched per mount.
 */
export function useMcpServers(spaceId: string) {
  const serversQuery = useApiQuery<{ definitions?: McpServerDefinitionSummary[] }>({
    key: ['space', spaceId, 'integrations', 'mcp', 'servers'],
    path: '/integrations/mcp/servers',
    spaceId,
    enabled: !!spaceId,
    staleTime: 30_000,
  });
  const bindingsQuery = useApiQuery<{ bindings?: McpServerBindingSummary[] }>({
    key: ['space', spaceId, 'integrations', 'mcp', 'bindings'],
    path: '/integrations/mcp/bindings',
    spaceId,
    enabled: !!spaceId,
    staleTime: 30_000,
  });

  const servers = useMemo(() => serversQuery.data?.definitions ?? [], [serversQuery.data]);
  const bindings = useMemo(() => bindingsQuery.data?.bindings ?? [], [bindingsQuery.data]);

  return {
    servers,
    bindings,
    isLoading: serversQuery.isLoading || bindingsQuery.isLoading,
  };
}
