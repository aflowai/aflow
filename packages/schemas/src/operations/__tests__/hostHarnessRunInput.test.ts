import { describe, expect, it } from 'vitest';
import {
  HostFilePatchInputSchema,
  HostFilePatchOutputSchema,
  HostHarnessRunInputSchema,
  HostHarnessRunOutputSchema,
} from '../host.js';
import { HostOperationRegistrations } from '../hostRegistrations.js';
import { toJsonSchemaSync } from '../../utils/jsonSchema.js';

const base = { bindingId: 'hb_x', task: 'Review the range.' };

describe('host.harness.run takes its object arguments however the caller spelled them', () => {
  it('parses a JSON-stringified outputSchema and inputs back to objects', () => {
    const parsed = HostHarnessRunInputSchema.parse({
      ...base,
      outputSchema: '{"type":"object","required":["verdict"]}',
      inputs: '{"range":"main..HEAD"}',
    });
    expect(parsed.outputSchema).toEqual({ type: 'object', required: ['verdict'] });
    expect(parsed.inputs).toEqual({ range: 'main..HEAD' });
  });

  it('takes the object forms unchanged and leaves an absent field absent', () => {
    const parsed = HostHarnessRunInputSchema.parse({ ...base, outputSchema: { type: 'object' } });
    expect(parsed.outputSchema).toEqual({ type: 'object' });
    expect(parsed.inputs).toBeUndefined();
  });

  it('still refuses a string that is not JSON as the object it is not', () => {
    const result = HostHarnessRunInputSchema.safeParse({ ...base, outputSchema: 'a schema' });
    expect(result.success).toBe(false);
  });

  it('describes the fields to a caller as objects, with their descriptions', () => {
    const json = toJsonSchemaSync(HostHarnessRunInputSchema) as {
      properties: Record<string, { type?: string; description?: string }>;
    };
    expect(json.properties['outputSchema']?.type).toBe('object');
    expect(json.properties['outputSchema']?.description).toContain('JSON Schema');
    expect(json.properties['inputs']?.type).toBe('object');
  });
});

describe('a commission and a publication name the commit they start from', () => {
  it('takes a branch, a tag or a sha as the base of a run, and leaves it absent otherwise', () => {
    for (const ref of ['feat/fix-the-parser', 'v1.2.0', 'a1b2c3d', 'a'.repeat(40)]) {
      expect(HostHarnessRunInputSchema.parse({ ...base, base: ref }).base).toBe(ref);
    }
    expect(HostHarnessRunInputSchema.parse(base).base).toBeUndefined();
  });

  it('refuses a base that would read as an option, split, or climb', () => {
    for (const ref of ['', '--output=/tmp/x', 'two words', 'a..b', 'x'.repeat(201)]) {
      expect(HostHarnessRunInputSchema.safeParse({ ...base, base: ref }).success).toBe(false);
    }
  });

  it('carries the base on a commit as `baseSha`, a sha and nothing else', () => {
    const patch = { bindingId: 'hb_x', patch: 'diff --git a/x b/x\n' };
    const withBase = (baseSha: string) => ({
      ...patch,
      commit: { branch: 'aflow/fix', message: 'Fix', baseSha },
    });
    for (const sha of ['a'.repeat(40), '5af899c', '5AF899C7CA75']) {
      expect(HostFilePatchInputSchema.parse(withBase(sha)).commit?.baseSha).toBe(sha);
    }
    for (const base of [
      'aflow/fix',
      'main',
      'v1.0',
      '5af899',
      'a'.repeat(41),
      'g'.repeat(7),
      '-x',
    ]) {
      const result = HostFilePatchInputSchema.safeParse(withBase(base));
      expect(result.success, base).toBe(false);
      expect(result.error?.issues[0]?.message, base).toContain('not a branch or tag name');
    }
  });

  it('says a remote-qualified base is fetched before it is read', () => {
    const description = HostHarnessRunInputSchema.innerType().shape.base.description ?? '';
    expect(description).toContain('`<remote>/<ref>`');
    expect(description).toContain("`origin/main` is the remote's `main` as of now");
  });

  it('refuses a base under any other name rather than dropping it', () => {
    const result = HostFilePatchInputSchema.safeParse({
      bindingId: 'hb_x',
      patch: 'diff --git a/x b/x\n',
      commit: { branch: 'aflow/fix', message: 'Fix', base: 'a'.repeat(40) },
    });
    expect(result.success).toBe(false);
  });

  it('says whether a commit was appended', () => {
    const commit = {
      branch: 'aflow/fix',
      sha: 'b'.repeat(40),
      message: 'Fix',
      baseSha: 'a'.repeat(40),
      range: `${'a'.repeat(40)}..${'b'.repeat(40)}`,
      pushRefspec: `${'b'.repeat(40)}:refs/heads/aflow/fix`,
    };
    const result = { state: 'applied', filesChanged: 1, files: ['x'], conflicts: [] };
    expect(
      HostFilePatchOutputSchema.safeParse({ ...result, commit: { ...commit, appended: true } })
        .success,
    ).toBe(true);
    expect(HostFilePatchOutputSchema.safeParse({ ...result, commit }).success).toBe(false);
  });
});

