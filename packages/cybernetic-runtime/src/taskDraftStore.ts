import { createHash } from 'node:crypto';

import { applyJsonPatch, type JsonPatchOperation } from '@aflow/lib';
import { TASK_DRAFT_DIR_PATH } from '@aflow/schemas';
import type { PayloadStore } from '@aflow/payload-store';
import type { MemoryDocRepository } from '@aflow/database';

/**
 * The scratch draft a task-mode agent builds its result in.
 *
 * Scope is derived here and nowhere else: the agent names no tenant, space,
 * task or attempt, so a draft cannot address another task's. It dies with the
 * attempt, which is what keeps the `retryability: 'unsafe'` coupling that
 * mid-task durable writes carry from spreading to every task that adopts this.
 */
export { TASK_DRAFT_DIR_PATH as DRAFT_PATH_PREFIX } from '@aflow/schemas';

/** Bodies above this move to content-addressed storage rather than inline. */
const INLINE_THRESHOLD = 65536;

/**
 * A draft belongs to one worker session, and that is the whole key.
 *
 * The session IS the attempt: a retry spawns a new one, so attempt isolation
 * comes free and there is no second field to keep in step. Deriving this key
 * two ways — once where the draft is written and once where it is cleaned up —
 * is how the first version leaked every draft it ever made.
 */
export interface TaskDraftScope {
  tenantId: string;
  /** The worker session the draft is being built in. */
  sessionId: string;
  spaceId: string;
}

export interface TaskDraftReceipt {
  revision: number;
  contentHash: string;
  /** What the draft now holds, e.g. "{ cases[12], rationale }". */
  census: string;
  sizeBytes: number;
  mutationId: string;
  replayed: boolean;
}

interface AppliedMutation {
  id: string;
  /** The revision this batch produced — what its receipt must report. */
  revision: number;
  contentHash: string;
  /** The draft as THIS mutation left it — a replay must not describe the present. */
  census: string;
  sizeBytes: number;
  /**
   * What this key was used for. A replay key identifies one batch, so the same
   * key arriving with different operations is a collision, not a retry —
   * without this the second batch is dropped and reported as a success.
   */
  operationsHash: string;
}

interface DraftEnvelope {
  /**
   * Payload refs this draft has spilled, newest last.
   *
   * Every revision over the inline threshold writes a new content-addressed
   * blob, and the store has a `delete` but nothing else knows which blobs a
   * draft owns. Without this list the row can be removed while its bodies stay
   * — indefinitely on a backend that ignores TTL.
   */
  spilledRefs?: string[];
  revision: number;
  /** Applied batches, oldest first, each with the receipt it earned. */
  mutations: AppliedMutation[];
  content: unknown;
}

