/**
 * Shared integrations route helpers — response schemas, DB helpers, row mappers.
 */
import { z } from 'zod';
import type { Redis } from 'ioredis';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { FastifyInstance } from 'fastify';
import { IntegrationHostPolicyError } from '@aflow/cybernetic-runtime';
import { curatedIntegrationIcon } from '@aflow/platform-artifacts';
import { BindingFulfillmentSchema } from '@aflow/schemas';
import { IconRefSchema, type IconRef } from '@aflow/schemas';

export { collectCredentialKeys, findUnreferencedCredentialKeys } from '@aflow/cybernetic-runtime';

/** 400 payload for integration writes — carries the allowlist denial when present. */
export const IntegrationWriteErrorSchema = z.object({
  error: z.string(),
  code: z.string().optional(),
  deniedHosts: z.array(z.string()).optional(),
});
export type IntegrationWriteError = z.infer<typeof IntegrationWriteErrorSchema>;

export function integrationPolicyDenialPayload(err: unknown): IntegrationWriteError | null {
  if (!(err instanceof IntegrationHostPolicyError)) return null;
  return { error: err.message, code: err.denial.code, deniedHosts: err.denial.deniedHosts };
}

export const ApiVariableMetaSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  example: z.string().optional(),
  required: z.boolean(),
});

