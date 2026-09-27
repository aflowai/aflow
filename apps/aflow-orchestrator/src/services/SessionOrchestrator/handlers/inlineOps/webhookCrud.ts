import { eq, and, desc } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import {
  getDatabase,
  withTenantSchema,
  createTenantContext,
  webhookEndpoints,
  agents,
  encryptCredentialEnvelope,
} from '@aflow/database';
import { getRunAccessGrant, getSessionState } from '@aflow/redis';
import {
  PersistentAgentTargetSchema,
  agentTargetKey,
  targetToColumns,
  type PersistentAgentTarget,
} from '@aflow/schemas';
import type { InlineHandlerArgs } from './types.js';
import { emitStepSuccess, emitStepError } from './helpers.js';
import { requireSpaceId } from './spaceScope.js';
import { getOrchestratorLogger } from '../../../../lib/orchestratorLogger.js';

/** Max webhooks an agent can create in a single run */
const MAX_WEBHOOK_CREATES_PER_RUN = 10;

/** Project the persistent target columns from a webhook_endpoints row. */
function projectWebhookTarget(row: {
  targetKind: 'platform-role' | 'custom-agent' | 'inline-agent';
  targetSystemRole: string | null;
  targetAgentId: string | null;
}): PersistentAgentTarget {
  // CHECK constraint guarantees one of these branches; webhooks reject inline.
  if (row.targetKind === 'platform-role' && row.targetSystemRole) {
    return {
      kind: 'platform-role',
      systemRole: row.targetSystemRole as PersistentAgentTarget extends {
        kind: 'platform-role';
        systemRole: infer T;
      }
        ? T
        : never,
    };
  }
  if (row.targetKind === 'custom-agent' && row.targetAgentId) {
    return {
      kind: 'custom-agent',
      agentId: row.targetAgentId as PersistentAgentTarget extends {
        kind: 'custom-agent';
        agentId: infer T;
      }
        ? T
        : never,
    };
  }
  throw new Error(`Malformed webhook target_kind: ${row.targetKind}`);
}

/** Per-run counters to enforce rate limit */
const runWebhookCreateCounts = new Map<string, number>();

// ============================================================================
// api.webhook.* Router
// ============================================================================

export async function handleWebhookCrudInline(args: InlineHandlerArgs): Promise<void> {
  const operationId = args.stepDef.operation;
  const startTime = Date.now();

  try {
    let input: Record<string, unknown> = {};
    try {
      const data = await args.payloadStore.retrieve(args.resolvedInputRef);
      if (typeof data === 'object' && data !== null) {
        input = data as Record<string, unknown>;
      }
    } catch {
      /* empty input */
    }

    switch (operationId) {
      case 'api.webhook.upsert':
        await handleUpsert(args, input, startTime);
        break;
      case 'api.webhook.get':
        await handleGet(args, input, startTime);
        break;
      case 'api.webhook.list':
        await handleList(args, input, startTime);
        break;
      case 'api.webhook.delete':
        await handleDelete(args, input, startTime);
        break;
      default:
        await emitStepError(
          args,
          'UNKNOWN_WEBHOOK_OPERATION',
          `Unknown webhook operation: ${operationId}`,
          startTime,
          'validation',
        );
    }
  } catch (err) {
    let message = 'Webhook operation failed';
    if (err instanceof Error) {
      const rawMessage = err.message;
      // Redact SQL details
      message = rawMessage.includes('syntax error') ? 'Database query failed' : rawMessage;
    }
    await emitStepError(args, 'WEBHOOK_OPERATION_FAILED', message, startTime, 'internal');
  }
}

// ============================================================================
// api.webhook.upsert
// ============================================================================

