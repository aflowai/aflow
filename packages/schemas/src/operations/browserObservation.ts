/**
 * Browser lane — the operations that look at a page without changing it, the
 * run's page list and close, and the profiles a space may use.
 */
import { z } from 'zod';

import type { OperationRegistration } from '../catalog/operationCatalog.js';
import { buildOperationId } from '../catalog/operationId.js';
import type { OperationObservation } from '../runtime/toolObservation.js';
import {
  BROWSER_OUTLINE_MAX_CHARS,
  BROWSER_PAGE_OBSERVATION_GROUP,
  BROWSER_PAGE_OUTLINE_FACET,
  BrowserElementRefSchema,
  browserMaxCharsSchema,
  BrowserOutlineCensusSchema,
  BrowserPageIdSchema,
} from './browser.js';
import { BrowserPostureSchema, BrowserProfileIdSchema } from './browserProfile.js';

export const BROWSER_PAGE_SNAPSHOT_OPERATION_ID = buildOperationId('browser', 'page', 'snapshot');
export const BROWSER_PAGE_READ_OPERATION_ID = buildOperationId('browser', 'page', 'read');
export const BROWSER_PAGE_LIST_OPERATION_ID = buildOperationId('browser', 'page', 'list');
export const BROWSER_PAGE_CLOSE_OPERATION_ID = buildOperationId('browser', 'page', 'close');
export const BROWSER_PROFILE_LIST_OPERATION_ID = buildOperationId('browser', 'profile', 'list');

/** The most text, console or network one read may ask for with `maxChars`. */
export const BROWSER_READ_MAX_CHARS = 32_000;
/** Console messages or network requests one read returns. */
export const BROWSER_READ_MAX_ENTRIES = 200;

/**
 * What a snapshot and a read return unless the call asks for more: under
 * `TOOL_RESULT_INLINE_MAX_CHARS` with the rest of the result, so the agent
 * reads it in the same call. Counted as the result carries the characters.
 */
export const BROWSER_SNAPSHOT_DEFAULT_CHARS = 8_000;
export const BROWSER_READ_DEFAULT_CHARS = 8_000;

// ---------------------------------------------------------------------------
// browser.page.snapshot
// ---------------------------------------------------------------------------

export const BrowserPageSnapshotInputSchema = z.object({
  pageId: BrowserPageIdSchema,
  ref: BrowserElementRefSchema.optional().describe(
    'Snapshot only this element and what is inside it. Omit for the whole page.',
  ),
  maxChars: browserMaxCharsSchema(
    'snapshot',
    BROWSER_SNAPSHOT_DEFAULT_CHARS,
    BROWSER_OUTLINE_MAX_CHARS,
  ),
});

export const BrowserPageSnapshotOutputSchema = z.object({
  pageId: BrowserPageIdSchema,
  url: z.string(),
  title: z.string(),
  snapshot: z
    .string()
    .describe(
      'The accessibility tree, one element per line, indented by nesting, with each element’s ' +
        '`[ref=…]` and its text. Password values are never shown.',
    ),
  snapshotCensus: BrowserOutlineCensusSchema.optional(),
  receipt: z.object({
    ref: z.string().optional().describe('The element the snapshot was scoped to, when it was.'),
    lines: z.number().int().nonnegative().describe('Lines the snapshot carries.'),
    cut: z.boolean().describe('True when the snapshot reached its bound.'),
    continueRef: z
      .string()
      .optional()
      .describe(
        'When cut: the element enclosing the first part left out. Snapshot with `ref` set to it ' +
          'to read on from there.',
      ),
  }),
});

// ---------------------------------------------------------------------------
// browser.page.read
// ---------------------------------------------------------------------------

export const BROWSER_READ_KINDS = ['text', 'console', 'network'] as const;

export const BrowserPageReadInputSchema = z.object({
  pageId: BrowserPageIdSchema,
  what: z
    .enum(BROWSER_READ_KINDS)
    .describe(
      '`text`: the visible text of the page. `console`: messages the page logged. `network`: ' +
        'requests it made. Console and network are kept from the moment the page was opened.',
    ),
  contains: z
    .string()
    .min(1)
    .optional()
    .describe('Keep only lines, messages or request addresses containing this, ignoring case.'),
  offset: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      'For `text`: start this many characters in — the `nextOffset` of a read that was cut. ' +
        'Counted in the text after `contains` has filtered it.',
    ),
  maxChars: browserMaxCharsSchema(
    'text or entries',
    BROWSER_READ_DEFAULT_CHARS,
    BROWSER_READ_MAX_CHARS,
  ),
});