export const ApiDefinitionResponseSchema = z.object({
  apiId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  baseUrl: z.string(),
  baseUrlTemplate: z.string().optional(),
  variables: z.array(ApiVariableMetaSchema).optional(),
  version: z.string(),
  callMode: z.enum(['endpoint', 'direct_url']).optional(),
  tags: z.array(z.string()),
  enabled: z.boolean(),
  endpointCount: z.number().int(),
  /** Resolved identity artwork — see `resolveIntegrationIcon`. */
  icon: IconRefSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const ApiBindingResponseSchema = z.object({
  bindingId: z.string(),
  apiId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  scope: z.record(z.unknown()),
  authType: z.string(),
  auth: z.record(z.unknown()),
  credentialKeys: z.array(z.string()),
  egressPolicy: z.record(z.unknown()),
  variableValues: z.record(z.string(), z.string()).optional(),
  /**
   * How this binding is answered. Present on every binding because a caller
   * that cannot tell a simulated connection from a live one has no way to read
   * anything downstream of it.
   */
  fulfillment: BindingFulfillmentSchema,
  enabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const CredentialMetaResponseSchema = z.object({
  credentialKey: z.string(),
  label: z.string(),
  description: z.string().nullable(),
  hasValue: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ApiDefinitionResponse = z.infer<typeof ApiDefinitionResponseSchema>;
export type ApiBindingResponse = z.infer<typeof ApiBindingResponseSchema>;
export type CredentialMetaResponse = z.infer<typeof CredentialMetaResponseSchema>;

/** Row shape from DB (handles both camelCase and snake_case from different code paths). */
interface ApiDefinitionRowLike {
  apiId?: string;
  api_id?: string;
  name: string;
  description?: string | null;
  baseUrl?: string;
  base_url?: string;
  version: string;
  tags?: unknown;
  enabled?: number;
  definitionJson?: Record<string, unknown>;
  definition_json?: Record<string, unknown>;
  createdAt?: Date;
  created_at?: Date;
  updatedAt?: Date;
  updated_at?: Date;
}

interface ApiBindingRowLike {
  bindingId?: string;
  binding_id?: string;
  apiId?: string;
  api_id?: string;
  name: string;
  description?: string | null;
  scopeJson?: Record<string, unknown>;
  scope_json?: Record<string, unknown>;
  authJson?: Record<string, unknown>;
  auth_json?: Record<string, unknown>;
  egressPolicyJson?: Record<string, unknown>;
  egress_policy_json?: Record<string, unknown>;
  variableValuesJson?: Record<string, string> | null;
  variable_values_json?: Record<string, string> | null;
  fulfillmentMode?: 'live' | 'simulated' | null;
  fulfillment_mode?: 'live' | 'simulated' | null;
  simulationId?: string | null;
  simulation_id?: string | null;
  enabled?: number;
  createdAt?: Date;
  created_at?: Date;
  updatedAt?: Date;
  updated_at?: Date;
}

interface ApiCredentialRowLike {
  credentialKey?: string;
  credential_key?: string;
  label: string;
  description?: string | null;
  encryptedValue?: string | null;
  encrypted_value?: string | null;
  createdAt?: Date;
  created_at?: Date;
  updatedAt?: Date;
  updated_at?: Date;
}

/**
 * How an integration gets its avatar, in precedence order:
 *
 * 1. an `icon` **on the definition** — the operator's/author's own choice, and
 *    the only path a hand-authored integration has to real artwork;
 * 2. the **curated default** the platform ships for that id (well-known
 *    connectors), which is a live read, so a rebrand reaches every space at once;
 * 3. nothing — the client draws a deterministic initials tile.
 *
 * Resolved here, in the one row mapper each definition kind goes through, rather
 * than in the web app: the id→artwork registry lives in `@aflow/platform-artifacts`
 * and a client-side copy of it would be a mirror list that silently rots.
 *
 * The stored value is re-validated because `definition_json` is unvalidated at
 * rest — a malformed icon degrades to the default instead of failing response
 * serialization for the whole list.
 */
export function resolveIntegrationIcon(
  id: string,
  defJson: Record<string, unknown>,
): IconRef | undefined {
  const declared = IconRefSchema.safeParse(defJson['icon']);
  return declared.success ? declared.data : curatedIntegrationIcon(id);
}

export function getDb(fastify: FastifyInstance): PostgresJsDatabase | null {
  return (fastify.appContext?.db as PostgresJsDatabase) ?? null;
}

export function getRedis(fastify: FastifyInstance): Redis | null {
  return fastify.appContext?.redis ?? null;
}

export function getPayloadStore(fastify: FastifyInstance) {
  return fastify.appContext?.payloadStore ?? null;
}

export function mapDefinitionRow(row: ApiDefinitionRowLike): ApiDefinitionResponse {
  const defJson = row.definitionJson ?? row.definition_json ?? {};
  const endpoints = (defJson?.['endpoints'] as unknown[]) ?? [];
  const baseUrlTemplate = defJson?.['baseUrlTemplate'] as string | undefined;
  const variables = defJson?.['variables'] as ApiDefinitionResponse['variables'];
  const apiId = row.apiId ?? row.api_id ?? '';
  const icon = resolveIntegrationIcon(apiId, defJson);
  return {
    apiId,
    name: row.name,
    description: row.description ?? null,
    baseUrl: row.baseUrl ?? row.base_url ?? '',
    ...(baseUrlTemplate ? { baseUrlTemplate } : {}),
    ...(variables ? { variables } : {}),
    version: row.version,
    ...(defJson?.['callMode'] === 'direct_url' ? { callMode: 'direct_url' as const } : {}),
    tags: (row.tags ?? []) as string[],
    enabled: (row.enabled ?? 1) === 1,
    endpointCount: endpoints.length,
    ...(icon ? { icon } : {}),
    createdAt: new Date(row.createdAt ?? row.created_at ?? 0).toISOString(),
    updatedAt: new Date(row.updatedAt ?? row.updated_at ?? 0).toISOString(),
  };
}

/**
 * The two columns read as the union they encode. A `simulated` row without a
 * simulation cannot exist — a CHECK constraint ties the columns in both
 * directions — so a row that somehow lacks one reads as live rather than as a
 * simulated binding pointing at nothing.
 */
function readFulfillment(row: ApiBindingRowLike): ApiBindingResponse['fulfillment'] {
  const mode = row.fulfillmentMode ?? row.fulfillment_mode ?? 'live';
  const simulationId = row.simulationId ?? row.simulation_id ?? null;
  if (mode === 'simulated' && simulationId !== null) return { mode: 'simulated', simulationId };
  return { mode: 'live' };
}

export function mapBindingRow(
  row: ApiBindingRowLike,
  credentialKeys: string[],
): ApiBindingResponse {
  const authJson = row.authJson ?? row.auth_json ?? {};
  const variableValues = row.variableValuesJson ?? row.variable_values_json ?? undefined;
  return {
    bindingId: row.bindingId ?? row.binding_id ?? '',
    apiId: row.apiId ?? row.api_id ?? '',
    name: row.name,
    description: row.description ?? null,
    scope: row.scopeJson ?? row.scope_json ?? {},
    authType: (authJson['type'] ?? 'unknown') as string,
    auth: authJson,
    credentialKeys,
    egressPolicy: row.egressPolicyJson ?? row.egress_policy_json ?? {},
    ...(variableValues ? { variableValues } : {}),
    fulfillment: readFulfillment(row),
    enabled: (row.enabled ?? 1) === 1,
    createdAt: new Date(row.createdAt ?? row.created_at ?? 0).toISOString(),
    updatedAt: new Date(row.updatedAt ?? row.updated_at ?? 0).toISOString(),
  };
}

export function mapCredentialRow(row: ApiCredentialRowLike): CredentialMetaResponse {
  return {
    credentialKey: row.credentialKey ?? row.credential_key ?? '',
    label: row.label,
    description: row.description ?? null,
    hasValue: Boolean(row.encryptedValue ?? row.encrypted_value),
    createdAt: new Date(row.createdAt ?? row.created_at ?? 0).toISOString(),
    updatedAt: new Date(row.updatedAt ?? row.updated_at ?? 0).toISOString(),
  };
}
