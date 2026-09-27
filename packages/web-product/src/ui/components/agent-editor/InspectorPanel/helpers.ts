import type { AgentDefinition } from '../../../lib/flow-to-graph.js';
import type { CatalogOperation, CatalogStepType } from '../../../hooks/use-operation-catalog.js';
import type { OperationGroup } from './types.js';

/** Parse an edge ID like "stepA->success->stepB" into parts */
export function parseEdgeId(
  edgeId: string,
): { sourceId: string; edgeType: string; targetId: string } | null {
  const [sourceId, edgeType, targetId] = edgeId.split('->');
  if (sourceId === undefined || edgeType === undefined || targetId === undefined) return null;
  return { sourceId, edgeType, targetId };
}

/** Check if a step is a tool step invoked by an agent turn step */
export function isAgentToolStep(flow: AgentDefinition, stepId: string): boolean {
  return flow.steps.some(
    (s) =>
      s.operation === 'ai.agent.turn' && s.onSuccess?.next?.some((edge) => edge.stepId === stepId),
  );
}

/** Get the name of the parent agent step, if any */
export function getParentAgentName(flow: AgentDefinition, stepId: string): string | undefined {
  const agent = flow.steps.find(
    (s) =>
      s.operation === 'ai.agent.turn' && s.onSuccess?.next?.some((edge) => edge.stepId === stepId),
  );
  return agent ? (agent.name ?? agent.stepId) : undefined;
}

export function deriveGroupIdFromOp(op: CatalogOperation): string {
  const parts = op.operationId.split('.');
  if (parts.length >= 3) return `${parts[0]}.${parts[1]}`;
  return op.stepType;
}

export function buildOperationGroups(
  operations: CatalogOperation[],
  stepTypes: CatalogStepType[],
): OperationGroup[] {
  const groupMap = new Map<string, OperationGroup>();
  for (const op of operations) {
    const gid = deriveGroupIdFromOp(op);
    const parts = op.operationId.split('.');
    const group = parts.length >= 3 ? (parts.at(1) ?? null) : null;

    let entry = groupMap.get(gid);
    if (!entry) {
      const stLabel = stepTypes.find((st) => st.type === op.stepType)?.displayName ?? op.stepType;
      const label = group
        ? `${stLabel} — ${group.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}`
        : stLabel;
      entry = { groupId: gid, stepType: op.stepType, group, label, ops: [] };
      groupMap.set(gid, entry);
    }
    entry.ops.push(op);
  }
  return [...groupMap.values()].sort((a, b) => a.groupId.localeCompare(b.groupId));
}

/** Safe string for retry maxAttempts input (avoids [object Object]). */
export function formatRetryAttempts(retryPolicy?: Record<string, unknown>): string {
  const v = retryPolicy?.['maxAttempts'];
  return typeof v === 'number' ? String(v) : '';
}

/** Safe string for timeout seconds (from executionTimeoutMs). */
export function formatTimeoutSeconds(timeout?: Record<string, unknown>): string {
  const ms = timeout?.['executionTimeoutMs'];
  if (ms == null || typeof ms !== 'number') return '';
  return String(Math.round(ms / 1000));
}

/** Pull enum values from a property schema (handles both direct enum and anyOf pattern). */
export function getEnumValues(prop: {
  enum?: unknown[] | undefined;
  anyOf?: Array<{ enum?: unknown[] }> | undefined;
}): string[] | null {
  if (prop.enum && Array.isArray(prop.enum)) {
    return prop.enum.map(String);
  }
  if (prop.anyOf && Array.isArray(prop.anyOf)) {
    for (const branch of prop.anyOf) {
      if (branch.enum && Array.isArray(branch.enum)) {
        return branch.enum.map(String);
      }
    }
  }
  return null;
}

/** Resolve the effective type from a property schema. */
export function resolveType(prop: {
  type?: string | undefined;
  anyOf?: Array<{ type?: string | undefined }> | undefined;
}): string {
  if (prop.type) return prop.type;
  if (prop.anyOf) {
    for (const branch of prop.anyOf) {
      if (branch.type) return branch.type;
    }
  }
  return 'string';
}

/** Convert camelCase/snake_case to human-readable */
export function humanize(key: string): string {
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/[_-]/g, ' ')
    .replace(/^\s/, '')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}
