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
  type PayloadRef,
  BROWSER_PAGE_ACT_OPERATION_ID,
  BROWSER_PAGE_CLOSE_OPERATION_ID,
  BROWSER_PAGE_HANDOFF_OPERATION_ID,
  BROWSER_PAGE_LIST_OPERATION_ID,
  BROWSER_PAGE_NAVIGATE_OPERATION_ID,
  BROWSER_PAGE_OPEN_OPERATION_ID,
  BROWSER_PAGE_READ_OPERATION_ID,
  BROWSER_PAGE_SCREENSHOT_OPERATION_ID,
  BROWSER_PAGE_SNAPSHOT_OPERATION_ID,
  BROWSER_PROFILE_LIST_OPERATION_ID,
  BrowserPageActInputSchema,
  type BrowserPageActOutputSchema,
  BrowserPageCloseInputSchema,
  type BrowserPageCloseOutputSchema,
  BrowserPageHandoffInputSchema,
  type BrowserPageHandoffOutputSchema,
  BrowserPageListInputSchema,
  type BrowserPageListOutputSchema,
  BrowserPageNavigateInputSchema,
  type BrowserPageNavigateOutputSchema,
  BrowserPageOpenInputSchema,
  type BrowserPageOpenOutputSchema,
  BrowserPageReadInputSchema,
  type BrowserPageReadOutputSchema,
  BrowserPageScreenshotInputSchema,
  type BrowserPageScreenshotOutputSchema,
  BrowserPageSnapshotInputSchema,
  type BrowserPageSnapshotOutputSchema,
  BrowserProfileListInputSchema,
  type BrowserProfileListOutputSchema,
} from '@aflow/schemas';
import type { z } from 'zod';

import type { BrowserDriver } from '../browser/driver.js';
import type { PageView, RunScope } from '../browser/driverTypes.js';
import { BrowserDriverError, type BrowserFailureKind } from '../browser/errors.js';
import { screenshotDescription } from '../browser/screenshot.js';
import type { EngineAction, EngineNavigation } from '../browser/types.js';

type Output<S extends z.ZodTypeAny> = z.infer<S>;

const FAILURE: Record<BrowserFailureKind, { code: string; classification: ErrorClassification }> = {
  page_gone: { code: 'PAGE_GONE', classification: 'not_found' },
  unknown_profile: { code: 'BROWSER_PROFILE_UNKNOWN', classification: 'permission' },
  profile_invalid: { code: 'BROWSER_PROFILE_INVALID', classification: 'configuration' },
  profile_not_for_space: { code: 'BROWSER_PROFILE_NOT_FOR_SPACE', classification: 'permission' },
  appliance_origin: { code: 'BROWSER_ORIGIN_REFUSED', classification: 'permission' },
  origin_denied: { code: 'BROWSER_ORIGIN_DENIED', classification: 'permission' },
  posture_refused: { code: 'BROWSER_POSTURE_REFUSED', classification: 'permission' },
  ask_unavailable: { code: 'BROWSER_ASK_NOT_AVAILABLE', classification: 'permission' },
  stale_ref: { code: 'BROWSER_REF_STALE', classification: 'validation' },
  credential_field: { code: 'BROWSER_CREDENTIAL_FIELD', classification: 'permission' },
  field_unchecked: { code: 'BROWSER_FIELD_UNCHECKED', classification: 'validation' },
  action_failed: { code: 'BROWSER_ACTION_FAILED', classification: 'provider' },
  no_browser: { code: 'BROWSER_NOT_FOUND', classification: 'configuration' },
  launch_failed: { code: 'BROWSER_LAUNCH_FAILED', classification: 'internal' },
  navigation_failed: { code: 'BROWSER_NAVIGATION_FAILED', classification: 'provider' },
  open_uncertain: { code: 'BROWSER_OPEN_UNCERTAIN', classification: 'conflict' },
  observation_failed: { code: 'BROWSER_OBSERVATION_FAILED', classification: 'provider' },
  window_shown: { code: 'BROWSER_WINDOW_IN_USE', classification: 'conflict' },
  window_failed: { code: 'BROWSER_WINDOW_FAILED', classification: 'internal' },
  handoff_not_posted: { code: 'BROWSER_HANDOFF_NOT_POSTED', classification: 'internal' },
  no_site: { code: 'BROWSER_PAGE_HAS_NO_SITE', classification: 'validation' },
  screenshot_too_large: { code: 'BROWSER_SCREENSHOT_TOO_LARGE', classification: 'validation' },
  script_refused: { code: 'BROWSER_SCRIPT_REFUSED', classification: 'permission' },
};

/**
 * Room past a hand-off's own wait for the browser to be restarted with a
 * window and back again, each start allowed half a minute, and the page to
 * load in it.
 */
export const BROWSER_HANDOFF_OUTER_MARGIN_MS = 150_000;