async function handleUpsert(
  args: InlineHandlerArgs,
  input: Record<string, unknown>,
  startTime: number,
): Promise<void> {
  const { context } = args;
  const spaceId = requireSpaceId(context);

  // --- Admin check ---
  const grant = await getRunAccessGrant(args.redis, context.tenantId, context.runId);
  const isAdmin =
    grant?.tenantRole === 'admin' || grant?.tenantRole === 'owner' || grant?.spaceRole === 'admin';
  if (!isAdmin) {
    await emitStepError(
      args,
      'WEBHOOK_PERMISSION_DENIED',
      'Webhook endpoints can only be managed by tenant or space admins.',
      startTime,
      'permission',
    );
    return;
  }

  // --- Rate limit ---
  const runId = context.runId as string;
  const count = runWebhookCreateCounts.get(runId) ?? 0;
  if (count >= MAX_WEBHOOK_CREATES_PER_RUN) {
    await emitStepError(
      args,
      'WEBHOOK_RATE_LIMIT',
      `Maximum ${String(MAX_WEBHOOK_CREATES_PER_RUN)} webhook upserts per run.`,
      startTime,
      'validation',
    );
    return;
  }

  // --- Validate required fields ---
  const name = input['name'] as string | undefined;
  let target: PersistentAgentTarget | undefined;
  const rawTarget = input['target'];
  if (rawTarget === 'self') {
    const runState = await getSessionState(args.redis, context.tenantId, context.runId);
    if (!runState || runState.target.kind === 'inline-agent') {
      await emitStepError(
        args,
        'WEBHOOK_SELF_UNRESOLVED',
        'target: "self" requires a persistent (non-inline) running session.',
        startTime,
        'validation',
      );
      return;
    }
    target = runState.target;
  } else if (rawTarget !== undefined && rawTarget !== null) {
    const parse = PersistentAgentTargetSchema.safeParse(rawTarget);
    if (!parse.success) {
      await emitStepError(
        args,
        'WEBHOOK_INVALID_TARGET',
        `Invalid target: ${parse.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
        startTime,
        'validation',
      );
      return;
    }
    target = parse.data;
  }
  if (!name || !target) {
    await emitStepError(
      args,
      'WEBHOOK_MISSING_FIELDS',
      'name and target are required. Use target: "self" for the current agent.',
      startTime,
      'validation',
    );
    return;
  }

  const db = getDatabase();
  const tenantCtx = createTenantContext(context.tenantId);

  // --- Validate target exists ---
  if (target.kind === 'custom-agent') {
    const agentRows = await withTenantSchema(db, tenantCtx, async (tx) => {
      return tx
        .select({ id: agents.id, archivedAt: agents.archivedAt })
        .from(agents)
        .where(and(eq(agents.id, target.agentId), eq(agents.spaceId, spaceId)))
        .limit(1);
    });
    if (agentRows.length === 0 || agentRows[0]?.archivedAt) {
      await emitStepError(
        args,
        'WEBHOOK_AGENT_NOT_FOUND',
        `Custom agent (id: ${target.agentId}) not found or archived in this space.`,
        startTime,
        'validation',
      );
      return;
    }
  }

  // --- Check if exists (upsert by name) ---
  const existing = await withTenantSchema(db, tenantCtx, async (tx) => {
    return tx
      .select()
      .from(webhookEndpoints)
      .where(and(eq(webhookEndpoints.name, name), eq(webhookEndpoints.spaceId, spaceId)))
      .limit(1);
  });

  const apiBaseUrl = process.env['API_BASE_URL'] ?? 'https://api.aflow.ai';

  if (existing[0]) {
    // --- Update ---
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    const targetCols = targetToColumns(target);
    updates['targetKind'] = targetCols.targetKind;
    updates['targetSystemRole'] = targetCols.targetSystemRole;
    updates['targetAgentId'] = targetCols.targetAgentId;
    if (input['description'] !== undefined) updates['description'] = input['description'] as string;
    if (input['filterExpression'] !== undefined)
      updates['filterExpression'] = input['filterExpression'] as string;
    if (input['inputMapping'] !== undefined) updates['inputMapping'] = input['inputMapping'];
    if (input['signatureHeader'] !== undefined)
      updates['signatureHeader'] = input['signatureHeader'] as string;
    if (input['deliveryIdHeader'] !== undefined)
      updates['deliveryIdHeader'] = input['deliveryIdHeader'] as string;
    if (input['timestampHeader'] !== undefined)
      updates['timestampHeader'] = input['timestampHeader'] as string;
    if (input['replayWindowSeconds'] !== undefined)
      updates['replayWindowSeconds'] = input['replayWindowSeconds'] as number;

    const rows = await withTenantSchema(db, tenantCtx, async (tx) => {
      return tx
        .update(webhookEndpoints)
        .set(updates)
        .where(and(eq(webhookEndpoints.name, name), eq(webhookEndpoints.spaceId, spaceId)))
        .returning();
    });

    const row = rows[0]!;
    runWebhookCreateCounts.set(runId, count + 1);

    await emitStepSuccess(
      args,
      {
        webhookId: row.id,
        name: row.name,
        target,
        status: row.status,
        url: `${apiBaseUrl}/v1/webhooks/ingest/${context.tenantId as string}/${row.id}`,
        created: false,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      },
      startTime,
    );
  } else {
    // --- Create ---
    const plaintextSecret = randomBytes(32).toString('hex');
    const secretEncrypted = await encryptCredentialEnvelope(plaintextSecret);

    const insertTargetCols = targetToColumns(target) as {
      targetKind: 'platform-role' | 'custom-agent';
      targetSystemRole: string | null;
      targetAgentId: string | null;
    };
    const rows = await withTenantSchema(db, tenantCtx, async (tx) => {
      return tx
        .insert(webhookEndpoints)
        .values({
          spaceId,
          targetKind: insertTargetCols.targetKind,
          targetSystemRole: insertTargetCols.targetSystemRole,
          targetAgentId: insertTargetCols.targetAgentId,
          name,
          description: (input['description'] as string | undefined) ?? null,
          secretEncrypted,
          signatureHeader:
            (input['signatureHeader'] as string | undefined) ?? 'x-webhook-signature',
          deliveryIdHeader: (input['deliveryIdHeader'] as string | undefined) ?? 'x-webhook-id',
          timestampHeader:
            (input['timestampHeader'] as string | undefined) ?? 'x-webhook-timestamp',
          replayWindowSeconds: (input['replayWindowSeconds'] as number | undefined) ?? 300,
          requireDeliveryId: false,
          inputMapping: (input['inputMapping'] as Record<string, string> | undefined) ?? null,
          filterExpression: (input['filterExpression'] as string | undefined) ?? null,
          status: 'active',
          creatorUserId: grant.grantedToUserId,
          creatorTenantRole: grant.tenantRole,
          creatorSpaceRole: grant.spaceRole,
          createdBy: grant.grantedToUserId,
        })
        .returning();
    });

    const row = rows[0]!;
    runWebhookCreateCounts.set(runId, count + 1);

    getOrchestratorLogger().info(
      `[webhookCrud] Created webhook endpoint "${name}" → ${agentTargetKey(target)} (id: ${row.id})`,
    );

    await emitStepSuccess(
      args,
      {
        webhookId: row.id,
        name: row.name,
        target,
        status: row.status,
        url: `${apiBaseUrl}/v1/webhooks/ingest/${context.tenantId as string}/${row.id}`,
        secret: plaintextSecret,
        created: true,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      },
      startTime,
    );
  }
}

// ============================================================================
// api.webhook.get
// ============================================================================

async function handleGet(
  args: InlineHandlerArgs,
  input: Record<string, unknown>,
  startTime: number,
): Promise<void> {
  const { context } = args;
  const spaceId = requireSpaceId(context);

  const webhookId = input['webhookId'] as string | undefined;
  const name = input['name'] as string | undefined;
  if (!webhookId && !name) {
    await emitStepError(
      args,
      'WEBHOOK_MISSING_ID',
      'Provide webhookId or name.',
      startTime,
      'validation',
    );
    return;
  }

  const db = getDatabase();
  const tenantCtx = createTenantContext(context.tenantId);

  const condition = webhookId
    ? and(eq(webhookEndpoints.id, webhookId), eq(webhookEndpoints.spaceId, spaceId))
    : and(eq(webhookEndpoints.name, name!), eq(webhookEndpoints.spaceId, spaceId));

  const rows = await withTenantSchema(db, tenantCtx, async (tx) => {
    return tx.select().from(webhookEndpoints).where(condition).limit(1);
  });

  const row = rows[0];
  if (!row) {
    await emitStepError(
      args,
      'WEBHOOK_NOT_FOUND',
      `Webhook endpoint not found: ${webhookId ?? name ?? 'unknown'}`,
      startTime,
      'validation',
    );
    return;
  }

  const apiBaseUrl = process.env['API_BASE_URL'] ?? 'https://api.aflow.ai';

  await emitStepSuccess(
    args,
    {
      webhookId: row.id,
      name: row.name,
      description: row.description ?? null,
      target: projectWebhookTarget(row),
      status: row.status,
      url: `${apiBaseUrl}/v1/webhooks/ingest/${context.tenantId as string}/${row.id}`,
      signatureHeader: row.signatureHeader,
      deliveryIdHeader: row.deliveryIdHeader,
      timestampHeader: row.timestampHeader,
      replayWindowSeconds: row.replayWindowSeconds,
      filterExpression: row.filterExpression ?? null,
      inputMapping: row.inputMapping ?? null,
      lastReceivedAt: row.lastReceivedAt ? row.lastReceivedAt.toISOString() : null,
      lastError: row.lastError ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    },
    startTime,
  );
}

// ============================================================================
// api.webhook.list
// ============================================================================

async function handleList(
  args: InlineHandlerArgs,
  input: Record<string, unknown>,
  startTime: number,
): Promise<void> {
  const { context } = args;
  const spaceId = requireSpaceId(context);

  const db = getDatabase();
  const tenantCtx = createTenantContext(context.tenantId);

  const conditions = [eq(webhookEndpoints.spaceId, spaceId)];
  const status = input['status'] as string | undefined;
  if (status) conditions.push(eq(webhookEndpoints.status, status));
  const rawTargetFilter = input['target'];
  if (rawTargetFilter && typeof rawTargetFilter === 'object') {
    const parse = PersistentAgentTargetSchema.safeParse(rawTargetFilter);
    if (parse.success) {
      const filterCols = targetToColumns(parse.data) as {
        targetKind: 'platform-role' | 'custom-agent';
        targetSystemRole: string | null;
        targetAgentId: string | null;
      };
      conditions.push(eq(webhookEndpoints.targetKind, filterCols.targetKind));
      if (filterCols.targetKind === 'platform-role') {
        conditions.push(eq(webhookEndpoints.targetSystemRole, filterCols.targetSystemRole!));
      } else {
        conditions.push(eq(webhookEndpoints.targetAgentId, filterCols.targetAgentId!));
      }
    }
  }

  const limit = Math.min((input['limit'] as number | undefined) ?? 20, 100);

  const rows = await withTenantSchema(db, tenantCtx, async (tx) => {
    return tx
      .select()
      .from(webhookEndpoints)
      .where(and(...conditions))
      .orderBy(desc(webhookEndpoints.createdAt))
      .limit(limit);
  });

  const apiBaseUrl = process.env['API_BASE_URL'] ?? 'https://api.aflow.ai';

  await emitStepSuccess(
    args,
    {
      webhooks: rows.map((row) => ({
        webhookId: row.id,
        name: row.name,
        description: row.description ?? null,
        target: projectWebhookTarget(row),
        status: row.status,
        url: `${apiBaseUrl}/v1/webhooks/ingest/${context.tenantId as string}/${row.id}`,
        signatureHeader: row.signatureHeader,
        deliveryIdHeader: row.deliveryIdHeader,
        timestampHeader: row.timestampHeader,
        replayWindowSeconds: row.replayWindowSeconds,
        filterExpression: row.filterExpression ?? null,
        inputMapping: row.inputMapping ?? null,
        lastReceivedAt: row.lastReceivedAt ? row.lastReceivedAt.toISOString() : null,
        lastError: row.lastError ?? null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      })),
      totalCount: rows.length,
    },
    startTime,
  );
}

// ============================================================================
// api.webhook.delete
// ============================================================================

async function handleDelete(
  args: InlineHandlerArgs,
  input: Record<string, unknown>,
  startTime: number,
): Promise<void> {
  const { context } = args;
  const spaceId = requireSpaceId(context);

  // --- Admin check ---
  const grant = await getRunAccessGrant(args.redis, context.tenantId, context.runId);
  const isAdmin =
    grant?.tenantRole === 'admin' || grant?.tenantRole === 'owner' || grant?.spaceRole === 'admin';
  if (!isAdmin) {
    await emitStepError(
      args,
      'WEBHOOK_PERMISSION_DENIED',
      'Webhook endpoints can only be deleted by tenant or space admins.',
      startTime,
      'permission',
    );
    return;
  }

  const webhookId = input['webhookId'] as string | undefined;
  const name = input['name'] as string | undefined;
  if (!webhookId && !name) {
    await emitStepError(
      args,
      'WEBHOOK_MISSING_ID',
      'Provide webhookId or name.',
      startTime,
      'validation',
    );
    return;
  }

  const db = getDatabase();
  const tenantCtx = createTenantContext(context.tenantId);

  const condition = webhookId
    ? and(eq(webhookEndpoints.id, webhookId), eq(webhookEndpoints.spaceId, spaceId))
    : and(eq(webhookEndpoints.name, name!), eq(webhookEndpoints.spaceId, spaceId));

  const rows = await withTenantSchema(db, tenantCtx, async (tx) => {
    return tx.delete(webhookEndpoints).where(condition).returning({ id: webhookEndpoints.id });
  });

  if (rows.length === 0) {
    await emitStepError(
      args,
      'WEBHOOK_NOT_FOUND',
      `Webhook endpoint not found: ${webhookId ?? name ?? 'unknown'}`,
      startTime,
      'validation',
    );
    return;
  }

  getOrchestratorLogger().info(`[webhookCrud] Deleted webhook endpoint ${rows[0]!.id}`);

  await emitStepSuccess(
    args,
    {
      webhookId: rows[0]!.id,
      deleted: true,
    },
    startTime,
  );
}
