import { describe, expect, it, vi } from 'vitest';
import {
  DraftRevisionMismatch,
  DraftMutationIdReused,
  DraftUnchanged,
  DraftWouldDiscard,
  discardTaskDraft,
  draftPathFor,
  materializeTaskDraft,
  patchTaskDraft,
  readTaskDraft,
} from '../taskDraftStore.js';

const scope = {
  tenantId: 'tenant-1',
  sessionId: 'sess-1',
  spaceId: 'space-1',
};

/** A repository backed by one in-memory document, as the real one behaves. */
function fakeRepo() {
  let stored: {
    inlineContent: string | null;
    payloadRef: string | null;
    contentHash: string;
  } | null = null;
  return {
    getByPath: vi.fn(async () =>
      stored ? { ...stored, id: 'doc-1', path: draftPathFor(scope) } : null,
    ),
    put: vi.fn(
      async (p: {
        inlineContent: string | null;
        payloadRef: string | null;
        contentHash: string;
        expectedHash?: string;
      }) => {
        // The real repository asserts this inside its own transaction.
        if (p.expectedHash !== undefined && stored && stored.contentHash !== p.expectedHash) {
          throw new Error(`MEMORY_HASH_MISMATCH: expected ${p.expectedHash}`);
        }
        stored = {
          inlineContent: p.inlineContent,
          payloadRef: p.payloadRef,
          contentHash: p.contentHash,
        };
        return { id: 'doc-1' };
      },
    ),
    // Internal scratch is deleted outright — the row, its versions and any
    // trash listing — rather than soft-deleted, so the fake mirrors that.
    hardDelete: vi.fn(async () => {
      stored = null;
      return true;
    }),
    softDelete: vi.fn(async () => {
      throw new Error('a draft must be hard-deleted, not trashed');
    }),
  } as never;
}

// A body big enough to spill past the inline threshold, so the payload path is
// actually exercised — it was not, which is why two successive fixes to it were
// inert without failing a test.
const bigText = 'x'.repeat(70_000);

function fakePayloadStore() {
  const bodies = new Map<string, string>();
  let n = 0;
  return {
    bodies,
    store: vi.fn(async (p: { data: unknown }) => {
      const ref = `payload:owned-${String((n += 1))}`;
      bodies.set(ref, typeof p.data === 'string' ? p.data : JSON.stringify(p.data));
      return ref;
    }),
    storeContentAddressed: vi.fn(async () => {
      throw new Error('scratch must be uniquely owned, not content-addressed');
    }),
    retrieve: vi.fn(async (ref: string) => bodies.get(ref) ?? ''),
    delete: vi.fn(async (ref: string) => {
      bodies.delete(ref);
    }),
  };
}

const payloadStore = fakePayloadStore() as never;

const patch = (repo: never, mutationId: string, operations: unknown[], expectedRevision?: number) =>
  patchTaskDraft({
    repo,
    payloadStore,
    scope,
    mutationId,
    operations: operations as never,
    ...(expectedRevision !== undefined ? { expectedRevision } : {}),
  });

