import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { getOrchestratorLogger } from '../../../../lib/orchestratorLogger.js';
import type { OperationId } from '@aflow/schemas';
import {
  defaultSpaceDirectives,
  defaultsToSafeProfile,
  resolveEditionDescriptor,
} from '@aflow/schemas';
import { addStepResult } from '@aflow/redis';
import {
  getDatabase,
  withTenantSchema,
  createTenantContext,
  spaces,
  spaceMemberships,
  spaceCapabilityAssignments,
  spaceSlugHistory,
  tenantMemberships,
  findDefaultCapabilityProfileId,
} from '@aflow/database';
import { encodeInlineOpOutputRef } from './helpers.js';
import type { InlineHandlerArgs } from './types.js';

/**
 * Look up a space row by spaceId input (UUID or slug).
 */
async function findSpaceRow(
  db: ReturnType<typeof getDatabase>,
  tenantCtx: ReturnType<typeof createTenantContext>,
  spaceIdInput: string,
): Promise<typeof spaces.$inferSelect | null> {
  const rows = await withTenantSchema(db, tenantCtx, async (tx) => {
    return tx
      .select()
      .from(spaces)
      .where(or(eq(spaces.id, spaceIdInput), eq(spaces.slug, spaceIdInput)))
      .limit(1);
  });
  return rows[0] ?? null;
}

// ============================================================================
// space.manage.* — Space CRUD
// ============================================================================

