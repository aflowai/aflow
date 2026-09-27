import type { StepHandler, ExecutorContext, StepResult } from '@aflow/executor-runtime';
import { pausedWithRequest, validationError } from '@aflow/executor-runtime';
import {
  UserRequestInputInputSchema,
  UserRequestApprovalInputSchema,
  type AflowError,
  type UserRequestInputInput,
  type UserRequestApprovalInput,
} from '@aflow/schemas';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Redis } from 'ioredis';

import { executeSendEmail, type SendEmailDeps } from './sendEmailHandler.js';
import { executeListEmails, type ListEmailsDeps } from './listEmailsHandler.js';
import type { CredentialResolver } from '@aflow/credential-resolver';

/**
 * Dependencies injected into the handler for operations that need DB/email access.
 */
export interface UserHandlerDeps {
  redis: Redis;
  db?: PostgresJsDatabase | undefined;
  credentialResolver?: CredentialResolver | undefined;
}

/**
 * User step handler — handles interaction and notification operations.
 */
export class UserHandler implements StepHandler {
  readonly stepType = 'user';
  private readonly deps: UserHandlerDeps;

  constructor(deps: UserHandlerDeps) {
    this.deps = deps;
  }

  async validate(ctx: ExecutorContext): Promise<AflowError | null> {
    const operationId = ctx.operationId;

    // notification operations handle their own validation
    if (operationId === 'user.notification.email' || operationId === 'user.notification.emails') {
      return null;
    }

    const input = await ctx.readPayload(ctx.job.inputRef);
    if (typeof input !== 'object' || input === null) {
      return validationError('Input must be an object');
    }

    if (operationId === 'user.interaction.ask') {
      const parsed = UserRequestInputInputSchema.safeParse(input);
      if (!parsed.success) {
        return validationError(`Invalid user.interaction.ask input: ${parsed.error.message}`, {
          issues: parsed.error.issues,
        });
      }
      return null;
    }

    if (operationId === 'user.interaction.approve') {
      const parsed = UserRequestApprovalInputSchema.safeParse(input);
      if (!parsed.success) {
        return validationError(`Invalid user.interaction.approve input: ${parsed.error.message}`, {
          issues: parsed.error.issues,
        });
      }
      return null;
    }

    return validationError(`Unknown user operation: ${operationId}`);
  }