export const BrowserConsoleEntrySchema = z.object({
  level: z.string().describe('`log`, `info`, `warning`, `error`, `debug`, …'),
  text: z.string(),
  at: z.string().describe('When it was logged, ISO 8601.'),
});

export const BrowserNetworkEntrySchema = z.object({
  method: z.string(),
  url: z.string().describe('The address, with every query value replaced by `redacted`.'),
  status: z
    .number()
    .int()
    .optional()
    .describe('The response status. Absent when the request failed before one arrived.'),
  failure: z.string().optional().describe('Why the request failed, when it did.'),
  resourceType: z.string().describe('`document`, `script`, `xhr`, `fetch`, `image`, …'),
  at: z.string().describe('When it finished, ISO 8601.'),
});

export const BrowserPageReadOutputSchema = z.object({
  pageId: BrowserPageIdSchema,
  url: z.string(),
  what: z.enum(BROWSER_READ_KINDS),
  contains: z
    .string()
    .describe('The `contains` this read was filtered by, the empty string when none was.'),
  text: z.string().optional().describe('For `text`.'),
  offset: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('For `text`: the `offset` this read was given, 0 when none was.'),
  console: z.array(BrowserConsoleEntrySchema).optional().describe('For `console`, oldest first.'),
  network: z.array(BrowserNetworkEntrySchema).optional().describe('For `network`, oldest first.'),
  withheld: z
    .number()
    .int()
    .nonnegative()
    .describe(
      'What matched but was left out because the result reached its bound: for `text`, the ' +
        'characters after what is shown — read on from `nextOffset`; for `console` and ' +
        '`network`, the oldest entries — narrow with `contains`, or raise `maxChars`.',
    ),
  nextOffset: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('For `text` cut short: the `offset` that reads on from where this one stopped.'),
  notRetained: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      'For `console` and `network`: entries the page produced so long ago that they are no ' +
        'longer kept.',
    ),
});

// ---------------------------------------------------------------------------
// browser.page.list / browser.page.close
// ---------------------------------------------------------------------------

export const BrowserPageListInputSchema = z.object({});

export const BrowserPageListOutputSchema = z.object({
  pages: z.array(
    z.object({
      pageId: BrowserPageIdSchema,
      url: z.string(),
      title: z.string(),
      profileId: BrowserProfileIdSchema,
      lastUsedAt: z.string().describe('When an operation last touched the page, ISO 8601.'),
    }),
  ),
});

export const BrowserPageCloseInputSchema = z.object({ pageId: BrowserPageIdSchema });

export const BrowserPageCloseOutputSchema = z.object({
  pageId: BrowserPageIdSchema,
  state: z
    .enum(['closed', 'already_gone'])
    .describe('`already_gone`: the page was not open — closed earlier, idle, or never this run’s.'),
});

// ---------------------------------------------------------------------------
// browser.profile.list
// ---------------------------------------------------------------------------

export const BrowserProfileListInputSchema = z.object({});

export const BrowserProfileListOutputSchema = z.object({
  profiles: z.array(
    z.object({
      profileId: BrowserProfileIdSchema,
      posture: BrowserPostureSchema,
      window: z.enum(['hidden', 'visible']),
      unattended: z
        .boolean()
        .describe(
          'Whether runs nobody is present for may use it: one a schedule, a webhook, the API, an ' +
            'MCP client, an eval, a timer, a sub-agent finishing or an agent last set going, ' +
            'rather than a person’s message or answer in the Action Center.',
        ),
      openToThisRun: z
        .boolean()
        .describe(
          '`false` when nobody is present for this run now and the profile takes no such run: ' +
            'every operation on it is refused until a person next sets the run going.',
        ),
      running: z.boolean().describe('Whether the profile’s browser is running now.'),
      sites: z
        .array(z.string())
        .optional()
        .describe(
          'Sites the profile holds cookies for — a session, usually — by host name only. ' +
            'Present while its browser is running.',
        ),
      sitesUnknown: z
        .enum(['not_started', 'stopped'])
        .optional()
        .describe(
          'Why `sites` is absent. `not_started`: its browser has not run since this machine’s ' +
            'browser executor started. `stopped`: its browser ran since then and has stopped, ' +
            'usually after sitting idle. ' +
            'Opening a page in the profile starts it, and the list then carries its sites.',
        ),
    }),
  ),
});

