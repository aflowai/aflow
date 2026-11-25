/**
 * A dry run of the daily trading cycle holds every write the cycle can ask
 * for — the broker order and cancel, the ledger's memory writes and the
 * learnings — while every read and every agent task runs for real. Read off
 * the shipped definition, so a write added to the cycle is classified here.
 */
import { describe, expect, it } from 'vitest';
import {
  dryRunWriteDisposition,
  effectiveWriteRiskTier,
  requiresWriteApproval,
  WRITE_HOLD_EVERY_TIER,
  type WorkflowTask,
} from '@aflow/schemas';
import { getSkillCatalogEntry } from '../skillCatalog.js';
import {
  ALPACA_ACCOUNT_READ_API_DEFINITION,
  ALPACA_MARKET_DATA_API_DEFINITION,
  ALPACA_PAPER_ORDERS_WRITE_API_DEFINITION,
} from '../skillBundleCatalog/alpacaApiDefinitions.js';

const API_DEFINITIONS = [
  ALPACA_ACCOUNT_READ_API_DEFINITION,
  ALPACA_MARKET_DATA_API_DEFINITION,
  ALPACA_PAPER_ORDERS_WRITE_API_DEFINITION,
];

/** Whether the dry run holds a call to `apiId/endpointId`, or undefined for an API the bundle does not ship. */
function apiCallHeld(apiId: string, endpointId: string): boolean | undefined {
  const api = API_DEFINITIONS.find((d) => d.apiId === apiId);
  if (api === undefined) return undefined;
  const endpoint = (
    api.definition.endpoints as ReadonlyArray<{
      endpointId: string;
      method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    }>
  ).find((e) => e.endpointId === endpointId);
  if (endpoint === undefined) throw new Error(`${apiId} has no endpoint ${endpointId}`);
  return requiresWriteApproval(effectiveWriteRiskTier(endpoint), WRITE_HOLD_EVERY_TIER);
}

interface Census {
  held: string[];
  ran: string[];
}

function census(tasks: readonly WorkflowTask[]): Census {
  const held = new Set<string>();
  const ran = new Set<string>();
  const place = (name: string, isHeld: boolean) => (isHeld ? held : ran).add(name);
  for (const task of tasks) {
    if (task.type === 'operation' && task.operation !== undefined) {
      const disposition = dryRunWriteDisposition(task.operation);
      if (disposition === 'endpoint') {
        const template = (task.inputTemplate ?? {}) as Record<string, unknown>;
        const apiId = template['apiId'];
        const endpointId = template['endpointId'];
        if (typeof apiId !== 'string' || typeof endpointId !== 'string') continue;
        const isHeld = apiCallHeld(apiId, endpointId);
        if (isHeld !== undefined) place(`${task.taskId}: ${apiId}/${endpointId}`, isHeld);
      } else {
        place(`${task.taskId}: ${task.operation}`, disposition === 'hold');
      }
      continue;
    }
    const capabilities = task.context?.capabilities;
    for (const operation of capabilities?.operations ?? []) {
      place(`${task.taskId}: ${operation}`, dryRunWriteDisposition(operation) === 'hold');
    }
    for (const integration of capabilities?.integrations ?? []) {
      const apiId = (integration as { integrationId?: string }).integrationId;
      if (apiId === undefined) continue;
      for (const { toolName } of integration.toolNames ?? []) {
        const isHeld = apiCallHeld(apiId, toolName);
        if (isHeld !== undefined) place(`${task.taskId}: ${apiId}/${toolName}`, isHeld);
      }
    }
  }
  return { held: [...held].sort(), ran: [...ran].sort() };
}

describe('a dry run of the daily trading cycle', () => {
  const tasks = getSkillCatalogEntry('daily-trading-cycle')?.bundle.workflow.tasks ?? [];
  const { held, ran } = census(tasks);

  it('reads the shipped cycle', () => {
    expect(tasks.length).toBeGreaterThan(10);
  });

  it('holds the broker order and its cancel', () => {
    expect(held).toContain('execute-orders: alpaca-paper-orders-write/post_orders');
    expect(held).toContain('execute-orders: alpaca-paper-orders-write/delete_orders_order_id');
  });

  it('holds every ledger and learnings write', () => {
    expect(held).toEqual(
      expect.arrayContaining([
        'execute-orders: memory.store.put',
        'execute-orders: memory.store.delete',
        'record: memory.store.put',
        'record: memory.store.delete',
        'write-snapshot: memory.store.put',
        'write-cycle-doc: memory.store.put',
        'record-learnings: workflow.learn',
      ]),
    );
  });

  it('holds nothing but writes', () => {
    expect(held.every((entry) => /(put|delete|learn|post_orders|delete_orders)/.test(entry))).toBe(
      true,
    );
  });

  it('runs every read for real', () => {
    expect(ran).toEqual(
      expect.arrayContaining([
        'ingest-account: alpaca-account-read/get_account',
        'ingest-positions: alpaca-account-read/get_positions',
        'ingest-orders: alpaca-account-read/get_orders',
        'execute-orders: alpaca-account-read/get_orders_order_id',
        'execute-orders: memory.store.get',
      ]),
    );
    expect(ran.some((entry) => /(\.put|\.delete|learn|post_|delete_)/.test(entry))).toBe(false);
  });
});
