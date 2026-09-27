import { getDatabase } from '@aflow/database';
import {
  archiveSkill,
  unarchiveSkill,
  purgeSkill,
  previewSkill,
  SkillLifecycleError,
  type SkillLifecycleErrorCode,
} from '@aflow/cybernetic-runtime';
import type { InlineHandlerArgs } from './types.js';
import { emitStepSuccess, emitStepError } from './helpers.js';
import { requireSpaceId } from './spaceScope.js';

/**
 * Map a typed lifecycle error to an HTTP-style classification + retryability
 * pair. All lifecycle errors are non-retryable from the orchestrator's
 * perspective (operator must change inputs / cancel runs / change state).
 */
function classifyLifecycleError(code: SkillLifecycleErrorCode): {
  classification: 'validation' | 'internal';
  retryable: false;
} {
  switch (code) {
    case 'PLATFORM_ARTIFACT_READ_ONLY':
    case 'SKILL_NOT_FOUND':
    case 'SKILL_NOT_ARCHIVED':
    case 'SKILL_HAS_ACTIVE_RUNS':
    case 'SKILL_HAS_LIVE_RUNS':
    case 'SKILL_HAS_HISTORICAL_RUNS':
      return { classification: 'validation', retryable: false };
    case 'WORKFLOW_DOC_MISSING':
      return { classification: 'internal', retryable: false };
  }
}

export async function handleSkillManageInline(args: InlineHandlerArgs): Promise<void> {
  const { context, stepDef, payloadStore, resolvedInputRef } = args;
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

    const skillId = typeof input['skillId'] === 'string' ? input['skillId'] : undefined;
    if (!skillId) {
      await emitStepError(args, 'INVALID_INPUT', 'skillId is required.', startTime, 'validation');
      return;
    }

    const db = getDatabase();
    const spaceId = requireSpaceId(context);
    const ctx = {
      db,
      tenantId: context.tenantId,
      spaceId,
      // FlowExecutionContext does not currently carry the initiating user;
      // audit-log integration in a later phase populates this from the HTTP
      // route layer where the auth user is known.
      actorUserId: null,
    };

    let outputData: Record<string, unknown>;
    switch (operationId) {
      case 'skill.manage.archive': {
        const force = input['force'] === true;
        outputData = (await archiveSkill(ctx, skillId, { force })) as unknown as Record<
          string,
          unknown
        >;
        break;
      }
      case 'skill.manage.unarchive': {
        outputData = (await unarchiveSkill(ctx, skillId)) as unknown as Record<string, unknown>;
        break;
      }
      case 'skill.manage.purge': {
        const confirmRunHistoryDangling = input['confirmRunHistoryDangling'] === true;
        outputData = (await purgeSkill(ctx, skillId, {
          confirmRunHistoryDangling,
        })) as unknown as Record<string, unknown>;
        break;
      }
      case 'skill.manage.preview': {
        const kind = input['kind'];
        if (kind !== 'archive' && kind !== 'purge') {
          await emitStepError(
            args,
            'INVALID_INPUT',
            `kind must be 'archive' or 'purge', got: ${String(kind)}`,
            startTime,
            'validation',
          );
          return;
        }
        outputData = (await previewSkill(ctx, skillId, kind)) as unknown as Record<string, unknown>;
        break;
      }
      default:
        await emitStepError(
          args,
          'UNROUTED_INLINE_OPERATION',
          `Unknown skill.manage operation: ${operationId}`,
          startTime,
          'validation',
        );
        return;
    }

    await emitStepSuccess(args, outputData, startTime);
  } catch (err) {
    if (err instanceof SkillLifecycleError) {
      const { classification, retryable } = classifyLifecycleError(err.code);
      await emitStepError(args, err.code, err.message, startTime, classification, retryable);
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    await emitStepError(args, 'INTERNAL', message, startTime, 'internal', false);
  }
}