describe('a fix to a branch its base moved past names the merge at both layers', () => {
  it('takes a remote branch to merge into the commission, and refuses what would read as an option', () => {
    const onto = { ...base, base: 'aflow/fix' };
    expect(HostHarnessRunInputSchema.parse({ ...onto, mergeFrom: 'origin/main' }).mergeFrom).toBe(
      'origin/main',
    );
    expect(HostHarnessRunInputSchema.parse(base).mergeFrom).toBeUndefined();
    for (const ref of ['', '--upload-pack=x', 'two words', 'origin/a..b']) {
      expect(HostHarnessRunInputSchema.safeParse({ ...onto, mergeFrom: ref }).success, ref).toBe(
        false,
      );
    }
  });

  it('refuses a merge with no branch to merge into, naming both fields', () => {
    const result = HostHarnessRunInputSchema.safeParse({ ...base, mergeFrom: 'origin/main' });
    expect(result.success).toBe(false);
    const issue = result.error?.issues[0];
    expect(issue?.path).toEqual(['base']);
    expect(issue?.message).toContain('`mergeFrom` (`origin/main`) is given without `base`');
    expect(issue?.message).toContain('A merge needs the branch it is merged into');
  });

  it('takes a publication whose whole change is the merge, and no other without a diff', () => {
    const commit = { branch: 'aflow/fix', message: 'Fix', baseSha: 'a'.repeat(40) };
    const mergeOnly = HostFilePatchInputSchema.safeParse({
      bindingId: 'hb_x',
      commit: { ...commit, mergeFrom: 'c'.repeat(40) },
    });
    expect(mergeOnly.success).toBe(true);
    for (const input of [{ bindingId: 'hb_x', commit }, { bindingId: 'hb_x' }]) {
      const result = HostFilePatchInputSchema.safeParse(input);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.message).toContain('Name the diff to apply');
    }
  });

  it("reports the commit message's body apart from its subject", () => {
    const commit = {
      branch: 'aflow/fix',
      sha: 'b'.repeat(40),
      message: 'Fix\n\nWhy it changed.',
      body: 'Why it changed.',
      baseSha: 'a'.repeat(40),
      appended: false,
      range: `${'a'.repeat(40)}..${'b'.repeat(40)}`,
      pushRefspec: `${'b'.repeat(40)}:refs/heads/aflow/fix`,
    };
    const result = { state: 'applied', filesChanged: 1, files: ['x'], conflicts: [] };
    expect(HostFilePatchOutputSchema.parse({ ...result, commit }).commit?.body).toBe(
      'Why it changed.',
    );
    expect(
      HostFilePatchOutputSchema.safeParse({ ...result, commit: { ...commit, body: '' } }).success,
    ).toBe(false);
  });

  it('carries the merged commit on the publication as a sha, never a branch name', () => {
    const withMerge = (mergeFrom: string) => ({
      bindingId: 'hb_x',
      patch: 'diff --git a/x b/x\n',
      commit: { branch: 'aflow/fix', message: 'Fix', baseSha: 'a'.repeat(40), mergeFrom },
    });
    expect(HostFilePatchInputSchema.parse(withMerge('c'.repeat(40))).commit?.mergeFrom).toBe(
      'c'.repeat(40),
    );
    for (const ref of ['origin/main', 'main', 'g'.repeat(40)]) {
      const result = HostFilePatchInputSchema.safeParse(withMerge(ref));
      expect(result.success, ref).toBe(false);
      expect(result.error?.issues[0]?.message, ref).toContain('not a branch or tag name');
    }
  });

  it('reports the merge a commission made, and the one a publication folded the patch into', () => {
    const run = {
      runId: 'hr_1',
      harness: { id: 'claude' },
      continued: false,
      baseSha: 'a'.repeat(40),
      filesChanged: 1,
      patchTruncated: false,
      exitCode: 0,
      timedOut: false,
      durationMs: 1,
      truncated: false,
      applies: 'clean',
      headMoved: false,
      refChanges: [],
      blockedDomains: [],
    };
    const merge = {
      from: 'c'.repeat(40),
      conflicts: [
        { path: 'a.txt', kind: 'content' },
        { path: 'gone.txt', kind: 'modify-delete' },
      ],
    };
    expect(HostHarnessRunOutputSchema.parse({ ...run, merge }).merge).toEqual(merge);
    expect(HostHarnessRunOutputSchema.parse(run).merge).toBeUndefined();
    for (const conflicts of [undefined, ['a.txt'], [{ path: 'a.txt', kind: 'rename' }]]) {
      expect(
        HostHarnessRunOutputSchema.safeParse({ ...run, merge: { from: 'c'.repeat(40), conflicts } })
          .success,
        JSON.stringify(conflicts),
      ).toBe(false);
    }

    const commit = {
      branch: 'aflow/fix',
      sha: 'b'.repeat(40),
      message: 'Fix',
      baseSha: 'a'.repeat(40),
      appended: true,
      merged: 'c'.repeat(40),
      range: `${'a'.repeat(40)}..${'b'.repeat(40)}`,
      pushRefspec: `${'b'.repeat(40)}:refs/heads/aflow/fix`,
    };
    const parsed = HostFilePatchOutputSchema.parse({
      state: 'applied',
      filesChanged: 1,
      files: ['x'],
      conflicts: [],
      commit,
    });
    expect(parsed.commit?.merged).toBe('c'.repeat(40));
  });

  it('tells both operations how a fix to a moved-past branch is commissioned and published', () => {
    const hint =
      'A fix to a branch its base has moved past is commissioned with `mergeFrom: origin/<base>` and published with the sha the commission reported in `merge.from` as `commit.mergeFrom`; the branch then carries one merge commit holding the fix';
    for (const verb of ['run', 'patch']) {
      const registration = HostOperationRegistrations.find((r) => r.verb === verb);
      expect(registration?.usage?.whenToUse, verb).toContain(hint);
    }
  });
});