export function draftPathFor(scope: TaskDraftScope): string {
  // Nothing the agent sends reaches this string, so addressing another
  // session's draft is inexpressible rather than merely discouraged.
  const safe = scope.sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${TASK_DRAFT_DIR_PATH}/${safe}.json`;
}

function emptyEnvelope(): DraftEnvelope {
  return { revision: 0, mutations: [], content: null };
}

function parseEnvelope(raw: string | null): DraftEnvelope {
  if (!raw) return emptyEnvelope();
  try {
    const parsed = JSON.parse(raw) as Partial<DraftEnvelope>;
    return {
      revision: typeof parsed.revision === 'number' ? parsed.revision : 0,
      mutations: Array.isArray(parsed.mutations) ? parsed.mutations : [],
      content: parsed.content ?? null,
      // Dropping this silently un-does the cleanup it exists for: every write
      // after the first spill would forget the bodies before it.
      ...(Array.isArray(parsed.spilledRefs) ? { spilledRefs: parsed.spilledRefs } : {}),
    };
  } catch {
    return emptyEnvelope();
  }
}

/**
 * What the draft holds, in the receipt the agent reads on its next turn.
 *
 * A hash and a key count are not feedback: an empty `{cases: [], rationale: ''}`
 * reported two items and SUCCEEDED, which reads as progress. One live run
 * re-sent that same empty shape 130 times, each call succeeding, destroying its
 * own work every three seconds.
 */
/**
 * Key order is not meaning: a patch that rewrites an object wholesale can emit
 * the same fields in a different order, and comparing raw JSON would call that
 * a change.
 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return value === undefined ? 'null' : JSON.stringify(value);
}

function sameContent(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

/**
 * Create the containers an `add` is reaching through, so appending to a list
 * that does not exist yet means what the author meant.
 *
 * RFC 6902 refuses `add` at `/cases/0/rubrics/-` when the case has no
 * `rubrics`, which is correct for a patch against a fixed document and wrong
 * for a draft being built up — a run spent a turn on exactly that refusal. Only
 * `add` is forgiven: `replace`, `remove` and `test` name something that is
 * supposed to already be there, and inventing it would hide the mistake.
 *
 * A gap in an array is never filled. Creating index 5 of a three-element list
 * would have to invent the two before it.
 *
 * Applied immediately before its own operation, never as a pass over the whole
 * batch: synthesising every parent up front lets a later `add` decide an
 * earlier `test`, so `test /foo {}` would pass against `{}` because an `add
 * /foo/bar` further down had already created it. Batch order has to keep
 * meaning what it says.
 */
const UNSAFE_PATH_SEGMENTS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

function createMissingAddParents(root: unknown, op: JsonPatchOperation): void {
  {
    if (op.op !== 'add' || op.path === '') return;
    const segments = op.path
      .split('/')
      .slice(1)
      .map((raw) => raw.replace(/~1/g, '/').replace(/~0/g, '~'));

    let node: unknown = root;
    for (let i = 0; i < segments.length - 1; i++) {
      const key = segments[i]!;
      const next = segments[i + 1]!;
      if (Array.isArray(node)) {
        const index = Number(key);
        if (!Number.isInteger(index) || index < 0 || index >= node.length) break;
        node = node[index];
        continue;
      }
      if (typeof node !== 'object' || node === null) break;
      // A path segment naming an inherited member is never followed. `??=`
      // reads through the prototype chain, so `/safe/__proto__/polluted`
      // would find Object.prototype truthy, step onto it, and write the next
      // segment globally — before fast-json-patch ever sees the operation.
      if (UNSAFE_PATH_SEGMENTS.has(key)) break;
      const obj = node as Record<string, unknown>;
      // The child's own key says which container it needs: an index or the
      // append token means a list, anything else a record.
      if (!Object.hasOwn(obj, key)) {
        Object.defineProperty(obj, key, {
          value: next === '-' || /^\d+$/.test(next) ? [] : {},
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }
      node = obj[key];
    }
  }
}

/**
 * Whether the draft holds anything a rewrite would destroy.
 *
 * An established-but-empty shape — `{cases: [], rationale: ''}` — holds no
 * work, so re-establishing it costs nothing and must not be refused as
 * destructive; the unchanged guard answers that case instead.
 */
function holdsWork(content: unknown): boolean {
  if (Array.isArray(content)) return content.length > 0;
  if (typeof content === 'string') return content.length > 0;
  if (content === null || content === undefined) return false;
  if (typeof content === 'object') return Object.values(content).some(holdsWork);
  return true;
}

export function censusOf(content: unknown): string {
  if (Array.isArray(content)) return `[${String(content.length)} items]`;
  if (content && typeof content === 'object') {
    const parts = Object.entries(content as Record<string, unknown>).map(([k, v]) => {
      if (Array.isArray(v)) return `${k}[${String(v.length)}]`;
      if (v === null || v === undefined || v === '') return `${k}=empty`;
      if (typeof v === 'object') return `${k}{${String(Object.keys(v).length)}}`;
      return k;
    });
    return parts.length > 0 ? `{ ${parts.join(', ')} }` : '{ empty }';
  }
  return content === null || content === undefined ? 'empty' : typeof content;
}

async function readEnvelope(
  repo: MemoryDocRepository,
  payloadStore: PayloadStore,
  scope: TaskDraftScope,
): Promise<{
  envelope: DraftEnvelope;
  exists: boolean;
  docHash: string | undefined;
  payloadRef: string | undefined;
}> {
  const doc = await repo.getByPath(draftPathFor(scope), scope.spaceId, {
    allowReserved: true,
  });
  if (!doc) {
    return { envelope: emptyEnvelope(), exists: false, docHash: undefined, payloadRef: undefined };
  }
  let raw = doc.inlineContent;
  if (raw === null && doc.payloadRef) {
    // Deliberately not caught. A body is persisted and reclaimed explicitly, so
    // failing to read one is exceptional rather than expected — and reporting
    // it as an empty draft would let the next root patch pass the document's
    // compare-and-swap and overwrite a draft that a transient store failure had
    // made unreadable for a moment. Losing the work is worse than failing the
    // turn the agent can retry.
    const payload = await payloadStore.retrieve(doc.payloadRef);
    raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
  }
  return {
    envelope: parseEnvelope(raw),
    exists: true,
    docHash: (doc as { contentHash?: string }).contentHash,
    payloadRef: doc.payloadRef ?? undefined,
  };
}

export class DraftMutationIdReused extends Error {
  constructor(public readonly mutationId: string) {
    super(
      `mutationId "${mutationId}" was already used for a different set of operations. ` +
        `A mutationId identifies one batch: repeating it returns that batch's receipt, so ` +
        `reusing it for new work would silently discard the new work. Send this batch with a ` +
        `fresh mutationId.`,
    );
    this.name = 'DraftMutationIdReused';
  }
}

