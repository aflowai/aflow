/**
 * Asking the operator before a browser action (D7). An action a profile's
 * posture or an origin rule asks about parks its step as an approval pause —
 * the write approval's own path — and runs on the fresh dispatch that follows
 * an approval. The grant is minted only at the authenticated resolve boundary;
 * this module reads it and spends it, and never writes it.
 *
 * Three facts make it hold. The request hash covers what the operator saw:
 * profile and page, the address of the page and of the frame the element is
 * in, the element's reference, role and accessible name, the action and a
 * digest of its value, all read from the page at the moment of the action.
 * The addresses are in it because a reference is bound to the element, and an
 * application that routes by script keeps its elements across routes. An
 * approval is spent by the one action it lets through, or by finding the page
 * changed under it. A denial
 * stays on record for as long as a request stands, so the same request on the
 * same page is refused with the operator's reason rather than put to them again.
 */
import { createHash } from 'node:crypto';

import {
  BROWSER_APPROVAL_EXCERPT_MAX_UNITS,
  BROWSER_APPROVAL_PATH_MAX_UNITS,
  type BrowserAction,
  type BrowserApprovalAskedBy,
  type BrowserApprovalValueSummary,
  type BrowserWriteApprovalRequestPayload,
  type PayloadRef,
  stableHash,
  stableStringify,
  WRITE_APPROVAL_GRANT_TTL_SECONDS,
  type WriteApprovalGrant,
  writeApprovalLifetimeWords,
} from '@aflow/schemas';

import { BrowserDriverError } from './errors.js';
import type { PageOwner } from './pageTable.js';
import type { EngineAction } from './types.js';

/** What the approver is shown of a value: enough to judge it. */
export const APPROVAL_EXCERPT_GRAPHEMES = 200;

/**
 * Until when a request asked for at `now` stands: the record of the ask, and
 * the grant an answer mints, live as long.
 */
export function askStandsUntil(now: number): number {
  return now + WRITE_APPROVAL_GRANT_TTL_SECONDS * 1000;
}

/** Where approvals are read and spent, and which request a call was parked on. */
export interface ApprovalStore {
  grant(scope: PageOwner, requestHash: string): Promise<WriteApprovalGrant | null>;
  /** True for the one caller that spent it. */
  spend(scope: PageOwner, grant: WriteApprovalGrant): Promise<boolean>;
  recall(scope: PageOwner, callKey: string): Promise<string | null>;
  remember(scope: PageOwner, callKey: string, requestHash: string): Promise<void>;
}

/**
 * What a call needs to ask. Only a browser step carries it: a coding harness
 * cannot wait on the operator, so a call without it is refused where it would
 * have asked.
 */
export interface ActionApprovals {
  readonly store: ApprovalStore;
  storeScreenshot(image: { data: string; mimeType: string }): Promise<PayloadRef>;
}

/** The action as the gate read it off the page, before anything was done. */
export interface ActionAsk {
  readonly profileId: string;
  /** The run's page: an approval for one page does not reach another opened later at the same place. */
  readonly pageId: string;
  /** The top page's address as the engine gives it, query and fragment included: hashed, never shown. */
  readonly pageUrl: string;
  /** The address of the frame the element belongs to, as given: hashed, never shown whole. */
  readonly frameUrl: string;
  /** The origin of that frame. */
  readonly pageOrigin: string;
  /** That frame's path, which the approver is shown beside its origin. */
  readonly pagePath: string;
  readonly pageTitle: string;
  readonly ref: string;
  readonly element: { readonly role: string; readonly name?: string };
  readonly action: EngineAction;
  /** The element takes a credential, so its value is described by length alone. */
  readonly credentialField: boolean;
  readonly askedBy: BrowserApprovalAskedBy;
}

/** The step parks here; the handler turns it into the approval pause. */
export class BrowserApprovalRequired extends Error {
  constructor(readonly request: BrowserWriteApprovalRequestPayload) {
    super(`The operator is asked before this ${request.action} on ${request.pageOrigin}.`);
    this.name = 'BrowserApprovalRequired';
  }
}

function digest(value: unknown): string {
  return createHash('sha256').update(stableStringify(value), 'utf8').digest('hex');
}

/** Everything the action would enter, and nothing for an action that enters nothing. */
function valueDigest(action: EngineAction): string | null {
  switch (action.kind) {
    case 'type':
      return digest({ text: action.text, submit: action.submit });
    case 'select':
      return digest({ values: action.values });
    case 'press':
      return digest({ key: action.key });
    case 'click':
    case 'hover':
      return null;
  }
}

export function browserActionRequestHash(ask: ActionAsk): string {
  return stableHash({
    target: 'browser',
    profileId: ask.profileId,
    pageId: ask.pageId,
    pageUrl: ask.pageUrl,
    frameUrl: ask.frameUrl,
    pageOrigin: ask.pageOrigin,
    ref: ask.ref,
    role: ask.element.role,
    name: ask.element.name ?? null,
    action: ask.action.kind,
    value: valueDigest(ask.action),
  });
}

/**
 * The call as the agent made it — page, reference, action and value — which
 * the dispatch after an approval makes again unchanged, whatever the page did
 * meanwhile. The page's address stays out of it for that reason: a call made
 * again after the page routed elsewhere finds the request it was parked on,
 * whose hash names the old address, and spends its approval as superseded.
 */
export function browserCallKey(pageId: string, ref: string, action: EngineAction): string {
  return stableHash({ pageId, ref, action: action.kind, value: valueDigest(action) });
}

function graphemes(text: string): string[] {
  return [...new Intl.Segmenter().segment(text)].map((part) => part.segment);
}

