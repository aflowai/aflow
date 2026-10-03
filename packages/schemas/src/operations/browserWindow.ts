/**
 * Browser lane — the operations that involve the window: handing a page to
 * the operator, and taking a picture of one.
 *
 * A hand-off shows the profile's browser on the operator's desk at the page
 * that needs them — a sign-in, a challenge, a confirmation only a person may
 * give — and waits. A screenshot is stored as a payload and returned by
 * reference, never as bytes in the result.
 */
import { z } from 'zod';

import type { OperationRegistration } from '../catalog/operationCatalog.js';
import { buildOperationId } from '../catalog/operationId.js';
import { StepImageSchema } from '../media/stepImage.js';
import {
  BrowserElementRefSchema,
  BrowserOutlineMaxCharsSchema,
  BrowserPageIdSchema,
  browserPageViewShape,
  outlineReceiptShape,
} from './browser.js';

export const BROWSER_PAGE_HANDOFF_OPERATION_ID = buildOperationId('browser', 'page', 'handoff');
export const BROWSER_PAGE_SCREENSHOT_OPERATION_ID = buildOperationId(
  'browser',
  'page',
  'screenshot',
);

/** The largest image a screenshot stores; a larger one is retaken once as a smaller JPEG. */
export const BROWSER_SCREENSHOT_MAX_BYTES = 4 * 1024 * 1024;
/** The JPEG quality a screenshot over the ceiling is retaken at. */
export const BROWSER_SCREENSHOT_RETAKE_QUALITY = 60;

// ---------------------------------------------------------------------------
// browser.page.handoff
// ---------------------------------------------------------------------------

export const BROWSER_HANDOFF_REASONS = ['sign_in', 'challenge', 'confirm'] as const;
export type BrowserHandoffReason = (typeof BROWSER_HANDOFF_REASONS)[number];
export const BROWSER_HANDOFF_OUTCOMES = ['completed', 'window_closed', 'timed_out'] as const;
export type BrowserHandoffOutcome = (typeof BROWSER_HANDOFF_OUTCOMES)[number];

export const BrowserPageHandoffInputSchema = z.object({
  pageId: BrowserPageIdSchema,
  reason: z
    .enum(BROWSER_HANDOFF_REASONS)
    .describe(
      '`sign_in`: the page asks for an account. `challenge`: a CAPTCHA, a one-time code or a ' +
        'check that the visitor is a person. `confirm`: a step the operator should take ' +
        'themselves.',
    ),
  message: z
    .string()
    .min(1)
    .max(8_000)
    .describe(
      'For the operator: what is needed on this page, and what the run will do once they are ' +
        'done.',
    ),
  maxChars: BrowserOutlineMaxCharsSchema,
});

export const BrowserPageHandoffOutputSchema = z.object({
  outcome: z
    .enum(BROWSER_HANDOFF_OUTCOMES)
    .describe(
      '`completed`: the page moved on from the one handed over, holds no field for a password, ' +
        'code or passkey, is under no sign-in path and settled — usually signed in — or the ' +
        'operator pressed Done on the Action Center item. A page that waits for approval on ' +
        'another device with no field and outside a sign-in path also reads this way; read the ' +
        'outline. ' +
        '`window_closed`: the operator closed the window; read the outline before assuming ' +
        'anything was done. `timed_out`: nobody finished in time; the page is as they left it.',
    ),
  ...browserPageViewShape,
  pageId: BrowserPageIdSchema.describe(
    'The page to use from now on. When the window was shown by restarting the browser this is ' +
      'a new page, and `previousPageId` names the one it replaces.',
  ),
  previousPageId: BrowserPageIdSchema.optional().describe(
    'The page this call was given, which no longer resolves. Present only when it was replaced.',
  ),
  receipt: z.object({
    reason: z.enum(BROWSER_HANDOFF_REASONS),
    waitedSeconds: z.number().int().nonnegative(),
    restarted: z
      .boolean()
      .describe(
        'True when the profile’s browser was restarted with a window to show the page, which ' +
          'closed every other page open in it.',
      ),
    ...outlineReceiptShape,
  }),
});

// ---------------------------------------------------------------------------
// browser.page.screenshot
// ---------------------------------------------------------------------------

export const BrowserPageScreenshotInputSchema = z
  .object({
    pageId: BrowserPageIdSchema,
    ref: BrowserElementRefSchema.optional().describe(
      'Capture only this element. Omit for what the window shows.',
    ),
    fullPage: z
      .boolean()
      .default(false)
      .describe('Capture the whole scrollable page rather than what the window shows.'),
  })
  .superRefine((input, ctx) => {
    if (input.ref === undefined || !input.fullPage) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['fullPage'],
      message: 'An element is captured whole already: give `ref` or `fullPage`, not both.',
    });
  });