// ---------------------------------------------------------------------------
// Registrations
// ---------------------------------------------------------------------------

/**
 * A snapshot scoped to an element is replaced only by a later snapshot of the
 * same element; one continued from `continueRef` is another part, not a
 * replacement. A whole-page snapshot is the empty scope, and also the page's
 * outline. `maxChars` is not a part key: its references resolve only in the
 * newest look at the page, so any later snapshot of the same part replaces
 * it, however much either left out.
 */
export const BROWSER_PAGE_SNAPSHOT_OBSERVATION: OperationObservation = {
  group: BROWSER_PAGE_OBSERVATION_GROUP,
  facets: [
    {
      facet: 'snapshot',
      fields: ['snapshot', 'snapshotCensus'],
      keyPath: 'pageId',
      partKeyPaths: ['receipt.ref'],
      expires: 'on_any_later_look',
      currentStateOperation: BROWSER_PAGE_SNAPSHOT_OPERATION_ID,
    },
    {
      ...BROWSER_PAGE_OUTLINE_FACET,
      fields: ['snapshot', 'snapshotCensus'],
      onlyWhenAbsent: 'receipt.ref',
    },
  ],
};

/**
 * Text, console and network are different reads of a page, text read on from
 * `nextOffset` is another part of it, and a read filtered by `contains` shows
 * lines another filter does not: a later read replaces this one only when it
 * reads the same kind at the same offset through the same filter. `maxChars`
 * is not a part key, and what a read holds carries nothing that expires: a
 * later read of the same part replaces this one only when it leaves out no
 * more — what it `withheld` at its bound, and for console and network the
 * entries the browser no longer keeps (`notRetained`) — so a smaller read, or
 * one made after the oldest entries this one shows were dropped, leaves this
 * one in full.
 */
export const BROWSER_PAGE_READ_OBSERVATION: OperationObservation = {
  group: BROWSER_PAGE_OBSERVATION_GROUP,
  facets: [
    {
      facet: 'read',
      fields: ['text', 'console', 'network'],
      keyPath: 'pageId',
      partKeyPaths: ['what', 'offset', 'contains'],
      expires: 'on_covering_look',
      withheldAt: ['withheld', 'notRetained'],
      currentStateOperation: BROWSER_PAGE_READ_OPERATION_ID,
    },
  ],
};

export const BROWSER_PAGE_CLOSE_OBSERVATION: OperationObservation = {
  group: BROWSER_PAGE_OBSERVATION_GROUP,
  ends: ['pageId'],
};

const PAGE_IS_THE_RUNS =
  '`pageId` belongs to the run that opened it; a page that is gone fails with `page_gone` and ' +
  'the address it was last at.';