describe("a commission's diff travels by reference", () => {
  const ref = 'gs://file-store/tenants/t_1/runs/r_1/steps/s_1/attempt/1/patch.json';

  it('takes exactly one of `patchRef` and `patch`, in either mode', () => {
    for (const commit of [undefined, { branch: 'aflow/fix', message: 'Fix' }]) {
      const at = { bindingId: 'hb_x', ...(commit !== undefined ? { commit } : {}) };
      expect(HostFilePatchInputSchema.parse({ ...at, patchRef: ref }).patchRef).toBe(ref);
      expect(HostFilePatchInputSchema.safeParse({ ...at, patch: 'diff\n' }).success).toBe(true);

      const neither = HostFilePatchInputSchema.safeParse(at);
      expect(neither.success).toBe(false);
      expect(neither.error?.issues[0]?.message).toContain(
        '`patchRef` for the change a commission reported',
      );
      const both = HostFilePatchInputSchema.safeParse({ ...at, patch: 'diff\n', patchRef: ref });
      expect(both.success).toBe(false);
      expect(both.error?.issues[0]?.message).toContain('not both');
    }
  });

  it('refuses a `patchRef` that is not a payload reference', () => {
    expect(
      HostFilePatchInputSchema.safeParse({ bindingId: 'hb_x', patchRef: 'the diff' }).success,
    ).toBe(false);
  });

  it('reports the whole diff by reference beside the inline copy, and says which to pass on', () => {
    const run = {
      runId: 'hr_1',
      harness: { id: 'claude' },
      continued: false,
      baseSha: 'abc',
      patchRef: ref,
      patch: 'diff --git a/x b/x\n',
      filesChanged: 1,
      patchTruncated: true,
      exitCode: 0,
      timedOut: false,
      durationMs: 10,
      truncated: false,
      applies: 'clean',
      headMoved: false,
      refChanges: [],
      blockedDomains: [],
    };
    expect(HostHarnessRunOutputSchema.parse(run).patchRef).toBe(ref);
    expect(HostHarnessRunOutputSchema.safeParse({ ...run, patchRef: 'a diff' }).success).toBe(
      false,
    );
    const shape = HostHarnessRunOutputSchema.shape;
    expect(shape.patchRef.description).toContain('This is what a publication takes');
    expect(shape.patch.description).toContain('Never what a publication takes');
    expect(shape.patchTruncated.description).toContain('`patchRef` holds all of it');

    const input = toJsonSchemaSync(HostFilePatchInputSchema) as {
      properties: Record<string, { description?: string }>;
    };
    expect(input.properties['patchRef']?.description).toContain(
      'the `patchRef` a `host.harness.run` result reports',
    );
    expect(input.properties['patch']?.description).toContain('pass its `patchRef` instead');
  });
});

