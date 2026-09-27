import { describe, it, expect } from 'vitest';
import { SKILL_CATALOG } from '../skillCatalog.js';
import {
  ALPACA_ACCOUNT_READ_API_DEFINITION,
  ALPACA_MARKET_DATA_API_DEFINITION,
  ALPACA_PAPER_ORDERS_WRITE_API_DEFINITION,
} from '../skillBundleCatalog/alpacaApiDefinitions.js';

// apiId → set of registered endpointIds, for the three Alpaca API definitions.
const ALPACA_API_ENDPOINTS: Record<string, Set<string>> = Object.fromEntries(
  [
    ALPACA_ACCOUNT_READ_API_DEFINITION,
    ALPACA_MARKET_DATA_API_DEFINITION,
    ALPACA_PAPER_ORDERS_WRITE_API_DEFINITION,
  ].map((def) => [def.apiId, new Set(def.definition.endpoints.map((e) => e.endpointId))]),
);

interface ApiGrant {
  sourceKind?: string;
  integrationId?: string;
  bindingId?: string;
  allTools?: boolean;
  toolNames?: Array<{ toolName?: string }>;
}

interface WorkflowTask {
  taskId?: string;
  context?: { capabilities?: { integrations?: ApiGrant[] } };
}

describe('Alpaca capability grants ↔ API endpoint registry (Plan 177)', () => {
  it('every granted Alpaca toolName is a registered endpointId in its API definition', () => {
    const violations: string[] = [];

    for (const entry of SKILL_CATALOG) {
      const skillId = entry.bundle.manifest.skillId;
      const tasks = (entry.bundle.workflow.tasks ?? []) as WorkflowTask[];

      for (const task of tasks) {
        const grants = task.context?.capabilities?.integrations ?? [];
        for (const grant of grants) {
          if (grant.sourceKind !== 'api') continue;
          const apiId = grant.integrationId;
          if (!apiId) continue;
          // Only police the three Alpaca API definitions; other integrations
          // (MCP servers, non-Alpaca APIs) are out of scope for this guard.
          const endpoints = ALPACA_API_ENDPOINTS[apiId];
          if (!endpoints) continue;
          // `allTools` grants promote every endpoint — nothing to cross-check.
          if (grant.allTools) continue;

          for (const named of grant.toolNames ?? []) {
            const toolName = named.toolName;
            if (!toolName) continue;
            if (!endpoints.has(toolName)) {
              violations.push(
                `${skillId} / task "${task.taskId ?? '?'}" grants "${toolName}" on ` +
                  `"${apiId}", but that is not a registered endpointId. ` +
                  `Registered: [${[...endpoints].sort().join(', ')}].`,
              );
            }
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