export const BrowserObservationRegistrations: OperationRegistration[] = [
  {
    stepType: 'browser',
    group: 'page',
    verb: 'snapshot',
    name: 'Snapshot Page',
    actionLabel: 'Reading the page structure…',
    semanticDescription:
      'The full accessibility tree of a page this run opened — every element with its text and ' +
      'reference — or of one element and what is inside it. Bounded like the outline, with a ' +
      'count of what was left out when cut.',
    tags: ['browser', 'web', 'page', 'local'],
    idempotency: 'idempotent',
    mutates: false,
    usage: {
      oneLine: 'The full accessibility tree of a page, or of one element in it.',
      whenToUse: [
        'The outline leaves out what an action needs — a list’s items, a table, a dialog’s text',
        'A cut outline: scope the snapshot to the region the census points at',
      ],
      whenNotToUse: ['Reading prose — browser.page.read with `what: text` is smaller'],
      pitfalls: [
        'A whole-page snapshot is large; scope it with `ref` where you can. A cut one names ' +
          'in `receipt.continueRef` the element to scope the next snapshot to.',
        'Its references replace the outline’s: act on the newest one taken.',
        PAGE_IS_THE_RUNS,
      ],
      minimalExampleInput: { pageId: 'pg_…', ref: 'e40' },
    },
    accessMode: 'read',
    inputZod: BrowserPageSnapshotInputSchema,
    outputZod: BrowserPageSnapshotOutputSchema,
    observation: BROWSER_PAGE_SNAPSHOT_OBSERVATION,
  },
  {
    stepType: 'browser',
    group: 'page',
    verb: 'read',
    name: 'Read Page',
    actionLabel: 'Reading the page…',
    semanticDescription:
      'The visible text of a page this run opened, or the console messages it logged, or the ' +
      'requests it made — method, address with query values redacted, status and kind, never a ' +
      'body or header. Filterable, bounded, with a count of what was withheld.',
    tags: ['browser', 'web', 'page', 'local'],
    idempotency: 'idempotent',
    mutates: false,
    usage: {
      oneLine: 'A page’s text, console messages or network requests, filtered and bounded.',
      whenToUse: [
        'The words on the page — an article, a result, a message',
        'Why a page misbehaves: its console errors and failed requests',
      ],
      whenNotToUse: ['Finding something to click — the outline names every control'],
      pitfalls: [
        '`withheld` above zero means more matched than fits: read text on from `nextOffset`, or ' +
          'narrow with `contains`.',
        'Console messages and requests are kept from when the page was opened, the oldest ' +
          'dropping first; `notRetained` counts those no longer kept.',
        PAGE_IS_THE_RUNS,
      ],
      minimalExampleInput: { pageId: 'pg_…', what: 'text' },
    },
    accessMode: 'read',
    inputZod: BrowserPageReadInputSchema,
    outputZod: BrowserPageReadOutputSchema,
    observation: BROWSER_PAGE_READ_OBSERVATION,
  },
  {
    stepType: 'browser',
    group: 'page',
    verb: 'list',
    name: 'List Open Pages',
    actionLabel: 'Listing open pages…',
    semanticDescription:
      'The pages this run has open, with each one’s address, title, profile and when it was ' +
      'last used.',
    tags: ['browser', 'web', 'page', 'local'],
    idempotency: 'idempotent',
    mutates: false,
    usage: {
      oneLine: 'The pages this run has open.',
      whenToUse: ['Picking up a page this run opened earlier rather than opening another'],
      whenNotToUse: ['Pages of another run — a run sees only its own'],
      pitfalls: [
        'A page nothing touched for the profile’s idle limit is closed, and leaves this list.',
      ],
      minimalExampleInput: {},
    },
    accessMode: 'read',
    inputZod: BrowserPageListInputSchema,
    outputZod: BrowserPageListOutputSchema,
  },
  {
    stepType: 'browser',
    group: 'page',
    verb: 'close',
    name: 'Close Page',
    actionLabel: 'Closing the page…',
    semanticDescription:
      'Close a page this run opened. Closing one that is already gone succeeds and says so.',
    tags: ['browser', 'web', 'page', 'local'],
    idempotency: 'idempotent',
    mutates: true,
    usage: {
      oneLine: 'Close a page this run opened.',
      whenToUse: ['The task is done with a page'],
      whenNotToUse: ['Moving the page elsewhere — browser.page.navigate keeps it'],
      pitfalls: ['The profile keeps its sign-ins; closing a page signs nothing out.'],
      minimalExampleInput: { pageId: 'pg_…' },
    },
    accessMode: 'write',
    inputZod: BrowserPageCloseInputSchema,
    outputZod: BrowserPageCloseOutputSchema,
    observation: BROWSER_PAGE_CLOSE_OBSERVATION,
  },
  {
    stepType: 'browser',
    group: 'profile',
    verb: 'list',
    name: 'List Browser Profiles',
    actionLabel: 'Listing browser profiles…',
    groupDisplayName: 'Browser profiles',
    groupDescription:
      'The browser profiles this space may use, and which sites each holds a session for.',
    semanticDescription:
      'The browser profiles this space may use: each one’s posture, whether it has a window, ' +
      'whether its browser is running, and the sites it holds a session for — host names only, ' +
      'never a cookie value. Says whether a task’s site is reachable signed in before work starts.',
    tags: ['browser', 'web', 'profile', 'local'],
    idempotency: 'idempotent',
    mutates: false,
    usage: {
      oneLine: 'Which browser profiles this space may use, and which sites each is signed in to.',
      whenToUse: [
        'Before browser work on a site that needs a sign-in: is there a session for it?',
        'Choosing the `profileId` for browser.page.open',
      ],
      whenNotToUse: ['Pages — browser.page.list lists this run’s'],
      pitfalls: [
        'Sites are known only while a profile’s browser runs; `sitesUnknown` says why they are ' +
          'absent. Opening a page starts the browser.',
        'A site listed holds cookies, which is usually a session but not proof of one.',
        'Profiles are declared on the operator’s machine; a run cannot add or change one.',
      ],
      minimalExampleInput: {},
    },
    accessMode: 'read',
    inputZod: BrowserProfileListInputSchema,
    outputZod: BrowserProfileListOutputSchema,
  },
];