export function browserFailure(error: BrowserDriverError): AflowError {
  const { code, classification } = FAILURE[error.kind];
  return {
    code,
    message: error.message,
    classification,
    // Nothing here gets better by being sent again unchanged, and a repeated
    // open or action would do it twice.
    retryable: false,
    timestamp: new Date().toISOString(),
    ...(Object.keys(error.details).length > 0 ? { details: { ...error.details } } : {}),
  };
}

/**
 * What a browser operation needs from whoever asked for it: a step on the
 * browser lane, or a harness run through its relay. Everything else — the
 * input's schema, the driver's rules, the refusal's code — is the same for both.
 */
export interface BrowserCall extends RunScope {
  /** An earlier delivery of this same call may already have acted. */
  readonly redelivered: boolean;
  readonly stepExecutionId: string;
  readonly sessionId?: string;
  /** Keeps a screenshot, in the form a StepImage's reference names. */
  storeScreenshot(image: { data: string; mimeType: string }): Promise<PayloadRef>;
}

function scopeOf(scope: RunScope | ExecutorContext): RunScope {
  return {
    tenantId: scope.tenantId,
    runId: scope.runId,
    ...(scope.spaceId !== undefined ? { spaceId: scope.spaceId } : {}),
  };
}

/**
 * A step's call. Whether this delivery may follow one that already acted: the
 * executor-host keeps pages in memory, so a job reclaimed from a dead executor
 * finds its page gone; what reaches a live page twice is a later attempt.
 */
function callOf(ctx: ExecutorContext): BrowserCall {
  return {
    ...scopeOf(ctx),
    redelivered: ctx.attempt > 1,
    stepExecutionId: ctx.stepExecutionId,
    ...(ctx.job.sessionId !== undefined ? { sessionId: ctx.job.sessionId } : {}),
    storeScreenshot: async (image) => await ctx.writePayload('screenshot', image),
  };
}

function viewFields(view: PageView): {
  pageId: string;
  url: string;
  title: string;
  outline: string;
  outlineCensus?: Record<string, number>;
} {
  return {
    pageId: view.pageId,
    url: view.url,
    title: view.title,
    outline: view.outline.text,
    ...(view.outline.census !== undefined ? { outlineCensus: { ...view.outline.census } } : {}),
  };
}

function outlineReceipt(view: PageView): {
  outlineElements: number;
  outlineCut: boolean;
  settled: boolean;
} {
  return {
    outlineElements: view.outline.elements,
    outlineCut: view.outline.census !== undefined,
    settled: view.settled,
  };
}

function bound(maxChars: number | undefined): { maxChars?: number } {
  return maxChars !== undefined ? { maxChars } : {};
}

interface Route {
  readonly schema: z.ZodTypeAny;
  run(call: BrowserCall, driver: BrowserDriver, input: unknown): Promise<unknown>;
}

/** A route receives its input as its schema parsed it, once. */
function route<S extends z.ZodTypeAny>(
  schema: S,
  run: (call: BrowserCall, driver: BrowserDriver, input: z.infer<S>) => Promise<unknown>,
): Route {
  return {
    schema,
    run: async (call, driver, input) => await run(call, driver, input as z.infer<S>),
  };
}

const open = route(BrowserPageOpenInputSchema, async (call, driver, input) => {
  const { url, profileId } = input;
  const opened = await driver.open({
    ...scopeOf(call),
    profileId,
    url,
    redelivered: call.redelivered,
    ...bound(input.maxChars),
  });
  const output: Output<typeof BrowserPageOpenOutputSchema> = {
    outcome: opened.outcome,
    ...viewFields(opened),
    ...(opened.outcome === 'performed'
      ? {
          receipt: {
            profileId,
            requestedUrl: url,
            redirected: opened.redirected,
            ...outlineReceipt(opened),
          },
        }
      : {}),
  };
  return output;
});

const navigate = route(BrowserPageNavigateInputSchema, async (call, driver, input) => {
  const to: EngineNavigation =
    input.url !== undefined
      ? { kind: 'url', url: input.url }
      : input.back === true
        ? { kind: 'back' }
        : input.forward === true
          ? { kind: 'forward' }
          : { kind: 'reload' };
  const result = await driver.navigate({
    ...scopeOf(call),
    pageId: input.pageId,
    to,
    redelivered: call.redelivered,
    ...bound(input.maxChars),
  });
  const output: Output<typeof BrowserPageNavigateOutputSchema> = {
    outcome: result.outcome,
    ...viewFields(result.view),
    ...(result.outcome === 'performed'
      ? { receipt: { went: to.kind, ...result.changed, ...outlineReceipt(result.view) } }
      : {}),
  };
  return output;
});

