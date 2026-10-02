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
  BROWSER_PAGE_ACT_OPERATION_ID,
  BROWSER_PAGE_CLOSE_OPERATION_ID,
  BROWSER_PAGE_LIST_OPERATION_ID,
  BROWSER_PAGE_NAVIGATE_OPERATION_ID,
  BROWSER_PAGE_OPEN_OPERATION_ID,
  BROWSER_PAGE_READ_OPERATION_ID,
  BROWSER_PAGE_SNAPSHOT_OPERATION_ID,
  BROWSER_PROFILE_LIST_OPERATION_ID,
  BrowserPageActInputSchema,
  type BrowserPageActOutputSchema,
  BrowserPageCloseInputSchema,
  type BrowserPageCloseOutputSchema,
  BrowserPageListInputSchema,
  type BrowserPageListOutputSchema,
  BrowserPageNavigateInputSchema,
  type BrowserPageNavigateOutputSchema,
  BrowserPageOpenInputSchema,
  type BrowserPageOpenOutputSchema,
  BrowserPageReadInputSchema,
  type BrowserPageReadOutputSchema,
  BrowserPageSnapshotInputSchema,
  type BrowserPageSnapshotOutputSchema,
  BrowserProfileListInputSchema,
  type BrowserProfileListOutputSchema,
} from '@aflow/schemas';
import type { z } from 'zod';

import type { BrowserDriver } from '../browser/driver.js';
import type { PageView, RunScope } from '../browser/driverTypes.js';
import { BrowserDriverError, type BrowserFailureKind } from '../browser/errors.js';
import type { EngineAction, EngineNavigation } from '../browser/types.js';

type Output<S extends z.ZodTypeAny> = z.infer<S>;

const FAILURE: Record<BrowserFailureKind, { code: string; classification: ErrorClassification }> = {
  page_gone: { code: 'PAGE_GONE', classification: 'not_found' },
  unknown_profile: { code: 'BROWSER_PROFILE_UNKNOWN', classification: 'permission' },
  profile_not_for_space: { code: 'BROWSER_PROFILE_NOT_FOR_SPACE', classification: 'permission' },
  appliance_origin: { code: 'BROWSER_ORIGIN_REFUSED', classification: 'permission' },
  origin_denied: { code: 'BROWSER_ORIGIN_DENIED', classification: 'permission' },
  posture_refused: { code: 'BROWSER_POSTURE_REFUSED', classification: 'permission' },
  ask_unavailable: { code: 'BROWSER_ASK_NOT_AVAILABLE', classification: 'permission' },
  stale_ref: { code: 'BROWSER_REF_STALE', classification: 'validation' },
  credential_field: { code: 'BROWSER_CREDENTIAL_FIELD', classification: 'permission' },
  action_failed: { code: 'BROWSER_ACTION_FAILED', classification: 'provider' },
  no_browser: { code: 'BROWSER_NOT_FOUND', classification: 'configuration' },
  launch_failed: { code: 'BROWSER_LAUNCH_FAILED', classification: 'internal' },
  navigation_failed: { code: 'BROWSER_NAVIGATION_FAILED', classification: 'provider' },
  observation_failed: { code: 'BROWSER_OBSERVATION_FAILED', classification: 'provider' },
};

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

function scopeOf(ctx: ExecutorContext): RunScope {
  return {
    tenantId: ctx.tenantId,
    runId: ctx.runId,
    ...(ctx.spaceId !== undefined ? { spaceId: ctx.spaceId } : {}),
  };
}

/**
 * Whether this delivery may follow one that already acted. The executor-host
 * keeps pages in memory, so a job reclaimed from a dead executor finds its
 * page gone; what reaches a live page twice is a later attempt of the step.
 */
