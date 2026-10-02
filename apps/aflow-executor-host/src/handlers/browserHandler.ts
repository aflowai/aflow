/**
 * The browser lane's handler. Every rule is the driver's; this turns a job
 * into a driver call and a driver refusal into the step's error.
 */
import type { ExecutorContext, StepHandler, StepResult } from '@aflow/executor-runtime';
import {
  failureWithError,
  internalError,
  successWithData,
  validationError,
} from '@aflow/executor-runtime';
import {
  type AflowError,
  type ErrorClassification,
  BROWSER_PAGE_OPEN_OPERATION_ID,
  BrowserPageOpenInputSchema,
  type BrowserPageOpenOutputSchema,
} from '@aflow/schemas';
import type { z } from 'zod';

import type { BrowserDriver } from '../browser/driver.js';
import { BrowserDriverError, type BrowserFailureKind } from '../browser/errors.js';

type BrowserPageOpenOutput = z.infer<typeof BrowserPageOpenOutputSchema>;

const FAILURE: Record<BrowserFailureKind, { code: string; classification: ErrorClassification }> = {
  page_gone: { code: 'PAGE_GONE', classification: 'not_found' },
  unknown_profile: { code: 'BROWSER_PROFILE_UNKNOWN', classification: 'permission' },
  profile_not_for_space: { code: 'BROWSER_PROFILE_NOT_FOR_SPACE', classification: 'permission' },
  appliance_origin: { code: 'BROWSER_ORIGIN_REFUSED', classification: 'permission' },
  no_browser: { code: 'BROWSER_NOT_FOUND', classification: 'configuration' },
  launch_failed: { code: 'BROWSER_LAUNCH_FAILED', classification: 'internal' },
  navigation_failed: { code: 'BROWSER_NAVIGATION_FAILED', classification: 'provider' },
};

export function browserFailure(error: BrowserDriverError): AflowError {
  const { code, classification } = FAILURE[error.kind];
  return {
    code,
    message: error.message,
    classification,
    // Nothing here gets better by being sent again unchanged, and a repeated
    // open would only open another page.
    retryable: false,
    timestamp: new Date().toISOString(),
    ...(Object.keys(error.details).length > 0 ? { details: { ...error.details } } : {}),
  };
}

async function open(ctx: ExecutorContext, driver: BrowserDriver): Promise<StepResult> {
  const parsed = BrowserPageOpenInputSchema.safeParse(await ctx.readPayload(ctx.job.inputRef));
  if (!parsed.success) return await failureWithError(ctx, validationError(parsed.error.message));
  const { url, profileId } = parsed.data;
  try {
    const opened = await driver.open({
      tenantId: ctx.tenantId,
      runId: ctx.runId,
      ...(ctx.spaceId !== undefined ? { spaceId: ctx.spaceId } : {}),
      profileId,
      url,
    });
    const output: BrowserPageOpenOutput = {
      pageId: opened.pageId,
      url: opened.url,
      title: opened.title,
      outline: opened.outline.text,
      ...(opened.outline.census !== undefined ? { outlineCensus: opened.outline.census } : {}),
      receipt: {
        profileId,
        requestedUrl: url,
        redirected: opened.url !== new URL(url).href,
        outlineElements: opened.outline.elements,
        outlineCut: opened.outline.census !== undefined,
      },
    };
    return await successWithData(ctx, output);
  } catch (error) {
    if (error instanceof BrowserDriverError) {
      return await failureWithError(ctx, browserFailure(error));
    }
    return await failureWithError(
      ctx,
      internalError(error instanceof Error ? error.message : String(error), { retryable: false }),
    );
  }
}

export function createBrowserHandler(driver: BrowserDriver): StepHandler {
  return {
    stepType: 'browser',
    async execute(ctx: ExecutorContext): Promise<StepResult> {
      if (ctx.operationId === BROWSER_PAGE_OPEN_OPERATION_ID) return await open(ctx, driver);
      return await failureWithError(
        ctx,
        validationError(`The browser lane on this machine does not serve \`${ctx.operationId}\`.`),
      );
    },
  };
}