/**
 * The start of the text, cut between graphemes: at most
 * `APPROVAL_EXCERPT_GRAPHEMES` of them, and never past the schema's bound,
 * which one grapheme of combining marks could otherwise exceed alone.
 */
function excerpt(text: string): { excerpt: string; truncated: boolean } {
  let kept = '';
  let count = 0;
  for (const part of graphemes(text)) {
    if (count === APPROVAL_EXCERPT_GRAPHEMES) return { excerpt: kept, truncated: true };
    if (kept.length + part.length > BROWSER_APPROVAL_EXCERPT_MAX_UNITS) {
      return { excerpt: kept, truncated: true };
    }
    kept += part;
    count += 1;
  }
  return { excerpt: kept, truncated: false };
}

/** What the approver is shown of the value. Never a credential field's value. */
export function summarizeValue(
  action: EngineAction,
  credentialField: boolean,
): BrowserApprovalValueSummary | undefined {
  switch (action.kind) {
    case 'type': {
      const length = graphemes(action.text).length;
      return credentialField
        ? { kind: 'credential', length, truncated: false, submit: action.submit }
        : { kind: 'text', length, ...excerpt(action.text), submit: action.submit };
    }
    case 'select':
      return credentialField
        ? { kind: 'credential', length: action.values.length, truncated: false }
        : { kind: 'options', length: action.values.length, ...excerpt(action.values.join(', ')) };
    case 'press':
      return { kind: 'key', length: 1, ...excerpt(action.key) };
    case 'click':
    case 'hover':
      return undefined;
  }
}

function deniedError(ask: ActionAsk, grant: WriteApprovalGrant): BrowserDriverError {
  return new BrowserDriverError(
    'approval_denied',
    `The operator denied this ${ask.action.kind} on ${ask.pageOrigin}` +
      (grant.reason !== undefined ? `. Operator's reason: "${grant.reason}"` : '') +
      `. It stays denied on this page for as long as the request stands, ${writeApprovalLifetimeWords()} ` +
      'from the decision: the same action on the same element with the same value is refused ' +
      'with this reason rather than asked again. Propose a different action, or tell the user ' +
      'it was declined and ask how to proceed.',
    {
      origin: ask.pageOrigin,
      action: ask.action.kind,
      ...(grant.reason !== undefined ? { reason: grant.reason } : {}),
    },
  );
}

/**
 * What became of an approval for this call: it lets this action through, or it
 * was given for the page as it stood and the page has changed since, so it is
 * spent and the action is not performed.
 */
export type Cleared = 'approved' | 'superseded';

/**
 * Clears an action that asks, or parks it. Returns when an approval for
 * exactly this request was on record and this call spent it, or when the
 * approval this call was parked on was given for a request the page no longer
 * makes. Throws the operator's denial, or `BrowserApprovalRequired`.
 */
export async function clearAction(
  approvals: ActionApprovals,
  scope: PageOwner,
  callKey: string,
  ask: ActionAsk,
  standsUntil: number,
  screenshot: () => Promise<{ data: string; mimeType: string } | undefined>,
): Promise<Cleared> {
  const { store } = approvals;
  const requestHash = browserActionRequestHash(ask);
  const grant = await store.grant(scope, requestHash);
  if (grant?.decision === 'denied') throw deniedError(ask, grant);
  if (grant?.decision === 'approved' && (await store.spend(scope, grant))) return 'approved';

  const parkedOn = await store.recall(scope, callKey);
  if (
    parkedOn !== null &&
    parkedOn !== requestHash &&
    (await forfeitHash(store, scope, parkedOn))
  ) {
    return 'superseded';
  }

  await store.remember(scope, callKey, requestHash);
  const image = await screenshot().catch(() => undefined);
  const screenshotRef =
    image !== undefined ? await approvals.storeScreenshot(image).catch(() => undefined) : undefined;
  const value = summarizeValue(ask.action, ask.credentialField);
  const request: BrowserWriteApprovalRequestPayload = {
    kind: 'write_approval',
    target: 'browser',
    profileId: ask.profileId,
    pageOrigin: ask.pageOrigin,
    pagePath: ask.pagePath.slice(0, BROWSER_APPROVAL_PATH_MAX_UNITS),
    pageTitle: ask.pageTitle.slice(0, 500),
    action: ask.action.kind satisfies BrowserAction,
    element: {
      ref: ask.ref,
      role: ask.element.role,
      ...(ask.element.name !== undefined ? { name: ask.element.name.slice(0, 500) } : {}),
    },
    ...(value !== undefined ? { value } : {}),
    askedBy: ask.askedBy,
    ...(screenshotRef !== undefined ? { screenshotRef } : {}),
    standsUntil: new Date(standsUntil).toISOString(),
    ...(grant?.decidedAt !== undefined ? { decidedBefore: grant.decidedAt } : {}),
    requestHash,
  };
  throw new BrowserApprovalRequired(request);
}

async function forfeitHash(
  store: ApprovalStore,
  scope: PageOwner,
  requestHash: string,
): Promise<boolean> {
  const grant = await store.grant(scope, requestHash);
  return grant?.decision === 'approved' && (await store.spend(scope, grant));
}

/**
 * Spends the approval a call was parked on, when the call cannot be performed
 * as it was approved — its reference no longer resolves. True when one was
 * spent.
 */
export async function forfeitApproval(
  approvals: ActionApprovals,
  scope: PageOwner,
  callKey: string,
): Promise<boolean> {
  const parkedOn = await approvals.store.recall(scope, callKey);
  return parkedOn !== null && (await forfeitHash(approvals.store, scope, parkedOn));
}