export class DraftWouldDiscard extends Error {
  constructor(public readonly census: string) {
    super(
      `This patch starts by writing the whole draft, which discards everything built so far — ` +
        `it currently holds ${census}. Establish the shape once, on an empty draft; after that ` +
        `patch the parts that are missing (e.g. {"op":"add","path":"/cases/-","value":{...}} to ` +
        `append one case). Use draft_get to read what is already there. If you do mean to ` +
        `replace the whole draft, read it first and send expectedRevision with the revision you ` +
        `are replacing.`,
    );
    this.name = 'DraftWouldDiscard';
  }
}

export class DraftUnchanged extends Error {
  constructor(public readonly census: string) {
    super(
      `This patch left the draft unchanged — it still holds ${census}. ` +
        `Re-sending the same operations will not advance it. Use draft_get to read what is ` +
        `already there, then patch the part that is actually missing (e.g. ` +
        `{"op":"add","path":"/cases/-","value":{...}} to append one case).`,
    );
    this.name = 'DraftUnchanged';
  }
}

export class DraftRevisionMismatch extends Error {
  constructor(
    readonly expected: number,
    readonly actual: number,
  ) {
    super(`DRAFT_REVISION_MISMATCH: expected revision ${expected}, draft is at ${actual}`);
    this.name = 'DraftRevisionMismatch';
  }
}

/**
 * Apply one batch atomically. All operations land or none do — a batch that
 * throws partway leaves the stored draft untouched, because the patch is
 * computed in memory and only the result is written.
 */
