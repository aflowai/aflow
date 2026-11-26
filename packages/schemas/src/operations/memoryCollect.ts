/**
 * memory.store.collect — read named memory documents whole, by code.
 *
 * A workflow that hands a set of documents to a model task reads them here
 * rather than asking a model to copy them. Each source names one document by
 * path, or every document under a path prefix. A document that is absent or
 * unreadable comes back as `{ path, missing: true, reason }`, so the reader
 * sees the gap and the read itself still succeeds. Only a failure to reach the
 * store fails the operation.
 */
import { z } from 'zod';
import type { OperationRegistration } from '../catalog/operationCatalog.js';

export const MEMORY_COLLECT_MAX_SOURCES = 20;
export const MEMORY_COLLECT_MAX_LIMIT = 200;
export const MEMORY_COLLECT_DEFAULT_LIMIT = 50;
/** The paths one prefix source considers, in its order, before its filters. */
export const MEMORY_COLLECT_SCAN_LIMIT = 1000;
export const MEMORY_COLLECT_DEFAULT_MAX_TOTAL_CHARS = 1_000_000;
export const MEMORY_COLLECT_MAX_TOTAL_CHARS = 4_000_000;
const MAX_WHERE_KEYS = 8;

const WhereValueSchema = z.union([z.string().max(512), z.number(), z.boolean(), z.null()]);