describe('the draft a task builds its result in', () => {
  it('derives its own address — nothing the agent sends reaches the path', () => {
    expect(draftPathFor(scope)).toBe('/run/draft/sess-1.json');
    // A session id is server-minted, but the sanitiser is the guarantee rather
    // than the provenance.
    expect(draftPathFor({ ...scope, sessionId: '../../escape' })).toBe(
      '/run/draft/______escape.json',
    );
  });

  it('is keyed by the session alone, so the cleanup cannot look elsewhere', () => {
    // Deriving this key two ways — once on write, once on discard — left every
    // draft behind. One field, one derivation.
    expect(Object.keys(scope).sort()).toEqual(['sessionId', 'spaceId', 'tenantId']);
  });

  it('creates on the first patch and advances a revision per batch', async () => {
    const repo = fakeRepo();
    const first = await patch(repo, 'm1', [{ op: 'add', path: '', value: { cases: [] } }]);
    expect(first.revision).toBe(1);
    const second = await patch(repo, 'm2', [{ op: 'add', path: '/cases/-', value: { t: 'a' } }]);
    expect(second.revision).toBe(2);
    expect(second.census).toContain('cases[1]');
  });

  it('replays a repeated mutationId without applying it twice', async () => {
    const repo = fakeRepo();
    await patch(repo, 'm1', [{ op: 'add', path: '', value: { cases: [] } }]);
    await patch(repo, 'm2', [{ op: 'add', path: '/cases/-', value: { t: 'a' } }]);
    const again = await patch(repo, 'm2', [{ op: 'add', path: '/cases/-', value: { t: 'a' } }]);
    expect(again.replayed).toBe(true);
    expect(again.revision).toBe(2);

    const read = await readTaskDraft({ repo, payloadStore, scope });
    expect((read.envelope.content as { cases: unknown[] }).cases).toHaveLength(1);
  });

  it('refuses a patch written against a revision that has moved', async () => {
    const repo = fakeRepo();
    await patch(repo, 'm1', [{ op: 'add', path: '', value: { n: 1 } }]);
    await expect(patch(repo, 'm2', [{ op: 'replace', path: '/n', value: 2 }], 0)).rejects.toThrow(
      DraftRevisionMismatch,
    );
  });

  it('leaves the stored draft untouched when a batch fails partway', async () => {
    const repo = fakeRepo();
    await patch(repo, 'm1', [{ op: 'add', path: '', value: { n: 1 } }]);
    await expect(
      patch(repo, 'm2', [
        { op: 'add', path: '/ok', value: 1 },
        { op: 'replace', path: '/missing/deep', value: 2 },
      ]),
    ).rejects.toThrow();
    const read = await readTaskDraft({ repo, payloadStore, scope });
    expect(read.envelope.revision).toBe(1);
    expect(read.envelope.content).toEqual({ n: 1 });
  });

  it('submits only the revision it is asked for', async () => {
    const repo = fakeRepo();
    await patch(repo, 'm1', [{ op: 'add', path: '', value: { n: 1 } }]);
    await patch(repo, 'm2', [{ op: 'replace', path: '/n', value: 2 }]);

    const stale = await materializeTaskDraft({ repo, payloadStore, scope, revision: 1 });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.detail).toContain('revision 2');

    const current = await materializeTaskDraft({ repo, payloadStore, scope, revision: 2 });
    expect(current).toEqual({ ok: true, content: { n: 2 } });
  });

  it('refuses to submit a draft that was never built', async () => {
    const result = await materializeTaskDraft({
      repo: fakeRepo(),
      payloadStore,
      scope,
      revision: 1,
    });
    expect(result.ok).toBe(false);
  });
});