export async function handleSpaceCrudInline(args: InlineHandlerArgs): Promise<void> {
  const {
    redis,
    payloadStore,
    context,
    stepDef,
    stepExecutionId,
    idempotencyKey,
    resolvedInputRef,
    attempt,
    parentStepExecutionId,
  } = args;
  const startTime = Date.now();
  const operationId = stepDef.operation;

  try {
    let input: Record<string, unknown> = {};
    try {
      const data = await payloadStore.retrieve(resolvedInputRef);
      if (typeof data === 'object' && data !== null) {
        input = data as Record<string, unknown>;
      }
    } catch {
      /* empty input */
    }

    const db = getDatabase();
    const tenantCtx = createTenantContext(context.tenantId);
    let outputData: Record<string, unknown>;

    switch (operationId) {
      case 'space.manage.create': {
        const slug = input['slug'] as string;
        const name = input['name'] as string;
        const description = input['description'] as string | undefined;

        // This value lands in `spaces.slug`, which the `/s/<slug>` route parses
        // with SpaceSlugSchema — a row written past it is a space no URL can
        // reach. Covers the reserved set the schema alone does not.
        const { validateSpaceSlug } = await import('@aflow/schemas');
        const slugValidation = validateSpaceSlug(slug);
        if (!slugValidation.ok) {
          throw new Error(`${slugValidation.code}: ${slugValidation.message}`);
        }

        const parentSpaceId = context.spaceId;
        if (!parentSpaceId) {
          throw new Error(
            'SPACE_NO_OWNER: this run belongs to no space, so the new space has no owner to inherit and would be unreachable',
          );
        }
        const { getTenantProvisioningPolicy } = await import('@aflow/database');
        const maxSpacesPerUser = (await getTenantProvisioningPolicy(db, context.tenantId)).quotas
          .maxSpacesPerUser;

        // Every row this writes is provisioning for one space, so they share a
        // transaction: a partial commit is the ownerless, membership-less space
        // this operation exists to stop producing.
        const newId = await withTenantSchema(db, tenantCtx, async (tx) => {
          // A run carries no acting user, so the space the agent is running in
          // supplies the human. `spaces.ownerId` is an always-set invariant, and
          // a space with no owner has nobody who can administer or dispose of it
          // and is hidden by the access gate — refuse instead of writing one.
          const ownerId = (
            await tx
              .select({ ownerId: spaces.ownerId })
              .from(spaces)
              .where(eq(spaces.id, parentSpaceId))
              .limit(1)
          )[0]?.ownerId;
          if (!ownerId) {
            throw new Error(
              'SPACE_NO_OWNER: the space this run belongs to has no owner to inherit, so the new space would be unreachable',
            );
          }

          // `resolveSpaceRef` reads live rows before history, so reviving a
          // retired slug silently points old links at an unrelated space.
          const [retired] = await tx
            .select({ id: spaceSlugHistory.id })
            .from(spaceSlugHistory)
            .where(eq(spaceSlugHistory.oldSlug, slug))
            .limit(1);
          if (retired) {
            throw new Error(
              `SLUG_RETIRED: "${slug}" is a retired slug from an existing space; reuse is blocked while history exists`,
            );
          }

          if (maxSpacesPerUser !== undefined) {
            await tx.execute(
              sql`SELECT pg_advisory_xact_lock(hashtext(${`space-quota:${ownerId}`}))`,
            );
            const owned = await tx
              .select({ id: spaces.id })
              .from(spaces)
              .where(and(eq(spaces.ownerId, ownerId), isNull(spaces.archivedAt)));
            if (owned.length >= maxSpacesPerUser) {
              throw new Error(
                `SPACE_QUOTA_REACHED: the owner already holds ${String(maxSpacesPerUser)} active spaces`,
              );
            }
          }

          const [created] = await tx
            .insert(spaces)
            .values({
              name,
              slug,
              ownerId,
              directives: defaultSpaceDirectives(),
              ...(description !== undefined ? { description } : {}),
            })
            .returning({ id: spaces.id });
          const createdId = created?.id;
          if (!createdId) throw new Error('Space insert returned no id');

          const inherited = (
            await tx
              .select({ profileId: spaceCapabilityAssignments.profileId })
              .from(spaceCapabilityAssignments)
              .where(eq(spaceCapabilityAssignments.spaceId, parentSpaceId))
              .limit(1)
          )[0]?.profileId;
          let profileId = inherited;
          if (profileId === undefined) {
            // A parent with no explicit assignment runs on the owner's role
            // default, so the child answers the same question `POST /spaces`
            // does: Personal Safe unless the inherited owner is a tenant admin
            // (see defaultsToSafeProfile for why admin-ness is the signal).
            const ownerRole = (
              await tx
                .select({ role: tenantMemberships.role })
                .from(tenantMemberships)
                .where(
                  and(
                    eq(tenantMemberships.userId, ownerId),
                    eq(tenantMemberships.tenantId, context.tenantId),
                    eq(tenantMemberships.status, 'active'),
                  ),
                )
                .limit(1)
            )[0]?.role;
            const memberSafeDefault = defaultsToSafeProfile({
              isTenantAdmin: ownerRole === 'owner' || ownerRole === 'admin',
              edition: resolveEditionDescriptor(),
            });
            profileId = await findDefaultCapabilityProfileId(tx, { memberSafeDefault });
          }
          if (!profileId) {
            throw new Error('No capability profile available — cannot provision space');
          }
          await tx.insert(spaceCapabilityAssignments).values({ spaceId: createdId, profileId });

          // `space_memberships` is a public-schema table reached through the
          // transaction's search_path, so it commits or rolls back with the rest.
          await tx.insert(spaceMemberships).values({
            tenantId: context.tenantId,
            spaceId: createdId,
            userId: ownerId,
            role: 'admin',
          });

          return createdId;
        });

        outputData = {
          spaceId: newId,
          createdAt: new Date().toISOString(),
        };
        break;
      }

      case 'space.manage.get': {
        const spaceId = input['spaceId'] as string;
        const row = await findSpaceRow(db, tenantCtx, spaceId);
        if (!row) throw new Error(`Space "${spaceId}" not found`);

        outputData = {
          spaceId: row.id,
          name: row.name,
          ...(row.description ? { description: row.description } : {}),
          createdAt: new Date(row.createdAt).toISOString(),
          updatedAt: new Date(row.updatedAt).toISOString(),
        };
        break;
      }

      case 'space.manage.update': {
        const spaceId = input['spaceId'] as string;

        const existingSpace = await findSpaceRow(db, tenantCtx, spaceId);
        if (!existingSpace) throw new Error(`Space "${spaceId}" not found`);
        const spaceUuid = existingSpace.id;

        const newName = input['name'] as string | undefined;
        const newDescription = input['description'] as string | undefined;

        await withTenantSchema(db, tenantCtx, async (tx) => {
          if (newName !== undefined && newDescription !== undefined) {
            await tx.execute(sql`
              UPDATE spaces SET name = ${newName}, description = ${newDescription}, updated_at = NOW()
              WHERE id = ${spaceUuid}
            `);
          } else if (newName !== undefined) {
            await tx.execute(sql`
              UPDATE spaces SET name = ${newName}, updated_at = NOW()
              WHERE id = ${spaceUuid}
            `);
          } else if (newDescription !== undefined) {
            await tx.execute(sql`
              UPDATE spaces SET description = ${newDescription}, updated_at = NOW()
              WHERE id = ${spaceUuid}
            `);
          } else {
            await tx.execute(sql`
              UPDATE spaces SET updated_at = NOW() WHERE id = ${spaceUuid}
            `);
          }
        });

        outputData = {
          spaceId: spaceUuid,
          updatedAt: new Date().toISOString(),
        };
        break;
      }

      case 'space.manage.list': {
        const nameFilter = input['nameFilter'] as string | undefined;
        const { ilike } = await import('drizzle-orm');

        const rows = await withTenantSchema(db, tenantCtx, async (tx) => {
          const query = tx.select().from(spaces);
          if (nameFilter) {
            return query.where(ilike(spaces.name, `%${nameFilter}%`));
          }
          return query;
        });

        const spaceList = rows.map((row) => ({
          id: row.id,
          name: row.name,
          slug: row.slug,
          ...(row.description ? { description: row.description } : {}),
          createdAt: new Date(row.createdAt).toISOString(),
        }));

        outputData = {
          spaces: spaceList,
          count: spaceList.length,
        };
        break;
      }

      default:
        throw new Error(
          `Unknown or removed space.manage operation: ${operationId}. ` +
            `Note: 'space.manage.delete' was renamed to 'space.manage.archive' (Plan 121).`,
        );
    }

    const outputRef = await encodeInlineOpOutputRef(
      payloadStore,
      context,
      stepExecutionId,
      attempt,
      outputData,
    );
    await addStepResult(redis, {
      messageVersion: 1,
      tenantId: context.tenantId,
      sessionId: context.runId,
      stepExecutionId,
      parentStepExecutionId: parentStepExecutionId ?? null,
      stepId: stepDef.stepId,
      stepType: stepDef.stepType,
      operationId: operationId as OperationId,
      attempt,
      idempotencyKey,
      status: 'SUCCEEDED',
      outputRef,
      resolvedInputRef,
      durationMs: Date.now() - startTime,
      traceId: context.traceId,
      finishedAtMs: Date.now(),
    });

    getOrchestratorLogger().debug(`[SessionOrchestrator] ${operationId} executed inline`);
  } catch (err) {
    const errorData = {
      code: 'SPACE_CRUD_OP_FAILED',
      message: err instanceof Error ? err.message : String(err),
      classification: 'internal' as const,
      retryable: false,
      timestamp: new Date().toISOString(),
    };
    const errorRef = `inline:${Buffer.from(JSON.stringify(errorData)).toString('base64')}`;

    await addStepResult(redis, {
      messageVersion: 1,
      tenantId: context.tenantId,
      sessionId: context.runId,
      stepExecutionId,
      parentStepExecutionId: parentStepExecutionId ?? null,
      stepId: stepDef.stepId,
      stepType: stepDef.stepType,
      operationId: operationId as OperationId,
      attempt,
      idempotencyKey,
      status: 'FAILED',
      errorRef,
      error: errorData,
      resolvedInputRef,
      durationMs: Date.now() - startTime,
      traceId: context.traceId,
      finishedAtMs: Date.now(),
    });
  }
}
