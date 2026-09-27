#!/usr/bin/env npx tsx
/**
 * E2E Flow Test Script
 *
 * This script:
 * 1. Creates a test flow definition in the database
 * 2. Triggers a flow run via the control stream (using proper schema validation)
 * 3. Monitors the flow execution via event log
 *
 * Prerequisites:
 * - PostgreSQL running on port 5433 (docker compose default)
 * - Redis running on port 6379
 * - Orchestrator running (apps/aflow-orchestrator)
 * - Mock executor running (apps/aflow-executor-mock)
 *
 * Usage:
 *   npx tsx scripts/test-e2e-flow.ts              # inline payload mode (dev convenience)
 *   npx tsx scripts/test-e2e-flow.ts --strict     # strict GCS-style payload refs
 *
 * Environment Variables:
 *   DATABASE_URL  - PostgreSQL connection (default: postgres://phoenix:phoenix@localhost:5433/phoenix)
 *   REDIS_URL     - Redis connection (default: redis://localhost:6379)
 */

import postgres from 'postgres';
import { getRedisConnection, closeRedisConnection, addControlMessage } from '@aflow/redis';
import type { TenantId, SessionId, TraceId, IdempotencyKey, PayloadRef } from '@aflow/schemas';

// Configuration - port 5433 matches docker-compose.yml default (${POSTGRES_PORT:-5433}:5432)
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://phoenix:phoenix@localhost:5433/phoenix';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

// Parse CLI args
const STRICT_MODE = process.argv.includes('--strict');

// Dev tenant - uses the schema naming convention: t_<32hexchars>
const TENANT_ID = 'a0000000-0000-0000-0000-000000000001' as TenantId;
// Schema name derived from tenant ID: remove dashes, prefix with t_
const TENANT_SCHEMA = 't_a0000000000000000000000000000001';

// Test flow definition - 3 steps: AI → Memory → AI
const TEST_FLOW_DEFINITION = {
  schemaVersion: 1,
  flowId: 'test-e2e-flow',
  version: '1.0.0',
  metadata: {
    name: 'E2E Test Flow',
    description: 'A simple 3-step flow for E2E testing',
  },
  startStepId: 'step-1-ai',
  steps: [
    {
      stepId: 'step-1-ai',
      stepType: 'ai',
      operation: 'ai.generate',
      onSuccess: {
        next: [{ stepId: 'step-2-memory', priority: 50 }],
      },
      onFailure: {
        next: [],
      },
    },
    {
      stepId: 'step-2-memory',
      stepType: 'memory',
      operation: 'memory.upsert',
      onSuccess: {
        next: [{ stepId: 'step-3-ai', priority: 50 }],
      },
      onFailure: {
        next: [],
      },
    },
    {
      stepId: 'step-3-ai',
      stepType: 'ai',
      operation: 'ai.generate',
      onSuccess: {
        next: [], // Terminal step
      },
      onFailure: {
        next: [],
      },
    },
  ],
  stateVariables: [],
};

/**
 * Create a payload reference.
 * - In strict mode: uses a GCS-style path (requires shared payload store)
 * - In dev mode: uses inline:<base64> for convenience
 */
function createPayloadRef(
  tenantId: string,
  runId: string,
  payload: unknown,
  mode: 'strict' | 'inline',
): PayloadRef {
  if (mode === 'strict') {
    // In strict mode, we'd normally store the payload first and return the ref.
    // For now, we simulate with a GCS-style path that the shared payload store would use.
    // NOTE: This requires the orchestrator and executor to share a payload store instance.
    return `gs://phoenix-payloads/tenants/${tenantId}/runs/${runId}/input.json`;
  }

  // Inline mode: encode payload as base64 in the reference itself
  const inputBase64 = Buffer.from(JSON.stringify(payload)).toString('base64');
  return `inline:${inputBase64}`;
}