describe('a draft is not lost to a concurrent writer', () => {
  it('lets exactly one of two writes computed from the same revision land', async () => {
    // Both read revision 1 and both compute revision 2. Without a
    // compare-and-swap on the write both succeed and one is gone with no error
    // anywhere — the defect this store was built to avoid and reproduced once.
    // Which one wins is scheduling; that only one does is the invariant.
    const repo = fakeRepo();
    await patch(repo, 'm1', [{ op: 'add', path: '', value: { n: 1 } }]);

    const results = await Promise.allSettled([
      patch(repo, 'a', [{ op: 'replace', path: '/n', value: 2 }]),
      patch(repo, 'b', [{ op: 'replace', path: '/n', value: 99 }]),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(String((rejected[0] as PromiseRejectedResult).reason)).toContain('MEMORY_HASH_MISMATCH');

    // And the draft holds one of the two values, at revision 2 — never both
    // applied, never a revision skipped.
    const read = await readTaskDraft({ repo, payloadStore, scope });
    expect(read.envelope.revision).toBe(2);
    expect([2, 99]).toContain((read.envelope.content as { n: number }).n);
  });
});

describe('a replayed batch answers for itself', () => {
  it('reports the revision it produced, not wherever the draft has got to', async () => {
    const repo = fakeRepo();
    await patch(repo, 'm1', [{ op: 'add', path: '', value: { cases: [] } }]);
    const second = await patch(repo, 'm2', [{ op: 'add', path: '/cases/-', value: { t: 'a' } }]);
    await patch(repo, 'm3', [{ op: 'add', path: '/cases/-', value: { t: 'b' } }]);

    const replay = await patch(repo, 'm2', [{ op: 'add', path: '/cases/-', value: { t: 'a' } }]);
    expect(replay.replayed).toBe(true);
    // Not revision 3 — attributing m3's work to m2 would make the receipt a lie.
    expect(replay.revision).toBe(second.revision);
    expect(replay.contentHash).toBe(second.contentHash);
    expect(replay.census).toBe(second.census);
  });
});

describe('a draft dies with its attempt', () => {
  it('is gone after it is discarded', async () => {
    const repo = fakeRepo();
    await patch(repo, 'm1', [{ op: 'add', path: '', value: { n: 1 } }]);
    expect((await readTaskDraft({ repo, payloadStore, scope })).exists).toBe(true);

    await discardTaskDraft({ repo, scope });
    const after = await readTaskDraft({ repo, payloadStore, scope });
    expect(after.exists).toBe(false);
    expect(after.envelope.revision).toBe(0);
  });
});

describe('a patch that changes nothing is refused', () => {
  // The loop this exists to stop: 130 identical "establish the shape" patches,
  // every one SUCCEEDED, each resetting the draft to empty. Nothing counted
  // them because nothing failed.
  const SHAPE = [{ op: 'add', path: '', value: { cases: [], rationale: '' } }];

  it('refuses the second write of an identical shape', async () => {
    const repo = fakeRepo();
    await patch(repo, 'shape-1', SHAPE);
    await expect(patch(repo, 'shape-2', SHAPE)).rejects.toBeInstanceOf(DraftUnchanged);
  });

  it('still refuses when the same fields arrive in a different key order', async () => {
    const repo = fakeRepo();
    await patch(repo, 'shape-1', SHAPE);
    await expect(
      patch(repo, 'shape-2', [{ op: 'add', path: '', value: { rationale: '', cases: [] } }]),
    ).rejects.toBeInstanceOf(DraftUnchanged);
  });

  it('names what the draft holds, so the agent patches the gap instead of the shape', async () => {
    const repo = fakeRepo();
    await patch(repo, 'shape-1', SHAPE);
    const err = await patch(repo, 'shape-2', SHAPE).catch((e: unknown) => e);
    expect((err as DraftUnchanged).message).toContain('cases[0]');
    expect((err as DraftUnchanged).message).toContain('/cases/-');
  });

  it('lets a real append through', async () => {
    const repo = fakeRepo();
    await patch(repo, 'shape-1', SHAPE);
    const receipt = await patch(repo, 'add-1', [
      { op: 'add', path: '/cases/-', value: { title: 'refund inside window' } },
    ]);
    expect(receipt.revision).toBe(2);
    expect(receipt.census).toContain('cases[1]');
  });

  it('reports a census rather than a key count — an empty draft read as "2 items"', async () => {
    const repo = fakeRepo();
    const receipt = await patch(repo, 'shape-1', SHAPE);
    expect(receipt.census).toBe('{ cases[0], rationale=empty }');
  });
});

describe('an add reaches through containers that do not exist yet', () => {
  // A run spent a turn on `add /cases/0/rubrics/-` against a case with no
  // rubrics array. RFC 6902 is right to refuse that against a fixed document
  // and wrong against a draft being built up.
  const seed = [{ op: 'add', path: '', value: { cases: [{ title: 'a case' }] } }];

  it('appends to a list the case does not have yet', async () => {
    const repo = fakeRepo();
    await patch(repo, 'seed', seed);
    const receipt = await patch(repo, 'rubric', [
      { op: 'add', path: '/cases/0/rubrics/-', value: { criterion: 'honest' } },
    ]);
    expect(receipt.revision).toBe(2);
    const { envelope } = await readTaskDraft({ repo, payloadStore, scope });
    const cases = (envelope.content as { cases: Array<{ rubrics?: unknown[] }> }).cases;
    expect(cases[0]!.rubrics).toEqual([{ criterion: 'honest' }]);
  });

  it('creates a record where the next segment is a name, not an index', async () => {
    const repo = fakeRepo();
    await patch(repo, 'seed', seed);
    await patch(repo, 'nested', [{ op: 'add', path: '/cases/0/fixture/tier', value: 'seeded' }]);
    const { envelope } = await readTaskDraft({ repo, payloadStore, scope });
    const cases = (envelope.content as { cases: Array<{ fixture?: unknown }> }).cases;
    expect(cases[0]!.fixture).toEqual({ tier: 'seeded' });
  });

  it('still refuses a replace against something that is not there', async () => {
    const repo = fakeRepo();
    await patch(repo, 'seed', seed);
    await expect(
      patch(repo, 'bad', [{ op: 'replace', path: '/cases/0/rubrics', value: [] }]),
    ).rejects.toBeTruthy();
  });

  it('does not invent the elements before a gap in a list', async () => {
    const repo = fakeRepo();
    await patch(repo, 'seed', seed);
    await expect(
      patch(repo, 'gap', [{ op: 'add', path: '/cases/5/rubrics/-', value: { criterion: 'x' } }]),
    ).rejects.toBeTruthy();
  });

  it('leaves an existing container alone rather than replacing it', async () => {
    const repo = fakeRepo();
    await patch(repo, 'seed', [
      {
        op: 'add',
        path: '',
        value: { cases: [{ title: 'a case', rubrics: [{ criterion: 'kept' }] }] },
      },
    ]);
    await patch(repo, 'append', [
      { op: 'add', path: '/cases/0/rubrics/-', value: { criterion: 'added' } },
    ]);
    const { envelope } = await readTaskDraft({ repo, payloadStore, scope });
    const cases = (envelope.content as { cases: Array<{ rubrics: unknown[] }> }).cases;
    expect(cases[0]!.rubrics).toEqual([{ criterion: 'kept' }, { criterion: 'added' }]);
  });
});

describe('a draft holding work is not thrown away by a rewrite', () => {
  // The near-miss: a model that believed its last call had failed re-sent the
  // batch it opened with, and that batch began with `add` at the root. It was
  // caught only because the resend reproduced identical content — a batch that
  // differed would have discarded four cases with nothing to report it.
  const shape = [{ op: 'add', path: '', value: { cases: [], rationale: '' } }];

  it('lets the shape be established on an empty draft', async () => {
    const repo = fakeRepo();
    const receipt = await patch(repo, 'shape', shape);
    expect(receipt.revision).toBe(1);
  });

  it('refuses a rewrite once cases have been appended, naming what is at stake', async () => {
    const repo = fakeRepo();
    await patch(repo, 'shape', shape);
    await patch(repo, 'c1', [{ op: 'add', path: '/cases/-', value: { title: 'one' } }]);
    const err = await patch(repo, 'resend', [
      ...shape,
      { op: 'add', path: '/cases/-', value: { title: 'different' } },
    ]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DraftWouldDiscard);
    expect((err as Error).message).toContain('cases[1]');
  });

  it('refuses a replace at the root for the same reason', async () => {
    const repo = fakeRepo();
    await patch(repo, 'shape', shape);
    await patch(repo, 'c1', [{ op: 'add', path: '/cases/-', value: { title: 'one' } }]);
    await expect(
      patch(repo, 'replace', [{ op: 'replace', path: '', value: { cases: [] } }]),
    ).rejects.toBeInstanceOf(DraftWouldDiscard);
  });

  it('still allows a rewrite while the draft holds nothing', async () => {
    const repo = fakeRepo();
    await patch(repo, 'shape', shape);
    const receipt = await patch(repo, 'reshape', [
      { op: 'add', path: '', value: { cases: [], rationale: 'better' } },
    ]);
    expect(receipt.revision).toBe(2);
  });

  it('leaves ordinary appends alone', async () => {
    const repo = fakeRepo();
    await patch(repo, 'shape', shape);
    await patch(repo, 'c1', [{ op: 'add', path: '/cases/-', value: { title: 'one' } }]);
    const receipt = await patch(repo, 'c2', [
      { op: 'add', path: '/cases/-', value: { title: 'two' } },
    ]);
    expect(receipt.census).toContain('cases[2]');
  });
});

describe('batch order keeps meaning what it says', () => {
  const seed = [{ op: 'add', path: '', value: { cases: [{ title: 'a case' }] } }];

  it('does not let a later add decide an earlier test', async () => {
    // Synthesising every parent up front made `test /foo {}` pass against a
    // document without `/foo`, because an add further down had created it.
    const repo = fakeRepo();
    await patch(repo, 'seed', seed);
    await expect(
      patch(repo, 'ordered', [
        { op: 'test', path: '/cases/0/rubrics', value: [] },
        { op: 'add', path: '/cases/0/rubrics/-', value: { criterion: 'x' } },
      ]),
    ).rejects.toBeTruthy();
  });

  it('still creates the parent for an add that stands on its own', async () => {
    const repo = fakeRepo();
    await patch(repo, 'seed', seed);
    const receipt = await patch(repo, 'ok', [
      { op: 'add', path: '/cases/0/rubrics/-', value: { criterion: 'x' } },
    ]);
    expect(receipt.revision).toBe(2);
  });

  it('leaves the draft untouched when a later operation in the batch fails', async () => {
    const repo = fakeRepo();
    await patch(repo, 'seed', seed);
    await patch(repo, 'one', [{ op: 'add', path: '/cases/-', value: { title: 'two' } }]);
    await expect(
      patch(repo, 'partial', [
        { op: 'add', path: '/cases/-', value: { title: 'three' } },
        { op: 'replace', path: '/nothing/here', value: 1 },
      ]),
    ).rejects.toBeTruthy();
    const { envelope } = await readTaskDraft({ repo, payloadStore, scope });
    expect((envelope.content as { cases: unknown[] }).cases).toHaveLength(2);
  });
});

describe('every way of rewriting the root is refused', () => {
  const seed = [{ op: 'add', path: '', value: { cases: [{ title: 'kept' }], spare: { a: 1 } } }];

  it.each(['copy', 'move'])('refuses a root %s, which replaces the document too', async (op) => {
    const repo = fakeRepo();
    await patch(repo, 'seed', seed);
    await expect(
      patch(repo, `root-${op}`, [{ op, path: '', from: '/spare' }]),
    ).rejects.toBeInstanceOf(DraftWouldDiscard);
  });

  it('allows a copy whose destination is not the root', async () => {
    const repo = fakeRepo();
    await patch(repo, 'seed', seed);
    const receipt = await patch(repo, 'inner', [
      { op: 'copy', path: '/cases/-', from: '/cases/0' },
    ]);
    expect(receipt.census).toContain('cases[2]');
  });
});

describe('a patch path cannot reach the prototype chain', () => {
  const seed = [{ op: 'add', path: '', value: { safe: {} } }];

  it('does not write through __proto__ while creating parents', async () => {
    const repo = fakeRepo();
    await patch(repo, 'seed', seed);
    await patch(repo, 'evil', [
      { op: 'add', path: '/safe/__proto__/polluted/value', value: 'owned' },
    ]).catch(() => undefined);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it.each(['constructor', 'prototype'])('refuses to follow %s too', async (segment) => {
    const repo = fakeRepo();
    await patch(repo, 'seed', seed);
    await patch(repo, `evil-${segment}`, [
      { op: 'add', path: `/safe/${segment}/owned/value`, value: 1 },
    ]).catch(() => undefined);
    expect(({} as Record<string, unknown>)['owned']).toBeUndefined();
  });

  it('still creates an ordinary nested parent', async () => {
    const repo = fakeRepo();
    await patch(repo, 'seed', seed);
    const receipt = await patch(repo, 'ok', [{ op: 'add', path: '/safe/nested/value', value: 1 }]);
    expect(receipt.revision).toBe(2);
  });
});

describe('a replay key identifies one batch', () => {
  const seed = [{ op: 'add', path: '', value: { cases: [] } }];

  it('returns the original receipt for a genuine retry', async () => {
    const repo = fakeRepo();
    const first = await patch(repo, 'seed', seed);
    const again = await patch(repo, 'seed', seed);
    expect(again.replayed).toBe(true);
    expect(again.revision).toBe(first.revision);
  });

  it('refuses the same key carrying different work, rather than dropping it', async () => {
    // Treating this as a replay reported success while silently discarding the
    // new operations.
    const repo = fakeRepo();
    await patch(repo, 'seed', seed);
    await expect(
      patch(repo, 'seed', [{ op: 'add', path: '/cases/-', value: { title: 'new work' } }]),
    ).rejects.toBeInstanceOf(DraftMutationIdReused);
  });

  it('is not fooled by key order within the same operations', async () => {
    const repo = fakeRepo();
    await patch(repo, 'm', [{ op: 'add', path: '', value: { a: 1, b: 2 } }]);
    const replay = await patch(repo, 'm', [{ op: 'add', path: '', value: { b: 2, a: 1 } }]);
    expect(replay.replayed).toBe(true);
  });
});

describe('a spilled draft body is owned, remembered and reclaimed', () => {
  const owner = { runId: 'run-1', stepExecutionId: 'step-1', attempt: 1 };
  const patchWith = (repo: never, store: never, mutationId: string, operations: unknown[]) =>
    patchTaskDraft({
      repo,
      payloadStore: store,
      scope,
      owner,
      mutationId,
      operations: operations as never,
    });

  it('stores a large body under an owned key rather than its content address', async () => {
    const repo = fakeRepo();
    const store = fakePayloadStore();
    await patchWith(repo, store as never, 'big', [
      { op: 'add', path: '', value: { blob: bigText } },
    ]);
    expect(store.store).toHaveBeenCalled();
    expect(store.storeContentAddressed).not.toHaveBeenCalled();
  });

  it('remembers every superseded body across revisions', async () => {
    // parseEnvelope used to drop the list, so each write forgot the bodies
    // before it and cleanup reclaimed only the last one.
    const repo = fakeRepo();
    const store = fakePayloadStore();
    await patchWith(repo, store as never, 'r1', [
      { op: 'add', path: '', value: { blob: bigText } },
    ]);
    await patchWith(repo, store as never, 'r2', [{ op: 'add', path: '/more', value: bigText }]);
    await patchWith(repo, store as never, 'r3', [{ op: 'add', path: '/again', value: bigText }]);
    expect(store.bodies.size).toBe(3);

    await discardTaskDraft({ repo, payloadStore: store as never, scope });
    expect(store.bodies.size).toBe(0);
  });

  it('reads a spilled draft back through its owned ref', async () => {
    const repo = fakeRepo();
    const store = fakePayloadStore();
    await patchWith(repo, store as never, 'big', [
      { op: 'add', path: '', value: { cases: [{ blob: bigText }] } },
    ]);
    const { envelope } = await readTaskDraft({ repo, payloadStore: store as never, scope });
    expect((envelope.content as { cases: unknown[] }).cases).toHaveLength(1);
  });
});

describe('a body is never left without the row that names it', () => {
  const owner = { runId: 'run-1', stepExecutionId: 'step-1', attempt: 1 };

  it('reclaims the spilled body when the write that would record it fails', async () => {
    const repo = fakeRepo();
    const store = fakePayloadStore();
    (repo as unknown as { put: unknown }).put = vi.fn(async () => {
      throw new Error('MEMORY_HASH_MISMATCH: lost the race');
    });

    await expect(
      patchTaskDraft({
        repo,
        payloadStore: store as never,
        scope,
        owner,
        mutationId: 'big',
        operations: [{ op: 'add', path: '', value: { blob: bigText } }] as never,
      }),
    ).rejects.toThrow(/lost the race/);

    // Written before the row, so nothing would name it afterwards.
    expect(store.bodies.size).toBe(0);
  });

  it('surfaces an unreadable body instead of reporting an empty draft', async () => {
    // Reporting empty here let the next root patch pass the document CAS and
    // overwrite a draft that a transient store failure had only hidden.
    const repo = fakeRepo();
    const store = fakePayloadStore();
    await patchTaskDraft({
      repo,
      payloadStore: store as never,
      scope,
      owner,
      mutationId: 'big',
      operations: [{ op: 'add', path: '', value: { blob: bigText } }] as never,
    });
    store.retrieve = vi.fn(async () => {
      throw new Error('payload store unavailable');
    });

    await expect(readTaskDraft({ repo, payloadStore: store as never, scope })).rejects.toThrow(
      /unavailable/,
    );
  });
});

describe('a rewrite that names its revision is not a blind reset', () => {
  const seed = [{ op: 'add', path: '', value: { cases: [{ title: 'kept' }] } }];

  it('refuses an unguarded root rewrite, as before', async () => {
    const repo = fakeRepo();
    await patch(repo, 'seed', seed);
    await expect(
      patch(repo, 'blind', [{ op: 'replace', path: '', value: { cases: [] } }]),
    ).rejects.toBeInstanceOf(DraftWouldDiscard);
  });

  it('allows it when the author names the revision it read', async () => {
    // Without this the refusal traps its own repair: a draft whose root is a
    // JSON string is work by any measure, so every route out of it was refused.
    const repo = fakeRepo();
    const first = await patch(repo, 'seed', seed);
    const receipt = await patch(
      repo,
      'guarded',
      [{ op: 'replace', path: '', value: { cases: [{ title: 'decoded' }] } }],
      first.revision,
    );
    expect(receipt.revision).toBe(2);
    expect(receipt.census).toContain('cases[1]');
  });

  it('still refuses when the named revision is stale', async () => {
    const repo = fakeRepo();
    const first = await patch(repo, 'seed', seed);
    await patch(repo, 'more', [{ op: 'add', path: '/cases/-', value: { title: 'two' } }]);
    await expect(
      patch(repo, 'stale', [{ op: 'replace', path: '', value: {} }], first.revision),
    ).rejects.toBeInstanceOf(DraftRevisionMismatch);
  });

  it('turns a stringified root into the decoded object, which is the trapped case', async () => {
    const repo = fakeRepo();
    const first = await patch(repo, 'strung', [
      { op: 'add', path: '', value: JSON.stringify({ cases: [{ title: 'inside' }] }) },
    ]);
    const receipt = await patch(
      repo,
      'decode',
      [{ op: 'replace', path: '', value: { cases: [{ title: 'inside' }] } }],
      first.revision,
    );
    expect(receipt.census).toContain('cases[1]');
  });
});
