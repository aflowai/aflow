'use client';

import { useState, useEffect, useCallback } from 'react';
import type { IconRef } from '@aflow/schemas';
import type { IntegrationCredentialMeta } from '../../hooks/use-integrations.js';
export type { IntegrationCredentialMeta };
import { useApi } from '../providers.js';
import { apiErrorFromResponse } from '../../lib/query-client.js';

export interface McpServerDefinitionSummary {
  serverId: string;
  name: string;
  description: string | null;
  serverUrl: string;
  transport: string;
  tags: string[];
  source: string;
  enabled: boolean;
  spaceId: string;
  observedProtocolVersion: string | null;
  /** Store-listing branding, present only for an installed connector. */
  icon?: IconRef;
  toolFilter: {
    include?: string[];
    exclude?: string[];
    opTaskOnly?: string[];
  } | null;
  createdAt: string;
  updatedAt: string;
}

export interface McpServerBindingSummary {
  bindingId: string;
  serverId: string;
  name: string;
  description: string | null;
  scope: Record<string, unknown>;
  authType: string;
  auth: Record<string, unknown>;
  credentialKeys: string[];
  connectionPolicy: Record<string, unknown>;
  subscribeListChanged: boolean;
  samplingPolicy: string;
  ownerScope?: 'user' | 'space';
  clientScope?: 'platform' | 'tenant' | 'space';
  pinnedOrigin: string | null;
  cachedToolCount: number | null;
  cachedToolsAt: string | null;
  cachedToolNames: string[] | null;
  sessionMetadata: Record<string, unknown> | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface McpToolFilter {
  include?: string[];
  exclude?: string[];
  opTaskOnly?: string[];
}

export interface SaveMcpServerInput {
  serverId: string;
  name: string;
  description?: string;
  serverUrl: string;
  transport?: 'streamable_http';
  tags?: string[];
  source?: 'platform' | 'custom' | 'discovered' | 'bundle';
  protectedResourceMetadataPath?: string;
  toolFilter?: McpToolFilter;
}

export interface SaveMcpBindingInput {
  bindingId: string;
  serverId: string;
  name: string;
  description?: string;
  scope: { flowId?: string | undefined };
  auth: Record<string, unknown>;
  connectionPolicy?: Record<string, unknown>;
  subscribeListChanged?: boolean;
  samplingPolicy?: 'off' | 'no_tools' | 'full';
  ownerScope?: 'user' | 'space';
  clientScope?: 'platform' | 'tenant' | 'space';
  enabled?: boolean;
}

export interface McpBindingTestResult {
  ok: boolean;
  message?: string;
  errorCode?: string;
}

export function useMcpIntegrations() {
  const { apiUrl, headers } = useApi();
  const [definitions, setDefinitions] = useState<McpServerDefinitionSummary[]>([]);
  const [bindings, setBindings] = useState<McpServerBindingSummary[]>([]);
  const [credentials, setCredentials] = useState<IntegrationCredentialMeta[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [defRes, bindRes, credRes] = await Promise.all([
        fetch(`${apiUrl}/integrations/mcp/servers`, { headers: headers() }),
        fetch(`${apiUrl}/integrations/mcp/bindings`, { headers: headers() }),
        fetch(`${apiUrl}/integrations/credentials`, { headers: headers() }),
      ]);
      if (defRes.ok) {
        const d = (await defRes.json()) as { definitions?: McpServerDefinitionSummary[] };
        setDefinitions(d.definitions ?? []);
      }
      if (bindRes.ok) {
        const d = (await bindRes.json()) as { bindings?: McpServerBindingSummary[] };
        setBindings(d.bindings ?? []);
      }
      if (credRes.ok) {
        const d = (await credRes.json()) as { credentials?: IntegrationCredentialMeta[] };
        setCredentials(d.credentials ?? []);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch MCP integrations');
    } finally {
      setIsLoading(false);
    }
  }, [apiUrl, headers]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const saveDefinition = useCallback(
    async (input: SaveMcpServerInput) => {
      const res = await fetch(`${apiUrl}/integrations/mcp/servers`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(input),
      });
      if (!res.ok) throw await apiErrorFromResponse(res, 'Failed to save MCP server');
      await refresh();
    },
    [apiUrl, headers, refresh],
  );

  const deleteDefinition = useCallback(
    async (serverId: string) => {
      const res = await fetch(
        `${apiUrl}/integrations/mcp/servers/${encodeURIComponent(serverId)}`,
        { method: 'DELETE', headers: headers() },
      );
      if (!res.ok) throw new Error(await readError(res, 'Failed to delete MCP server'));
      await refresh();
    },
    [apiUrl, headers, refresh],
  );

  const saveBinding = useCallback(
    async (input: SaveMcpBindingInput) => {
      const res = await fetch(`${apiUrl}/integrations/mcp/bindings`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(input),
      });
      if (!res.ok) throw await apiErrorFromResponse(res, 'Failed to save MCP binding');
      await refresh();
    },
    [apiUrl, headers, refresh],
  );

  /**
   * PUT a credential value against a credential key. Mirrors the API
   * integrations' `saveCredential` — both flows write into the shared
   * `/integrations/credentials` table (encrypted at rest).
   */
  const saveCredential = useCallback(
    async (credentialKey: string, value: string, label: string, description?: string) => {
      const res = await fetch(
        `${apiUrl}/integrations/credentials/${encodeURIComponent(credentialKey)}`,
        {
          method: 'PUT',
          headers: headers(),
          body: JSON.stringify({ value, label, ...(description ? { description } : {}) }),
        },
      );
      if (!res.ok) throw new Error(await readError(res, 'Failed to save credential'));
      await refresh();
    },
    [apiUrl, headers, refresh],
  );

  const deleteCredential = useCallback(
    async (credentialKey: string) => {
      const res = await fetch(
        `${apiUrl}/integrations/credentials/${encodeURIComponent(credentialKey)}`,
        { method: 'DELETE', headers: headers() },
      );
      if (!res.ok && res.status !== 404 && res.status !== 409) {
        throw new Error(await readError(res, 'Failed to delete credential'));
      }
      await refresh();
    },
    [apiUrl, headers, refresh],
  );

  const testBinding = useCallback(
    async (bindingId: string): Promise<McpBindingTestResult> => {
      const res = await fetch(`${apiUrl}/sessions?wait=30s`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          agentConfig: {
            name: `mcp-binding-test-${bindingId}`,
            steps: [
              {
                stepId: 'test',
                type: 'mcp',
                operation: 'mcp.binding.test',
                config: { bindingId },
              },
            ],
          },
          input: {},
        }),
      });
      if (!res.ok) {
        return { ok: false, message: await readError(res, 'Failed to start test session') };
      }
      const body = (await res.json()) as {
        status: string;
        error?: { code?: string; message?: string };
      };
      await refresh();
      if (body.status === 'SUCCEEDED') return { ok: true };
      return {
        ok: false,
        ...(body.error?.message ? { message: body.error.message } : {}),
        ...(body.error?.code ? { errorCode: body.error.code } : {}),
      };
    },
    [apiUrl, headers, refresh],
  );

  return {
    definitions,
    bindings,
    credentials,
    isLoading,
    error,
    refresh,
    saveDefinition,
    deleteDefinition,
    saveBinding,
    saveCredential,
    deleteCredential,
    testBinding,
  };
}

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string; error?: string };
    return body.message ?? body.error ?? fallback;
  } catch {
    return fallback;
  }
}