export const BrowserPageScreenshotOutputSchema = z.object({
  pageId: BrowserPageIdSchema,
  url: z.string(),
  image: StepImageSchema.describe(
    'The stored image. A model that takes images is shown it on the next turn; one that does ' +
      'not reads its description and size.',
  ),
  receipt: z.object({
    ref: z.string().optional(),
    fullPage: z.boolean(),
    retaken: z
      .boolean()
      .describe(
        'True when the first capture was over the size ceiling and this is a smaller JPEG.',
      ),
  }),
});

// ---------------------------------------------------------------------------
// Registrations
// ---------------------------------------------------------------------------

export const BrowserWindowRegistrations: OperationRegistration[] = [
  {
    stepType: 'browser',
    group: 'page',
    verb: 'handoff',
    name: 'Hand Page to Operator',
    actionLabel: 'Waiting for the operator in the browser window…',
    semanticDescription:
      'Show a page this run opened to the operator in a browser window on their machine, for ' +
      'what only they may do — sign in, pass a challenge, confirm a step — and wait, with one ' +
      'Action Center item per site that every run waiting on it shares. Returns when the page ' +
      'has moved on from the one handed over, holds no field for a password, a one-time code ' +
      'or a passkey, is under no sign-in path (login, signin, two-factor, verify, oauth, …) and ' +
      'has settled; when they press Done on the item or close the window; or at the profile’s ' +
      'deadline — with a fresh outline. A page asking the operator to approve the sign-in on ' +
      'another device, showing no field and outside a sign-in path, cannot be told apart from ' +
      'a signed-in page and ends the wait as one; Done or closing the window is what ends those ' +
      'faithfully.',
    tags: ['browser', 'web', 'page', 'local', 'operator'],
    idempotency: 'non_idempotent',
    mutates: true,
    usage: {
      oneLine: 'Hand a page to the operator to sign in or pass a check, and wait for them.',
      whenToUse: [
        'A sign-in form, a one-time code, a CAPTCHA, or a step the operator should take themselves',
      ],
      whenNotToUse: [
        'Anything the agent may do itself — browser.page.act does it',
        'A site browser.profile.list already shows a session for — try it first',
        'A page with no site — about:blank, a data: or file: address — has nothing to sign in to ' +
          'and is refused; go to the site’s own page first',
      ],
      pitfalls: [
        'Showing the window may restart the profile’s browser: every other page open in it is ' +
          'closed, and this page comes back under a new `pageId` — use the one returned.',
        'While the window is shown, every other browser call on the profile is refused.',
        '`window_closed` and `timed_out` say nothing about whether the operator finished: read ' +
          'the outline before going on.',
        '`completed` on a push-approval page — "check your phone", "approve on your device" — ' +
          'that shows no field outside a sign-in path can come before the approval: when the ' +
          'outline still asks for it, hand the page over again.',
        'The operator pressing Done or closing the window always ends a hand-off, whatever the ' +
          'page shows. Without either, a page that still holds a field for a password, code or ' +
          'passkey, or is still under a sign-in path, keeps the wait open until the deadline.',
      ],
      minimalExampleInput: {
        pageId: 'pg_…',
        reason: 'sign_in',
        message: 'Sign in to the example account; the run then reads this month’s invoices.',
      },
    },
    accessMode: 'write',
    inputZod: BrowserPageHandoffInputSchema,
    outputZod: BrowserPageHandoffOutputSchema,
  },
  {
    stepType: 'browser',
    group: 'page',
    verb: 'screenshot',
    name: 'Screenshot Page',
    actionLabel: 'Taking a screenshot…',
    semanticDescription:
      'An image of a page this run opened — what the window shows, the whole scrollable page, ' +
      'or one element. A model that takes images sees it on the next turn; one that does not ' +
      'reads a one-line description naming the page, with its size. Password fields are masked ' +
      'in the image.',
    tags: ['browser', 'web', 'page', 'local', 'image'],
    idempotency: 'idempotent',
    mutates: false,
    usage: {
      oneLine: 'See a page or one element as an image.',
      whenToUse: [
        'Evidence of what a page showed, for a report or for the operator',
        'A layout or visual state the outline and text cannot describe',
      ],
      whenNotToUse: ['Reading the page — the outline and browser.page.read are smaller'],
      pitfalls: [
        'Only the last three rounds of tool results keep their images; an older screenshot is ' +
          'reduced to its description — take another to look again.',
        'An image over the size ceiling is retaken once as a smaller JPEG, then refused with ' +
          'its size — capture one element or the visible window instead.',
      ],
      minimalExampleInput: { pageId: 'pg_…' },
    },
    accessMode: 'read',
    inputZod: BrowserPageScreenshotInputSchema,
    outputZod: BrowserPageScreenshotOutputSchema,
    imageOutputPaths: ['image'],
  },
];