  async execute(ctx: ExecutorContext): Promise<StepResult> {
    const operationId = ctx.operationId;

    // Route to appropriate handler based on operation
    if (operationId === 'user.notification.emails') {
      return this.handleListEmails(ctx);
    }

    if (operationId === 'user.notification.email') {
      return this.handleSendEmail(ctx);
    }

    const input = await ctx.readPayload(ctx.job.inputRef);

    if (operationId === 'user.interaction.ask') {
      // validate() already parsed; re-parse here is a typed access. Both calls
      // are pure CPU and resolve from the same payload.
      const params = UserRequestInputInputSchema.parse(input);
      return await this.handleRequestInput(ctx, params);
    }

    if (operationId === 'user.interaction.approve') {
      const params = UserRequestApprovalInputSchema.parse(input);
      return await this.handleRequestApproval(ctx, params);
    }

    // Should never reach — validate() rejects unknown ops.
    const { failureWithError } = await import('@aflow/executor-runtime');
    return failureWithError(ctx, {
      code: 'UNKNOWN_USER_OPERATION',
      message: `Unknown user operation: ${operationId}`,
      classification: 'internal' as const,
      retryable: false,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Handle user.notification.emails — query sent emails for current user.
   */
  private async handleListEmails(ctx: ExecutorContext): Promise<StepResult> {
    if (!this.deps.db) {
      const { failureWithError } = await import('@aflow/executor-runtime');
      return failureWithError(ctx, {
        code: 'EMAIL_QUERY_DISABLED',
        message: 'Email query not available — missing database connection',
        classification: 'internal' as const,
        retryable: false,
        timestamp: new Date().toISOString(),
      });
    }

    const listDeps: ListEmailsDeps = {
      redis: this.deps.redis,
      db: this.deps.db,
    };

    return executeListEmails(ctx, listDeps);
  }

  /**
   * Handle user.notification.email — delegate to dedicated email handler.
   */
  private async handleSendEmail(ctx: ExecutorContext): Promise<StepResult> {
    if (!this.deps.db || !this.deps.credentialResolver) {
      const { failureWithError } = await import('@aflow/executor-runtime');
      return failureWithError(ctx, {
        code: 'EMAIL_DELIVERY_NOT_CONFIGURED',
        message:
          'Email handler not configured — missing database or credential resolver. ' +
          'Ensure DATABASE_URL is set for the user executor.',
        classification: 'internal' as const,
        retryable: false,
        timestamp: new Date().toISOString(),
      });
    }

    const sendDeps: SendEmailDeps = {
      redis: this.deps.redis,
      db: this.deps.db,
      credentialResolver: this.deps.credentialResolver,
    };

    return executeSendEmail(ctx, sendDeps);
  }

  private async handleRequestInput(
    ctx: ExecutorContext,
    params: UserRequestInputInput,
  ): Promise<StepResult> {
    const pauseRequest: Record<string, unknown> = {
      kind: 'input',
      prompt: params.prompt,
      requestedAt: new Date().toISOString(),
      stepExecutionId: ctx.stepExecutionId,
    };
    if (params.inputSchema !== undefined) pauseRequest['inputSchema'] = params.inputSchema;
    if (params.uiHints !== undefined) pauseRequest['uiHints'] = params.uiHints;
    if (params.timeoutSeconds !== undefined && params.timeoutSeconds !== null) {
      pauseRequest['timeoutSeconds'] = params.timeoutSeconds;
    }
    if (params.defaultOnTimeout !== undefined) {
      pauseRequest['defaultOnTimeout'] = params.defaultOnTimeout;
    }
    if (params.gateContext !== undefined) pauseRequest['gateContext'] = params.gateContext;
    if (params.relatesTo !== undefined) pauseRequest['relatesTo'] = params.relatesTo;
    if (params.placement !== undefined) pauseRequest['placement'] = params.placement;

    return await pausedWithRequest(ctx, pauseRequest);
  }

  private async handleRequestApproval(
    ctx: ExecutorContext,
    params: UserRequestApprovalInput,
  ): Promise<StepResult> {
    const pauseRequest: Record<string, unknown> = {
      kind: 'approval',
      // Synthesized display prompt — title on its own line, then description.
      // Lets `requiredInput.prompt` render the approval text without each
      // consumer reimplementing the synthesis.
      prompt: `${params.title}\n\n${params.description}`,
      title: params.title,
      description: params.description,
      requestedAt: new Date().toISOString(),
      stepExecutionId: ctx.stepExecutionId,
    };
    if (params.reviewData !== undefined) pauseRequest['reviewData'] = params.reviewData;
    if (params.approvers !== undefined) pauseRequest['approvers'] = params.approvers;
    if (params.policy !== undefined) pauseRequest['policy'] = params.policy;
    if (params.uiHints !== undefined) pauseRequest['uiHints'] = params.uiHints;
    if (params.timeoutSeconds !== undefined && params.timeoutSeconds !== null) {
      pauseRequest['timeoutSeconds'] = params.timeoutSeconds;
    }
    if (params.defaultOnTimeout !== undefined) {
      pauseRequest['defaultOnTimeout'] = params.defaultOnTimeout;
    }
    if (params.gateContext !== undefined) pauseRequest['gateContext'] = params.gateContext;
    if (params.relatesTo !== undefined) pauseRequest['relatesTo'] = params.relatesTo;
    if (params.placement !== undefined) pauseRequest['placement'] = params.placement;

    return await pausedWithRequest(ctx, pauseRequest);
  }
}
