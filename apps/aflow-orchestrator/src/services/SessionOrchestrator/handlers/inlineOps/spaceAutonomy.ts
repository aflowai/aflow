/**
 * Inline handler for `space.autonomy.update` (Plan 345 D): the Helmsman's
 * write of its own space's autonomy setting, on the path
 * `PUT /v1/spaces/:spaceId/autonomy` takes. The route asks for an admin of
 * the space it names, and the space here is the run's own, so the op writes
 * only the calling space and only for a session whose user is its admin.
 *
 * A raise from `ratify` to `full` takes more than an admin session: it
 * removes the medium-tier write gate, Store ratification and the push-gate
 * asks at once, so it rests on the operator's word. The Helmsman runs as the
 * space's admin, so the word must be one the platform attests a person sent:
 * a message of the space's conversation record whose author the API stamped
 * (`selectSpaceAutonomyDirective`). The quote is that whole message, and the
 * message asks for full autonomy and does not refuse it. The write records that message, its
 * author and when the raise spent it, and a later raise needs a message
 * recorded after it. A lowering, or a change of `storeUpdates` alone, stays
 * the admin session's act and keeps the spent record.
 */
import { getDatabase } from '@aflow/database';
import {
  SpaceAutonomyUpdateInputSchema,
  SpaceAutonomyUpdateOutputSchema,
  resolveSpaceAutonomyPolicy,
  type SpaceAutonomyDirective,
  type SpaceAutonomyPolicy,
} from '@aflow/schemas';
import {
  isSpaceAdmin,
  readSpaceAutonomyDirectiveRecords,
  readStoredSpaceAutonomyPolicy,
  selectSpaceAutonomyDirective,
  writeSpaceAutonomyPolicy,
  type SpaceAutonomyDirectiveFinding,
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
          'Tell the operator: an admin of the space sets it.',
        startTime,
        'permission',
      );
      return;
    }

    const stored = await readStoredSpaceAutonomyPolicy(db, tenantId, spaceId);
    const { directiveQuote, ...setting } = parsed.data;
    const raising =
      setting.autonomy === 'full' && resolveSpaceAutonomyPolicy(stored).autonomy !== 'full';
    let directive: SpaceAutonomyDirective | undefined;
    if (raising) {
      if (directiveQuote === undefined) {
        await emitStepError(
          args,
          'SPACE_AUTONOMY_RAISE_NEEDS_DIRECTIVE',
          "A raise from `ratify` to `full` needs the operator's word, and this call quotes none, so nothing was changed. " +
            'Pass `directiveQuote`: the whole of a message the operator sent you in a conversation of this space, verbatim, that asks for full autonomy. ' +
            'Only the operator gives the directive. Without one, ask them.',
          startTime,
          'permission',
        );
        return;
      }
      const finding = await selectSpaceAutonomyDirective({
        rows: await readSpaceAutonomyDirectiveRecords(db, tenantId, spaceId),
        quote: directiveQuote,
        spent: stored?.directive,
        isOperator: (authorUserId) => isSpaceAdmin(db, tenantId, spaceId, authorUserId),
      });
      if (finding.kind !== 'verified') {
        const refusal = directiveRefusal(finding);
        await emitStepError(args, refusal.code, refusal.message, startTime, 'permission');
        return;
      }
      directive = { ...finding.directive, spentAt: new Date().toISOString() };
    }

    const policy: SpaceAutonomyPolicy = { ...stored, ...setting };
    if (directive !== undefined) policy.directive = directive;
    const row = await writeSpaceAutonomyPolicy({
      db,
      redis: args.redis,
      tenantId,
      spaceId,
      policy,
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
      `[space.autonomy.update] space ${spaceId}: autonomy ${resolved.autonomy}, storeUpdates ${resolved.storeUpdates}` +
        (directive !== undefined
          ? `, raised on the ${directive.eventType} event ${directive.eventId} of conversation ${directive.sessionId}, ` +
            `authored by user ${directive.authorUserId} at ${directive.postedAt}, now spent`
          : ''),
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

const ASK_THE_OPERATOR = 'Only the operator gives the directive. Without one, ask them.';

/** Why a quoted directive does not authorise the raise, as the refusal says it. */
function directiveRefusal(finding: Exclude<SpaceAutonomyDirectiveFinding, { kind: 'verified' }>): {
  code: string;
  message: string;
} {
  const record =
    'eventId' in finding ? `the ${finding.eventId} event of conversation ${finding.sessionId}` : '';
  switch (finding.kind) {
    case 'names_no_raise':
      return {
        code: 'SPACE_AUTONOMY_DIRECTIVE_NAMES_NO_RAISE',
        message:
          'The quoted message does not name the raise: it must hold the words "full" and "autonomy", so nothing was changed. ' +
          `A reply such as "yes" does not carry the operator's ask. ` +
          ASK_THE_OPERATOR,
      };
    case 'refuses_raise':
      return {
        code: 'SPACE_AUTONOMY_DIRECTIVE_REFUSES_RAISE',
        message:
          `The quoted message holds "${finding.word}", which negates or reverses the raise, so it does not ask for full autonomy and nothing was changed. ` +
          ASK_THE_OPERATOR,
      };
    case 'partial_quote':
      return {
        code: 'SPACE_AUTONOMY_DIRECTIVE_PARTIAL_QUOTE',
        message:
          `The quoted words are part of ${record}, not the whole of it, so they do not carry the operator's ask and nothing was changed. ` +
          'Quote the whole message the operator sent, verbatim. ' +
          ASK_THE_OPERATOR,
      };
    case 'not_found':
      return {
        code: 'SPACE_AUTONOMY_DIRECTIVE_UNATTESTED',
        message:
          "No message in this space's conversation record is the quoted words, so their author cannot be attested and nothing was changed. " +
          "Quote the operator's whole message verbatim, not a summary of it. " +
          ASK_THE_OPERATOR,
      };
    case 'agent_authored':
      return {
        code: 'SPACE_AUTONOMY_DIRECTIVE_AGENT_AUTHORED',
        message: `The quoted words are in ${record}, and ${finding.reason}. An agent's words are not the operator's directive, so nothing was changed. ${ASK_THE_OPERATOR}`,
      };
    case 'unattested':
      return {
        code: 'SPACE_AUTONOMY_DIRECTIVE_UNATTESTED',
        message: `The quoted words are in ${record}, and ${finding.reason}, so the platform does not attest a person wrote them and nothing was changed. ${ASK_THE_OPERATOR}`,
      };
    case 'not_operator':
      return {
        code: 'SPACE_AUTONOMY_DIRECTIVE_NOT_OPERATOR',
        message: `The quoted words are in ${record}, sent by user ${finding.authorUserId}, who is not an admin of this space, so nothing was changed. ${ASK_THE_OPERATOR}`,
      };
    case 'spent':
      return {
        code: 'SPACE_AUTONOMY_DIRECTIVE_SPENT',
        message:
          `The quoted words are in ${record}, and the raise of ${finding.spent.spentAt} spent the operator's message of ${finding.spent.postedAt}. ` +
          'One message authorises one raise, and this one is not recorded after it, so nothing was changed. ' +
          ASK_THE_OPERATOR,
      };
  }
}