async function main() {
  console.log('🚀 Starting E2E Flow Test\n');
  console.log(`   Mode: ${STRICT_MODE ? 'strict (GCS-style refs)' : 'inline (dev convenience)'}`);

  // Connect to PostgreSQL
  console.log('📦 Connecting to PostgreSQL...');
  const sql = postgres(DATABASE_URL);

  // Connect to Redis using the shared connection helper
  console.log('📦 Connecting to Redis...');
  process.env.REDIS_URL = REDIS_URL; // Ensure the helper uses our URL
  const redis = getRedisConnection();

  try {
    // 1. Create the test flow definition
    console.log('\n📝 Creating test flow definition...');
    const flowId = TEST_FLOW_DEFINITION.flowId;
    const flowVersion = TEST_FLOW_DEFINITION.version;

    await sql`
      INSERT INTO ${sql(TENANT_SCHEMA)}.agent_definitions
        (agent_id, version, name, description, definition_json, status)
      VALUES
        (${flowId}, ${flowVersion}, ${TEST_FLOW_DEFINITION.metadata.name}, ${TEST_FLOW_DEFINITION.metadata.description}, ${JSON.stringify(TEST_FLOW_DEFINITION)}::jsonb, 'active')
      ON CONFLICT (agent_id, version) DO UPDATE SET
        definition_json = EXCLUDED.definition_json,
        updated_at = NOW()
    `;
    console.log(`   Flow ID: ${flowId}`);
    console.log(`   Version: ${flowVersion}`);

    // 2. Create the run ID and input
    const runId = crypto.randomUUID() as SessionId;
    const traceId = crypto.randomUUID() as TraceId;
    const idempotencyKey = `test-${Date.now()}` as IdempotencyKey;

    // Create input payload (with __mock directive for mock executor)
    const inputPayload = {
      prompt: 'Say hello!',
      __mock: {
        status: 'SUCCEEDED',
        output: {
          content: 'Hello from step 1!',
          usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
          model: 'mock-model',
          finishReason: 'stop',
        },
      },
    };

    const inputRef = createPayloadRef(
      TENANT_ID,
      runId,
      inputPayload,
      STRICT_MODE ? 'strict' : 'inline',
    );

    console.log(`\n🎯 Starting flow run...`);
    console.log(`   Run ID: ${runId}`);
    console.log(`   Trace ID: ${traceId}`);
    console.log(`   Input Ref: ${inputRef.substring(0, 50)}${inputRef.length > 50 ? '...' : ''}`);

    // 3. Send start_run command using the proper helper (validates against schema)
    const messageId = await addControlMessage(redis, {
      messageVersion: 1, // number, not string
      type: 'start_run',
      tenantId: TENANT_ID,
      runId: runId,
      flowId: flowId,
      flowVersion: flowVersion,
      inputRef: inputRef,
      traceId: traceId,
      idempotencyKey: idempotencyKey,
      requestedAtMs: Date.now(), // number, not string
    });
    console.log(`   ✅ Control message sent (ID: ${messageId})`);

    // 4. Monitor the flow execution
    console.log('\n⏳ Monitoring flow execution (30s timeout)...\n');

    const startTime = Date.now();
    const timeout = 30_000;
    let lastEventCount = 0;

    while (Date.now() - startTime < timeout) {
      // Check flow run status
      const [run] = await sql`
        SELECT status, current_step_execution_id, final_output_ref, error_ref
        FROM ${sql(TENANT_SCHEMA)}.sessions
        WHERE session_id = ${runId}::uuid
      `;

      if (run) {
        // Get events
        const events = await sql`
          SELECT event_type, step_id, step_type, attempt, timestamp
          FROM ${sql(TENANT_SCHEMA)}.event_log
          WHERE session_id = ${runId}::uuid
          ORDER BY sequence_number
        `;

        // Print new events
        if (events.length > lastEventCount) {
          for (let i = lastEventCount; i < events.length; i++) {
            const e = events[i];
            if (!e) continue;
            const time = new Date(e.timestamp as string).toISOString().split('T')[1]?.split('.')[0];
            console.log(
              `   [${time}] ${e.event_type} - step: ${e.step_id ?? 'n/a'} (${e.step_type ?? 'n/a'})`,
            );
          }
          lastEventCount = events.length;
        }

        // Check if flow is complete
        if (run.status === 'SUCCEEDED') {
          console.log('\n✅ Flow completed successfully!');
          console.log(`   Final output: ${run.final_output_ref ?? 'n/a'}`);
          break;
        } else if (run.status === 'FAILED') {
          console.log('\n❌ Flow failed!');
          console.log(`   Error ref: ${run.error_ref ?? 'n/a'}`);
          break;
        } else if (run.status === 'CANCELLED') {
          console.log('\n⚠️ Flow was cancelled');
          break;
        }
      }

      // Wait before next poll
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    // Final status check
    const [finalRun] = await sql`
      SELECT status, started_at, ended_at
      FROM ${sql(TENANT_SCHEMA)}.sessions
      WHERE session_id = ${runId}::uuid
    `;

    if (finalRun) {
      console.log(`\n📊 Final Status: ${finalRun.status}`);
      if (finalRun.ended_at) {
        const duration =
          new Date(finalRun.ended_at as string).getTime() -
          new Date(finalRun.started_at as string).getTime();
        console.log(`   Duration: ${duration}ms`);
      }
    } else {
      console.log('\n⚠️ Run not found - orchestrator may not have processed the control message');
      console.log(
        '   Make sure the orchestrator is running: DATABASE_URL=... npx tsx apps/aflow-orchestrator/src/index.ts',
      );
    }

    // Show step executions
    const steps = await sql`
      SELECT step_id, step_type, status, attempt
      FROM ${sql(TENANT_SCHEMA)}.step_executions
      WHERE session_id = ${runId}::uuid
      ORDER BY scheduled_at
    `;

    if (steps.length > 0) {
      console.log('\n📋 Step Executions:');
      for (const step of steps) {
        console.log(
          `   ${step.step_id} (${step.step_type}): ${step.status} [attempt ${step.attempt}]`,
        );
      }
    }
  } catch (error) {
    console.error('\n❌ Error:', error);
    process.exit(1);
  } finally {
    await sql.end();
    await closeRedisConnection();
    console.log('\n👋 Done');
  }
}

main().catch(console.error);
