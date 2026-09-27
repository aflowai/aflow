'use client';

import { useMemo } from 'react';
import type { ListingAvatarKind } from '@aflow/design-system';
import type { IconRef } from '@aflow/schemas';

import { useIntegrations, type ApiBindingSummary } from './use-integrations.js';
import { useMcpServers } from './use-mcp-servers.js';
import { useOAuthConnections } from './use-oauth-connections.js';
import { useRepoBindings } from './use-repo-bindings.js';
import { getApiStatus, type ApiStatus } from '../components/integrations-api/helpers.js';
import { getMcpReadiness } from '../components/integrations-mcp/mcpReadiness.js';
import {
  displayCoordinate,
  getReadiness as getRepoReadiness,
} from '../components/integrations-repo/repoReadiness.js';

/**
 * Whether the agent can reach this integration, in the three answers a glance
 * needs. The management page states the precise reason on the card; a board that
 * has one dot per integration only has to separate "fine", "you have to do
 * something", and "off / not wired up" — with `detail` carrying the specific
 * wording so the tooltip never loses it.
 */
export type IntegrationReadiness = 'ready' | 'attention' | 'error' | 'idle';

/**
 * What the integration *does for the agent*, which is a coarser and more useful
 * split than the substrate. An API and an MCP server both hand the agent things
 * to call and differ only in protocol; a repo binding hands the coding lane a
 * checkout it can branch and push. Listing all three as undifferentiated
 * "integrations" invites the one mistake that matters — reading a repo binding as
 * a GitHub API connection, when they grant entirely different authority.
 */
export type IntegrationFamily = 'callable' | 'code';

export interface SpaceIntegration {
  key: string;
  kind: 'api' | 'mcp' | 'repo';
  family: IntegrationFamily;
  name: string;
  /** Store-listing branding; absent for anything hand-added (initials fallback). */
  icon?: IconRef;
  avatarKind: ListingAvatarKind;
  readiness: IntegrationReadiness;
  /** The precise state, as the management page words it. */
  detail: string;
}

/** Readiness ranking so the worst state of a definition's connections wins. */
const API_STATUS_RANK: Record<ApiStatus, number> = {
  needs_setup: 0,
  needs_secret: 1,
  not_connected: 2,
  ready: 3,
};

const API_STATUS_VIEW: Record<ApiStatus, { readiness: IntegrationReadiness; detail: string }> = {
  ready: { readiness: 'ready', detail: 'Ready' },
  needs_setup: { readiness: 'attention', detail: 'Needs setup' },
  needs_secret: { readiness: 'attention', detail: 'Needs secret' },
  not_connected: { readiness: 'idle', detail: 'Not connected' },
};

/**
 * Everything the agent can reach in this space — promoted APIs, MCP servers, and
 * coding-lane repos — flattened into one list with a readiness per entry.
 *
 * Readiness is **not** a stored field on any of the three: it is recomputed from
 * live connection, credential, and OAuth state by the same three functions the
 * integrations page renders its cards from. This hook composes them; it does not
 * restate them, so a change to what "ready" means lands on both surfaces at once.
 */