export async function patchTaskDraft(args: {
  repo: MemoryDocRepository;
  payloadStore: PayloadStore;
  scope: TaskDraftScope;
  mutationId: string;
  operations: readonly JsonPatchOperation[];
  expectedRevision?: number | undefined;
  /** Whose bytes a spilled body is, so discarding it cannot touch anyone else's. */
  owner: { runId: string; stepExecutionId: string; attempt: number };
}): Promise<TaskDraftReceipt> {
  const { repo, payloadStore, scope, mutationId, operations, expectedRevision, owner } = args;
  const {
    envelope,
    exists,
    docHash,
    payloadRef: supersededRef,
  } = await readEnvelope(repo, payloadStore, scope);

  // Replay: the same batch arriving twice reports what it did the FIRST time,
  // not the state of the draft now — later batches may have moved it, and a
  // receipt naming their revision would attribute their work to this call.
  // Checked before the revision guard, since a retry of an applied batch is
  // success, not a conflict.
  const operationsHash = createHash('sha256').update(canonical(operations)).digest('hex');
  const alreadyApplied = envelope.mutations.find((m) => m.id === mutationId);
  if (alreadyApplied) {
    // A key recorded before this field existed cannot be compared, so it is
    // treated as a replay rather than refused.
    if (alreadyApplied.operationsHash && alreadyApplied.operationsHash !== operationsHash) {
      throw new DraftMutationIdReused(mutationId);
    }
    return {
      revision: alreadyApplied.revision,
      contentHash: alreadyApplied.contentHash,
      census: alreadyApplied.census,
      sizeBytes: alreadyApplied.sizeBytes,
      mutationId,
      replayed: true,
    };
  }

  if (expectedRevision !== undefined && expectedRevision !== envelope.revision) {
    throw new DraftRevisionMismatch(expectedRevision, envelope.revision);
  }

  // Writing the whole document is how a draft is established and, after that,
  // the only way to destroy one. A model that believes its last call failed
  // re-sends the batch it opened with, and that batch starts at the root: one
  // run re-sent four cases this way and was caught only because the result
  // happened to be identical. A batch that differed would have discarded them
  // silently, since nothing downstream can tell a rewrite from a reset.
  //
  // Naming the revision is what separates a rewrite from a blind reset: an
  // author who says which revision it is replacing has read the draft and
  // cannot be re-sending an opening batch against work it never saw. Without
  // that escape the refusal traps its own repair — a draft whose root is a
  // JSON string has no way to become the decoded object, because a non-empty
  // string is work and every root write is refused.
  if (envelope.revision > 0 && holdsWork(envelope.content) && expectedRevision === undefined) {
    // `copy` and `move` name their destination in `path` too, so a root
    // destination replaces the whole document exactly as add/replace does.
    const rewritesRoot = (operations as JsonPatchOperation[]).some(
      (op) =>
        op.path === '' &&
        (op.op === 'add' || op.op === 'replace' || op.op === 'copy' || op.op === 'move'),
    );
    if (rewritesRoot) throw new DraftWouldDiscard(censusOf(envelope.content));
  }

  let content = structuredClone(envelope.content);
  for (const op of operations as JsonPatchOperation[]) {
    createMissingAddParents(content, op);
    content = applyJsonPatch(content, [op]);
  }

  // A patch that leaves the draft byte-identical is not progress, and
  // succeeding on it is how an agent loops forever: every call returns
  // SUCCEEDED, so no failure counter moves and no ceiling is ever reached.
  // Refusing makes the loop visible to the accounting that already exists.
  if (envelope.revision > 0 && sameContent(content, envelope.content)) {
    throw new DraftUnchanged(censusOf(content));
  }

  const revision = envelope.revision + 1;

  // Two different measurements, and conflating them made the receipt describe
  // something other than what was stored.
  //
  // The ARTIFACT metrics cover `{revision, content}` — what this batch produced
  // — and are recorded with the mutation so a replay still answers for itself.
  // The STORAGE metrics cover the serialized envelope, which also carries the
  // mutation history and is therefore larger. Storage is what the inline
  // threshold and the memory-doc row have to be measured against; reusing the
  // artifact size there under-reported the bytes actually written.
  const provisional = JSON.stringify({ revision, content });
  const sizeBytes = Buffer.byteLength(provisional, 'utf8');
  const contentHash = createHash('sha256').update(provisional).digest('hex');

  const next: DraftEnvelope = {
    revision,
    // The body this write replaces is orphaned the moment the row points
    // elsewhere, so it is recorded here for discard to reclaim.
    ...(supersededRef !== undefined
      ? { spilledRefs: [...(envelope.spilledRefs ?? []), supersededRef] }
      : envelope.spilledRefs
        ? { spilledRefs: envelope.spilledRefs }
        : {}),
    mutations: [
      ...envelope.mutations,
      {
        id: mutationId,
        revision,
        contentHash,
        census: censusOf(content),
        sizeBytes,
        operationsHash,
      },
    ],
    content,
  };

  const serialized = JSON.stringify(next);
  const storedBytes = Buffer.byteLength(serialized, 'utf8');
  const storedHash = createHash('sha256').update(serialized).digest('hex');

  let inlineContent: string | null = serialized;
  let payloadRef: string | null = null;
  if (storedBytes > INLINE_THRESHOLD) {
    // NOT content-addressed. An address derived from the bytes is shared by
    // construction, so two attempts that spill an identical envelope get one
    // object — and deleting it at the end of one attempt would pull the body
    // out from under the other, whose next read would report an empty draft.
    // Scratch is owned bytes, so it is stored under this attempt's own key and
    // is therefore safe to delete.
    payloadRef = await payloadStore.store({
      tenantId: scope.tenantId as never,
      runId: owner.runId as never,
      stepExecutionId: owner.stepExecutionId as never,
      attempt: owner.attempt,
      kind: 'body',
      // Reclaimed explicitly at discard. A TTL would be the wrong lifetime in
      // both directions: too short for an attempt paused overnight, and
      // ignored entirely by the object-store backend.
      persist: true,
      data: serialized,
    });
    inlineContent = null;
  }

  try {
    await repo.put({
      path: draftPathFor(scope),
      writeMode: exists ? 'upsert' : 'create',
      // Compare-and-swap on the document this patch was computed from. Reading,
      // checking a revision and then writing unconditionally is check-then-act:
      // two patches that both read revision N both write N+1, and one is lost
      // with no error anywhere.
      ...(docHash !== undefined ? { expectedHash: docHash } : {}),
      docType: 'json',
      mimeType: 'application/json',
      inlineContent,
      payloadRef,
      sizeBytes: storedBytes,
      contentHash: storedHash,
      preview: null,
      tags: ['draft'],
      summary: null,
      indexing: 'disabled',
      scope: { spaceId: scope.spaceId },
    } as never);
  } catch (err) {
    // The body was written before the row that names it. If this write lost a
    // compare-and-swap race, or failed for any other reason, nothing records
    // the new ref and terminal cleanup can never reach it.
    if (payloadRef) {
      try {
        await payloadStore.delete(payloadRef as never);
      } catch {
        // A leaked body must not replace the error the caller needs to see.
      }
    }
    throw err;
  }

  return {
    revision,
    contentHash,
    census: censusOf(content),
    sizeBytes,
    mutationId,
    replayed: false,
  };
}

