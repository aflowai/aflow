/**
 * Inline handler for `space.autonomy.update` (Plan 345 D): the Helmsman's
 * write of its own space's autonomy setting, on the path
 * `PUT /v1/spaces/:spaceId/autonomy` takes. The route asks for an admin of
 * the space it names, and the space here is the run's own, so the op writes
 * only the calling space and only for a session whose user is its admin.
 */
import { getDatabase } from '@aflow/database';
import {
  SpaceAutonomyUpdateInputSchema,
  SpaceAutonomyUpdateOutputSchema,
  mergeSpaceAutonomyPolicy,
  resolveSpaceAutonomyPolicy,
} from '@aflow/schemas';
import {
  isSpaceAdmin,
  readStoredSpaceAutonomyPolicy,
  writeSpaceAutonomyPolicy,
} from '@aflow/cybernetic-runtime';
import type { InlineHandlerArgs } from './types.js';
import { emitStepSuccess, emitStepError, readInlineOpInput } from './helpers.js';
import { requireSpaceId } from './spaceScope.js';
import { sessionUser } from './sessionUser.js';
import { getOrchestratorLogger } from '../../../../lib/orchestratorLogger.js';

export async function handleSpaceAutonomyUpdateInline(args: InlineHandlerArgs): Promise<void> {
  const startTime = Date.now();
  const logger = getOrchestratorLogger();

  try {
    const spaceId = requireSpaceId(args.context);
    const tenantId = args.context.tenantId;
    const parsed = SpaceAutonomyUpdateInputSchema.safeParse(await readInlineOpInput(args));
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join('.') || 'input'}: ${i.message}`)
        .join('; ');
      await emitStepError(
        args,
        'SPACE_AUTONOMY_UPDATE_INVALID_INPUT',
        `Invalid input for space.autonomy.update: ${issues}`,
        startTime,
        'validation',
      );
      return;
    }

    const db = getDatabase();
    const userId = await sessionUser(args);
    if (userId === undefined || !(await isSpaceAdmin(db, tenantId, spaceId, userId))) {
      await emitStepError(
        args,
        'SPACE_AUTONOMY_UPDATE_FORBIDDEN',
        "Only an admin of this space sets its autonomy, and this session's user is not one, so nothing was changed. " +
          'Tell the operator: an admin of the space sets it, here or under Settings → Autonomy.',
        startTime,
        'permission',
      );
      return;
    }

    const stored = await readStoredSpaceAutonomyPolicy(db, tenantId, spaceId);
    const row = await writeSpaceAutonomyPolicy({
      db,
      redis: args.redis,
      tenantId,
      spaceId,
      policy: mergeSpaceAutonomyPolicy(stored, parsed.data),
    });
    if (row === undefined) {
      await emitStepError(
        args,
        'SPACE_AUTONOMY_UPDATE_SPACE_NOT_FOUND',
        'The space this conversation runs in was not found, so nothing was changed.',
        startTime,
        'validation',
      );
      return;
    }

    const resolved = resolveSpaceAutonomyPolicy(row.autonomyPolicy);
    logger.info(
      `[space.autonomy.update] space ${spaceId}: autonomy ${resolved.autonomy}, storeUpdates ${resolved.storeUpdates}, set by user ${userId}`,
    );
    const output = SpaceAutonomyUpdateOutputSchema.parse({
      autonomyPolicy: row.autonomyPolicy,
      resolved,
    });
    await emitStepSuccess(args, output, startTime);
  } catch (err) {
    logger.error(
      `[space.autonomy.update] Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
    );
    await emitStepError(
      args,
      'SPACE_AUTONOMY_UPDATE_FAILED',
      err instanceof Error ? err.message : String(err),
      startTime,
      'internal',
    );
  }
}