function redelivered(ctx: ExecutorContext): boolean {
  return ctx.attempt > 1;
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

function outlineReceipt(view: PageView): { outlineElements: number; outlineCut: boolean } {
  return { outlineElements: view.outline.elements, outlineCut: view.outline.census !== undefined };
}

interface Route {
  readonly schema: z.ZodTypeAny;
  run(ctx: ExecutorContext, driver: BrowserDriver, input: unknown): Promise<unknown>;
}

/** A route receives its input as its schema parsed it, once. */
function route<S extends z.ZodTypeAny>(
  schema: S,
  run: (ctx: ExecutorContext, driver: BrowserDriver, input: z.infer<S>) => Promise<unknown>,
): Route {
  return { schema, run: async (ctx, driver, input) => await run(ctx, driver, input as z.infer<S>) };
}

const open = route(BrowserPageOpenInputSchema, async (ctx, driver, { url, profileId }) => {
  const view = await driver.open({ ...scopeOf(ctx), profileId, url });
  const output: Output<typeof BrowserPageOpenOutputSchema> = {
    ...viewFields(view),
    receipt: {
      profileId,
      requestedUrl: url,
      redirected: view.url !== new URL(url).href,
      ...outlineReceipt(view),
    },
  };
  return output;
});

const navigate = route(BrowserPageNavigateInputSchema, async (ctx, driver, input) => {
  const to: EngineNavigation =
    input.url !== undefined
      ? { kind: 'url', url: input.url }
      : input.back === true
        ? { kind: 'back' }
        : input.forward === true
          ? { kind: 'forward' }
          : { kind: 'reload' };
  const result = await driver.navigate({
    ...scopeOf(ctx),
    pageId: input.pageId,
    to,
    redelivered: redelivered(ctx),
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

const act = route(BrowserPageActInputSchema, async (ctx, driver, input) => {
  const result = await driver.act({
    ...scopeOf(ctx),
    pageId: input.pageId,
    ref: input.ref,
    action: engineAction(input),
    redelivered: redelivered(ctx),
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

const snapshot = route(BrowserPageSnapshotInputSchema, async (ctx, driver, { pageId, ref }) => {
  const taken = await driver.snapshot(scopeOf(ctx), pageId, ref);
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
    },
  };
  return output;
});

const read = route(BrowserPageReadInputSchema, async (ctx, driver, { pageId, what, contains }) => {
  const result = await driver.readPage(scopeOf(ctx), pageId, what, contains);
  const base = { pageId, url: result.url, what: result.what, withheld: result.withheld };
  const output: Output<typeof BrowserPageReadOutputSchema> =
    result.what === 'text'
      ? { ...base, text: result.text }
      : result.what === 'console'
        ? { ...base, console: result.console, notRetained: result.notRetained }
        : { ...base, network: result.network, notRetained: result.notRetained };
  return output;
});

const list = route(BrowserPageListInputSchema, async (ctx, driver) => {
  const pages = await driver.list(scopeOf(ctx));
  const output: Output<typeof BrowserPageListOutputSchema> = {
    pages: pages.map((page) => ({ ...page, lastUsedAt: new Date(page.lastUsedAt).toISOString() })),
  };
  return output;
});

const close = route(BrowserPageCloseInputSchema, async (ctx, driver, { pageId }) => {
  const output: Output<typeof BrowserPageCloseOutputSchema> = {
    pageId,
    state: await driver.close(scopeOf(ctx), pageId),
  };
  return output;
});

const listProfiles = route(BrowserProfileListInputSchema, async (ctx, driver) => {
  const output: Output<typeof BrowserProfileListOutputSchema> = {
    profiles: (await driver.listProfiles(ctx.spaceId)).map((profile) => ({
      ...profile,
      ...(profile.sites !== undefined ? { sites: [...profile.sites] } : {}),
    })),
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
  [BROWSER_PROFILE_LIST_OPERATION_ID]: listProfiles,
};

/** The operations this lane serves, for a test to hold against the registry. */
export const SERVED_BROWSER_OPERATIONS: readonly string[] = Object.keys(ROUTES);

export function createBrowserHandler(driver: BrowserDriver): StepHandler {
  return {
    stepType: 'browser',
    async execute(ctx: ExecutorContext): Promise<StepResult> {
      const route = ROUTES[ctx.operationId];
      if (route === undefined) {
        return await failureWithError(
          ctx,
          validationError(
            `The browser lane on this machine does not serve \`${ctx.operationId}\`.`,
          ),
        );
      }
      const raw = await ctx.readPayload(ctx.job.inputRef);
      const parsed = route.schema.safeParse(raw);
      if (!parsed.success)
        return await failureWithError(ctx, validationError(parsed.error.message));
      try {
        return await successWithData(ctx, await route.run(ctx, driver, parsed.data));
      } catch (error) {
        if (error instanceof BrowserDriverError) {
          return await failureWithError(ctx, browserFailure(error));
        }
        return await failureWithError(
          ctx,
          internalError(error instanceof Error ? error.message : String(error), {
            retryable: false,
          }),
        );
      }
    },
  };
}
