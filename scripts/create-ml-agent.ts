#!/usr/bin/env -S npx tsx
/**
 * Create the ML Prediction Agent flow in a specific space via the API.
 *
 * Usage:
 *   yarn tsx scripts/create-ml-agent.ts <spaceId>
 *   yarn tsx scripts/create-ml-agent.ts <spaceId> --server http://localhost:3000
 *
 * Requires the server to be running. Uses the default tenant in dev mode.
 */

import { ML_PREDICTION_AGENT } from '../packages/database/src/seeds/capabilityFlows.js';

const spaceId = process.argv[2];
if (!spaceId) {
  console.error('Usage: yarn tsx scripts/create-ml-agent.ts <spaceId> [--server <url>]');
  process.exit(1);
}

const serverIdx = process.argv.indexOf('--server');
const serverUrl = serverIdx !== -1 ? process.argv[serverIdx + 1] : 'http://localhost:3000';

const tenantId = process.env['DEFAULT_TENANT_ID'] ?? 'a0000000-0000-0000-0000-000000000001';

const flowPayload = {
  flowId: ML_PREDICTION_AGENT.flowId,
  version: '1',
  metadata: ML_PREDICTION_AGENT.metadata,
  definition: {
    schemaVersion: ML_PREDICTION_AGENT.schemaVersion,
    stateVariables: ML_PREDICTION_AGENT.stateVariables,
    steps: ML_PREDICTION_AGENT.steps,
    startStepId: ML_PREDICTION_AGENT.startStepId,
    supportedModes: ML_PREDICTION_AGENT.supportedModes,
  },
};

async function main(): Promise<void> {
  console.log(`Creating ML Prediction Agent in space ${spaceId}...`);
  console.log(`Server: ${serverUrl}`);

  const res = await fetch(`${serverUrl}/v1/agents`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env['PHX_API_KEY'] ?? ''}`,
      'X-Tenant-ID': tenantId,
      'X-Space-ID': spaceId,
    },
    body: JSON.stringify(flowPayload),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`Failed (${String(res.status)}): ${text}`);
    process.exit(1);
  }

  const result = (await res.json()) as Record<string, unknown>;
  const rawId = result['flowId'] ?? result['id'];
  const idStr =
    typeof rawId === 'string'
      ? rawId
      : typeof rawId === 'number' || typeof rawId === 'bigint'
        ? String(rawId)
        : 'unknown';
  console.log(`✓ Created flow "${ML_PREDICTION_AGENT.metadata.name}" (id: ${idStr})`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