describe('host.harness.run asks for a browser by profile', () => {
  it('takes ephemeral or a declared profile id, and leaves an absent browser absent', () => {
    expect(
      HostHarnessRunInputSchema.parse({ ...base, browser: { profile: 'ephemeral' } }).browser,
    ).toEqual({ profile: 'ephemeral' });
    expect(
      HostHarnessRunInputSchema.parse({ ...base, browser: { profile: 'work' } }).browser,
    ).toEqual({ profile: 'work' });
    expect(HostHarnessRunInputSchema.parse(base).browser).toBeUndefined();
    expect(
      HostHarnessRunInputSchema.safeParse({ ...base, browser: { profile: '../escape' } }).success,
    ).toBe(false);
    expect(HostHarnessRunInputSchema.safeParse({ ...base, browser: {} }).success).toBe(false);
  });

  it('tells the caller when to ask for one and that ephemeral is the default choice', () => {
    const json = toJsonSchemaSync(HostHarnessRunInputSchema) as {
      properties: Record<
        string,
        { description?: string; properties?: Record<string, { description?: string }> }
      >;
    };
    const browser = json.properties['browser'];
    expect(browser?.description).toContain('touches a UI');
    expect(browser?.properties?.['profile']?.description).toContain('the default choice');
  });

  it('names the browser log on the result', () => {
    const json = toJsonSchemaSync(HostHarnessRunOutputSchema) as {
      properties: Record<string, { description?: string }>;
    };
    expect(json.properties['browserLog']?.description).toContain('typed text by its length only');
  });
});
