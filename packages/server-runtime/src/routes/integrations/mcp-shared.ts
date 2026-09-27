import { z } from 'zod';
import { IconRefSchema } from '@aflow/schemas';
import { resolveIntegrationIcon } from './shared.js';

export const McpServerDefinitionResponseSchema = z.object({
  serverId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  serverUrl: z.string(),
  transport: z.string(),
  tags: z.array(z.string()),
  source: z.string(),
  enabled: z.boolean(),
  spaceId: z.string(),
  observedProtocolVersion: z.string().nullable(),
  /** Resolved identity artwork — see `resolveIntegrationIcon`. */
  icon: IconRefSchema.optional(),
  toolFilter: z
    .object({
      include: z.array(z.string()).optional(),
      exclude: z.array(z.string()).optional(),
      opTaskOnly: z.array(z.string()).optional(),
    })
    .nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const McpServerBindingResponseSchema = z.object({
  bindingId: z.string(),
  serverId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  scope: z.record(z.unknown()),
  authType: z.string(),
  auth: z.record(z.unknown()),
  credentialKeys: z.array(z.string()),
  connectionPolicy: z.record(z.unknown()),
  subscribeListChanged: z.boolean(),
  samplingPolicy: z.string(),
  ownerScope: z.enum(['user', 'space']),
  clientScope: z.enum(['platform', 'tenant', 'space']),
  pinnedOrigin: z.string().nullable(),
  cachedToolCount: z.number().int().nullable(),
  cachedToolsAt: z.string().nullable(),
  cachedToolNames: z.array(z.string()).nullable(),
  sessionMetadata: z.record(z.unknown()).nullable(),
  enabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type McpServerDefinitionResponse = z.infer<typeof McpServerDefinitionResponseSchema>;
export type McpServerBindingResponse = z.infer<typeof McpServerBindingResponseSchema>;

interface McpServerDefinitionRowLike {
  serverId?: string;
  server_id?: string;
  name: string;
  description?: string | null;
  serverUrl?: string;
  server_url?: string;
  transport: string;
  tags?: unknown;
  source: string;
  enabled?: number;
  spaceId?: string;
  space_id?: string;
  definitionJson?: Record<string, unknown>;
  definition_json?: Record<string, unknown>;
  createdAt?: Date;
  created_at?: Date;
  updatedAt?: Date;
  updated_at?: Date;
}

interface McpServerBindingRowLike {
  bindingId?: string;
  binding_id?: string;
  serverId?: string;
  server_id?: string;
  name: string;
  description?: string | null;
  scopeJson?: Record<string, unknown>;
  scope_json?: Record<string, unknown>;
  authJson?: Record<string, unknown>;
  auth_json?: Record<string, unknown>;
  connectionPolicyJson?: Record<string, unknown>;
  connection_policy_json?: Record<string, unknown>;
  subscribeListChanged?: number;
  subscribe_list_changed?: number;
  samplingPolicy?: string;
  sampling_policy?: string;
  ownerScope?: string | null;
  owner_scope?: string | null;
  clientScope?: string | null;
  client_scope?: string | null;
  pinnedOrigin?: string | null;
  pinned_origin?: string | null;
  cachedTools?: unknown[] | null;
  cached_tools?: unknown[] | null;
  cachedToolsAt?: Date | null;
  cached_tools_at?: Date | null;
  sessionMetadataJson?: Record<string, unknown> | null;
  session_metadata_json?: Record<string, unknown> | null;
  enabled?: number;
  createdAt?: Date;
  created_at?: Date;
  updatedAt?: Date;
  updated_at?: Date;
}

export function mapMcpDefinitionRow(row: McpServerDefinitionRowLike): McpServerDefinitionResponse {
  const defJson = row.definitionJson ?? row.definition_json ?? {};
  const toolFilterRaw = defJson['toolFilter'];
  const toolFilter =
    toolFilterRaw && typeof toolFilterRaw === 'object'
      ? {
          ...(Array.isArray((toolFilterRaw as Record<string, unknown>)['include'])
            ? {
                include: (toolFilterRaw as Record<string, unknown>)['include'] as string[],
              }
            : {}),
          ...(Array.isArray((toolFilterRaw as Record<string, unknown>)['exclude'])
            ? {
                exclude: (toolFilterRaw as Record<string, unknown>)['exclude'] as string[],
              }
            : {}),
          ...(Array.isArray((toolFilterRaw as Record<string, unknown>)['opTaskOnly'])
            ? {
                opTaskOnly: (toolFilterRaw as Record<string, unknown>)['opTaskOnly'] as string[],
              }
            : {}),
        }
      : null;
  const serverId = row.serverId ?? row.server_id ?? '';
  const icon = resolveIntegrationIcon(serverId, defJson);
  return {
    serverId,
    name: row.name,
    description: row.description ?? null,
    serverUrl: row.serverUrl ?? row.server_url ?? '',
    transport: row.transport,
    tags: (row.tags ?? []) as string[],
    source: row.source,
    enabled: (row.enabled ?? 1) === 1,
    spaceId: row.spaceId ?? row.space_id ?? '',
    observedProtocolVersion:
      typeof defJson['observedProtocolVersion'] === 'string'
        ? defJson['observedProtocolVersion']
        : null,
    ...(icon ? { icon } : {}),
    toolFilter,
    createdAt: new Date(row.createdAt ?? row.created_at ?? 0).toISOString(),
    updatedAt: new Date(row.updatedAt ?? row.updated_at ?? 0).toISOString(),
  };
}

export function mapMcpBindingRow(
  row: McpServerBindingRowLike,
  credentialKeys: string[],
): McpServerBindingResponse {
  const authJson = row.authJson ?? row.auth_json ?? {};
  const cachedTools = row.cachedTools ?? row.cached_tools ?? null;
  const cachedToolsAt = row.cachedToolsAt ?? row.cached_tools_at ?? null;
  const ownerScopeRaw = row.ownerScope ?? row.owner_scope;
  const ownerScope: McpServerBindingResponse['ownerScope'] =
    ownerScopeRaw === 'user' ? 'user' : 'space';
  const clientScopeRaw = row.clientScope ?? row.client_scope;
  const clientScope: McpServerBindingResponse['clientScope'] =
    clientScopeRaw === 'tenant' || clientScopeRaw === 'space' ? clientScopeRaw : 'platform';
  return {
    bindingId: row.bindingId ?? row.binding_id ?? '',
    serverId: row.serverId ?? row.server_id ?? '',
    name: row.name,
    description: row.description ?? null,
    scope: row.scopeJson ?? row.scope_json ?? {},
    authType: (authJson['type'] ?? 'unknown') as string,
    auth: authJson,
    credentialKeys,
    connectionPolicy: row.connectionPolicyJson ?? row.connection_policy_json ?? {},
    subscribeListChanged: (row.subscribeListChanged ?? row.subscribe_list_changed ?? 1) === 1,
    samplingPolicy: row.samplingPolicy ?? row.sampling_policy ?? 'off',
    ownerScope,
    clientScope,
    pinnedOrigin: row.pinnedOrigin ?? row.pinned_origin ?? null,
    cachedToolCount: Array.isArray(cachedTools) ? cachedTools.length : null,
    cachedToolsAt: cachedToolsAt ? new Date(cachedToolsAt).toISOString() : null,
    cachedToolNames: Array.isArray(cachedTools)
      ? cachedTools
          .map((t) => (t as { name?: unknown }).name)
          .filter((n): n is string => typeof n === 'string')
      : null,
    sessionMetadata: row.sessionMetadataJson ?? row.session_metadata_json ?? null,
    enabled: (row.enabled ?? 1) === 1,
    createdAt: new Date(row.createdAt ?? row.created_at ?? 0).toISOString(),
    updatedAt: new Date(row.updatedAt ?? row.updated_at ?? 0).toISOString(),
  };
}
