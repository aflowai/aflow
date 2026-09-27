import type { ExecutorContext, StepResult } from '@aflow/executor-runtime';
import { successWithData, failureWithError } from '@aflow/executor-runtime';
import { UserSendEmailInputSchema, type AflowError } from '@aflow/schemas';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Redis } from 'ioredis';
import { createTransport } from 'nodemailer';
import {
  type CredentialResolver,
  type CredentialContext,
  credentialMissingMessage,
} from '@aflow/credential-resolver';

import { renderEmailContent } from '../email/render.js';
import { resolveRecipient } from '../email/recipientResolver.js';
import type { UserSendEmailOutput } from '@aflow/schemas';

export interface SendEmailDeps {
  redis: Redis;
  db: PostgresJsDatabase;
  credentialResolver: CredentialResolver;
}

/**
 * Execute the send_email operation.
 */
export async function executeSendEmail(
  ctx: ExecutorContext,
  deps: SendEmailDeps,
): Promise<StepResult> {
  const { redis, db, credentialResolver } = deps;
  const log = ctx.log;

  // 1. Read and validate input
  const rawInput = await ctx.readPayload(ctx.job.inputRef);
  const parsed = UserSendEmailInputSchema.safeParse(rawInput);

  if (!parsed.success) {
    return failureWithError(ctx, contentInvalidError(parsed.error.message));
  }

  const { subject, content, contentFormat } = parsed.data;

  // 2. Resolve SES credentials from scope chain
  const { tenantId, credentialOwnerId, spaceId } = ctx.job;
  if (!credentialOwnerId || !spaceId) {
    return failureWithError(
      ctx,
      emailConfigError(
        'Step job is missing credentialOwnerId or spaceId. ' +
          'This run may have been created before BYOK credentials were enabled.',
      ),
    );
  }

  const credCtx: CredentialContext = { tenantId, credentialOwnerId, spaceId };
  const resolved = await credentialResolver.resolve('ses', credCtx);
  if (!resolved) {
    return failureWithError(ctx, emailConfigError(credentialMissingMessage('ses')));
  }

  // Extract SES fields from resolved credential bundle
  const smtpHost = resolved.config['smtp_host'];
  const smtpUsername = resolved.secrets['smtp_username'];
  const smtpPassword = resolved.secrets['smtp_password'];
  const fromAddress = resolved.config['from_address'];

  if (!smtpHost || !smtpUsername || !smtpPassword || !fromAddress) {
    return failureWithError(
      ctx,
      emailConfigError(
        'SES credential is incomplete. Required: smtp_host, smtp_username, smtp_password, from_address. ' +
          'Update your credentials in Settings → Credentials → Amazon SES.',
      ),
    );
  }

  const smtpPort = parseInt(resolved.config['smtp_port'] ?? '587', 10);
  const fromName = resolved.config['from_name'];
  const replyTo = resolved.config['reply_to'];

  // 3. Resolve recipient
  const recipientResult = await resolveRecipient(redis, db, ctx.tenantId, ctx.runId);

  if (!recipientResult.ok) {
    log.warn('Recipient resolution failed', {
      code: recipientResult.code,
      runId: ctx.runId,
    });
    return failureWithError(ctx, recipientError(recipientResult.code, recipientResult.message));
  }

  const { recipient } = recipientResult;

  log.info('Sending email', {
    recipientUserId: recipient.userId,
    contentFormat,
    subjectLength: subject.length,
    contentLength: content.length,
  });

  // 4. Render content
  const rendered = await renderEmailContent(content, contentFormat);

  // 5. Create transport and send
  const from = fromName ? `"${fromName}" <${fromAddress}>` : fromAddress;

  let messageId: string;
  try {
    const transporter = createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465,
      auth: { user: smtpUsername, pass: smtpPassword },
    });

    const info = (await transporter.sendMail({
      from,
      to: recipient.email,
      subject,
      html: rendered.html,
      text: rendered.text,
      ...(replyTo ? { replyTo } : {}),
    })) as { messageId: unknown };

    messageId = String(info.messageId);
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.error('SMTP send failed', { error: errMsg });
    return failureWithError(ctx, transportError(errMsg));
  }

  log.info('Email sent', {
    messageId,
    recipientUserId: recipient.userId,
    contentFormat,
  });

  // 6. Return success
  const output: UserSendEmailOutput = {
    provider: 'ses_smtp',
    messageId,
    recipientUserId: recipient.userId,
    recipientEmail: recipient.email,
    subject,
    contentFormat,
    sentAt: new Date().toISOString(),
  };

  return successWithData(ctx, output);
}

// ============================================================================
// Error constructors
// ============================================================================

function emailConfigError(message: string): AflowError {
  return {
    code: 'EMAIL_DELIVERY_NOT_CONFIGURED',
    message,
    classification: 'validation',
    retryable: false,
    timestamp: new Date().toISOString(),
  };
}

function recipientError(code: string, message: string): AflowError {
  return {
    code,
    message,
    classification: 'validation',
    retryable: false,
    timestamp: new Date().toISOString(),
  };
}

function contentInvalidError(message: string): AflowError {
  return {
    code: 'EMAIL_CONTENT_INVALID',
    message: `Invalid email input: ${message}`,
    classification: 'validation',
    retryable: false,
    timestamp: new Date().toISOString(),
  };
}

function transportError(message: string): AflowError {
  return {
    code: 'EMAIL_TRANSPORT_ERROR',
    message: `SMTP send failed: ${message}`,
    classification: 'provider',
    retryable: true,
    timestamp: new Date().toISOString(),
  };
}
