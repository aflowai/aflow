import { describe, expect, it } from 'vitest';
import {
  HostFilePatchInputSchema,
  HostFilePatchOutputSchema,
  HostHarnessRunInputSchema,
  HostHarnessRunOutputSchema,
} from '../host.js';
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
    const description = HostHarnessRunInputSchema.shape.base.description ?? '';
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
    };
    const result = { state: 'applied', filesChanged: 1, files: ['x'], conflicts: [] };
    expect(
      HostFilePatchOutputSchema.safeParse({ ...result, commit: { ...commit, appended: true } })
        .success,
    ).toBe(true);
    expect(HostFilePatchOutputSchema.safeParse({ ...result, commit }).success).toBe(false);
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