export async function readTaskDraft(args: {
  repo: MemoryDocRepository;
  payloadStore: PayloadStore;
  scope: TaskDraftScope;
}): Promise<{ envelope: DraftEnvelope; exists: boolean; contentHash: string; sizeBytes: number }> {
  const { envelope, exists } = await readEnvelope(args.repo, args.payloadStore, args.scope);
  // The same artifact measurement the receipt reported, so a draft_get right
  // after a patch agrees with the patch that produced it.
  const artifact = JSON.stringify({ revision: envelope.revision, content: envelope.content });
  return {
    envelope,
    exists,
    contentHash: createHash('sha256').update(artifact).digest('hex'),
    sizeBytes: Buffer.byteLength(artifact, 'utf8'),
  };
}

/**
 * The content a submit names, or a refusal naming the revision it is actually
 * at — so a racing patch cannot be submitted by accident.
 */
export async function materializeTaskDraft(args: {
  repo: MemoryDocRepository;
  payloadStore: PayloadStore;
  scope: TaskDraftScope;
  revision: number;
}): Promise<{ ok: true; content: unknown } | { ok: false; detail: string }> {
  const { envelope, exists } = await readEnvelope(args.repo, args.payloadStore, args.scope);
  if (!exists || envelope.revision === 0) {
    return { ok: false, detail: 'No draft has been built for this task attempt.' };
  }
  if (envelope.revision !== args.revision) {
    return {
      ok: false,
      detail: `Draft is at revision ${String(envelope.revision)}, not ${String(args.revision)}.`,
    };
  }
  return { ok: true, content: envelope.content };
}

/**
 * Drop the attempt's draft.
 *
 * The draft is scratch scoped to one attempt, and leaving it behind turns a
 * fixed-size working buffer into unbounded accumulation — one document per
 * task per attempt, for every run the space ever makes. Called when the task
 * reaches a terminal state, successful or not: the next attempt starts clean,
 * which is what keeps this from spreading the `retryability: 'unsafe'`
 * coupling that mid-task durable writes carry.
 */
export async function discardTaskDraft(args: {
  repo: MemoryDocRepository;
  scope: TaskDraftScope;
  /** Omit only where no body can have spilled; a large draft leaks without it. */
  payloadStore?: PayloadStore;
}): Promise<boolean> {
  const doc = await args.repo.getByPath(draftPathFor(args.scope), args.scope.spaceId, {
    allowReserved: true,
  });
  if (!doc) return false;

  // Every body this draft ever spilled: the ones earlier revisions superseded,
  // recorded on the envelope, and the one the row points at now. Reclaimed
  // before the row goes, because the row is the only thing that names them.
  if (args.payloadStore) {
    const refs = new Set<string>();
    // The list lives in the envelope, and the envelope is in the payload
    // exactly when a body spilled — reading only `inlineContent` here found
    // nothing in the one case that has anything to find.
    let raw = doc.inlineContent;
    if (raw === null && doc.payloadRef) {
      try {
        const body = await args.payloadStore.retrieve(doc.payloadRef as never);
        raw = typeof body === 'string' ? body : JSON.stringify(body);
      } catch {
        raw = null;
      }
    }
    if (raw !== null) {
      for (const ref of parseEnvelope(raw).spilledRefs ?? []) refs.add(ref);
    }
    if (doc.payloadRef) refs.add(doc.payloadRef);
    for (const ref of refs) {
      try {
        await args.payloadStore.delete(ref as never);
      } catch {
        // A body that cannot be deleted must not keep the row alive: the row is
        // what makes the draft readable, and leaving it is the worse leak.
      }
    }
  }

  return await args.repo.hardDelete(doc.id, args.scope.spaceId);
}

/** Shape and sizes, so inspecting a draft does not reload it into context. */
export function outlineOf(content: unknown, depth = 0): unknown {
  if (Array.isArray(content)) {
    return {
      type: 'array',
      length: content.length,
      ...(depth < 1 && content.length > 0 ? { first: outlineOf(content[0], depth + 1) } : {}),
    };
  }
  if (content && typeof content === 'object') {
    const entries = Object.entries(content as Record<string, unknown>);
    return {
      type: 'object',
      keys: entries.map(([k]) => k),
      ...(depth < 1
        ? { fields: Object.fromEntries(entries.map(([k, v]) => [k, outlineOf(v, depth + 1)])) }
        : {}),
    };
  }
  if (typeof content === 'string') return { type: 'string', length: content.length };
  return { type: content === null ? 'null' : typeof content };
}