function engineAction(input: z.infer<typeof BrowserPageActInputSchema>): EngineAction {
  switch (input.action) {
    case 'type':
      return { kind: 'type', text: input.text ?? '', submit: input.submit ?? false };
    case 'select':
      return { kind: 'select', values: input.values ?? [] };
    case 'press':
      return { kind: 'press', key: input.key ?? '' };
    case 'click':
    case 'hover':
      return { kind: input.action };
  }
}

const act = route(BrowserPageActInputSchema, async (call, driver, input) => {
  const result = await driver.act({
    ...scopeOf(call),
    pageId: input.pageId,
    ref: input.ref,
    action: engineAction(input),
    redelivered: call.redelivered,
    ...bound(input.maxChars),
  });
  const output: Output<typeof BrowserPageActOutputSchema> = {
    outcome: result.outcome,
    ...viewFields(result.view),
    ...(result.outcome === 'performed'
      ? {
          receipt: {
            action: input.action,
            ref: input.ref,
            element: { ...result.element },
            ...(result.typed !== undefined ? { typed: { ...result.typed } } : {}),
            ...result.changed,
            ...outlineReceipt(result.view),
          },
        }
      : {}),
  };
  return output;
});

const snapshot = route(BrowserPageSnapshotInputSchema, async (call, driver, input) => {
  const { pageId, ref } = input;
  const taken = await driver.snapshot(scopeOf(call), pageId, ref, input.maxChars);
  const output: Output<typeof BrowserPageSnapshotOutputSchema> = {
    pageId,
    url: taken.url,
    title: taken.title,
    snapshot: taken.snapshot.text,
    ...(taken.snapshot.census !== undefined
      ? { snapshotCensus: { ...taken.snapshot.census } }
      : {}),
    receipt: {
      ...(ref !== undefined ? { ref } : {}),
      lines: taken.snapshot.lines,
      cut: taken.snapshot.census !== undefined,
      ...(taken.snapshot.continueRef !== undefined
        ? { continueRef: taken.snapshot.continueRef }
        : {}),
    },
  };
  return output;
});

const read = route(BrowserPageReadInputSchema, async (call, driver, input) => {
  const { pageId, what, contains, offset } = input;
  const result = await driver.readPage(scopeOf(call), pageId, {
    what,
    ...(contains !== undefined ? { contains } : {}),
    ...(offset !== undefined ? { offset } : {}),
    ...bound(input.maxChars),
  });
  const base = { pageId, url: result.url, what: result.what, withheld: result.withheld };
  const output: Output<typeof BrowserPageReadOutputSchema> =
    result.what === 'text'
      ? {
          ...base,
          text: result.text,
          ...(result.nextOffset !== undefined ? { nextOffset: result.nextOffset } : {}),
        }
      : result.what === 'console'
        ? { ...base, console: result.console, notRetained: result.notRetained }
        : { ...base, network: result.network, notRetained: result.notRetained };
  return output;
});

const list = route(BrowserPageListInputSchema, async (call, driver) => {
  const pages = await driver.list(scopeOf(call));
  const output: Output<typeof BrowserPageListOutputSchema> = {
    pages: pages.map((page) => ({ ...page, lastUsedAt: new Date(page.lastUsedAt).toISOString() })),
  };
  return output;
});

const close = route(BrowserPageCloseInputSchema, async (call, driver, { pageId }) => {
  const output: Output<typeof BrowserPageCloseOutputSchema> = {
    pageId,
    state: await driver.close(scopeOf(call), pageId),
  };
  return output;
});

const listProfiles = route(BrowserProfileListInputSchema, async (call, driver) => {
  const output: Output<typeof BrowserProfileListOutputSchema> = {
    profiles: (await driver.listProfiles(call.spaceId)).map((profile) => ({
      ...profile,
      ...(profile.sites !== undefined ? { sites: [...profile.sites] } : {}),
    })),
  };
  return output;
});

const screenshot = route(BrowserPageScreenshotInputSchema, async (call, driver, input) => {
  const { pageId, ref, fullPage } = input;
  const request = { ...(ref !== undefined ? { ref } : {}), fullPage };
  const taken = await driver.screenshot(scopeOf(call), pageId, request);
  // The form a StepImage's reference names, which the agent turn reads to show
  // the model the image.
  const imageRef = await call.storeScreenshot({
    data: taken.bytes.toString('base64'),
    mimeType: taken.contentType,
  });
  const output: Output<typeof BrowserPageScreenshotOutputSchema> = {
    pageId,
    url: taken.url,
    image: {
      ref: imageRef,
      contentType: taken.contentType,
      sizeBytes: taken.bytes.length,
      width: taken.width,
      height: taken.height,
      description: screenshotDescription(taken, request),
    },
    receipt: { ...request, retaken: taken.retaken },
  };
  return output;
});