export function useSpaceIntegrations(spaceId: string) {
  const api = useIntegrations(spaceId);
  const mcp = useMcpServers(spaceId);
  const repo = useRepoBindings(spaceId);
  const { connections } = useOAuthConnections();

  const credentialsByKey = useMemo(
    () => new Map(api.credentials.map((c) => [c.credentialKey, c])),
    [api.credentials],
  );

  const integrations = useMemo<SpaceIntegration[]>(() => {
    const bindingsByApiId = new Map<string, ApiBindingSummary[]>();
    for (const b of api.bindings) {
      const list = bindingsByApiId.get(b.apiId) ?? [];
      list.push(b);
      bindingsByApiId.set(b.apiId, list);
    }
    const connectionsById = new Map(api.bindings.map((b) => [b.bindingId, b]));
    const firstMcpBindingByServerId = new Map<string, (typeof mcp.bindings)[number]>();
    for (const b of mcp.bindings) {
      if (!firstMcpBindingByServerId.has(b.serverId)) firstMcpBindingByServerId.set(b.serverId, b);
    }

    const items: SpaceIntegration[] = [];

    for (const def of api.definitions) {
      const requiredVariables = (def.variables ?? []).filter((v) => v.required).map((v) => v.name);
      // A connection's connect-once identity is the API definition id — the same
      // value the executor passes as the OAuth `resourceKey`.
      const oauthConnected =
        connections.find((c) => c.integrationKind === 'api' && c.resourceKey === def.apiId)
          ?.status === 'connected';
      const bindings = bindingsByApiId.get(def.apiId) ?? [];
      const status = bindings.length
        ? bindings
            .map((b) => getApiStatus(b, credentialsByKey, requiredVariables, oauthConnected))
            .reduce((best, next) => (API_STATUS_RANK[next] > API_STATUS_RANK[best] ? next : best))
        : getApiStatus(undefined, credentialsByKey, requiredVariables, oauthConnected);
      items.push({
        key: `api:${def.apiId}`,
        kind: 'api',
        family: 'callable',
        name: def.name,
        ...(def.icon ? { icon: def.icon } : {}),
        avatarKind: 'connector',
        ...API_STATUS_VIEW[status],
      });
    }

    for (const server of mcp.servers) {
      const readiness = getMcpReadiness(
        firstMcpBindingByServerId.get(server.serverId),
        credentialsByKey,
      );
      items.push({
        key: `mcp:${server.serverId}`,
        kind: 'mcp',
        family: 'callable',
        name: server.name,
        ...(server.icon ? { icon: server.icon } : {}),
        avatarKind: 'connector',
        readiness:
          readiness === 'connected'
            ? 'ready'
            : readiness === 'needs_secret' || readiness === 'not_connected'
              ? 'attention'
              : 'idle',
        detail:
          readiness === 'connected'
            ? 'Connected'
            : readiness === 'needs_secret'
              ? 'Needs secret'
              : readiness === 'paused'
                ? 'Paused'
                : 'Not connected',
      });
    }

    for (const binding of repo.repoBindings) {
      if (binding.status === 'archived') continue;
      const readiness = getRepoReadiness(binding, credentialsByKey, connectionsById);
      items.push({
        key: `repo:${binding.repoDesignationId}`,
        kind: 'repo',
        family: 'code',
        name: displayCoordinate(binding.coordinate),
        // Deliberately the git glyph and never the host's brand mark: a repo
        // binding wearing the GitHub logo is indistinguishable from the GitHub
        // REST connector, and the two grant different authority.
        icon: { kind: 'phosphor', name: 'git-branch' },
        avatarKind: 'repo',
        readiness:
          readiness === 'ready'
            ? 'ready'
            : readiness === 'error'
              ? 'error'
              : readiness === 'needs_credential'
                ? 'attention'
                : 'idle',
        detail:
          readiness === 'ready'
            ? 'Ready'
            : readiness === 'error'
              ? 'Error'
              : readiness === 'needs_credential'
                ? 'Needs credential'
                : 'Provisioning',
      });
    }

    // Anything the operator has to act on leads; the rest reads alphabetically.
    const rank: Record<IntegrationReadiness, number> = {
      error: 0,
      attention: 1,
      ready: 2,
      idle: 3,
    };
    return items.sort(
      (a, b) =>
        rank[a.readiness] - rank[b.readiness] ||
        a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
    );
  }, [
    api.definitions,
    api.bindings,
    mcp.servers,
    mcp.bindings,
    repo.repoBindings,
    connections,
    credentialsByKey,
  ]);

  return {
    integrations,
    isLoading: api.isLoading || mcp.isLoading || repo.isLoading,
  };
}