export const MemoryCollectSourceSchema = z
  .object({
    key: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/)
      .describe('The name this source carries in `docs` and `found`.'),
    path: z.string().min(1).max(1024).optional().describe('One document, by its exact path.'),
    pathPrefix: z
      .string()
      .min(1)
      .max(1024)
      .optional()
      .describe(
        'Every document whose path starts with this text. The text is compared as it stands, ' +
          'so `/journal/2026-` matches `/journal/2026-07-14.md`.',
      ),
    before: z
      .string()
      .min(1)
      .max(1024)
      .optional()
      .describe('With pathPrefix: only documents whose path sorts before this text.'),
    order: z
      .enum(['asc', 'desc'])
      .optional()
      .describe('With pathPrefix: path order, `asc` by default. `desc` reads the latest first.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MEMORY_COLLECT_MAX_LIMIT)
      .optional()
      .describe(
        `With pathPrefix: the most documents returned, ${String(MEMORY_COLLECT_DEFAULT_LIMIT)} by default.`,
      ),
    where: z
      .record(WhereValueSchema)
      .refine((where) => Object.keys(where).length <= MAX_WHERE_KEYS, {
        message: `At most ${String(MAX_WHERE_KEYS)} where fields per source`,
      })
      .optional()
      .describe(
        'With pathPrefix: only JSON documents whose top-level fields equal these values. ' +
          'An unreadable document under the prefix is still returned as missing.',
      ),
  })
  .strict()
  .superRefine((source, ctx) => {
    if ((source.path === undefined) === (source.pathPrefix === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Name exactly one of path or pathPrefix',
        path: ['path'],
      });
    }
    if (source.path !== undefined) {
      for (const field of ['before', 'order', 'limit', 'where'] as const) {
        if (source[field] !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${field} applies to a pathPrefix source only`,
            path: [field],
          });
        }
      }
    }
  });
export type MemoryCollectSource = z.infer<typeof MemoryCollectSourceSchema>;

export const MemoryCollectInputSchema = z
  .object({
    sources: z
      .array(MemoryCollectSourceSchema)
      .min(1)
      .max(MEMORY_COLLECT_MAX_SOURCES)
      .refine((sources) => new Set(sources.map((s) => s.key)).size === sources.length, {
        message: 'Each source needs its own key',
      }),
    maxTotalChars: z
      .number()
      .int()
      .min(1)
      .max(MEMORY_COLLECT_MAX_TOTAL_CHARS)
      .optional()
      .describe(
        `The content every source together returns, in characters, ${String(MEMORY_COLLECT_DEFAULT_MAX_TOTAL_CHARS)} by default. A document past it comes back missing.`,
      ),
  })
  .strict();
export type MemoryCollectInput = z.infer<typeof MemoryCollectInputSchema>;

export const MemoryCollectedDocSchema = z.union([
  z
    .object({
      path: z.string(),
      docType: z.string(),
      content: z.unknown().describe('A JSON document parsed, any other document as its text.'),
    })
    .strict(),
  z
    .object({
      path: z.string(),
      missing: z.literal(true),
      reason: z.string(),
    })
    .strict(),
]);
export type MemoryCollectedDoc = z.infer<typeof MemoryCollectedDocSchema>;

export const MemoryCollectOutputSchema = z.object({
  docs: z
    .record(z.union([MemoryCollectedDocSchema, z.array(MemoryCollectedDocSchema)]))
    .describe(
      'Per source key: a path source gives one document, a pathPrefix source a list, empty where none matched.',
    ),
  found: z
    .record(z.number().int().nonnegative())
    .describe('Per source key: the documents read whole, missing ones not counted.'),
  missing: z.array(z.string()).describe('Every path returned as missing.'),
  incomplete: z
    .array(z.string())
    .describe(
      `The pathPrefix source keys whose prefix holds more than ${String(MEMORY_COLLECT_SCAN_LIMIT)} documents, so later paths were not considered.`,
    ),
});
export type MemoryCollectOutput = z.infer<typeof MemoryCollectOutputSchema>;

/** One document as the store returned it, or why it gave none. */
export type MemoryCollectRead =
  { ok: true; docType: string; content: unknown } | { ok: false; reason: string };

/**
 * The store a collect reads. Each method throws only where the store cannot
 * be reached. An absent or unreadable document is a `read` that returns
 * `{ ok: false }`.
 */
export interface MemoryCollectStore {
  /** The document paths starting with `prefix`, in ascending path order, at most `max` of them. */
  list(prefix: string, max: number): Promise<string[]>;
  read(path: string): Promise<MemoryCollectRead>;
}

/** The same store, answering at once: an in-memory stand-in for the space's documents. */
export interface MemoryCollectStoreSync {
  list(prefix: string, max: number): string[];
  read(path: string): MemoryCollectRead;
}

type CollectRequest =
  { kind: 'list'; prefix: string; max: number } | { kind: 'read'; path: string };
type CollectAnswer = string[] | MemoryCollectRead;

function matchesWhere(where: Record<string, unknown>, content: unknown): boolean {
  if (content === null || typeof content !== 'object' || Array.isArray(content)) return false;
  const record = content as Record<string, unknown>;
  return Object.entries(where).every(([field, value]) => record[field] === value);
}

function charsOf(content: unknown): number {
  if (typeof content === 'string') return content.length;
  // JSON.stringify gives undefined for undefined, though its type says string.
  const text = JSON.stringify(content) as string | undefined;
  return text === undefined ? 0 : text.length;
}

const isMissing = (
  doc: MemoryCollectedDoc,
): doc is Extract<MemoryCollectedDoc, { missing: true }> => 'missing' in doc;

/**
 * The collect itself, as the reads it asks of a store. Both runners below
 * drive it, so the executor and every stand-in for it select, filter, order
 * and budget the same way.
 */
function* collectPlan(
  input: MemoryCollectInput,
): Generator<CollectRequest, MemoryCollectOutput, CollectAnswer> {
  const docs: MemoryCollectOutput['docs'] = {};
  const found: Record<string, number> = {};
  const missing: string[] = [];
  const incomplete: string[] = [];
  let budget = input.maxTotalChars ?? MEMORY_COLLECT_DEFAULT_MAX_TOTAL_CHARS;

  /** One document, or null where it is readable and the where filter refuses it. */
  function* readOne(
    path: string,
    where?: Record<string, unknown>,
  ): Generator<CollectRequest, MemoryCollectedDoc | null, CollectAnswer> {
    const read = (yield { kind: 'read', path }) as MemoryCollectRead;
    if (!read.ok) return { path, missing: true, reason: read.reason };
    if (where !== undefined && !matchesWhere(where, read.content)) return null;
    const chars = charsOf(read.content);
    if (chars > budget) {
      return {
        path,
        missing: true,
        reason: `The document holds ${String(chars)} characters, past the ${String(budget)} the read had left.`,
      };
    }
    budget -= chars;
    return { path, docType: read.docType, content: read.content };
  }

  for (const source of input.sources) {
    if (source.pathPrefix === undefined) {
      // A path source has no where filter, so its read is never refused.
      const doc = (yield* readOne(source.path ?? ''))!;
      docs[source.key] = doc;
      found[source.key] = isMissing(doc) ? 0 : 1;
      if (isMissing(doc)) missing.push(doc.path);
      continue;
    }
    const prefix = source.pathPrefix;
    const listed = (yield {
      kind: 'list',
      prefix,
      max: MEMORY_COLLECT_SCAN_LIMIT + 1,
    }) as string[];
    if (listed.length > MEMORY_COLLECT_SCAN_LIMIT) incomplete.push(source.key);
    const candidates = listed
      .slice(0, MEMORY_COLLECT_SCAN_LIMIT)
      .filter((path) => path.startsWith(prefix))
      .filter((path) => source.before === undefined || path < source.before)
      .sort();
    if (source.order === 'desc') candidates.reverse();
    const limit = source.limit ?? MEMORY_COLLECT_DEFAULT_LIMIT;
    const kept: MemoryCollectedDoc[] = [];
    for (const path of candidates) {
      if (kept.length >= limit) break;
      const doc = yield* readOne(path, source.where);
      if (doc !== null) kept.push(doc);
    }
    docs[source.key] = kept;
    found[source.key] = kept.filter((doc) => !isMissing(doc)).length;
    missing.push(...kept.filter(isMissing).map((doc) => doc.path));
  }
  return { docs, found, missing, incomplete };
}

/** Run a collect against the space's store. */
export async function collectMemoryDocuments(
  input: MemoryCollectInput,
  store: MemoryCollectStore,
): Promise<MemoryCollectOutput> {
  const plan = collectPlan(input);
  let step = plan.next(undefined as unknown as CollectAnswer);
  while (!step.done) {
    const request = step.value;
    const answer =
      request.kind === 'list'
        ? await store.list(request.prefix, request.max)
        : await store.read(request.path);
    step = plan.next(answer);
  }
  return step.value;
}

/** Run a collect against a store that answers at once. */
export function collectMemoryDocumentsSync(
  input: MemoryCollectInput,
  store: MemoryCollectStoreSync,
): MemoryCollectOutput {
  const plan = collectPlan(input);
  let step = plan.next(undefined as unknown as CollectAnswer);
  while (!step.done) {
    const request = step.value;
    step = plan.next(
      request.kind === 'list' ? store.list(request.prefix, request.max) : store.read(request.path),
    );
  }
  return step.value;
}

export const MemoryCollectOperationRegistrations: OperationRegistration[] = [
  {
    stepType: 'memory',
    group: 'store',
    verb: 'collect',
    name: 'Collect Memory Documents',
    agentTool: false,
    actionLabel: 'Reading memory…',
    semanticDescription:
      'Read named memory documents whole, without a model: each source names one document by ' +
      'path, or every document under a path prefix, ordered, limited and filtered on top-level ' +
      'JSON fields. A document that is absent or unreadable comes back as { path, missing: true, ' +
      'reason }, so the read succeeds and the gap shows.',
    tags: ['memory', 'storage', 'read'],
    idempotency: 'idempotent',
    mutates: false,
    opTaskOnly: true,
    usage: {
      oneLine: 'Read a named set of memory documents whole, as data, by code.',
      whenToUse: [
        'A workflow hands a model task a set of memory documents: read them in this operation task and bind its docs, rather than asking a model to copy them',
      ],
      whenNotToUse: [
        'Reading one document an agent chooses as it goes — use memory.store.get',
        'Searching memory by meaning or text — use memory.store.query',
        'Ad-hoc selection from an agent’s tool surface — this op is opTaskOnly and must be an explicit workflow operation task.',
      ],
      pitfalls: [
        'A missing document is not a failure. Read `found` to tell a source that matched nothing from one that matched.',
        'pathPrefix is compared as text: end it with / to read one directory alone.',
        'A JSON document whose text does not parse comes back as its text, and no where filter matches it.',
      ],
      minimalExampleInput: {
        sources: [{ key: 'notes', pathPrefix: '/notes/' }],
      },
    },
    accessMode: 'read',
    inputZod: MemoryCollectInputSchema,
    outputZod: MemoryCollectOutputSchema,
  },
];