const handoff = route(BrowserPageHandoffInputSchema, async (call, driver, input) => {
  const result = await driver.handoff({
    ...scopeOf(call),
    stepExecutionId: call.stepExecutionId,
    ...(call.sessionId !== undefined ? { sessionId: call.sessionId } : {}),
    pageId: input.pageId,
    reason: input.reason,
    message: input.message,
    ...bound(input.maxChars),
  });
  const output: Output<typeof BrowserPageHandoffOutputSchema> = {
    outcome: result.outcome,
    ...viewFields(result.view),
    ...(result.previousPageId !== undefined ? { previousPageId: result.previousPageId } : {}),
    receipt: {
      reason: input.reason,
      waitedSeconds: Math.round(result.waitedMs / 1000),
      restarted: result.restarted,
      ...outlineReceipt(result.view),
    },
  };
  return output;
});

const ROUTES: Readonly<Record<string, Route>> = {
  [BROWSER_PAGE_OPEN_OPERATION_ID]: open,
  [BROWSER_PAGE_NAVIGATE_OPERATION_ID]: navigate,
  [BROWSER_PAGE_ACT_OPERATION_ID]: act,
  [BROWSER_PAGE_SNAPSHOT_OPERATION_ID]: snapshot,
  [BROWSER_PAGE_READ_OPERATION_ID]: read,
  [BROWSER_PAGE_LIST_OPERATION_ID]: list,
  [BROWSER_PAGE_CLOSE_OPERATION_ID]: close,
  [BROWSER_PAGE_SCREENSHOT_OPERATION_ID]: screenshot,
  [BROWSER_PAGE_HANDOFF_OPERATION_ID]: handoff,
  [BROWSER_PROFILE_LIST_OPERATION_ID]: listProfiles,
};

/** The operations this lane serves, for a test to hold against the registry. */
export const SERVED_BROWSER_OPERATIONS: readonly string[] = Object.keys(ROUTES);

export type BrowserOperationOutcome =
  | { readonly ok: true; readonly output: unknown }
  | { readonly ok: false; readonly error: AflowError };

/**
 * One browser operation, from its raw input to its output or its refusal. The
 * step handler and the harness relay both call this and nothing beneath it, so
 * a rule, a bound or a refusal cannot differ between them.
 */
export async function performBrowserOperation(
  driver: BrowserDriver,
  operationId: string,
  raw: unknown,
  call: BrowserCall,
): Promise<BrowserOperationOutcome> {
  const route = ROUTES[operationId];
  if (route === undefined) {
    return {
      ok: false,
      error: validationError(`The browser lane on this machine does not serve \`${operationId}\`.`),
    };
  }
  const parsed = route.schema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: validationError(parsed.error.message) };
  try {
    return { ok: true, output: await route.run(call, driver, parsed.data) };
  } catch (error) {
    if (error instanceof BrowserDriverError) return { ok: false, error: browserFailure(error) };
    return {
      ok: false,
      error: internalError(error instanceof Error ? error.message : String(error), {
        retryable: false,
      }),
    };
  }
}

function noSpace(): AflowError {
  return {
    code: 'BROWSER_JOB_HAS_NO_SPACE',
    message:
      'This browser step reached the machine carrying no space, so it was refused: which ' +
      'profiles it may use and where a hand-off is shown both depend on the space its run is in.',
    classification: 'internal',
    retryable: false,
    timestamp: new Date().toISOString(),
  };
}

export function createBrowserHandler(driver: BrowserDriver): StepHandler {
  return {
    stepType: 'browser',
    // A hand-off waits on a person for as long as the profile allows; every
    // other operation fits the lane's default.
    async resolveTimeoutMs(ctx: ExecutorContext): Promise<number | undefined> {
      if (ctx.operationId !== BROWSER_PAGE_HANDOFF_OPERATION_ID) return undefined;
      if (ctx.stepDefinition?.timeout?.executionTimeoutMs !== undefined) return undefined;
      const parsed = BrowserPageHandoffInputSchema.safeParse(
        await ctx.readPayload(ctx.job.inputRef),
      );
      if (!parsed.success) return undefined;
      const waitMs = await driver.handoffWaitLimitMs(scopeOf(ctx), parsed.data.pageId);
      return waitMs === undefined ? undefined : waitMs + BROWSER_HANDOFF_OUTER_MARGIN_MS;
    },
    async execute(ctx: ExecutorContext): Promise<StepResult> {
      // Without a space, every check that asks which profiles a space may use
      // would be answered for no space at all, and a hand-off would have no
      // Action Center to be shown in.
      if (ctx.spaceId === undefined) return await failureWithError(ctx, noSpace());
      const raw = await ctx.readPayload(ctx.job.inputRef);
      const outcome = await performBrowserOperation(driver, ctx.operationId, raw, callOf(ctx));
      return outcome.ok
        ? await successWithData(ctx, outcome.output)
        : await failureWithError(ctx, outcome.error);
    },
  };
}
